import {
  AUTH_PROVIDERS_MAX_COUNT,
  OIDC_ROLE_MAPPINGS_MAX_COUNT,
  oidcProviderAdminSchema,
  oidcProviderCreateRequestSchema,
  oidcProviderUpdateRequestSchema,
  type OidcProviderAdmin,
  type OidcProviderCreateRequest,
  type OidcProviderUpdateRequest,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { asc, eq } from "drizzle-orm";

import type { AppConfig } from "../../config.js";
import type { DatabaseHandle } from "../../db/client.js";
import { oidcProviders } from "../../db/schema.js";
import { EnvelopeCipher, privacyHash, randomToken } from "../../security/crypto.js";
import { oidcClientSecretEncryptionContext } from "./provider-registry.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VALIDATION_AUDIT_REASONS = new Set<OidcProviderValidationAuditReason>([
  "oidc_provider_changed",
  "oidc_provider_disabled",
  "oidc_provider_discovery_failed",
  "oidc_provider_misconfigured",
  "oidc_provider_not_found",
  "oidc_provider_storage_failed",
  "ready",
]);

export type OidcProviderAdminErrorReason =
  | "client_secret_required"
  | "integrity_failure"
  | "provider_conflict"
  | "provider_in_use"
  | "provider_limit_reached"
  | "provider_must_be_disabled"
  | "provider_not_found"
  | "storage_failure";

export type OidcProviderValidationAuditReason =
  | "oidc_provider_changed"
  | "oidc_provider_disabled"
  | "oidc_provider_discovery_failed"
  | "oidc_provider_misconfigured"
  | "oidc_provider_not_found"
  | "oidc_provider_storage_failed"
  | "ready";

export class OidcProviderAdminError extends Error {
  public readonly reason: OidcProviderAdminErrorReason;

  public constructor(reason: OidcProviderAdminErrorReason, options?: ErrorOptions) {
    super("OIDC provider administration could not be completed.", options);
    this.name = "OidcProviderAdminError";
    this.reason = reason;
  }
}

export interface OidcProviderAdminDependencies {
  clock?: () => Date;
  createId?: () => string;
}

export interface OidcProviderAdminContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface OidcProviderMutationResult {
  provider: OidcProviderAdmin;
  revokedSessions: number;
}

export interface OidcProviderDeletionResult {
  deletedProviderId: string;
  deletedRoleMappings: number;
  revokedSessions: number;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validOptionalText(value: string | undefined, maximumLength: number) {
  return value === undefined || (value.length >= 1 && value.length <= maximumLength);
}

function presentProvider(row: typeof oidcProviders.$inferSelect): OidcProviderAdmin {
  let approvedEndpointOrigins: unknown;
  try {
    approvedEndpointOrigins = JSON.parse(row.approvedEndpointOriginsJson) as unknown;
  } catch {
    throw new OidcProviderAdminError("integrity_failure");
  }
  const parsed = oidcProviderAdminSchema.safeParse({
    allowJitProvisioning: row.allowJitProvisioning,
    approvedEndpointOrigins,
    clientId: row.clientId,
    clientSecretConfigured: row.encryptedClientSecret !== null,
    createdAt: row.createdAt.toISOString(),
    discoveryCheckedAt: row.discoveryCheckedAt?.toISOString() ?? null,
    discoveryState: row.discoveryState,
    displayName: row.displayName,
    enabled: row.enabled,
    id: row.id,
    idTokenSigningAlg: row.idTokenSigningAlg,
    issuer: row.issuer,
    scopes: row.scopes.split(" "),
    slug: row.slug,
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.success) throw new OidcProviderAdminError("integrity_failure");
  return parsed.data;
}

export class OidcProviderAdminService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: OidcProviderAdminDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? (() => randomToken(16));
  }

