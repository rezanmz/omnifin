import type { JellyfinAuthenticationResult } from "@omnifin/connectors/auth/jellyfin-authentication-client";
import {
  OIDC_ROLE_MAPPINGS_MAX_COUNT,
  RECOVERY_PERMISSIONS,
  administratorRecoveryConfirmationRequestSchema,
  administratorRecoveryPreviewResponseSchema,
  administratorRecoveryTargetSchema,
  roleMappingSchema,
  type AdministratorRecoveryConfirmationRequest,
  type AdministratorRecoveryPreviewResponse,
  type AdministratorRecoveryTarget,
  type RoleMapping,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, privacyHash } from "../security/crypto.js";
import type { JellyfinConnectorTarget } from "./jellyfin/connector-registry.js";
import { isValidatedOidcClaims } from "./oidc/claims.js";
import { consumeVerifiedOidcGrant, type VerifiedOidcGrant } from "./oidc/protocol.js";
import { resolveOidcRole } from "./oidc/role-mapping.js";
import type {
  AdministratorReplacementSessionCompletion,
  SessionAttribution,
  SessionService,
  ValidatedRecoveryBootstrapSession,
} from "./session-service.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_IP_ADDRESS_LENGTH = 256;
const MAX_USER_AGENT_LENGTH = 2_048;
const MAX_ACCESS_TOKEN_LENGTH = 32_768;

export type AdministratorRecoveryErrorReason =
  "integrity_failure" | "permission_denied" | "storage_failure" | "unavailable";

export class AdministratorRecoveryError extends Error {
  public readonly reason: AdministratorRecoveryErrorReason;

  public constructor(reason: AdministratorRecoveryErrorReason, options?: ErrorOptions) {
    super("Administrator recovery could not be completed.", options);
    this.name = "AdministratorRecoveryError";
    this.reason = reason;
  }
}

export interface AdministratorRecoveryServiceDependencies {
  readonly clock?: () => Date;
  readonly createId?: () => string;
}

export interface AdministratorRecoveryRequestContext {
  readonly ipAddress?: string;
  readonly requestId?: string;
  readonly userAgent?: string;
}

export interface JellyfinAdministratorReplacementInput
  extends AdministratorRecoveryRequestContext, AdministratorRecoveryConfirmationRequest {
  readonly authentication: JellyfinAuthenticationResult;
  readonly deviceId: string;
  readonly proof: "password" | "quick_connect";
  readonly target: JellyfinConnectorTarget;
  readonly validatedSession?: unknown;
}

export interface OidcAdministratorReplacementInput
  extends AdministratorRecoveryRequestContext, AdministratorRecoveryConfirmationRequest {
  readonly currentRecoverySessionToken?: unknown;
  readonly grant: VerifiedOidcGrant;
  readonly recoverySessionId: string;
}

export type AdministratorRecoveryReplacementResult =
  | {
      readonly reason: "proof_denied";
      readonly status: "denied";
      toJSON(): never;
    }
  | {
      readonly reason: "state_unavailable";
      readonly status: "unavailable";
      toJSON(): never;
    }
  | (AdministratorReplacementSessionCompletion & {
      readonly status: "replaced";
      toJSON(): never;
    });

interface SoleAdministratorRow {
  activeSessions: number;
  displayName: string;
  hasJellyfin: number;
  hasOidc: number;
  id: string;
  updatedAt: number;
}

interface CandidateRow {
  connectorEnabled: number;
  connectorId: string;
  connectorUpdatedAt: number;
  encryptedAccessToken: string;
  linkId: string;
  linkRevision: number;
  linkUpdatedAt: number;
  role: string;
  roleSource: string;
  status: string;
  updatedAt: number;
  userId: string;
}

interface OidcCandidateRow extends CandidateRow {
  externalIdentityId: string;
  identityProviderId: string;
}

interface OidcProviderRow {
  clientId: string;
  discoveryState: string;
  enabled: number;
  id: string;
  issuer: string;
}

interface RoleMappingRow {
  claimPathJson: string;
  enabled: number;
  id: string;
  operator: string;
  priority: number;
  providerId: string;
  role: string;
  valuesJson: string;
}

