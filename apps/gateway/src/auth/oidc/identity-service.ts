import { roleSchema, type Role, type RoleMapping } from "@omnifin/contracts/auth";
import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "../../db/client.js";
import type { SessionAttribution } from "../session-service.js";
import { isValidatedOidcClaims, type ValidatedOidcClaims } from "./claims.js";
import {
  consumeVerifiedOidcGrant,
  type ConsumedVerifiedOidcGrant,
  type VerifiedOidcGrant,
} from "./protocol.js";
import type { OidcProviderRuntimeBindingVerifier } from "./provider-registry.js";
import { resolveOidcRole, type OidcRoleResolution } from "./role-mapping.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ISSUER_LENGTH = 2_048;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 160;
const MAX_PREFERRED_USERNAME_LENGTH = 160;
const MAX_EMAIL_LENGTH = 320;
const MAX_CLIENT_ID_BYTES = 1_024;
const DISPLAY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const DISPLAY_WHITESPACE = /\s+/gu;
const SAFE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

type AccountStatus = "active" | "pending_link";
type RoleSource = "default" | "manual" | "oidc_mapping" | "recovery_bootstrap";

export type OidcIdentityDenialReason =
  | "active_service_link_required"
  | "disabled_user"
  | "identity_integrity_failure"
  | "identity_provider_mismatch"
  | "invalid_request"
  | "invalid_verified_context"
  | "jit_provisioning_disabled"
  | "provider_context_mismatch"
  | "provider_disabled"
  | "provider_not_ready"
  | "provider_not_found"
  | "role_mapping_denied"
  | "role_resolution_mismatch";

export interface ResolveOidcIdentityInput {
  readonly grant: VerifiedOidcGrant;
  readonly requestId?: string;
}

type OidcSessionAttribution = Extract<SessionAttribution, { authMethod: "oidc" }>;

export interface ResolvedOidcIdentity {
  readonly accountStatus: AccountStatus;
  readonly attribution: Readonly<OidcSessionAttribution>;
  readonly provisioned: boolean;
  readonly role: Role;
  readonly roleChanged: boolean;
  readonly roleSource: RoleSource;
  readonly status: "resolved";
  toJSON(): never;
}

export type OidcIdentityResolution =
  | ResolvedOidcIdentity
  | {
      readonly reason: OidcIdentityDenialReason;
      readonly status: "denied";
    };

export interface OidcIdentityServiceDependencies {
  readonly clock?: () => Date;
  readonly createId?: () => string;
  readonly providerBindingVerifier: OidcProviderRuntimeBindingVerifier;
}

interface ProviderRow {
  allowJitProvisioning: number;
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

interface ExistingIdentityRow {
  externalIdentityId: string;
  identityCreatedAt: number;
  identityProviderId: string;
  identityUpdatedAt: number;
  lastLoginAt: number;
  role: string | null;
  roleSource: string | null;
  status: string | null;
  userCreatedAt: number | null;
  userId: string | null;
  userUpdatedAt: number | null;
}

interface ExistingServiceLinkRow {
  connectorEnabled: number | null;
  connectorId: string | null;
  connectorType: string | null;
  createdAt: number;
  encryptedAccessToken: string | null;
  externalDisplayName: string;
  externalUserId: string;
  externalUsername: string;
  healthState: string;
  id: string;
  lastVerifiedAt: number | null;
  linkConnectorId: string | null;
  linkUserId: string;
  revokedAt: number | null;
  service: string;
  tokenCreatedAt: number | null;
}

interface AuditEvent {
  actorUserId?: string;
  eventType: string;
  metadata: Readonly<Record<string, boolean | number | string>>;
  occurredAt: number;
  outcome: "denied" | "failure" | "success";
  requestId?: string;
  targetId?: string;
  targetType: "external_identity" | "oidc_provider" | "user";
}

export class OidcIdentityServiceError extends Error {
  public readonly code = "oidc_identity_resolution_failed";

