import {
  OIDC_ROLE_MAPPINGS_MAX_COUNT,
  oidcRoleMappingCreateRequestSchema,
  oidcRoleMappingUpdateRequestSchema,
  roleMappingSchema,
  type OidcRoleMappingCreateRequest,
  type OidcRoleMappingUpdateRequest,
  type RoleMapping,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { and, asc, desc, eq } from "drizzle-orm";

import type { AppConfig } from "../../config.js";
import type { DatabaseHandle } from "../../db/client.js";
import { oidcProviders, roleMappings } from "../../db/schema.js";
import { privacyHash, randomToken } from "../../security/crypto.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type OidcRoleMappingAdminErrorReason =
  | "integrity_failure"
  | "mapping_conflict"
  | "mapping_limit_reached"
  | "mapping_not_found"
  | "provider_not_found"
  | "storage_failure";

export class OidcRoleMappingAdminError extends Error {
  public readonly reason: OidcRoleMappingAdminErrorReason;

  public constructor(reason: OidcRoleMappingAdminErrorReason, options?: ErrorOptions) {
    super("OIDC role mapping administration could not be completed.", options);
    this.name = "OidcRoleMappingAdminError";
    this.reason = reason;
  }
}

export interface OidcRoleMappingAdminDependencies {
  clock?: () => Date;
  createId?: () => string;
}

export interface OidcRoleMappingAdminContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface OidcRoleMappingMutationResult {
  mapping: RoleMapping;
  revokedSessions: number;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validOptionalText(value: string | undefined, maximumLength: number) {
  return value === undefined || (value.length >= 1 && value.length <= maximumLength);
}

function scalarKey(value: boolean | number | string): string {
  return `${typeof value}:${JSON.stringify(value)}`;
}

function canonicalValues(
  configuration: OidcRoleMappingCreateRequest,
): readonly (boolean | number | string)[] {
  return [...configuration.values].sort((left, right) => {
    const leftKey = scalarKey(left);
    const rightKey = scalarKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function safeAuditConfiguration(configuration: OidcRoleMappingCreateRequest) {
  return {
    enabled: configuration.enabled,
    operator: configuration.operator,
    priority: configuration.priority,
    role: configuration.role,
  };
}

function presentMapping(row: typeof roleMappings.$inferSelect): RoleMapping {
  let claimPath: unknown;
  let values: unknown;
  try {
    claimPath = JSON.parse(row.claimPathJson) as unknown;
    values = JSON.parse(row.valuesJson) as unknown;
  } catch {
    throw new OidcRoleMappingAdminError("integrity_failure");
  }
  const parsed = roleMappingSchema.safeParse({
    claimPath,
    enabled: row.enabled,
    id: row.id,
    operator: row.operator,
    priority: row.priority,
    providerId: row.providerId,
    role: row.role,
    values,
  });
  if (!parsed.success || parsed.data.id !== row.id || parsed.data.providerId !== row.providerId) {
    throw new OidcRoleMappingAdminError("integrity_failure");
  }
  return parsed.data;
}

export class OidcRoleMappingAdminService {
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: OidcRoleMappingAdminDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? (() => randomToken(16));
  }

  public list(providerId: string): RoleMapping[] {
    if (!validIdentifier(providerId)) throw new OidcRoleMappingAdminError("integrity_failure");
    try {
      if (!this.#providerExists(providerId)) {
        throw new OidcRoleMappingAdminError("provider_not_found");
      }
      const rows = this.#database.db
        .select()
        .from(roleMappings)
        .where(eq(roleMappings.providerId, providerId))
        .orderBy(desc(roleMappings.priority), asc(roleMappings.id))
        .limit(OIDC_ROLE_MAPPINGS_MAX_COUNT + 1)
        .all();
      if (rows.length > OIDC_ROLE_MAPPINGS_MAX_COUNT) {
        throw new OidcRoleMappingAdminError("integrity_failure");
      }
      return rows.map(presentMapping);
    } catch (error) {
      if (error instanceof OidcRoleMappingAdminError) throw error;
      throw new OidcRoleMappingAdminError("storage_failure", { cause: error });
    }
  }

  public create(
    providerId: string,
    input: OidcRoleMappingCreateRequest,
    context: OidcRoleMappingAdminContext,
  ): OidcRoleMappingMutationResult {
    const parsed = oidcRoleMappingCreateRequestSchema.safeParse(input);
    if (!validIdentifier(providerId) || !parsed.success || !this.#validContext(context)) {
      throw new OidcRoleMappingAdminError("integrity_failure");
    }
    let result: OidcRoleMappingMutationResult | undefined;
    try {
      this.#database.sqlite
        .transaction(() => {
          result = this.createInExistingTransaction(providerId, parsed.data, context);
        })
        .immediate();
    } catch (error) {
      if (error instanceof OidcRoleMappingAdminError) throw error;
      throw new OidcRoleMappingAdminError("storage_failure", { cause: error });
    }
    if (!result) throw new OidcRoleMappingAdminError("integrity_failure");
    return result;
  }

  public createInExistingTransaction(
    providerId: string,
    input: OidcRoleMappingCreateRequest,
    context: OidcRoleMappingAdminContext,
  ): OidcRoleMappingMutationResult {
    const parsed = oidcRoleMappingCreateRequestSchema.safeParse(input);
    if (
      !this.#database.sqlite.inTransaction ||
      !validIdentifier(providerId) ||
      !parsed.success ||
      !this.#validContext(context)
    ) {
      throw new OidcRoleMappingAdminError("integrity_failure");
    }
    const mappingId = this.#nextIdentifier("mapping");
    const auditId = this.#nextIdentifier("audit");
    const now = this.#currentTime();
    const configuration = parsed.data;
    const normalizedValues = canonicalValues(configuration);
    const claimPathJson = JSON.stringify(configuration.claimPath);
    const valuesJson = JSON.stringify(normalizedValues);

    if (!this.#providerExists(providerId)) {
      throw new OidcRoleMappingAdminError("provider_not_found");
    }
    const count = this.#database.sqlite
      .prepare("select count(*) as count from role_mappings where provider_id = ?")
      .get(providerId) as { count: number };
    if (!Number.isSafeInteger(count.count) || count.count < 0) {
      throw new OidcRoleMappingAdminError("integrity_failure");
    }
    if (count.count >= OIDC_ROLE_MAPPINGS_MAX_COUNT) {
      throw new OidcRoleMappingAdminError("mapping_limit_reached");
    }
    const conflict = this.#database.sqlite
      .prepare(
        `select id from role_mappings
         where provider_id = ?
           and claim_path_json = ?
           and operator = ?
           and values_json = ?
           and role = ?
           and priority = ?
           and enabled = ?
         limit 1`,
      )
      .get(
        providerId,
        claimPathJson,
        configuration.operator,
        valuesJson,
        configuration.role,
        configuration.priority,
        configuration.enabled ? 1 : 0,
      );
    if (conflict) throw new OidcRoleMappingAdminError("mapping_conflict");

    this.#database.db
      .insert(roleMappings)
      .values({
        claimPathJson,
        createdAt: now,
        enabled: configuration.enabled,
        id: mappingId,
        operator: configuration.operator,
        priority: configuration.priority,
        providerId,
        role: configuration.role,
        updatedAt: now,
        valuesJson,
      })
      .run();
    const revokedSessions = this.#revokeAffectedSessions(providerId, now);
    this.#insertAudit(
      auditId,
      "auth.oidc.role_mapping.created",
      mappingId,
      providerId,
      configuration,
      revokedSessions,
      context,
      now,
    );
    const row = this.#database.db
      .select()
      .from(roleMappings)
      .where(and(eq(roleMappings.id, mappingId), eq(roleMappings.providerId, providerId)))
      .get();
    if (!row) throw new OidcRoleMappingAdminError("integrity_failure");
    return { mapping: presentMapping(row), revokedSessions };
  }

  public update(
    providerId: string,
    mappingId: string,
    input: OidcRoleMappingUpdateRequest,
    context: OidcRoleMappingAdminContext,
  ): OidcRoleMappingMutationResult {
    const parsed = oidcRoleMappingUpdateRequestSchema.safeParse(input);
    if (
      !validIdentifier(providerId) ||
      !validIdentifier(mappingId) ||
      !parsed.success ||
      !this.#validContext(context)
    ) {
      throw new OidcRoleMappingAdminError("integrity_failure");
    }
    const auditId = this.#nextIdentifier("audit");
    const now = this.#currentTime();
    const configuration = parsed.data;
    const claimPathJson = JSON.stringify(configuration.claimPath);
    const valuesJson = JSON.stringify(canonicalValues(configuration));
    let revokedSessions = 0;

    try {
      this.#database.sqlite
        .transaction(() => {
          if (!this.#providerExists(providerId)) {
            throw new OidcRoleMappingAdminError("provider_not_found");
          }
          const row = this.#database.db
            .select()
            .from(roleMappings)
            .where(and(eq(roleMappings.id, mappingId), eq(roleMappings.providerId, providerId)))
            .get();
          if (!row) throw new OidcRoleMappingAdminError("mapping_not_found");
          const previous = presentMapping(row);
          const conflict = this.#database.sqlite
            .prepare(
              `select id from role_mappings
               where provider_id = ?
                 and claim_path_json = ?
                 and operator = ?
                 and values_json = ?
                 and role = ?
                 and priority = ?
                 and enabled = ?
               limit 1`,
            )
            .get(
              providerId,
              claimPathJson,
              configuration.operator,
              valuesJson,
              configuration.role,
              configuration.priority,
              configuration.enabled ? 1 : 0,
            );
          if (conflict) throw new OidcRoleMappingAdminError("mapping_conflict");

          const changes = this.#database.sqlite
            .prepare(
              `update role_mappings
               set claim_path_json = ?,
                   operator = ?,
                   values_json = ?,
                   role = ?,
                   priority = ?,
                   enabled = ?,
                   updated_at = ?
               where id = ? and provider_id = ?`,
            )
            .run(
              claimPathJson,
              configuration.operator,
              valuesJson,
              configuration.role,
              configuration.priority,
              configuration.enabled ? 1 : 0,
              now.getTime(),
              mappingId,
              providerId,
            ).changes;
          if (changes !== 1) throw new OidcRoleMappingAdminError("integrity_failure");
          revokedSessions = this.#revokeAffectedSessions(providerId, now);
          this.#insertAudit(
            auditId,
            "auth.oidc.role_mapping.updated",
            mappingId,
            providerId,
            configuration,
            revokedSessions,
            context,
            now,
            previous,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof OidcRoleMappingAdminError) throw error;
      throw new OidcRoleMappingAdminError("storage_failure", { cause: error });
    }

    return {
      mapping: this.#get(providerId, mappingId),
      revokedSessions,
    };
  }

  public delete(
    providerId: string,
    mappingId: string,
    context: OidcRoleMappingAdminContext,
  ): { deletedMappingId: string; revokedSessions: number } {
    if (
      !validIdentifier(providerId) ||
      !validIdentifier(mappingId) ||
      !this.#validContext(context)
    ) {
      throw new OidcRoleMappingAdminError("integrity_failure");
    }
    const auditId = this.#nextIdentifier("audit");
    const now = this.#currentTime();
    let revokedSessions = 0;

    try {
      this.#database.sqlite
        .transaction(() => {
          if (!this.#providerExists(providerId)) {
            throw new OidcRoleMappingAdminError("provider_not_found");
          }
          const row = this.#database.db
            .select()
            .from(roleMappings)
            .where(and(eq(roleMappings.id, mappingId), eq(roleMappings.providerId, providerId)))
            .get();
          if (!row) throw new OidcRoleMappingAdminError("mapping_not_found");
          const mapping = presentMapping(row);
          const changes = this.#database.db
            .delete(roleMappings)
            .where(and(eq(roleMappings.id, mappingId), eq(roleMappings.providerId, providerId)))
            .run().changes;
          if (changes !== 1) throw new OidcRoleMappingAdminError("integrity_failure");
          revokedSessions = this.#revokeAffectedSessions(providerId, now);
          this.#insertAudit(
            auditId,
            "auth.oidc.role_mapping.deleted",
            mappingId,
            providerId,
            mapping,
            revokedSessions,
            context,
            now,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof OidcRoleMappingAdminError) throw error;
      throw new OidcRoleMappingAdminError("storage_failure", { cause: error });
    }

    return { deletedMappingId: mappingId, revokedSessions };
  }

  #get(providerId: string, mappingId: string): RoleMapping {
    try {
      const row = this.#database.db
        .select()
        .from(roleMappings)
        .where(and(eq(roleMappings.id, mappingId), eq(roleMappings.providerId, providerId)))
        .get();
      if (!row) throw new OidcRoleMappingAdminError("integrity_failure");
      return presentMapping(row);
    } catch (error) {
      if (error instanceof OidcRoleMappingAdminError) throw error;
      throw new OidcRoleMappingAdminError("storage_failure", { cause: error });
    }
  }

  #providerExists(providerId: string): boolean {
    return (
      this.#database.db
        .select({ id: oidcProviders.id })
        .from(oidcProviders)
        .where(eq(oidcProviders.id, providerId))
        .get() !== undefined
    );
  }

  #revokeAffectedSessions(providerId: string, now: Date): number {
    const result = this.#database.sqlite
      .prepare(
        `update sessions
         set revoked_at = max(@now, created_at)
         where revoked_at is null
           and user_id in (
             select distinct users.id
             from users
             inner join external_identities
               on external_identities.user_id = users.id
             where external_identities.provider_id = @providerId
               and users.role_source in ('default', 'oidc_mapping')
           )`,
      )
      .run({ now: now.getTime(), providerId });
    if (!Number.isSafeInteger(result.changes) || result.changes < 0) {
      throw new OidcRoleMappingAdminError("integrity_failure");
    }
    return result.changes;
  }

  #insertAudit(
    auditId: string,
    eventType:
      | "auth.oidc.role_mapping.created"
      | "auth.oidc.role_mapping.deleted"
      | "auth.oidc.role_mapping.updated",
    mappingId: string,
    providerId: string,
    configuration: OidcRoleMappingCreateRequest,
    revokedSessions: number,
    context: OidcRoleMappingAdminContext,
    now: Date,
    previous?: OidcRoleMappingCreateRequest,
  ): void {
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
        ) values (?, ?, ?, ?, ?, ?, 'success', 'oidc_role_mapping', ?, ?, ?, ?, ?)`,
      )
      .run(
        auditId,
        context.principal.userId,
        context.principal.sessionId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        eventType,
        mappingId,
        context.requestId ?? null,
        JSON.stringify(
          eventType === "auth.oidc.role_mapping.updated" && previous
            ? {
                after: safeAuditConfiguration(configuration),
                before: safeAuditConfiguration(previous),
                providerId,
                revokedSessions,
              }
            : {
                ...safeAuditConfiguration(configuration),
                providerId,
                revokedSessions,
              },
        ),
        context.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        now.getTime(),
      );
  }

  #currentTime(): Date {
    let now: Date;
    try {
      now = this.#clock();
    } catch (error) {
      throw new OidcRoleMappingAdminError("integrity_failure", { cause: error });
    }
    const milliseconds = now.getTime();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new OidcRoleMappingAdminError("integrity_failure");
    }
    return new Date(milliseconds);
  }

  #nextIdentifier(namespace: "audit" | "mapping"): string {
    let entropy: string;
    try {
      entropy = this.#createId();
    } catch (error) {
      throw new OidcRoleMappingAdminError("integrity_failure", { cause: error });
    }
    const identifier = `${namespace}-${entropy}`;
    if (!validIdentifier(identifier)) {
      throw new OidcRoleMappingAdminError("integrity_failure");
    }
    return identifier;
  }

  #validContext(context: OidcRoleMappingAdminContext): boolean {
    const principal = context.principal;
    return (
      validIdentifier(principal.sessionId) &&
      (principal.userId === null || validIdentifier(principal.userId)) &&
      ["jellyfin", "oidc", "recovery"].includes(principal.authenticationMethod.kind) &&
      validOptionalText(context.ipAddress, 256) &&
      validOptionalText(context.requestId, 128)
    );
  }
}
