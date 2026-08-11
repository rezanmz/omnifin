import {
  AUTH_USERS_PAGE_MAX_COUNT,
  oidcRoleAssignmentRequestSchema,
  oidcRoleAssignmentResponseSchema,
  userAccessListQuerySchema,
  userAccessListResponseSchema,
  userAccessMutationRequestSchema,
  userAccessMutationResponseSchema,
  userAccessSummarySchema,
  type SessionPrincipal,
  type UserAccessListQuery,
  type UserAccessListResponse,
  type UserAccessMutationRequest,
  type UserAccessMutationResponse,
  type UserAccessSummary,
  type OidcRoleAssignmentResponse,
} from "@omnifin/contracts/auth";

import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { privacyHash, randomToken } from "../security/crypto.js";
import {
  OidcRoleMappingAdminError,
  OidcRoleMappingAdminService,
  type OidcRoleMappingAdminDependencies,
} from "./oidc/role-mapping-admin-service.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const USER_ROW_SELECT = `
  select
    u.id,
    u.display_name as displayName,
    u.role,
    u.role_source as roleSource,
    u.status,
    u.created_at as createdAt,
    u.updated_at as updatedAt,
    exists(
      select 1 from external_identities e where e.user_id = u.id
    ) as hasOidcIdentity,
    (
      select l.health_state
      from service_identity_links l
      where l.user_id = u.id and l.service = 'jellyfin'
      limit 1
    ) as jellyfinLinkHealth,
    (
      select count(*)
      from sessions s
      where s.user_id = u.id
        and s.revoked_at is null
        and s.expires_at > @now
        and s.absolute_expires_at > @now
    ) as activeSessions,
    (
      select max(s.last_seen_at) from sessions s where s.user_id = u.id
    ) as lastActiveAt
  from users u`;

type UserAccessAdminErrorReason =
  | "cursor_invalid"
  | "integrity_failure"
  | "last_active_admin"
  | "mapping_conflict"
  | "mapping_limit_reached"
  | "no_effect"
  | "oidc_identity_unavailable"
  | "oidc_role_assignment_unavailable"
  | "permission_denied"
  | "role_managed_by_provider"
  | "self_mutation"
  | "stale_revision"
  | "storage_failure"
  | "user_not_found";

export class UserAccessAdminError extends Error {
  public readonly reason: UserAccessAdminErrorReason;

  public constructor(reason: UserAccessAdminErrorReason, options?: ErrorOptions) {
    super("User access administration could not be completed.", options);
    this.name = "UserAccessAdminError";
    this.reason = reason;
  }
}

export interface UserAccessAdminDependencies {
  clock?: () => Date;
  createId?: () => string;
  oidcRoleMapping?: OidcRoleMappingAdminDependencies;
}

export interface UserAccessAdminContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

interface UserRow {
  activeSessions: number;
  createdAt: number;
  displayName: string;
  hasOidcIdentity: number;
  id: string;
  jellyfinLinkHealth: string | null;
  lastActiveAt: number | null;
  role: string;
  roleSource: string;
  status: string;
  updatedAt: number;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validOptionalText(value: string | undefined, maximumLength: number) {
  return value === undefined || (value.length >= 1 && value.length <= maximumLength);
}

function presentUser(row: UserRow): UserAccessSummary {
  if (
    !validIdentifier(row.id) ||
    !validTimestamp(row.createdAt) ||
    !validTimestamp(row.updatedAt) ||
    (row.lastActiveAt !== null && !validTimestamp(row.lastActiveAt)) ||
    !Number.isSafeInteger(row.activeSessions) ||
    row.activeSessions < 0 ||
    (row.hasOidcIdentity !== 0 && row.hasOidcIdentity !== 1)
  ) {
    throw new UserAccessAdminError("integrity_failure");
  }
  const authenticationMethods: Array<"jellyfin" | "oidc"> = [];
  if (row.hasOidcIdentity === 1) authenticationMethods.push("oidc");
  if (row.jellyfinLinkHealth !== null) authenticationMethods.push("jellyfin");
  const parsed = userAccessSummarySchema.safeParse({
    activeSessions: row.activeSessions,
    authenticationMethods,
    createdAt: new Date(row.createdAt).toISOString(),
    displayName: row.displayName,
    id: row.id,
    jellyfinLinkHealth: row.jellyfinLinkHealth,
    lastActiveAt: row.lastActiveAt === null ? null : new Date(row.lastActiveAt).toISOString(),
    role: row.role,
    roleSource: row.roleSource,
    status: row.status,
    updatedAt: new Date(row.updatedAt).toISOString(),
  });
  if (!parsed.success) throw new UserAccessAdminError("integrity_failure");
  return parsed.data;
}

export class UserAccessAdminService {
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;
  readonly #oidcRoleMappings: OidcRoleMappingAdminService;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: UserAccessAdminDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? (() => randomToken(16));
    this.#oidcRoleMappings = new OidcRoleMappingAdminService(
      database,
      config,
      dependencies.oidcRoleMapping,
    );
  }

  public list(input: UserAccessListQuery): UserAccessListResponse {
    const parsed = userAccessListQuerySchema.safeParse(input);
    if (!parsed.success) throw new UserAccessAdminError("cursor_invalid");
    const now = this.#currentTime().getTime();
    try {
      let cursorCreatedAt: number | null = null;
      if (parsed.data.cursor) {
        const cursor = this.#database.sqlite
          .prepare("select created_at as createdAt from users where id = ?")
          .get(parsed.data.cursor) as { createdAt: number } | undefined;
        if (!cursor || !validTimestamp(cursor.createdAt)) {
          throw new UserAccessAdminError("cursor_invalid");
        }
        cursorCreatedAt = cursor.createdAt;
      }
      const rows = this.#database.sqlite
        .prepare(
          `${USER_ROW_SELECT}
           where @cursor is null
              or u.created_at > @cursorCreatedAt
              or (u.created_at = @cursorCreatedAt and u.id > @cursor)
           order by u.created_at asc, u.id asc
           limit @limit`,
        )
        .all({
          cursor: parsed.data.cursor ?? null,
          cursorCreatedAt,
          limit: AUTH_USERS_PAGE_MAX_COUNT + 1,
          now,
        }) as UserRow[];
      const hasNextPage = rows.length > AUTH_USERS_PAGE_MAX_COUNT;
      const visibleRows = hasNextPage ? rows.slice(0, AUTH_USERS_PAGE_MAX_COUNT) : rows;
      const users = visibleRows.map(presentUser);
      const response = {
        nextCursor: hasNextPage ? (users.at(-1)?.id ?? null) : null,
        users,
      };
      const validated = userAccessListResponseSchema.safeParse(response);
      if (!validated.success) throw new UserAccessAdminError("integrity_failure");
      return validated.data;
    } catch (error) {
      if (error instanceof UserAccessAdminError) throw error;
      throw new UserAccessAdminError("storage_failure", { cause: error });
    }
  }

  public update(
    userId: string,
    input: UserAccessMutationRequest,
    context: UserAccessAdminContext,
  ): UserAccessMutationResponse {
    const parsed = userAccessMutationRequestSchema.safeParse(input);
    if (!validIdentifier(userId) || !parsed.success || !this.#validContext(context)) {
      throw new UserAccessAdminError("integrity_failure");
    }
    if (context.principal.userId === userId) {
      throw new UserAccessAdminError("self_mutation");
    }
    if (
      (parsed.data.role !== undefined && !context.principal.permissions.includes("roles.manage")) ||
      (parsed.data.enabled !== undefined &&
        !context.principal.permissions.includes("identities.manage"))
    ) {
      throw new UserAccessAdminError("permission_denied");
    }
    const expectedUpdatedAt = Date.parse(parsed.data.expectedUpdatedAt);
    if (!validTimestamp(expectedUpdatedAt)) {
      throw new UserAccessAdminError("integrity_failure");
    }
    let result: UserAccessMutationResponse | undefined;

    try {
      this.#database.sqlite
        .transaction(() => {
          const clockTime = this.#currentTime().getTime();
          const current = this.#readRow(userId, clockTime);
          if (!current) throw new UserAccessAdminError("user_not_found");
          if (current.updatedAt !== expectedUpdatedAt) {
            throw new UserAccessAdminError("stale_revision");
          }
          const roleChanged = parsed.data.role !== undefined && parsed.data.role !== current.role;
          if (roleChanged && current.hasOidcIdentity === 1) {
            throw new UserAccessAdminError("role_managed_by_provider");
          }
          const hasUsableJellyfinLink = ["linked", "unavailable"].includes(
            current.jellyfinLinkHealth ?? "",
          );
          const nextStatus =
            parsed.data.enabled === undefined
              ? current.status
              : parsed.data.enabled
                ? hasUsableJellyfinLink
                  ? "active"
                  : "pending_link"
                : "disabled";
          const nextRole = parsed.data.role ?? current.role;
          const statusChanged = nextStatus !== current.status;
          if (!roleChanged && !statusChanged) throw new UserAccessAdminError("no_effect");
          if (
            current.role === "admin" &&
            current.status === "active" &&
            (nextRole !== "admin" || nextStatus !== "active") &&
            !this.#anotherActiveAdminExists(userId)
          ) {
            throw new UserAccessAdminError("last_active_admin");
          }

          const operationTime = Math.max(clockTime, current.updatedAt + 1);
          if (!validTimestamp(operationTime)) {
            throw new UserAccessAdminError("integrity_failure");
          }
          const updated = this.#database.sqlite
            .prepare(
              `update users
               set role = ?, role_source = ?, status = ?, updated_at = ?
               where id = ? and updated_at = ?`,
            )
            .run(
              nextRole,
              roleChanged ? "manual" : current.roleSource,
              nextStatus,
              operationTime,
              userId,
              expectedUpdatedAt,
            );
          if (updated.changes !== 1) throw new UserAccessAdminError("stale_revision");
          const revoked = this.#database.sqlite
            .prepare(
              `update sessions
               set revoked_at = max(@now, created_at)
               where user_id = @userId and revoked_at is null`,
            )
            .run({ now: operationTime, userId });
          if (!Number.isSafeInteger(revoked.changes) || revoked.changes < 0) {
            throw new UserAccessAdminError("integrity_failure");
          }
          this.#insertAudit(
            userId,
            current,
            { role: nextRole, status: nextStatus },
            revoked.changes,
            context,
            operationTime,
          );
          const user = this.#readRow(userId, operationTime);
          if (!user) throw new UserAccessAdminError("integrity_failure");
          const validated = userAccessMutationResponseSchema.safeParse({
            revokedSessions: revoked.changes,
            user: presentUser(user),
          });
          if (!validated.success) throw new UserAccessAdminError("integrity_failure");
          result = validated.data;
        })
        .immediate();
    } catch (error) {
      if (error instanceof UserAccessAdminError) throw error;
      throw new UserAccessAdminError("storage_failure", { cause: error });
    }

    if (!result) throw new UserAccessAdminError("integrity_failure");
    return result;
  }

  public assignOidcRole(
    userId: string,
    input: unknown,
    context: UserAccessAdminContext,
  ): OidcRoleAssignmentResponse {
    const parsed = oidcRoleAssignmentRequestSchema.safeParse(input);
    if (!validIdentifier(userId) || !parsed.success || !this.#validContext(context)) {
      throw new UserAccessAdminError("integrity_failure");
    }
    const principal = context.principal;
    if (
      principal.authenticationMethod.kind === "recovery" ||
      principal.accountState !== "active" ||
      principal.role !== "admin" ||
      !principal.permissions.includes("roles.manage")
    ) {
      throw new UserAccessAdminError("permission_denied");
    }
    if (principal.userId === userId) throw new UserAccessAdminError("self_mutation");
    const expectedUpdatedAt = Date.parse(parsed.data.expectedUpdatedAt);
    if (!validTimestamp(expectedUpdatedAt)) {
      throw new UserAccessAdminError("integrity_failure");
    }

    let result: OidcRoleAssignmentResponse | undefined;
    try {
      this.#database.sqlite
        .transaction(() => {
          const current = this.#readRow(userId, this.#currentTime().getTime());
          if (!current) throw new UserAccessAdminError("user_not_found");
          if (current.updatedAt !== expectedUpdatedAt) {
            throw new UserAccessAdminError("stale_revision");
          }
          if (!(current.roleSource === "default" || current.roleSource === "oidc_mapping")) {
            throw new UserAccessAdminError("oidc_role_assignment_unavailable");
          }

          const identities = this.#database.sqlite
            .prepare(
              `select provider_id as providerId, subject
               from external_identities
               where user_id = ?
               limit 2`,
            )
            .all(userId) as Array<{ providerId: string; subject: string }>;
          const identity = identities[0];
          if (
            identities.length !== 1 ||
            !identity ||
            !validIdentifier(identity.providerId) ||
            typeof identity.subject !== "string" ||
            identity.subject.length < 1 ||
            identity.subject.length > 512
          ) {
            throw new UserAccessAdminError("oidc_identity_unavailable");
          }

          let mapping: ReturnType<OidcRoleMappingAdminService["createInExistingTransaction"]>;
          try {
            mapping = this.#oidcRoleMappings.createInExistingTransaction(
              identity.providerId,
              {
                claimPath: ["sub"],
                enabled: true,
                operator: "equals",
                priority: 0,
                role: parsed.data.role,
                values: [identity.subject],
              },
              context,
            );
          } catch (error) {
            if (error instanceof OidcRoleMappingAdminError) {
              if (error.reason === "mapping_conflict") {
                throw new UserAccessAdminError("mapping_conflict", { cause: error });
              }
              if (error.reason === "mapping_limit_reached") {
                throw new UserAccessAdminError("mapping_limit_reached", { cause: error });
              }
            }
            throw error;
          }
          result = oidcRoleAssignmentResponseSchema.parse({
            effectiveAfter: "next_oidc_sign_in",
            fallbackPrecedence: "lowest",
            mappingId: mapping.mapping.id,
            priority: 0,
            revokedSessions: mapping.revokedSessions,
            role: parsed.data.role,
          });
        })
        .immediate();
    } catch (error) {
      if (error instanceof UserAccessAdminError) throw error;
      throw new UserAccessAdminError("storage_failure", { cause: error });
    }
    if (!result) throw new UserAccessAdminError("integrity_failure");
    return result;
  }

  #anotherActiveAdminExists(userId: string): boolean {
    const row = this.#database.sqlite
      .prepare(
        `select exists(
           select 1 from users
           where id <> ? and role = 'admin' and status = 'active'
         ) as present`,
      )
      .get(userId) as { present: number };
    if (row.present !== 0 && row.present !== 1) {
      throw new UserAccessAdminError("integrity_failure");
    }
    return row.present === 1;
  }

  #readRow(userId: string, now: number): UserRow | undefined {
    return this.#database.sqlite
      .prepare(`${USER_ROW_SELECT} where u.id = @userId limit 1`)
      .get({ now, userId }) as UserRow | undefined;
  }

  #insertAudit(
    userId: string,
    previous: UserRow,
    next: { role: string; status: string },
    revokedSessions: number,
    context: UserAccessAdminContext,
    occurredAt: number,
  ) {
    const auditId = this.#nextIdentifier();
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
        ) values (?, ?, ?, ?, ?, 'auth.user.access_updated', 'success', 'user', ?, ?, ?, ?, ?)`,
      )
      .run(
        auditId,
        context.principal.userId,
        context.principal.sessionId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        userId,
        context.requestId ?? null,
        JSON.stringify({
          newRole: next.role,
          newStatus: next.status,
          previousRole: previous.role,
          previousStatus: previous.status,
          revokedSessions,
        }),
        context.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        occurredAt,
      );
  }

  #currentTime(): Date {
    let now: Date;
    try {
      now = this.#clock();
    } catch (error) {
      throw new UserAccessAdminError("integrity_failure", { cause: error });
    }
    if (!validTimestamp(now.getTime())) {
      throw new UserAccessAdminError("integrity_failure");
    }
    return new Date(now.getTime());
  }

  #nextIdentifier(): string {
    let entropy: string;
    try {
      entropy = this.#createId();
    } catch (error) {
      throw new UserAccessAdminError("integrity_failure", { cause: error });
    }
    const identifier = `audit-${entropy}`;
    if (!validIdentifier(identifier)) throw new UserAccessAdminError("integrity_failure");
    return identifier;
  }

  #validContext(context: UserAccessAdminContext): boolean {
    return (
      context.principal.userId !== null &&
      validIdentifier(context.principal.userId) &&
      validIdentifier(context.principal.sessionId) &&
      context.principal.authenticationMethod.kind !== "recovery" &&
      validOptionalText(context.ipAddress, 256) &&
      validOptionalText(context.requestId, 128)
    );
  }
}