  public constructor(options?: ErrorOptions) {
    super("OIDC identity resolution failed.", options);
    this.name = "OidcIdentityServiceError";
  }
}

function normalizedDisplayText(value: string | undefined, maximumLength: number) {
  if (value === undefined) return undefined;
  const normalized = value
    .normalize("NFC")
    .replace(DISPLAY_CONTROL_CHARACTERS, "")
    .replace(DISPLAY_WHITESPACE, " ")
    .trim();
  return normalized.length > 0 && normalized.length <= maximumLength ? normalized : undefined;
}

function normalizedDisplayClaims(claims: ValidatedOidcClaims) {
  const displayName = normalizedDisplayText(
    claims.displayClaims.displayName,
    MAX_DISPLAY_NAME_LENGTH,
  );
  const preferredUsername = normalizedDisplayText(
    claims.displayClaims.preferredUsername,
    MAX_PREFERRED_USERNAME_LENGTH,
  );
  const candidateEmail = normalizedDisplayText(claims.displayClaims.email, MAX_EMAIL_LENGTH);
  const email = candidateEmail && SAFE_EMAIL.test(candidateEmail) ? candidateEmail : undefined;
  const output: {
    displayName?: string;
    email?: string;
    emailVerified?: boolean;
    preferredUsername?: string;
  } = {};
  if (displayName !== undefined) output.displayName = displayName;
  if (preferredUsername !== undefined) output.preferredUsername = preferredUsername;
  if (email !== undefined) {
    output.email = email;
    if (claims.displayClaims.emailVerified !== undefined) {
      output.emailVerified = claims.displayClaims.emailVerified;
    }
  }
  return Object.freeze(output);
}

function displayNameFallback(claims: ReturnType<typeof normalizedDisplayClaims>) {
  return claims.displayName ?? claims.preferredUsername ?? "OIDC user";
}

function resolvedMappingRole(resolution: Extract<OidcRoleResolution, { status: "resolved" }>) {
  if (resolution.source === "oidc_mapping" && resolution.role !== "viewer") {
    return { role: resolution.role, roleSource: "oidc_mapping" as const };
  }
  return { role: "viewer" as const, roleSource: "default" as const };
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validRequestId(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length >= 1 &&
      value.length <= MAX_REQUEST_ID_LENGTH &&
      value.trim() === value)
  );
}

function validIssuer(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_ISSUER_LENGTH) {
    return false;
  }
  try {
    const issuer = new URL(value);
    return (
      issuer.protocol === "https:" &&
      !issuer.username &&
      !issuer.password &&
      !issuer.search &&
      !issuer.hash &&
      issuer.href === value
    );
  } catch {
    return false;
  }
}

function validClientId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_CLIENT_ID_BYTES &&
    value.trim() === value &&
    value.search(DISPLAY_CONTROL_CHARACTERS) === -1
  );
}

function validDatabaseRole(value: string | null): value is Role {
  return roleSchema.safeParse(value).success;
}

function validDatabaseRoleSource(value: string | null): value is RoleSource {
  return ["default", "manual", "oidc_mapping", "recovery_bootstrap"].includes(value ?? "");
}

function validDatabaseStatus(value: string | null): value is AccountStatus | "disabled" {
  return ["active", "pending_link", "disabled"].includes(value ?? "");
}

function validTimestamp(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function validBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    value.trim() === value &&
    value.search(DISPLAY_CONTROL_CHARACTERS) === -1
  );
}

function parseRoleMappings(rows: readonly RoleMappingRow[]): readonly RoleMapping[] | null {
  try {
    return rows.map((row) => ({
      claimPath: JSON.parse(row.claimPathJson) as unknown,
      enabled: row.enabled === 1,
      id: row.id,
      operator: row.operator,
      priority: row.priority,
      providerId: row.providerId,
      role: row.role,
      values: JSON.parse(row.valuesJson) as unknown,
    })) as readonly RoleMapping[];
  } catch {
    return null;
  }
}

export class OidcIdentityService {
  readonly #providerBindingVerifier: OidcProviderRuntimeBindingVerifier;
  private readonly clock: () => Date;
  private readonly createId: () => string;
  private readonly database: DatabaseHandle;

