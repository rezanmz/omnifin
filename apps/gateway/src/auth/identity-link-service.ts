import {
  serviceIdentityLinkSchema,
  type ServiceIdentityLink,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { privacyHash } from "../security/crypto.js";
import type { SessionRequestContext, SessionService, ValidatedSession } from "./session-service.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface IdentityLinkRow {
  createdAt: number;
  externalDisplayName: string;
  externalUserId: string;
  externalUsername: string;
  healthState: "linked" | "relink_required" | "revoked" | "unavailable";
  id: string;
  lastVerifiedAt: number | null;
  revision: number;
  service: string;
  updatedAt: number;
  userId: string;
}

export interface IdentityLinkServiceDependencies {
  readonly clock?: () => Date;
  readonly createId?: () => string;
}

export interface RevokeIdentityLinkInput extends SessionRequestContext {
  readonly linkId: string;
  readonly validatedSession?: ValidatedSession | null;
}

export interface IdentityLinkRevocationResult {
  readonly link: ServiceIdentityLink;
  readonly principal: SessionPrincipal | null;
  readonly revokedSessionCount: number;
  toJSON(): never;
}

export class IdentityLinkServiceError extends Error {
  public readonly code = "identity_link_operation_failed";
  public readonly reason:
    "identity_link_not_found" | "integrity_failure" | "invalid_session" | "permission_denied";