  public list(): OidcProviderAdmin[] {
    try {
      const rows = this.#database.db
        .select()
        .from(oidcProviders)
        .orderBy(asc(oidcProviders.displayName), asc(oidcProviders.id))
        .limit(AUTH_PROVIDERS_MAX_COUNT + 1)
        .all();
      if (rows.length > AUTH_PROVIDERS_MAX_COUNT) {
        throw new OidcProviderAdminError("integrity_failure");
      }
      return rows.map(presentProvider);
    } catch (error) {
      if (error instanceof OidcProviderAdminError) throw error;
      throw new OidcProviderAdminError("storage_failure", { cause: error });
    }
  }

  public get(providerId: string): OidcProviderAdmin {
    if (!validIdentifier(providerId)) throw new OidcProviderAdminError("integrity_failure");
    try {
      const row = this.#database.db
        .select()
        .from(oidcProviders)
        .where(eq(oidcProviders.id, providerId))
        .get();
      if (!row) throw new OidcProviderAdminError("provider_not_found");
      return presentProvider(row);
    } catch (error) {
      if (error instanceof OidcProviderAdminError) throw error;
      throw new OidcProviderAdminError("storage_failure", { cause: error });
    }
  }

  public create(input: OidcProviderCreateRequest, context: OidcProviderAdminContext) {
    const parsedInput = oidcProviderCreateRequestSchema.safeParse(input);
    if (!parsedInput.success || !this.#validContext(context)) {
      throw new OidcProviderAdminError("integrity_failure");
    }
    const provider = parsedInput.data;
    const providerId = `oidc-${provider.slug}`;
    const auditId = this.#nextId();
    if (!validIdentifier(providerId) || !validIdentifier(auditId)) {
      throw new OidcProviderAdminError("integrity_failure");
    }
    const now = this.#currentTime();
    const encryptedClientSecret = provider.clientSecret
      ? this.#cipher.encrypt(provider.clientSecret, oidcClientSecretEncryptionContext(providerId))
      : null;
    const metadata = JSON.stringify({
      allowJitProvisioning: provider.allowJitProvisioning,
      enabled: provider.enabled,
      tokenEndpointAuthMethod: provider.tokenEndpointAuthMethod,
    });

    try {
      this.#database.sqlite
        .transaction(() => {
          const conflict = this.#database.sqlite
            .prepare("select id from oidc_providers where id = ? or slug = ? or issuer = ? limit 1")
            .get(providerId, provider.slug, provider.issuer);
          if (conflict) throw new OidcProviderAdminError("provider_conflict");
          const count = this.#database.sqlite
            .prepare("select count(*) as count from oidc_providers")
            .get() as { count: number };
          if (!Number.isSafeInteger(count.count) || count.count < 0) {
            throw new OidcProviderAdminError("integrity_failure");
          }
          if (count.count >= AUTH_PROVIDERS_MAX_COUNT) {
            throw new OidcProviderAdminError("provider_limit_reached");
          }

          this.#database.db
            .insert(oidcProviders)
            .values({
              allowJitProvisioning: provider.allowJitProvisioning,
              approvedEndpointOriginsJson: JSON.stringify(provider.approvedEndpointOrigins),
              clientId: provider.clientId,
              claimConfigJson: "{}",
              createdAt: now,
              discoveryCapabilitiesJson: "{}",
              discoveryCheckedAt: null,
              discoveryState: "unchecked",
              displayName: provider.displayName,
              enabled: provider.enabled,
              encryptedClientSecret,
              id: providerId,
              idTokenSigningAlg: provider.idTokenSigningAlg,
              issuer: provider.issuer,
              scopes: provider.scopes.join(" "),
              slug: provider.slug,
              tokenEndpointAuthMethod: provider.tokenEndpointAuthMethod,
              updatedAt: now,
            })
            .run();

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
              ) values (?, ?, ?, ?, ?, 'auth.oidc.provider.created', 'success',
                        'oidc_provider', ?, ?, ?, ?, ?)`,
            )
            .run(
              auditId,
              context.principal.userId,
              context.principal.sessionId,
              context.principal.sessionId,
              context.principal.authenticationMethod.kind,
              providerId,
              context.requestId ?? null,
              metadata,
              context.ipAddress
                ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
                : null,
              now.getTime(),
            );
        })
        .immediate();
    } catch (error) {
      if (error instanceof OidcProviderAdminError) throw error;
      throw new OidcProviderAdminError("storage_failure", { cause: error });
    }

    try {
      const row = this.#database.db
        .select()
        .from(oidcProviders)
        .where(eq(oidcProviders.id, providerId))
        .get();
      if (!row) throw new OidcProviderAdminError("integrity_failure");
      return presentProvider(row);
    } catch (error) {
      if (error instanceof OidcProviderAdminError) throw error;
      throw new OidcProviderAdminError("storage_failure", { cause: error });
    }
  }

  public update(
    providerId: string,
    input: OidcProviderUpdateRequest,
    context: OidcProviderAdminContext,
  ): OidcProviderMutationResult {
    const parsedInput = oidcProviderUpdateRequestSchema.safeParse(input);
    if (!validIdentifier(providerId) || !parsedInput.success || !this.#validContext(context)) {
      throw new OidcProviderAdminError("integrity_failure");
    }
    const auditId = this.#nextId();
    if (!validIdentifier(auditId)) throw new OidcProviderAdminError("integrity_failure");
    const now = this.#currentTime();
    const provider = parsedInput.data;
    let revokedSessions = 0;

    try {
      this.#database.sqlite
        .transaction(() => {
          const row = this.#database.db
            .select()
            .from(oidcProviders)
            .where(eq(oidcProviders.id, providerId))
            .get();
          if (!row) throw new OidcProviderAdminError("provider_not_found");
          const previous = presentProvider(row);

          const conflict = this.#database.sqlite
            .prepare(
              `select id from oidc_providers
               where id <> ? and (slug = ? or issuer = ?)
               limit 1`,
            )
            .get(providerId, provider.slug, provider.issuer);
          if (conflict) throw new OidcProviderAdminError("provider_conflict");

          if (provider.issuer !== previous.issuer) {
            const identity = this.#database.sqlite
              .prepare("select id from external_identities where provider_id = ? limit 1")
              .get(providerId);
            if (identity) throw new OidcProviderAdminError("provider_in_use");
          }

          let encryptedClientSecret: string | null;
          if (provider.tokenEndpointAuthMethod === "none") {
            encryptedClientSecret = null;
          } else if (provider.clientSecret !== undefined) {
            encryptedClientSecret = this.#cipher.encrypt(
              provider.clientSecret,
              oidcClientSecretEncryptionContext(providerId),
            );
          } else if (row.encryptedClientSecret !== null) {
            encryptedClientSecret = row.encryptedClientSecret;
          } else {
            throw new OidcProviderAdminError("client_secret_required");
          }

          const approvedEndpointOriginsJson = JSON.stringify(provider.approvedEndpointOrigins);
          const scopes = provider.scopes.join(" ");
          const changedFields: string[] = [];
          if (provider.allowJitProvisioning !== previous.allowJitProvisioning) {
            changedFields.push("allowJitProvisioning");
          }
          if (approvedEndpointOriginsJson !== row.approvedEndpointOriginsJson) {
            changedFields.push("approvedEndpointOrigins");
          }
          if (provider.clientId !== previous.clientId) changedFields.push("clientId");
          if (
            provider.clientSecret !== undefined ||
            encryptedClientSecret !== row.encryptedClientSecret
          ) {
            changedFields.push("clientSecret");
          }
          if (provider.displayName !== previous.displayName) changedFields.push("displayName");
          if (provider.enabled !== previous.enabled) changedFields.push("enabled");
          if (provider.idTokenSigningAlg !== previous.idTokenSigningAlg) {
            changedFields.push("idTokenSigningAlg");
          }
          if (provider.issuer !== previous.issuer) changedFields.push("issuer");
          if (scopes !== row.scopes) changedFields.push("scopes");
          if (provider.slug !== previous.slug) changedFields.push("slug");
          if (provider.tokenEndpointAuthMethod !== previous.tokenEndpointAuthMethod) {
            changedFields.push("tokenEndpointAuthMethod");
          }
          const runtimeReset = changedFields.some((field) =>
            [
              "approvedEndpointOrigins",
              "clientId",
              "clientSecret",
              "idTokenSigningAlg",
              "issuer",
              "scopes",
              "tokenEndpointAuthMethod",
            ].includes(field),
          );

          if (changedFields.length > 0) {
            const updateChanges = this.#database.db
              .update(oidcProviders)
              .set({
                allowJitProvisioning: provider.allowJitProvisioning,
                approvedEndpointOriginsJson,
                clientId: provider.clientId,
                discoveryCapabilitiesJson: runtimeReset ? "{}" : row.discoveryCapabilitiesJson,
                discoveryCheckedAt: runtimeReset ? null : row.discoveryCheckedAt,
                discoveryState: runtimeReset ? "unchecked" : row.discoveryState,
                displayName: provider.displayName,
                enabled: provider.enabled,
                encryptedClientSecret,
                idTokenSigningAlg: provider.idTokenSigningAlg,
                issuer: provider.issuer,
                scopes,
                slug: provider.slug,
                tokenEndpointAuthMethod: provider.tokenEndpointAuthMethod,
                updatedAt: now,
              })
              .where(eq(oidcProviders.id, providerId))
              .run().changes;
            if (updateChanges !== 1) {
              throw new OidcProviderAdminError("integrity_failure");
            }
            this.#database.sqlite
              .prepare("delete from auth_transactions where provider_id = ?")
              .run(providerId);
            revokedSessions = this.#revokeProviderSessions(providerId, now);
          }

          this.#insertSuccessAudit(
            auditId,
            "auth.oidc.provider.updated",
            providerId,
            {
              changedFields,
              runtimeReset,
              revokedSessions,
            },
            context,
            now,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof OidcProviderAdminError) throw error;
      throw new OidcProviderAdminError("storage_failure", { cause: error });
    }

    return { provider: this.get(providerId), revokedSessions };
  }

  public delete(providerId: string, context: OidcProviderAdminContext): OidcProviderDeletionResult {
    if (!validIdentifier(providerId) || !this.#validContext(context)) {
      throw new OidcProviderAdminError("integrity_failure");
    }
    const auditId = this.#nextId();
    if (!validIdentifier(auditId)) throw new OidcProviderAdminError("integrity_failure");
    const now = this.#currentTime();
    let deletedRoleMappings = 0;
    let revokedSessions = 0;

    try {
      this.#database.sqlite
        .transaction(() => {
          const row = this.#database.db
            .select()
            .from(oidcProviders)
            .where(eq(oidcProviders.id, providerId))
            .get();
          if (!row) throw new OidcProviderAdminError("provider_not_found");
          if (row.enabled) throw new OidcProviderAdminError("provider_must_be_disabled");

          const identities = this.#database.sqlite
            .prepare("select count(*) as count from external_identities where provider_id = ?")
            .get(providerId) as { count: number };
          if (!Number.isSafeInteger(identities.count) || identities.count < 0) {
            throw new OidcProviderAdminError("integrity_failure");
          }
          if (identities.count > 0) throw new OidcProviderAdminError("provider_in_use");

          const mappings = this.#database.sqlite
            .prepare("select count(*) as count from role_mappings where provider_id = ?")
            .get(providerId) as { count: number };
          if (
            !Number.isSafeInteger(mappings.count) ||
            mappings.count < 0 ||
            mappings.count > OIDC_ROLE_MAPPINGS_MAX_COUNT
          ) {
            throw new OidcProviderAdminError("integrity_failure");
          }
          deletedRoleMappings = mappings.count;
          revokedSessions = this.#revokeProviderSessions(providerId, now);
          const changes = this.#database.db
            .delete(oidcProviders)
            .where(eq(oidcProviders.id, providerId))
            .run().changes;
          if (changes !== 1) throw new OidcProviderAdminError("integrity_failure");

          this.#insertSuccessAudit(
            auditId,
            "auth.oidc.provider.deleted",
            providerId,
            { deletedRoleMappings, revokedSessions },
            context,
            now,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof OidcProviderAdminError) throw error;
      throw new OidcProviderAdminError("storage_failure", { cause: error });
    }

    return { deletedProviderId: providerId, deletedRoleMappings, revokedSessions };
  }

  public recordValidation(
    providerId: string,
    context: OidcProviderAdminContext,
    outcome: "failure" | "success",
    reason: OidcProviderValidationAuditReason,
    retryable: boolean,
  ): void {
    if (
      !validIdentifier(providerId) ||
      !this.#validContext(context) ||
      !VALIDATION_AUDIT_REASONS.has(reason) ||
      (outcome === "success") !== (reason === "ready")
    ) {
      throw new OidcProviderAdminError("integrity_failure");
    }
    const auditId = this.#nextId();
    if (!validIdentifier(auditId)) throw new OidcProviderAdminError("integrity_failure");
    const now = this.#currentTime();
    try {
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
          ) values (?, ?, ?, ?, ?, 'auth.oidc.provider.validated', ?,
                    'oidc_provider', ?, ?, ?, ?, ?)`,
        )
        .run(
          auditId,
          context.principal.userId,
          context.principal.sessionId,
          context.principal.sessionId,
          context.principal.authenticationMethod.kind,
          outcome,
          providerId,
          context.requestId ?? null,
          JSON.stringify({ reason, retryable }),
          context.ipAddress
            ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
            : null,
          now.getTime(),
        );
    } catch (error) {
      throw new OidcProviderAdminError("storage_failure", { cause: error });
    }
  }