  public constructor(database: DatabaseHandle, dependencies: OidcIdentityServiceDependencies) {
    this.#providerBindingVerifier = dependencies.providerBindingVerifier;
    this.clock = dependencies.clock ?? (() => new Date());
    this.createId = dependencies.createId ?? randomUUID;
    this.database = database;
  }

  public toJSON(): never {
    throw new TypeError("OIDC identity services cannot be serialized.");
  }

  public resolve(input: ResolveOidcIdentityInput): OidcIdentityResolution {
    const occurredAt = this.currentTime();
    let grant: unknown;
    let grantWasExtracted = false;
    try {
      grant = input.grant;
      grantWasExtracted = true;
    } catch {
      grant = undefined;
    }
    let requestIdInput: unknown;
    let requestEnvelopeValid = true;
    try {
      requestIdInput = input.requestId;
    } catch {
      requestEnvelopeValid = false;
    }
    const requestId = validRequestId(requestIdInput) ? requestIdInput : undefined;

    try {
      return this.database.sqlite
        .transaction(() => {
          let identity: ConsumedVerifiedOidcGrant;
          try {
            identity = consumeVerifiedOidcGrant(grantWasExtracted ? grant : undefined);
          } catch {
            return this.deny("invalid_verified_context", occurredAt, requestId);
          }
          if (!requestEnvelopeValid || !validRequestId(requestIdInput)) {
            return this.deny("invalid_request", occurredAt, requestId);
          }
          if (
            !isValidatedOidcClaims(identity.claims) ||
            !validIdentifier(identity.providerId) ||
            !validIssuer(identity.issuer) ||
            !validClientId(identity.clientId)
          ) {
            return this.deny("invalid_verified_context", occurredAt, requestId);
          }

          const provider = this.database.sqlite
            .prepare(
              `select
              id,
              issuer,
              client_id as clientId,
              allow_jit_provisioning as allowJitProvisioning,
              discovery_state as discoveryState,
              enabled
             from oidc_providers
             where id = ?`,
            )
            .get(identity.providerId) as ProviderRow | undefined;
          if (!provider) {
            return this.deny("provider_not_found", occurredAt, requestId, identity.providerId);
          }
          if (provider.issuer !== identity.issuer || provider.clientId !== identity.clientId) {
            return this.deny("provider_context_mismatch", occurredAt, requestId, provider.id);
          }
          if (provider.enabled !== 1) {
            return this.deny("provider_disabled", occurredAt, requestId, provider.id);
          }
          if (provider.discoveryState !== "ready") {
            return this.deny("provider_not_ready", occurredAt, requestId, provider.id);
          }
          try {
            this.#providerBindingVerifier.verify(provider.id, identity.providerRuntimeBinding);
          } catch {
            return this.deny("invalid_verified_context", occurredAt, requestId);
          }

          const mappingRows = this.database.sqlite
            .prepare(
              `select
              id,
              provider_id as providerId,
              claim_path_json as claimPathJson,
              operator,
              values_json as valuesJson,
              role,
              priority,
              enabled
             from role_mappings
             where provider_id = ?
             order by priority desc, id asc`,
            )
            .all(provider.id) as RoleMappingRow[];
          const mappings = parseRoleMappings(mappingRows);
          const expectedResolution = mappings
            ? resolveOidcRole({ claims: identity.claims, mappings, providerId: provider.id })
            : undefined;
          if (!expectedResolution || expectedResolution.status !== "resolved") {
            return this.deny("role_mapping_denied", occurredAt, requestId, provider.id);
          }

          const displayClaims = normalizedDisplayClaims(identity.claims);
          const displayClaimsJson = JSON.stringify(displayClaims);
          const existing = this.database.sqlite
            .prepare(
              `select
              e.id as externalIdentityId,
              e.provider_id as identityProviderId,
              e.last_login_at as lastLoginAt,
              e.created_at as identityCreatedAt,
              e.updated_at as identityUpdatedAt,
              u.id as userId,
              u.role,
              u.role_source as roleSource,
              u.status,
              u.created_at as userCreatedAt,
              u.updated_at as userUpdatedAt
             from external_identities e
             left join users u on u.id = e.user_id
             where e.issuer = ? and e.subject = ?`,
            )
            .get(provider.issuer, identity.claims.subject) as ExistingIdentityRow | undefined;

          if (!existing) {
            if (provider.allowJitProvisioning !== 1) {
              return this.deny("jit_provisioning_disabled", occurredAt, requestId, provider.id);
            }
            return this.provision({
              claims: identity.claims,
              displayClaimsJson,
              displayName: displayNameFallback(displayClaims),
              occurredAt,
              provider,
              ...(requestId ? { requestId } : {}),
              resolution: expectedResolution,
              sessionProof: {
                idTokenHint: identity.idTokenHint,
                ...(identity.sessionId ? { oidcSessionId: identity.sessionId } : {}),
              },
            });
          }

          if (existing.identityProviderId !== provider.id) {
            return this.deny("identity_provider_mismatch", occurredAt, requestId, provider.id);
          }
          if (
            !existing.userId ||
            !validIdentifier(existing.externalIdentityId) ||
            !validIdentifier(existing.identityProviderId) ||
            !validIdentifier(existing.userId) ||
            !validDatabaseRole(existing.role) ||
            !validDatabaseRoleSource(existing.roleSource) ||
            !validDatabaseStatus(existing.status) ||
            !validTimestamp(existing.identityCreatedAt, occurredAt) ||
            !validTimestamp(existing.identityUpdatedAt, occurredAt) ||
            !validTimestamp(existing.lastLoginAt, occurredAt) ||
            !validTimestamp(existing.userCreatedAt, occurredAt) ||
            !validTimestamp(existing.userUpdatedAt, occurredAt) ||
            existing.identityCreatedAt > existing.identityUpdatedAt ||
            existing.identityCreatedAt > existing.lastLoginAt ||
            existing.userCreatedAt > existing.userUpdatedAt
          ) {
            return this.deny("identity_integrity_failure", occurredAt, requestId, provider.id);
          }
          if (existing.status === "disabled") {
            return this.deny(
              "disabled_user",
              occurredAt,
              requestId,
              existing.externalIdentityId,
              existing.userId,
              "external_identity",
            );
          }
          const serviceIdentityLinkId =
            existing.status === "active"
              ? this.loadActiveServiceLink(existing.userId, occurredAt)
              : undefined;
          if (existing.status === "active" && serviceIdentityLinkId === undefined) {
            return this.deny(
              "active_service_link_required",
              occurredAt,
              requestId,
              existing.externalIdentityId,
              existing.userId,
              "external_identity",
            );
          }
          return this.loginExisting({
            claims: identity.claims,
            displayClaimsJson,
            existing: {
              ...existing,
              role: existing.role,
              roleSource: existing.roleSource,
              status: existing.status,
              userId: existing.userId,
            },
            occurredAt,
            provider,
            ...(requestId ? { requestId } : {}),
            resolution: expectedResolution,
            ...(serviceIdentityLinkId ? { serviceIdentityLinkId } : {}),
            sessionProof: {
              idTokenHint: identity.idTokenHint,
              ...(identity.sessionId ? { oidcSessionId: identity.sessionId } : {}),
            },
          });
        })
        .immediate();
    } catch (error) {
      if (error instanceof OidcIdentityServiceError) throw error;
      throw new OidcIdentityServiceError({ cause: error });
    }
  }