  public constructor(reason: IdentityLinkServiceError["reason"], options?: ErrorOptions) {
    super("The identity-link operation could not be completed.", options);
    this.name = "IdentityLinkServiceError";
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
      throw new TypeError("Identity-link operation results cannot be serialized.");
    },
    writable: false,
  });
  return Object.freeze(result);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validTimestamp(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

export class IdentityLinkService {
  readonly #clock: () => Date;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;
  readonly #privacyKey: Buffer;
  readonly #sessions: SessionService;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey">,
    sessions: SessionService,
    dependencies: IdentityLinkServiceDependencies = {},
  ) {
    if (!sessions.isBoundToDatabase(database)) {
      throw new IdentityLinkServiceError("integrity_failure");
    }
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
    this.#database = database;
    this.#privacyKey = Buffer.from(config.encryptionKey);
    this.#sessions = sessions;
  }

  public toJSON(): never {
    throw new TypeError("Identity-link services cannot be serialized.");
  }

  public listForPrincipal(principal: SessionPrincipal): readonly ServiceIdentityLink[] {
    this.#requireSelfManagement(principal);
    const rows = this.#loadRows(principal.userId!);
    return Object.freeze(rows.map((row) => this.#publicLink(row)));
  }

  public revoke(input: RevokeIdentityLinkInput): IdentityLinkRevocationResult {
    if (!input || typeof input !== "object" || !validIdentifier(input.linkId)) {
      throw new IdentityLinkServiceError("identity_link_not_found");
    }
    try {
      return this.#database.sqlite
        .transaction(() => {
          const principal = this.#sessions.resolveValidatedSessionPrincipal(input.validatedSession);
          if (!principal) throw new IdentityLinkServiceError("invalid_session");
          this.#requireSelfManagement(principal);
          const now = this.#currentTime();
          const row = this.#loadOwnedRow(principal.userId!, input.linkId);
          if (!row) throw new IdentityLinkServiceError("identity_link_not_found");
          const publicLink = this.#publicLink(row, now);
          if (row.healthState === "revoked") {
            return internalResult({ link: publicLink, principal, revokedSessionCount: 0 });
          }
          if (row.revision >= 2_147_483_647) {
            throw new IdentityLinkServiceError("integrity_failure");
          }

          const linkUpdate = this.#database.sqlite
            .prepare(
              `update service_identity_links
               set
                 encrypted_access_token = null,
                 token_created_at = null,
                 health_state = 'revoked',
                 revoked_at = @now,
                 revision = revision + 1,
                 updated_at = @now
               where id = @linkId
                 and user_id = @userId
                 and revision = @revision
                 and health_state <> 'revoked'`,
            )
            .run({
              linkId: row.id,
              now,
              revision: row.revision,
              userId: principal.userId,
            });
          if (linkUpdate.changes !== 1) {
            throw new IdentityLinkServiceError("integrity_failure");
          }
          const userUpdate = this.#database.sqlite
            .prepare(
              `update users
               set status = 'pending_link', updated_at = @now
               where id = @userId and status in ('active', 'pending_link')`,
            )
            .run({ now, userId: principal.userId });
          if (userUpdate.changes !== 1) {
            throw new IdentityLinkServiceError("integrity_failure");
          }

          const sessionUpdates = this.#database.sqlite
            .prepare(
              `update sessions
               set
                 service_identity_link_id = case
                   when auth_method = 'oidc' then null
                   else service_identity_link_id
                 end,
                 revoked_at = case
                   when id = @actorSessionId and auth_method = 'oidc' then null
                   else max(@now, created_at)
                 end
               where user_id = @userId and revoked_at is null
               returning id, revoked_at as revokedAt`,
            )
            .all({
              actorSessionId: principal.sessionId,
              now,
              userId: principal.userId,
            }) as { id: string; revokedAt: number | null }[];
          if (!sessionUpdates.some(({ id }) => id === principal.sessionId)) {
            throw new IdentityLinkServiceError("invalid_session");
          }
          const revokedSessionCount = sessionUpdates.filter(
            ({ revokedAt }) => revokedAt !== null,
          ).length;
          const retainedPrincipal = this.#sessions.resolveValidatedSessionPrincipal(
            input.validatedSession,
          );
          if (principal.authenticationMethod.kind === "oidc") {
            if (
              !retainedPrincipal ||
              retainedPrincipal.accountState !== "pending_link" ||
              retainedPrincipal.userId !== principal.userId
            ) {
              throw new IdentityLinkServiceError("integrity_failure");
            }
          } else if (retainedPrincipal !== null) {
            throw new IdentityLinkServiceError("integrity_failure");
          }

          this.#insertAudit({
            authMethod: principal.authenticationMethod.kind,
            context: input,
            eventType: "auth.jellyfin.identity.revoked",
            metadata: {
              currentSessionRetained: retainedPrincipal !== null,
              revokedSessionCount,
            },
            occurredAt: now,
            sessionId: principal.sessionId,
            targetId: row.id,
            userId: principal.userId!,
          });
          return internalResult({
            link: this.#publicLink(
              { ...row, healthState: "revoked", revision: row.revision + 1, updatedAt: now },
              now,
            ),
            principal: retainedPrincipal,
            revokedSessionCount,
          });
        })
        .immediate();
    } catch (error) {
      if (error instanceof IdentityLinkServiceError) throw error;
      throw new IdentityLinkServiceError("integrity_failure", { cause: error });
    }
  }

  #currentTime() {
    const time = this.#clock().getTime();
    if (!Number.isSafeInteger(time) || time < 0) {
      throw new IdentityLinkServiceError("integrity_failure");
    }
    return time;
  }

  #loadOwnedRow(userId: string, linkId: string) {
    return this.#database.sqlite
      .prepare(
        `select
          id,
          user_id as userId,
          service,
          external_user_id as externalUserId,
          external_username as externalUsername,
          external_display_name as externalDisplayName,
          health_state as healthState,
          last_verified_at as lastVerifiedAt,
          revision,
          created_at as createdAt,
          updated_at as updatedAt
         from service_identity_links
         where id = ? and user_id = ? and service = 'jellyfin'`,
      )
      .get(linkId, userId) as IdentityLinkRow | undefined;
  }

  #loadRows(userId: string) {
    const rows = this.#database.sqlite
      .prepare(
        `select
          id,
          user_id as userId,
          service,
          external_user_id as externalUserId,
          external_username as externalUsername,
          external_display_name as externalDisplayName,
          health_state as healthState,
          last_verified_at as lastVerifiedAt,
          revision,
          created_at as createdAt,
          updated_at as updatedAt
         from service_identity_links
         where user_id = ? and service = 'jellyfin'
         order by created_at, id
         limit 2`,
      )
      .all(userId) as IdentityLinkRow[];
    if (rows.length > 1) throw new IdentityLinkServiceError("integrity_failure");
    return rows;
  }

  #publicLink(row: IdentityLinkRow, maximumTimestamp = this.#currentTime()) {
    if (
      !validIdentifier(row.id) ||
      !validIdentifier(row.userId) ||
      row.service !== "jellyfin" ||
      !["linked", "relink_required", "revoked", "unavailable"].includes(row.healthState) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      row.revision > 2_147_483_647 ||
      !validTimestamp(row.createdAt, maximumTimestamp) ||
      !validTimestamp(row.updatedAt, maximumTimestamp) ||
      row.createdAt > row.updatedAt ||
      (row.lastVerifiedAt !== null && !validTimestamp(row.lastVerifiedAt, maximumTimestamp))
    ) {
      throw new IdentityLinkServiceError("integrity_failure");
    }
    const parsed = serviceIdentityLinkSchema.safeParse({
      displayName: row.externalDisplayName,
      externalUserId: row.externalUserId,
      health: row.healthState,
      id: row.id,
      lastVerifiedAt:
        row.lastVerifiedAt === null ? null : new Date(row.lastVerifiedAt).toISOString(),
      linkedAt: new Date(row.createdAt).toISOString(),
      service: "jellyfin",
      username: row.externalUsername,
    });
    if (!parsed.success) throw new IdentityLinkServiceError("integrity_failure");
    return parsed.data;
  }

  #requireSelfManagement(principal: SessionPrincipal) {
    if (
      !principal ||
      !principal.userId ||
      !principal.permissions.includes("identities.self.manage")
    ) {
      throw new IdentityLinkServiceError("permission_denied");
    }
  }

  #insertAudit(input: {
    authMethod: "jellyfin" | "oidc" | "recovery";
    context: SessionRequestContext;
    eventType: string;
    metadata: Record<string, boolean | number>;
    occurredAt: number;
    sessionId: string;
    targetId: string;
    userId: string;
  }) {
    const id = this.#createId();
    if (!validIdentifier(id)) throw new IdentityLinkServiceError("integrity_failure");
    if (
      input.context.requestId !== undefined &&
      (input.context.requestId.length < 1 || input.context.requestId.length > 128)
    ) {
      throw new IdentityLinkServiceError("integrity_failure");
    }
    if (
      input.context.ipAddress !== undefined &&
      (input.context.ipAddress.length < 1 || input.context.ipAddress.length > 256)
    ) {
      throw new IdentityLinkServiceError("integrity_failure");
    }
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
          id,
          actor_user_id,
          session_id,
          actor_session_id,
          actor_auth_method,
          event_type,
          outcome,
          target_type,
          target_id,
          request_id,
          metadata_json,
          ip_hash,
          created_at
        ) values (?, ?, ?, ?, ?, ?, 'success', 'service_identity_link', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.sessionId,
        input.sessionId,
        input.authMethod,
        input.eventType,
        input.targetId,
        input.context.requestId ?? null,
        JSON.stringify(input.metadata),
        input.context.ipAddress
          ? privacyHash("ip_address", input.context.ipAddress, this.#privacyKey)
          : null,
        input.occurredAt,
      );
  }
}