function internalResult<T extends Readonly<Record<string, unknown>>>(
  properties: T,
): Readonly<T> & { toJSON(): never } {
  const result = Object.create(null) as T & { toJSON(): never };
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(result, name, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }
  Object.defineProperty(result, "toJSON", {
    configurable: false,
    enumerable: false,
    value: () => {
      throw new TypeError("Administrator recovery results cannot be serialized.");
    },
    writable: false,
  });
  return Object.freeze(result);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validTimestamp(value: unknown, maximum?: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    (maximum === undefined || Number(value) <= maximum)
  );
}

function validOptionalText(value: string | undefined, maximum: number) {
  return value === undefined || (value.length >= 1 && value.length <= maximum);
}

function accessTokenContext(linkId: string) {
  return `service_identity_access_token:jellyfin:${linkId}`;
}

function parseRoleMappings(rows: readonly RoleMappingRow[]): readonly RoleMapping[] | undefined {
  if (rows.length > OIDC_ROLE_MAPPINGS_MAX_COUNT) return undefined;
  const mappings: RoleMapping[] = [];
  try {
    for (const row of rows) {
      const parsed = roleMappingSchema.safeParse({
        claimPath: JSON.parse(row.claimPathJson) as unknown,
        enabled: row.enabled === 1,
        id: row.id,
        operator: row.operator,
        priority: row.priority,
        providerId: row.providerId,
        role: row.role,
        values: JSON.parse(row.valuesJson) as unknown,
      });
      if (!parsed.success) return undefined;
      mappings.push(parsed.data);
    }
  } catch {
    return undefined;
  }
  return mappings;
}