  #revokeProviderSessions(providerId: string, now: Date): number {
    const result = this.#database.sqlite
      .prepare(
        `update sessions
         set revoked_at = max(@now, created_at)
         where revoked_at is null
           and auth_method = 'oidc'
           and oidc_provider_id = @providerId`,
      )
      .run({ now: now.getTime(), providerId });
    if (!Number.isSafeInteger(result.changes) || result.changes < 0) {
      throw new OidcProviderAdminError("integrity_failure");
    }
    return result.changes;
  }

  #insertSuccessAudit(
    auditId: string,
    eventType: "auth.oidc.provider.deleted" | "auth.oidc.provider.updated",
    providerId: string,
    metadata: Readonly<Record<string, unknown>>,
    context: OidcProviderAdminContext,
    now: Date,
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
        ) values (?, ?, ?, ?, ?, ?, 'success', 'oidc_provider', ?, ?, ?, ?, ?)`,
      )
      .run(
        auditId,
        context.principal.userId,
        context.principal.sessionId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        eventType,
        providerId,
        context.requestId ?? null,
        JSON.stringify(metadata),
        context.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        now.getTime(),
      );
  }

  #currentTime() {
    let now: Date;
    try {
      now = this.#clock();
    } catch (error) {
      throw new OidcProviderAdminError("integrity_failure", { cause: error });
    }
    const milliseconds = now.getTime();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new OidcProviderAdminError("integrity_failure");
    }
    return new Date(milliseconds);
  }

  #nextId() {
    try {
      return this.#createId();
    } catch (error) {
      throw new OidcProviderAdminError("integrity_failure", { cause: error });
    }
  }

  #validContext(context: OidcProviderAdminContext) {
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
