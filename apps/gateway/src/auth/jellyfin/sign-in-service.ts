import {
  JellyfinAuthenticationClient,
  type JellyfinAuthenticationResult,
  type JellyfinPublicSystemInfo,
} from "@omnifin/connectors/auth/jellyfin-authentication-client";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../../config.js";
import type { DatabaseHandle } from "../../db/client.js";
import { EnvelopeCipher } from "../../security/crypto.js";
import {
  SessionIssuanceLimitError,
  type CreateSessionInput,
  type IssuedSession,
  type SessionService,
} from "../session-service.js";
import {
  JellyfinConnectorConfigurationError,
  JellyfinConnectorRegistry,
  type JellyfinConnectorTarget,
} from "./connector-registry.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const DISPLAY_WHITESPACE = /\s+/gu;

interface ExistingLinkRow {
  connectorId: string;
  createdAt: number;
  externalServerId: string;
  externalUserId: string;
  healthState: string;
  id: string;
  linkUserId: string;
  revision: number;
  service: string;
  userId: string | null;
  userRole: string | null;
  userRoleSource: string | null;
  userStatus: string | null;
}

export interface JellyfinPasswordSignInInput {
  readonly currentSessionToken?: unknown;
  readonly ipAddress?: string;
  readonly password: string;
  readonly requestId?: string;
  readonly userAgent?: string;
  readonly username: string;
}

export interface JellyfinAuthenticatedSignInInput {
  readonly authentication: JellyfinAuthenticationResult;
  readonly currentSessionToken?: unknown;
  readonly deviceId: string;
  readonly ipAddress?: string;
  readonly proof: "password" | "quick_connect";
  readonly requestId?: string;
  readonly target: JellyfinConnectorTarget;
  readonly userAgent?: string;
}

export type JellyfinSignInDenialReason = "account_disabled" | "invalid_credentials";

export interface JellyfinSignInDeniedResult {
  readonly reason: JellyfinSignInDenialReason;
  readonly status: "denied";
  toJSON(): never;
}

export interface JellyfinSignInSuccessResult {
  readonly session: IssuedSession;
  readonly status: "signed_in";
  toJSON(): never;
}

export type JellyfinSignInResult = JellyfinSignInDeniedResult | JellyfinSignInSuccessResult;

export interface JellyfinSignInServiceDependencies {
  readonly clock?: () => Date;
  readonly createClient?: (
    target: JellyfinConnectorTarget,
  ) => Pick<JellyfinAuthenticationClient, "authenticateByName" | "getPublicSystemInfo">;
  readonly createDeviceId?: () => string;
  readonly createId?: () => string;
}

export class JellyfinSignInServiceError extends Error {
  public readonly code = "jellyfin_sign_in_failed";
  public readonly reason: "configuration_invalid" | "provider_unavailable" | "server_mismatch";

  public constructor(reason: JellyfinSignInServiceError["reason"], options?: ErrorOptions) {
    super("Jellyfin sign-in could not be completed.", options);
    this.name = "JellyfinSignInServiceError";
    this.reason = reason;
  }
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
      throw new TypeError("Jellyfin sign-in results cannot be serialized.");
    },
    writable: false,
  });
  return Object.freeze(result);
}