export class AdministratorRecoveryService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: Pick<AppConfig, "encryptionKey">;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;
  readonly #sessionService: SessionService;

  public constructor(
    database: DatabaseHandle,
    sessionService: SessionService,
    config: Pick<AppConfig, "encryptionKey">,
    dependencies: AdministratorRecoveryServiceDependencies = {},
  ) {
    if (!sessionService.isBoundToDatabase(database)) {
      throw new AdministratorRecoveryError("integrity_failure");
    }
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#config = config;
    this.#createId = dependencies.createId ?? randomUUID;
    this.#database = database;
    this.#sessionService = sessionService;
  }

  public toJSON(): never {
    throw new TypeError("Administrator recovery services cannot be serialized.");
  }

  /** @internal Verifies service composition without exposing the database handle. */
  public isBoundToDatabase(database: DatabaseHandle): boolean {
    return this.#database === database;
  }

  public preview(
    principal: SessionPrincipal | null | undefined,
  ): AdministratorRecoveryPreviewResponse {
    this.#requireRecoveryPrincipal(principal);
    try {
      const administrator = this.#loadSoleAdministrator(this.#currentTime());
      if (!administrator) {
        return administratorRecoveryPreviewResponseSchema.parse({ status: "unavailable" });
      }
      const authenticationMethods: Array<"jellyfin" | "oidc"> = [];
      if (administrator.hasJellyfin === 1) authenticationMethods.push("jellyfin");
      if (administrator.hasOidc === 1) authenticationMethods.push("oidc");
      return administratorRecoveryPreviewResponseSchema.parse({
        administrator: {
          activeSessions: administrator.activeSessions,
          authenticationMethods,
          displayName: administrator.displayName,
          id: administrator.id,
          updatedAt: new Date(administrator.updatedAt).toISOString(),
        },
        status: "available",
      });
    } catch (error) {
      if (error instanceof AdministratorRecoveryError) throw error;
      throw new AdministratorRecoveryError("storage_failure", { cause: error });
    }
  }

  /** @internal Validates the current recovery actor and exact target before upstream proof starts. */
  public beginValidatedReplacement(
    validatedSession: unknown,
    target?: AdministratorRecoveryTarget,
  ): ValidatedRecoveryBootstrapSession | null {
    const principal = this.#sessionService.resolveValidatedSessionPrincipal(validatedSession);
    try {
      this.#requireRecoveryPrincipal(principal);
    } catch {
      return null;
    }
    const recovery = this.#sessionService.beginValidatedRecoveryBootstrapSession(validatedSession);
    if (!recovery) return null;
    if (target !== undefined) {
      const parsed = administratorRecoveryTargetSchema.safeParse({
        administratorId: target.administratorId,
        expectedUpdatedAt: target.expectedUpdatedAt,
      });
      if (!parsed.success || !this.#targetMatches(parsed.data, recovery.operationTime)) return null;
    }
    return recovery;
  }

  public replaceWithJellyfin(
    input: JellyfinAdministratorReplacementInput,
  ): AdministratorRecoveryReplacementResult {
    const confirmation = administratorRecoveryConfirmationRequestSchema.safeParse({
      administratorId: input?.administratorId,
      confirmation: input?.confirmation,
      expectedUpdatedAt: input?.expectedUpdatedAt,
    });
    if (!confirmation.success || !this.#validContext(input)) {
      return internalResult({
        reason: "state_unavailable" as const,
        status: "unavailable" as const,
      });
    }
    if (!this.#validJellyfinAuthentication(input.authentication, input.deviceId, input.target)) {
      return internalResult({ reason: "proof_denied" as const, status: "denied" as const });
    }

    try {
      return this.#database.sqlite
        .transaction(() => {
          const recovery = this.beginValidatedReplacement(
            input.validatedSession,
            confirmation.data,
          );
          if (!recovery) {
            return internalResult({
              reason: "state_unavailable" as const,
              status: "unavailable" as const,
            });
          }
          if (input.authentication.User.Policy.IsAdministrator !== true) {
            return internalResult({
              reason: "proof_denied" as const,
              status: "denied" as const,
            });
          }
          const candidate = this.#loadJellyfinCandidate(input, recovery.operationTime);
          if (!candidate || candidate.status !== "active") {
            return internalResult({
              reason: "proof_denied" as const,
              status: "denied" as const,
            });
          }
          if (candidate.userId === confirmation.data.administratorId) {
            return internalResult({
              reason: "proof_denied" as const,
              status: "denied" as const,
            });
          }

          const encryptedAccessToken = this.#cipher.encrypt(
            input.authentication.AccessToken,
            accessTokenContext(candidate.linkId),
          );
          const refreshed = this.#database.sqlite
            .prepare(
              `update service_identity_links
               set encrypted_access_token = @encryptedAccessToken,
                   device_id = @deviceId,
                   token_created_at = @now,
                   health_state = 'linked',
                   last_verified_at = @now,
                   revoked_at = null,
                   revision = revision + 1,
                   updated_at = @now
               where id = @linkId
                 and user_id = @userId
                 and revision = @revision
                 and updated_at = @linkUpdatedAt
                 and health_state in ('linked', 'unavailable')`,
            )
            .run({
              deviceId: input.deviceId,
              encryptedAccessToken,
              linkId: candidate.linkId,
              linkUpdatedAt: candidate.linkUpdatedAt,
              now: recovery.operationTime,
              revision: candidate.linkRevision,
              userId: candidate.userId,
            });
          if (refreshed.changes !== 1) throw new AdministratorRecoveryError("unavailable");

          return this.#completeReplacement({
            attribution: {
              authMethod: "jellyfin",
              serviceIdentityLinkId: candidate.linkId,
              userId: candidate.userId,
            },
            candidate,
            confirmation: confirmation.data,
            context: input,
            proof: input.proof === "password" ? "jellyfin_password" : "jellyfin_quick_connect",
            recovery,
            roleSource: "recovery_bootstrap",
          });
        })
        .immediate();
    } catch (error) {
      if (error instanceof AdministratorRecoveryError && error.reason === "unavailable") {
        return internalResult({
          reason: "state_unavailable" as const,
          status: "unavailable" as const,
        });
      }
      if (error instanceof AdministratorRecoveryError) throw error;
      throw new AdministratorRecoveryError("storage_failure", { cause: error });
    }
  }

  public replaceWithOidc(
    input: OidcAdministratorReplacementInput,
  ): AdministratorRecoveryReplacementResult {
    const confirmation = administratorRecoveryConfirmationRequestSchema.safeParse({
      administratorId: input?.administratorId,
      confirmation: input?.confirmation,
      expectedUpdatedAt: input?.expectedUpdatedAt,
    });
    if (
      !confirmation.success ||
      !validIdentifier(input.recoverySessionId) ||
      !this.#validContext(input)
    ) {
      return internalResult({
        reason: "state_unavailable" as const,
        status: "unavailable" as const,
      });
    }

    try {
      return this.#database.sqlite
        .transaction(() => {
          const recovery = this.#sessionService.resumeRecoveryBootstrapSession(
            input.currentRecoverySessionToken,
            input.recoverySessionId,
          );
          if (!recovery || !this.#targetMatches(confirmation.data, recovery.operationTime)) {
            return internalResult({
              reason: "state_unavailable" as const,
              status: "unavailable" as const,
            });
          }

          let identity;
          try {
            identity = consumeVerifiedOidcGrant(input.grant);
          } catch {
            return internalResult({
              reason: "proof_denied" as const,
              status: "denied" as const,
            });
          }
          if (!isValidatedOidcClaims(identity.claims)) {
            return internalResult({
              reason: "proof_denied" as const,
              status: "denied" as const,
            });
          }
          const provider = this.#database.sqlite
            .prepare(
              `select id, issuer, client_id as clientId, enabled,
                      discovery_state as discoveryState
               from oidc_providers
               where id = ?`,
            )
            .get(identity.providerId) as OidcProviderRow | undefined;
          if (
            !provider ||
            provider.enabled !== 1 ||
            provider.discoveryState !== "ready" ||
            provider.issuer !== identity.issuer ||
            provider.clientId !== identity.clientId
          ) {
            return internalResult({
              reason: "state_unavailable" as const,
              status: "unavailable" as const,
            });
          }
          const mappingRows = this.#database.sqlite
            .prepare(
              `select id, provider_id as providerId, claim_path_json as claimPathJson,
                      operator, values_json as valuesJson, role, priority, enabled
               from role_mappings
               where provider_id = ?
               order by priority desc, id asc
               limit ?`,
            )
            .all(provider.id, OIDC_ROLE_MAPPINGS_MAX_COUNT + 1) as RoleMappingRow[];
          const mappings = parseRoleMappings(mappingRows);
          const role =
            mappings === undefined
              ? undefined
              : resolveOidcRole({ claims: identity.claims, mappings, providerId: provider.id });
          if (!role || role.status !== "resolved" || role.role !== "admin") {
            return internalResult({
              reason: "proof_denied" as const,
              status: "denied" as const,
            });
          }

          const candidate = this.#loadOidcCandidate(
            provider.id,
            provider.issuer,
            identity.claims.subject,
            recovery.operationTime,
          );
          if (!candidate) {
            return internalResult({
              reason: "state_unavailable" as const,
              status: "unavailable" as const,
            });
          }
          if (
            candidate.status === "disabled" ||
            candidate.userId === confirmation.data.administratorId
          ) {
            return internalResult({
              reason: "proof_denied" as const,
              status: "denied" as const,
            });
          }
          if (candidate.status !== "active") {
            return internalResult({
              reason: "state_unavailable" as const,
              status: "unavailable" as const,
            });
          }

          const attribution: Extract<SessionAttribution, { authMethod: "oidc" }> = {
            authMethod: "oidc",
            externalIdentityId: candidate.externalIdentityId,
            idTokenHint: identity.idTokenHint,
            oidcProviderId: provider.id,
            ...(identity.sessionId === undefined ? {} : { oidcSessionId: identity.sessionId }),
            serviceIdentityLinkId: candidate.linkId,
            userId: candidate.userId,
          };
          return this.#completeReplacement({
            attribution,
            candidate,
            confirmation: confirmation.data,
            context: input,
            proof: "oidc",
            recovery,
            roleSource: "oidc_mapping",
          });
        })
        .immediate();
    } catch (error) {
      if (error instanceof AdministratorRecoveryError && error.reason === "unavailable") {
        return internalResult({
          reason: "state_unavailable" as const,
          status: "unavailable" as const,
        });
      }
      if (error instanceof AdministratorRecoveryError) throw error;
      throw new AdministratorRecoveryError("storage_failure", { cause: error });
    }
  }

  #completeReplacement(input: {
    attribution: Exclude<SessionAttribution, { authMethod: "recovery" }>;
    candidate: CandidateRow;
    confirmation: AdministratorRecoveryConfirmationRequest;
    context: AdministratorRecoveryRequestContext;
    proof: "jellyfin_password" | "jellyfin_quick_connect" | "oidc";
    recovery: ValidatedRecoveryBootstrapSession;
    roleSource: "oidc_mapping" | "recovery_bootstrap";
  }): AdministratorRecoveryReplacementResult {
    if (!this.#database.sqlite.inTransaction) {
      throw new AdministratorRecoveryError("integrity_failure");
    }
    const now = input.recovery.operationTime;
    if (
      !validTimestamp(input.candidate.updatedAt, now) ||
      !validTimestamp(input.candidate.linkUpdatedAt, now)
    ) {
      throw new AdministratorRecoveryError("unavailable");
    }
    const promoted = this.#database.sqlite
      .prepare(
        `update users
         set role = 'admin', role_source = @roleSource, status = 'active', updated_at = @now
         where id = @userId
           and status = 'active'
           and updated_at = @candidateUpdatedAt`,
      )
      .run({
        candidateUpdatedAt: input.candidate.updatedAt,
        now,
        roleSource: input.roleSource,
        userId: input.candidate.userId,
      });
    if (promoted.changes !== 1) throw new AdministratorRecoveryError("unavailable");

    const expectedUpdatedAt = Date.parse(input.confirmation.expectedUpdatedAt);
    const disabled = this.#database.sqlite
      .prepare(
        `update users
         set status = 'disabled', updated_at = @now
         where id = @administratorId
           and role = 'admin'
           and status = 'active'
           and updated_at = @expectedUpdatedAt
           and (select count(*) from users where role = 'admin' and status = 'active') = 2`,
      )
      .run({
        administratorId: input.confirmation.administratorId,
        expectedUpdatedAt,
        now,
      });
    if (disabled.changes !== 1) throw new AdministratorRecoveryError("unavailable");
    const finalAdministrator = this.#database.sqlite
      .prepare(
        `select id
         from users
         where role = 'admin' and status = 'active'
         order by id`,
      )
      .all() as { id: string }[];
    if (finalAdministrator.length !== 1 || finalAdministrator[0]?.id !== input.candidate.userId) {
      throw new AdministratorRecoveryError("unavailable");
    }

    const completed = this.#sessionService.completeValidatedAdministratorReplacementSession(
      input.recovery,
      input.confirmation.administratorId,
      input.candidate.userId,
      input.attribution,
      {
        ...(input.context.ipAddress === undefined ? {} : { ipAddress: input.context.ipAddress }),
        ...(input.context.requestId === undefined ? {} : { requestId: input.context.requestId }),
        ...(input.context.userAgent === undefined ? {} : { userAgent: input.context.userAgent }),
      },
    );
    this.#insertAudit(input, completed, now);
    return internalResult({
      revokedSessions: completed.revokedSessions,
      session: completed.session,
      status: "replaced" as const,
    });
  }

  #insertAudit(
    input: {
      candidate: CandidateRow;
      confirmation: AdministratorRecoveryConfirmationRequest;
      context: AdministratorRecoveryRequestContext;
      proof: "jellyfin_password" | "jellyfin_quick_connect" | "oidc";
      recovery: ValidatedRecoveryBootstrapSession;
    },
    completed: AdministratorReplacementSessionCompletion,
    now: number,
  ) {
    const auditId = this.#createId();
    if (!validIdentifier(auditId)) throw new AdministratorRecoveryError("integrity_failure");
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
           id, session_id, actor_session_id, actor_auth_method, event_type, outcome,
           target_type, target_id, request_id, metadata_json, ip_hash, created_at
         ) values (
           @id, @sessionId, @actorSessionId, 'recovery',
           'auth.administrator.replaced', 'success', 'user', @targetId,
           @requestId, @metadataJson, @ipHash, @createdAt
         )`,
      )
      .run({
        actorSessionId: input.recovery.sessionId,
        createdAt: now,
        id: auditId,
        ipHash:
          input.context.ipAddress === undefined
            ? null
            : privacyHash("ip_address", input.context.ipAddress, this.#config.encryptionKey),
        metadataJson: JSON.stringify({
          previousReplacementRole: input.candidate.role,
          previousReplacementRoleSource: input.candidate.roleSource,
          proof: input.proof,
          recoverySessionsRevoked: completed.revokedSessions.recovery,
          replacementAdministratorId: input.candidate.userId,
          replacementSessionsRevoked: completed.revokedSessions.replacement,
          targetSessionsRevoked: completed.revokedSessions.target,
        }),
        requestId: input.context.requestId ?? null,
        sessionId: completed.session.principal.sessionId,
        targetId: input.confirmation.administratorId,
      });
  }

  #loadSoleAdministrator(now: number): SoleAdministratorRow | undefined {
    const rows = this.#database.sqlite
      .prepare(
        `select
           u.id,
           u.display_name as displayName,
           u.updated_at as updatedAt,
           exists(
             select 1
             from service_identity_links l
             join connector_configs c on c.id = l.connector_id and c.type = l.service
             where l.user_id = u.id
               and l.service = 'jellyfin'
               and l.health_state in ('linked', 'unavailable')
               and c.enabled = 1
           ) as hasJellyfin,
           exists(
             select 1
             from external_identities e
             join oidc_providers p on p.id = e.provider_id
             where e.user_id = u.id and p.enabled = 1 and p.discovery_state = 'ready'
           ) as hasOidc,
           (
             select count(*)
             from sessions s
             where s.user_id = u.id
               and s.revoked_at is null
               and s.created_at <= @now
               and s.expires_at > @now
               and s.absolute_expires_at > @now
           ) as activeSessions
         from users u
         where u.role = 'admin' and u.status = 'active'
         order by u.id
         limit 2`,
      )
      .all({ now }) as SoleAdministratorRow[];
    if (rows.length !== 1) return undefined;
    const administrator = rows[0];
    if (
      !administrator ||
      !validIdentifier(administrator.id) ||
      !validTimestamp(administrator.updatedAt, now) ||
      !Number.isSafeInteger(administrator.activeSessions) ||
      administrator.activeSessions < 0 ||
      (administrator.hasJellyfin !== 0 && administrator.hasJellyfin !== 1) ||
      (administrator.hasOidc !== 0 && administrator.hasOidc !== 1)
    ) {
      throw new AdministratorRecoveryError("integrity_failure");
    }
    return administrator;
  }

  #targetMatches(target: AdministratorRecoveryTarget, now: number): boolean {
    const parsed = administratorRecoveryTargetSchema.safeParse({
      administratorId: target.administratorId,
      expectedUpdatedAt: target.expectedUpdatedAt,
    });
    if (!parsed.success) return false;
    const administrator = this.#loadSoleAdministrator(now);
    return (
      administrator !== undefined &&
      administrator.id === parsed.data.administratorId &&
      administrator.updatedAt === Date.parse(parsed.data.expectedUpdatedAt)
    );
  }

  #loadJellyfinCandidate(
    input: JellyfinAdministratorReplacementInput,
    now: number,
  ): CandidateRow | undefined {
    const row = this.#database.sqlite
      .prepare(
        `select
           u.id as userId, u.role, u.role_source as roleSource, u.status,
           u.updated_at as updatedAt,
           l.id as linkId, l.revision as linkRevision, l.updated_at as linkUpdatedAt,
           l.encrypted_access_token as encryptedAccessToken,
           c.id as connectorId, c.enabled as connectorEnabled, c.updated_at as connectorUpdatedAt
         from service_identity_links l
         join users u on u.id = l.user_id
         join connector_configs c on c.id = l.connector_id and c.type = l.service
         where l.service = 'jellyfin'
           and l.connector_id = @connectorId
           and l.external_server_id = @serverId
           and l.external_user_id = @externalUserId
           and l.health_state in ('linked', 'unavailable')
           and l.revoked_at is null
           and c.type = 'jellyfin'
           and c.enabled = 1
           and c.base_url = @baseUrl
           and c.updated_at = @connectorUpdatedAt`,
      )
      .get({
        baseUrl: input.target.baseUrl,
        connectorId: input.target.connectorId,
        connectorUpdatedAt: input.target.updatedAt,
        externalUserId: input.authentication.User.Id,
        serverId: input.authentication.ServerId,
      }) as CandidateRow | undefined;
    return row && this.#candidateIsValid(row, now) ? row : undefined;
  }

  #loadOidcCandidate(
    providerId: string,
    issuer: string,
    subject: string,
    now: number,
  ): OidcCandidateRow | undefined {
    const row = this.#database.sqlite
      .prepare(
        `select
           u.id as userId, u.role, u.role_source as roleSource, u.status,
           u.updated_at as updatedAt,
           e.id as externalIdentityId, e.provider_id as identityProviderId,
           l.id as linkId, l.revision as linkRevision, l.updated_at as linkUpdatedAt,
           l.encrypted_access_token as encryptedAccessToken,
           c.id as connectorId, c.enabled as connectorEnabled, c.updated_at as connectorUpdatedAt
         from external_identities e
         join users u on u.id = e.user_id
         join service_identity_links l on l.user_id = u.id and l.service = 'jellyfin'
         join connector_configs c on c.id = l.connector_id and c.type = l.service
         where e.provider_id = @providerId
           and e.issuer = @issuer
           and e.subject = @subject
           and l.health_state in ('linked', 'unavailable')
           and l.revoked_at is null
           and c.enabled = 1`,
      )
      .get({ issuer, providerId, subject }) as OidcCandidateRow | undefined;
    if (
      !row ||
      !validIdentifier(row.externalIdentityId) ||
      row.identityProviderId !== providerId ||
      !this.#candidateIsValid(row, now)
    ) {
      return undefined;
    }
    return row;
  }

  #candidateIsValid(row: CandidateRow, now: number): boolean {
    return (
      validIdentifier(row.userId) &&
      validIdentifier(row.linkId) &&
      validIdentifier(row.connectorId) &&
      ["viewer", "requester", "operator", "admin"].includes(row.role) &&
      ["default", "manual", "oidc_mapping", "recovery_bootstrap"].includes(row.roleSource) &&
      ["active", "pending_link", "disabled"].includes(row.status) &&
      row.connectorEnabled === 1 &&
      validTimestamp(row.connectorUpdatedAt, now) &&
      validTimestamp(row.updatedAt, now) &&
      validTimestamp(row.linkUpdatedAt, now) &&
      Number.isSafeInteger(row.linkRevision) &&
      row.linkRevision >= 0 &&
      row.linkRevision < 2_147_483_647 &&
      typeof row.encryptedAccessToken === "string" &&
      row.encryptedAccessToken.length >= 1 &&
      row.encryptedAccessToken.length <= MAX_ACCESS_TOKEN_LENGTH
    );
  }

  #validJellyfinAuthentication(
    authentication: JellyfinAuthenticationResult,
    deviceId: string,
    target: JellyfinConnectorTarget,
  ): boolean {
    try {
      return (
        validIdentifier(deviceId) &&
        validIdentifier(target?.connectorId) &&
        typeof target.baseUrl === "string" &&
        target.baseUrl.length >= 1 &&
        target.baseUrl.length <= 2_048 &&
        validTimestamp(target.updatedAt) &&
        typeof authentication?.AccessToken === "string" &&
        authentication.AccessToken.length >= 1 &&
        authentication.AccessToken.length <= MAX_ACCESS_TOKEN_LENGTH &&
        typeof authentication.ServerId === "string" &&
        authentication.ServerId.length >= 1 &&
        authentication.ServerId.length <= 256 &&
        typeof authentication.User?.Id === "string" &&
        authentication.User.Id.length >= 1 &&
        authentication.User.Id.length <= 256 &&
        typeof authentication.User.Policy?.IsAdministrator === "boolean"
      );
    } catch {
      return false;
    }
  }

  #validContext(context: AdministratorRecoveryRequestContext): boolean {
    return (
      validOptionalText(context.ipAddress, MAX_IP_ADDRESS_LENGTH) &&
      validOptionalText(context.requestId, MAX_REQUEST_ID_LENGTH) &&
      validOptionalText(context.userAgent, MAX_USER_AGENT_LENGTH)
    );
  }

  #requireRecoveryPrincipal(
    principal: SessionPrincipal | null | undefined,
  ): asserts principal is SessionPrincipal {
    const recoveryPermissions = new Set<string>(RECOVERY_PERMISSIONS);
    if (
      !principal ||
      principal.accountState !== "recovery" ||
      principal.userId !== null ||
      principal.role !== "admin" ||
      principal.authenticationMethod.kind !== "recovery" ||
      !principal.permissions.includes("recovery.administrator.replace") ||
      principal.permissions.length !== RECOVERY_PERMISSIONS.length ||
      principal.permissions.some((permission) => !recoveryPermissions.has(permission))
    ) {
      throw new AdministratorRecoveryError("permission_denied");
    }
  }

  #currentTime(): number {
    let now: Date;
    try {
      now = this.#clock();
    } catch (error) {
      throw new AdministratorRecoveryError("integrity_failure", { cause: error });
    }
    if (!(now instanceof Date) || !validTimestamp(now.getTime())) {
      throw new AdministratorRecoveryError("integrity_failure");
    }
    return now.getTime();
  }
}