  private loadActiveServiceLink(userId: string, occurredAt: number) {
    const links = this.database.sqlite
      .prepare(
        `select
          l.id,
          l.user_id as linkUserId,
          l.service,
          l.connector_id as linkConnectorId,
          l.external_user_id as externalUserId,
          l.external_username as externalUsername,
          l.external_display_name as externalDisplayName,
          l.encrypted_access_token as encryptedAccessToken,
          l.token_created_at as tokenCreatedAt,
          l.health_state as healthState,
          l.last_verified_at as lastVerifiedAt,
          l.revoked_at as revokedAt,
          l.created_at as createdAt,
          c.id as connectorId,
          c.type as connectorType,
          c.enabled as connectorEnabled
         from service_identity_links l
         left join connector_configs c on c.id = l.connector_id and c.type = l.service
         where l.user_id = ? and l.service = 'jellyfin'`,
      )
      .all(userId) as ExistingServiceLinkRow[];
    if (links.length !== 1) return undefined;
    const link = links[0];
    if (
      !link ||
      !validIdentifier(link.id) ||
      !validIdentifier(link.linkUserId) ||
      link.linkUserId !== userId ||
      link.service !== "jellyfin" ||
      !validIdentifier(link.linkConnectorId) ||
      !validIdentifier(link.connectorId) ||
      link.linkConnectorId !== link.connectorId ||
      link.connectorType !== "jellyfin" ||
      link.connectorEnabled !== 1 ||
      (link.healthState !== "linked" && link.healthState !== "unavailable") ||
      link.revokedAt !== null ||
      !validBoundedText(link.externalUserId, 256) ||
      !validBoundedText(link.externalUsername, MAX_PREFERRED_USERNAME_LENGTH) ||
      !validBoundedText(link.externalDisplayName, MAX_DISPLAY_NAME_LENGTH) ||
      typeof link.encryptedAccessToken !== "string" ||
      link.encryptedAccessToken.length < 1 ||
      link.encryptedAccessToken.length > 32_768 ||
      !validTimestamp(link.createdAt, occurredAt) ||
      !validTimestamp(link.tokenCreatedAt, occurredAt) ||
      link.createdAt > link.tokenCreatedAt ||
      (link.lastVerifiedAt !== null &&
        (!validTimestamp(link.lastVerifiedAt, occurredAt) || link.createdAt > link.lastVerifiedAt))
    ) {
      return undefined;
    }
    return link.id;
  }