function normalizedDisplayText(value: string, maximumLength: number) {
  const normalized = value
    .normalize("NFC")
    .replace(CONTROL_CHARACTERS, "")
    .replace(DISPLAY_WHITESPACE, " ")
    .trim();
  if (normalized.length < 1 || normalized.length > maximumLength) {
    throw new JellyfinSignInServiceError("provider_unavailable");
  }
  return normalized;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validTimestamp(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function accessTokenContext(linkId: string) {
  return `service_identity_access_token:jellyfin:${linkId}`;
}

export class JellyfinSignInService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #createClient: NonNullable<JellyfinSignInServiceDependencies["createClient"]>;
  readonly #createDeviceId: () => string;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;
  readonly #registry: JellyfinConnectorRegistry;
  readonly #sessionService: SessionService;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey">,
    sessionService: SessionService,
    dependencies: JellyfinSignInServiceDependencies = {},
  ) {
    if (!sessionService.isBoundToDatabase(database)) {
      throw new JellyfinSignInServiceError("configuration_invalid");
    }
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createClient =
      dependencies.createClient ??
      ((target) =>
        new JellyfinAuthenticationClient({
          baseUrl: target.baseUrl,
          connectorId: target.connectorId,
          displayName: target.displayName,
          insecureHttpApproved: target.insecureHttpApproved,
        }));
    this.#createDeviceId = dependencies.createDeviceId ?? randomUUID;
    this.#createId = dependencies.createId ?? randomUUID;
    this.#database = database;
    this.#registry = new JellyfinConnectorRegistry(database);
    this.#sessionService = sessionService;
  }

  public toJSON(): never {
    throw new TypeError("Jellyfin sign-in services cannot be serialized.");
  }

  public async signInWithPassword(
    input: JellyfinPasswordSignInInput,
  ): Promise<JellyfinSignInResult> {
    this.#validatePasswordInput(input);
    let target: JellyfinConnectorTarget;
    try {
      target = this.#registry.resolve();
    } catch (error) {
      if (error instanceof JellyfinConnectorConfigurationError) {
        throw new JellyfinSignInServiceError("configuration_invalid", { cause: error });
      }
      throw error;
    }
    const deviceId = this.#nextIdentifier(this.#createDeviceId());
    const client = this.#createClient(target);
    let publicInfo: JellyfinPublicSystemInfo;
    let authentication: JellyfinAuthenticationResult;
    try {
      publicInfo = await client.getPublicSystemInfo();
      authentication = await client.authenticateByName({
        deviceId,
        password: input.password,
        username: input.username,
      });
    } catch (error) {
      if (error instanceof SafeConnectorError && error.code === "invalid_credentials") {
        return internalResult({
          reason: "invalid_credentials" as const,
          status: "denied" as const,
        });
      }
      if (error instanceof JellyfinSignInServiceError) throw error;
      throw new JellyfinSignInServiceError("provider_unavailable", { cause: error });
    }
    if (publicInfo.Id !== authentication.ServerId) {
      throw new JellyfinSignInServiceError("server_mismatch");
    }

    return this.#reconcileAndIssueSession({
      authentication,
      deviceId,
      requestContext: input,
      proof: "password",
      target,
    });
  }

  public completeAuthenticatedSignIn(
    input: JellyfinAuthenticatedSignInInput,
  ): JellyfinSignInResult {
    this.#validateAuthenticatedSignInInput(input);
    return this.#reconcileAndIssueSession({
      authentication: input.authentication,
      deviceId: input.deviceId,
      proof: input.proof,
      requestContext: input,
      target: input.target,
    });
  }

  #reconcileAndIssueSession(input: {
    authentication: JellyfinAuthenticationResult;
    deviceId: string;
    proof: "password" | "quick_connect";
    requestContext: Pick<
      JellyfinPasswordSignInInput,
      "currentSessionToken" | "ipAddress" | "requestId" | "userAgent"
    >;
    target: JellyfinConnectorTarget;
  }): JellyfinSignInResult {
    try {
      return this.#database.sqlite
        .transaction(() =>
          this.#sessionService.withSessionReplacementCapability(
            input.requestContext.currentSessionToken,
            (capability) => {
              const replacement = capability
                ? this.#sessionService.verifyReplacementCapabilityForIdentity(capability)
                : undefined;
              const occurredAt = replacement?.operationTime ?? this.#currentTime();
              const identity = this.#reconcileIdentity({ ...input, occurredAt });
              if (capability) {
                this.#sessionService.completeReplacementIdentityResolution(
                  capability,
                  identity.status,
                );
              }
              if (identity.status === "denied") return identity;

              const sessionInput: CreateSessionInput = {
                attribution: {
                  authMethod: "jellyfin",
                  serviceIdentityLinkId: identity.linkId,
                  userId: identity.userId,
                },
                ...(input.requestContext.ipAddress === undefined
                  ? {}
                  : { ipAddress: input.requestContext.ipAddress }),
                ...(input.requestContext.requestId === undefined
                  ? {}
                  : { requestId: input.requestContext.requestId }),
                ...(input.requestContext.userAgent === undefined
                  ? {}
                  : { userAgent: input.requestContext.userAgent }),
              };
              const session = capability
                ? this.#sessionService.replaceSessionWithCapability(capability, sessionInput)
                : this.#sessionService.createSession(sessionInput);
              return internalResult({ session, status: "signed_in" as const });
            },
          ),
        )
        .immediate();
    } catch (error) {
      if (error instanceof SessionIssuanceLimitError) throw error;
      if (error instanceof JellyfinSignInServiceError) throw error;
      throw new JellyfinSignInServiceError("provider_unavailable", { cause: error });
    }
  }

  #reconcileIdentity(input: {
    authentication: JellyfinAuthenticationResult;
    deviceId: string;
    proof: "password" | "quick_connect";
    requestContext: Pick<JellyfinPasswordSignInInput, "requestId">;
    occurredAt: number;
    target: JellyfinConnectorTarget;
  }):
    | JellyfinSignInDeniedResult
    | { readonly linkId: string; readonly status: "resolved"; readonly userId: string } {
    if (!this.#database.sqlite.inTransaction || !this.#registry.bindingIsCurrent(input.target)) {
      throw new JellyfinSignInServiceError("configuration_invalid");
    }
    const externalUserId = normalizedDisplayText(input.authentication.User.Id, 256);
    const externalUsername = normalizedDisplayText(input.authentication.User.Name, 160);
    const externalDisplayName = externalUsername;
    const existing = this.#database.sqlite
      .prepare(
        `select
          l.id,
          l.user_id as linkUserId,
          l.service,
          l.connector_id as connectorId,
          l.external_server_id as externalServerId,
          l.external_user_id as externalUserId,
          l.health_state as healthState,
          l.revision,
          l.created_at as createdAt,
          u.id as userId,
          u.role as userRole,
          u.role_source as userRoleSource,
          u.status as userStatus
         from service_identity_links l
         left join users u on u.id = l.user_id
         where l.connector_id = ?
           and l.external_server_id = ?
           and l.external_user_id = ?`,
      )
      .get(
        input.target.connectorId,
        input.authentication.ServerId,
        input.authentication.User.Id,
      ) as ExistingLinkRow | undefined;

    if (existing) {
      if (!this.#existingLinkIsValid(existing, input, externalUserId)) {
        throw new JellyfinSignInServiceError("provider_unavailable");
      }
      if (existing.userStatus === "disabled") {
        this.#insertAudit({
          actorUserId: existing.userId!,
          eventType: "auth.jellyfin.sign_in",
          metadata: { reason: "account_disabled" },
          occurredAt: input.occurredAt,
          outcome: "denied",
          ...(input.requestContext.requestId === undefined
            ? {}
            : { requestId: input.requestContext.requestId }),
          targetId: existing.id,
          targetType: "service_identity_link",
        });
        return internalResult({ reason: "account_disabled" as const, status: "denied" as const });
      }
      const encryptedAccessToken = this.#cipher.encrypt(
        input.authentication.AccessToken,
        accessTokenContext(existing.id),
      );
      const linkUpdate = this.#database.sqlite
        .prepare(
          `update service_identity_links
           set
             external_username = ?,
             external_display_name = ?,
             encrypted_access_token = ?,
             device_id = ?,
             token_created_at = ?,
             health_state = 'linked',
             last_verified_at = ?,
             revoked_at = null,
             revision = revision + 1,
             updated_at = ?
           where id = ?
             and user_id = ?
             and revision = ?`,
        )
        .run(
          externalUsername,
          externalDisplayName,
          encryptedAccessToken,
          input.deviceId,
          input.occurredAt,
          input.occurredAt,
          input.occurredAt,
          existing.id,
          existing.userId,
          existing.revision,
        );
      if (linkUpdate.changes !== 1) throw new JellyfinSignInServiceError("provider_unavailable");
      const userUpdate = this.#database.sqlite
        .prepare(
          `update users
           set status = 'active', updated_at = ?
           where id = ? and status <> 'disabled'`,
        )
        .run(input.occurredAt, existing.userId);
      if (userUpdate.changes !== 1) throw new JellyfinSignInServiceError("provider_unavailable");
      this.#insertAudit({
        actorUserId: existing.userId!,
        eventType: "auth.jellyfin.sign_in",
        metadata: {
          proof: input.proof,
          provisioned: false,
          relinked: existing.healthState !== "linked",
        },
        occurredAt: input.occurredAt,
        outcome: "success",
        ...(input.requestContext.requestId === undefined
          ? {}
          : { requestId: input.requestContext.requestId }),
        targetId: existing.id,
        targetType: "service_identity_link",
      });
      return Object.freeze({
        linkId: existing.id,
        status: "resolved" as const,
        userId: existing.userId!,
      });
    }

    const userId = this.#nextIdentifier(this.#createId());
    const linkId = this.#nextIdentifier(this.#createId());
    const encryptedAccessToken = this.#cipher.encrypt(
      input.authentication.AccessToken,
      accessTokenContext(linkId),
    );
    this.#database.sqlite
      .prepare(
        `insert into users (
          id, display_name, role, role_source, status, created_at, updated_at
        ) values (?, ?, 'viewer', 'default', 'active', ?, ?)`,
      )
      .run(userId, externalDisplayName, input.occurredAt, input.occurredAt);
    this.#database.sqlite
      .prepare(
        `insert into service_identity_links (
          id,
          user_id,
          service,
          connector_id,
          external_server_id,
          external_user_id,
          external_username,
          external_display_name,
          encrypted_access_token,
          device_id,
          token_created_at,
          health_state,
          last_verified_at,
          revision,
          created_at,
          updated_at
        ) values (?, ?, 'jellyfin', ?, ?, ?, ?, ?, ?, ?, ?, 'linked', ?, 0, ?, ?)`,
      )
      .run(
        linkId,
        userId,
        input.target.connectorId,
        input.authentication.ServerId,
        input.authentication.User.Id,
        externalUsername,
        externalDisplayName,
        encryptedAccessToken,
        input.deviceId,
        input.occurredAt,
        input.occurredAt,
        input.occurredAt,
        input.occurredAt,
      );
    this.#insertAudit({
      actorUserId: userId,
      eventType: "auth.jellyfin.identity.linked",
      metadata: { proof: input.proof, provisioned: true },
      occurredAt: input.occurredAt,
      outcome: "success",
      ...(input.requestContext.requestId === undefined
        ? {}
        : { requestId: input.requestContext.requestId }),
      targetId: linkId,
      targetType: "service_identity_link",
    });
    this.#insertAudit({
      actorUserId: userId,
      eventType: "auth.jellyfin.sign_in",
      metadata: { proof: input.proof, provisioned: true, relinked: false },
      occurredAt: input.occurredAt,
      outcome: "success",
      ...(input.requestContext.requestId === undefined
        ? {}
        : { requestId: input.requestContext.requestId }),
      targetId: linkId,
      targetType: "service_identity_link",
    });
    return Object.freeze({ linkId, status: "resolved" as const, userId });
  }

  #existingLinkIsValid(
    row: ExistingLinkRow,
    input: {
      authentication: JellyfinAuthenticationResult;
      occurredAt: number;
      target: JellyfinConnectorTarget;
    },
    normalizedExternalUserId: string,
  ) {
    return (
      validIdentifier(row.id) &&
      validIdentifier(row.linkUserId) &&
      row.userId === row.linkUserId &&
      row.service === "jellyfin" &&
      row.connectorId === input.target.connectorId &&
      row.externalServerId === input.authentication.ServerId &&
      row.externalUserId === normalizedExternalUserId &&
      ["linked", "relink_required", "revoked", "unavailable"].includes(row.healthState) &&
      Number.isSafeInteger(row.revision) &&
      row.revision >= 0 &&
      row.revision < 2_147_483_647 &&
      validTimestamp(row.createdAt, input.occurredAt) &&
      ["viewer", "requester", "operator", "admin"].includes(row.userRole ?? "") &&
      ["default", "oidc_mapping", "manual", "recovery_bootstrap"].includes(
        row.userRoleSource ?? "",
      ) &&
      ["active", "pending_link", "disabled"].includes(row.userStatus ?? "")
    );
  }

  #insertAudit(event: {
    actorUserId: string;
    eventType: string;
    metadata: Readonly<Record<string, boolean | string>>;
    occurredAt: number;
    outcome: "denied" | "success";
    requestId?: string;
    targetId: string;
    targetType: string;
  }) {
    this.#database.sqlite
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
        this.#nextIdentifier(this.#createId()),
        event.actorUserId,
        event.eventType,
        event.outcome,
        event.targetType,
        event.targetId,
        event.requestId ?? null,
        JSON.stringify(event.metadata),
        event.occurredAt,
      );
  }

  #currentTime() {
    const time = this.#clock().getTime();
    if (!Number.isSafeInteger(time) || time < 0) {
      throw new JellyfinSignInServiceError("provider_unavailable");
    }
    return time;
  }

  #nextIdentifier(value: string) {
    if (!validIdentifier(value)) throw new JellyfinSignInServiceError("provider_unavailable");
    return value;
  }

  #validatePasswordInput(input: JellyfinPasswordSignInInput) {
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.username !== "string" ||
      input.username.length < 1 ||
      input.username.length > 160 ||
      input.username.trim() !== input.username ||
      input.username.search(CONTROL_CHARACTERS) !== -1 ||
      typeof input.password !== "string" ||
      input.password.length < 1 ||
      input.password.length > 1_024 ||
      (input.requestId !== undefined &&
        (typeof input.requestId !== "string" ||
          input.requestId.length < 1 ||
          input.requestId.length > 128))
    ) {
      throw new JellyfinSignInServiceError("provider_unavailable");
    }
  }

  #validateAuthenticatedSignInInput(input: JellyfinAuthenticatedSignInInput) {
    if (
      !input ||
      typeof input !== "object" ||
      !validIdentifier(input.deviceId) ||
      (input.proof !== "password" && input.proof !== "quick_connect") ||
      !input.authentication ||
      typeof input.authentication !== "object" ||
      !validIdentifier(input.target?.connectorId) ||
      (input.requestId !== undefined &&
        (typeof input.requestId !== "string" ||
          input.requestId.length < 1 ||
          input.requestId.length > 128))
    ) {
      throw new JellyfinSignInServiceError("provider_unavailable");
    }
  }
}