  private currentTime() {
    const now = this.clock();
    const time = now.getTime();
    if (!Number.isSafeInteger(time) || time < 0) {
      throw new TypeError("OIDC identity resolution requires a valid time.");
    }
    return time;
  }

  private nextId() {
    const identifier = this.createId();
    if (!validIdentifier(identifier)) {
      throw new OidcIdentityServiceError();
    }
    return identifier;
  }

  private insertAudit(event: AuditEvent) {
    this.database.sqlite
      .prepare(
        `insert into audit_events (
          id,
          actor_user_id,
          event_type,
          outcome,
          target_type,
          target_id,
          request_id,
          metadata_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.nextId(),
        event.actorUserId ?? null,
        event.eventType,
        event.outcome,
        event.targetType,
        event.targetId ?? null,
        event.requestId ?? null,
        JSON.stringify(event.metadata),
        event.occurredAt,
      );
  }

  private deny(
    reason: OidcIdentityDenialReason,
    occurredAt: number,
    requestId?: string,
    targetId?: string,
    actorUserId?: string,
    targetType: AuditEvent["targetType"] = "oidc_provider",
  ): OidcIdentityResolution {
    this.insertAudit({
      ...(actorUserId ? { actorUserId } : {}),
      eventType: "auth.oidc.identity.denied",
      metadata: { reason },
      occurredAt,
      outcome: "denied",
      ...(requestId ? { requestId } : {}),
      ...(targetId ? { targetId } : {}),
      targetType,
    });
    return Object.freeze({ reason, status: "denied" });
  }

  private provision(input: {
    claims: ValidatedOidcClaims;
    displayClaimsJson: string;
    displayName: string;
    occurredAt: number;
    provider: ProviderRow;
    requestId?: string;
    resolution: Extract<OidcRoleResolution, { status: "resolved" }>;
    sessionProof: {
      idTokenHint: string;
      oidcSessionId?: string;
    };
  }): ResolvedOidcIdentity {
    const userId = this.nextId();
    const externalIdentityId = this.nextId();
    const mapped = resolvedMappingRole(input.resolution);
    this.database.sqlite
      .prepare(
        `insert into users (
          id, display_name, role, role_source, status, created_at, updated_at
        ) values (?, ?, ?, ?, 'pending_link', ?, ?)`,
      )
      .run(
        userId,
        input.displayName,
        mapped.role,
        mapped.roleSource,
        input.occurredAt,
        input.occurredAt,
      );
    this.database.sqlite
      .prepare(
        `insert into external_identities (
          id,
          user_id,
          provider_id,
          issuer,
          subject,
          display_claims_json,
          last_login_at,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        externalIdentityId,
        userId,
        input.provider.id,
        input.provider.issuer,
        input.claims.subject,
        input.displayClaimsJson,
        input.occurredAt,
        input.occurredAt,
        input.occurredAt,
      );
    this.insertAudit({
      actorUserId: userId,
      eventType: "auth.oidc.identity.jit_provisioned",
      metadata: { role: mapped.role, roleSource: mapped.roleSource },
      occurredAt: input.occurredAt,
      outcome: "success",
      ...(input.requestId ? { requestId: input.requestId } : {}),
      targetId: externalIdentityId,
      targetType: "external_identity",
    });
    this.insertAudit({
      actorUserId: userId,
      eventType: "auth.oidc.identity.login",
      metadata: { accountStatus: "pending_link", provisioned: true },
      occurredAt: input.occurredAt,
      outcome: "success",
      ...(input.requestId ? { requestId: input.requestId } : {}),
      targetId: externalIdentityId,
      targetType: "external_identity",
    });
    return this.resolvedResult({
      accountStatus: "pending_link",
      externalIdentityId,
      providerId: input.provider.id,
      provisioned: true,
      role: mapped.role,
      roleChanged: false,
      roleSource: mapped.roleSource,
      sessionProof: input.sessionProof,
      userId,
    });
  }

  private loginExisting(input: {
    claims: ValidatedOidcClaims;
    displayClaimsJson: string;
    existing: ExistingIdentityRow & {
      role: Role;
      roleSource: RoleSource;
      status: AccountStatus;
      userId: string;
    };
    occurredAt: number;
    provider: ProviderRow;
    requestId?: string;
    resolution: Extract<OidcRoleResolution, { status: "resolved" }>;
    serviceIdentityLinkId?: string;
    sessionProof: {
      idTokenHint: string;
      oidcSessionId?: string;
    };
  }): ResolvedOidcIdentity {
    const currentRole = input.existing.role;
    const currentRoleSource = input.existing.roleSource;
    const mapped = resolvedMappingRole(input.resolution);
    const mayRecomputeRole =
      currentRoleSource === "default" || currentRoleSource === "oidc_mapping";
    const roleChanged =
      mayRecomputeRole && (currentRole !== mapped.role || currentRoleSource !== mapped.roleSource);

    if (roleChanged) {
      const update = this.database.sqlite
        .prepare(
          `update users
           set role = ?, role_source = ?, updated_at = ?
           where id = ? and role = ? and role_source = ? and status <> 'disabled'`,
        )
        .run(
          mapped.role,
          mapped.roleSource,
          input.occurredAt,
          input.existing.userId,
          currentRole,
          currentRoleSource,
        );
      if (update.changes !== 1) throw new OidcIdentityServiceError();
      const revoked = this.database.sqlite
        .prepare(
          `update sessions
           set revoked_at = max(?, created_at)
           where user_id = ? and revoked_at is null`,
        )
        .run(input.occurredAt, input.existing.userId);
      this.insertAudit({
        actorUserId: input.existing.userId,
        eventType: "auth.oidc.role.changed",
        metadata: {
          currentRole,
          currentRoleSource,
          newRole: mapped.role,
          newRoleSource: mapped.roleSource,
          revokedSessionCount: revoked.changes,
        },
        occurredAt: input.occurredAt,
        outcome: "success",
        ...(input.requestId ? { requestId: input.requestId } : {}),
        targetId: input.existing.userId,
        targetType: "user",
      });
    }

    const identityUpdate = this.database.sqlite
      .prepare(
        `update external_identities
         set display_claims_json = ?, last_login_at = ?, updated_at = ?
         where id = ?
           and user_id = ?
           and provider_id = ?
           and issuer = ?
           and subject = ?`,
      )
      .run(
        input.displayClaimsJson,
        input.occurredAt,
        input.occurredAt,
        input.existing.externalIdentityId,
        input.existing.userId,
        input.provider.id,
        input.provider.issuer,
        input.claims.subject,
      );
    if (identityUpdate.changes !== 1) throw new OidcIdentityServiceError();

    const effectiveRole = roleChanged ? mapped.role : currentRole;
    const effectiveRoleSource = roleChanged ? mapped.roleSource : currentRoleSource;
    this.insertAudit({
      actorUserId: input.existing.userId,
      eventType: "auth.oidc.identity.login",
      metadata: { accountStatus: input.existing.status, provisioned: false },
      occurredAt: input.occurredAt,
      outcome: "success",
      ...(input.requestId ? { requestId: input.requestId } : {}),
      targetId: input.existing.externalIdentityId,
      targetType: "external_identity",
    });
    return this.resolvedResult({
      accountStatus: input.existing.status,
      externalIdentityId: input.existing.externalIdentityId,
      providerId: input.provider.id,
      provisioned: false,
      role: effectiveRole,
      roleChanged,
      roleSource: effectiveRoleSource,
      ...(input.serviceIdentityLinkId
        ? { serviceIdentityLinkId: input.serviceIdentityLinkId }
        : {}),
      sessionProof: input.sessionProof,
      userId: input.existing.userId,
    });
  }

  private resolvedResult(input: {
    accountStatus: AccountStatus;
    externalIdentityId: string;
    providerId: string;
    provisioned: boolean;
    role: Role;
    roleChanged: boolean;
    roleSource: RoleSource;
    serviceIdentityLinkId?: string;
    sessionProof: {
      idTokenHint: string;
      oidcSessionId?: string;
    };
    userId: string;
  }): ResolvedOidcIdentity {
    const attribution = Object.create(null) as OidcSessionAttribution;
    const visibleAttribution: Readonly<Record<string, string>> = {
      authMethod: "oidc",
      externalIdentityId: input.externalIdentityId,
      oidcProviderId: input.providerId,
      ...(input.serviceIdentityLinkId
        ? { serviceIdentityLinkId: input.serviceIdentityLinkId }
        : {}),
      userId: input.userId,
    };
    for (const [name, value] of Object.entries(visibleAttribution)) {
      Object.defineProperty(attribution, name, {
        configurable: false,
        enumerable: true,
        value,
        writable: false,
      });
    }
    Object.defineProperty(attribution, "idTokenHint", {
      configurable: false,
      enumerable: false,
      value: input.sessionProof.idTokenHint,
      writable: false,
    });
    if (input.sessionProof.oidcSessionId !== undefined) {
      Object.defineProperty(attribution, "oidcSessionId", {
        configurable: false,
        enumerable: false,
        value: input.sessionProof.oidcSessionId,
        writable: false,
      });
    }
    Object.defineProperty(attribution, "toJSON", {
      configurable: false,
      enumerable: false,
      value: () => {
        throw new TypeError("OIDC session attribution cannot be serialized.");
      },
      writable: false,
    });
    Object.freeze(attribution);

    const result = Object.create(null) as ResolvedOidcIdentity;
    const visibleResult: Readonly<Record<string, unknown>> = {
      accountStatus: input.accountStatus,
      attribution,
      provisioned: input.provisioned,
      role: input.role,
      roleChanged: input.roleChanged,
      roleSource: input.roleSource,
      status: "resolved",
    };
    for (const [name, value] of Object.entries(visibleResult)) {
      Object.defineProperty(result, name, {
        configurable: false,
        enumerable: true,
        value,
        writable: false,
      });
    }
    Object.defineProperty(result, "toJSON", {
      configurable: false,
      enumerable: false,
      value: () => {
        throw new TypeError("Resolved OIDC identities cannot be serialized.");
      },
      writable: false,
    });
    return Object.freeze(result);
  }
}
