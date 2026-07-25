import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
};

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["viewer", "requester", "operator", "admin"] })
      .notNull()
      .default("viewer"),
    status: text("status", { enum: ["active", "pending_link", "disabled"] })
      .notNull()
      .default("pending_link"),
    ...timestamps,
  },
  (table) => [
    index("users_status_idx").on(table.status),
    check("users_role_check", sql`${table.role} in ('viewer', 'requester', 'operator', 'admin')`),
    check("users_status_check", sql`${table.status} in ('active', 'pending_link', 'disabled')`),
  ],
);

export const oidcProviders = sqliteTable(
  "oidc_providers",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    issuer: text("issuer").notNull(),
    clientId: text("client_id").notNull(),
    encryptedClientSecret: text("encrypted_client_secret"),
    scopes: text("scopes").notNull().default("openid profile email"),
    claimConfigJson: text("claim_config_json").notNull().default("{}"),
    allowJitProvisioning: integer("allow_jit_provisioning", { mode: "boolean" })
      .notNull()
      .default(true),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("oidc_providers_slug_unique").on(table.slug),
    uniqueIndex("oidc_providers_issuer_unique").on(table.issuer),
    uniqueIndex("oidc_providers_id_issuer_unique").on(table.id, table.issuer),
    check(
      "oidc_providers_claim_config_json_check",
      sql`json_valid(${table.claimConfigJson}) and json_type(${table.claimConfigJson}) = 'object'`,
    ),
    check(
      "oidc_providers_allow_jit_provisioning_check",
      sql`${table.allowJitProvisioning} in (0, 1)`,
    ),
    check("oidc_providers_enabled_check", sql`${table.enabled} in (0, 1)`),
  ],
);

export const externalIdentities = sqliteTable(
  "external_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    displayClaimsJson: text("display_claims_json").notNull().default("{}"),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("external_identities_issuer_subject_unique").on(table.issuer, table.subject),
    uniqueIndex("external_identities_session_binding_unique").on(
      table.id,
      table.userId,
      table.providerId,
    ),
    index("external_identities_user_idx").on(table.userId),
    foreignKey({
      columns: [table.providerId, table.issuer],
      foreignColumns: [oidcProviders.id, oidcProviders.issuer],
      name: "external_identities_provider_issuer_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "external_identities_display_claims_json_check",
      sql`json_valid(${table.displayClaimsJson}) and json_type(${table.displayClaimsJson}) = 'object'`,
    ),
  ],
);

export const roleMappings = sqliteTable(
  "role_mappings",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => oidcProviders.id, { onDelete: "cascade" }),
    claimPathJson: text("claim_path_json").notNull(),
    operator: text("operator", { enum: ["equals", "contains_any", "contains_all"] }).notNull(),
    valuesJson: text("values_json").notNull(),
    role: text("role", { enum: ["viewer", "requester", "operator", "admin"] }).notNull(),
    priority: integer("priority").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index("role_mappings_provider_priority_idx").on(
      table.providerId,
      table.enabled,
      table.priority,
    ),
    check(
      "role_mappings_claim_path_json_check",
      sql`json_valid(${table.claimPathJson}) and json_type(${table.claimPathJson}) = 'array'`,
    ),
    check(
      "role_mappings_values_json_check",
      sql`json_valid(${table.valuesJson}) and json_type(${table.valuesJson}) = 'array'`,
    ),
    check(
      "role_mappings_operator_check",
      sql`${table.operator} in ('equals', 'contains_any', 'contains_all')`,
    ),
    check(
      "role_mappings_role_check",
      sql`${table.role} in ('viewer', 'requester', 'operator', 'admin')`,
    ),
    check("role_mappings_priority_check", sql`${table.priority} between 0 and 10000`),
    check("role_mappings_enabled_check", sql`${table.enabled} in (0, 1)`),
  ],
);

export const serviceIdentityLinks = sqliteTable(
  "service_identity_links",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    service: text("service", { enum: ["jellyfin"] }).notNull(),
    externalUserId: text("external_user_id").notNull(),
    externalUsername: text("external_username").notNull(),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    healthState: text("health_state", {
      enum: ["healthy", "degraded", "revoked", "unreachable"],
    })
      .notNull()
      .default("healthy"),
    lastVerifiedAt: integer("last_verified_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("service_identity_links_user_service_unique").on(table.userId, table.service),
    uniqueIndex("service_identity_links_external_unique").on(table.service, table.externalUserId),
    check("service_identity_links_service_check", sql`${table.service} = 'jellyfin'`),
    check(
      "service_identity_links_health_state_check",
      sql`${table.healthState} in ('healthy', 'degraded', 'revoked', 'unreachable')`,
    ),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    authMethod: text("auth_method", { enum: ["oidc", "jellyfin", "recovery"] }).notNull(),
    oidcProviderId: text("oidc_provider_id"),
    externalIdentityId: text("external_identity_id"),
    oidcSessionIdHash: text("oidc_session_id_hash"),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    absoluteExpiresAt: integer("absolute_expires_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
    index("sessions_expiry_idx").on(table.expiresAt),
    index("sessions_external_identity_idx").on(table.externalIdentityId),
    index("sessions_oidc_sid_idx").on(table.oidcProviderId, table.oidcSessionIdHash),
    foreignKey({
      columns: [table.externalIdentityId, table.userId, table.oidcProviderId],
      foreignColumns: [
        externalIdentities.id,
        externalIdentities.userId,
        externalIdentities.providerId,
      ],
      name: "sessions_oidc_identity_fk",
    }).onDelete("cascade"),
    check(
      "sessions_auth_method_check",
      sql`${table.authMethod} in ('oidc', 'jellyfin', 'recovery')`,
    ),
    check(
      "sessions_auth_attribution_check",
      sql`(
        ${table.authMethod} = 'oidc'
        and ${table.userId} is not null
        and ${table.oidcProviderId} is not null
        and ${table.externalIdentityId} is not null
      ) or (
        ${table.authMethod} = 'jellyfin'
        and ${table.userId} is not null
        and ${table.oidcProviderId} is null
        and ${table.externalIdentityId} is null
        and ${table.oidcSessionIdHash} is null
      ) or (
        ${table.authMethod} = 'recovery'
        and ${table.oidcProviderId} is null
        and ${table.externalIdentityId} is null
        and ${table.oidcSessionIdHash} is null
      )`,
    ),
    check(
      "sessions_oidc_sid_hash_length_check",
      sql`${table.oidcSessionIdHash} is null or length(${table.oidcSessionIdHash}) between 16 and 128`,
    ),
  ],
);

export const authTransactions = sqliteTable(
  "auth_transactions",
  {
    id: text("id").primaryKey(),
    stateHash: text("state_hash").notNull(),
    providerId: text("provider_id")
      .notNull()
      .references(() => oidcProviders.id, { onDelete: "cascade" }),
    encryptedCodeVerifier: text("encrypted_code_verifier").notNull(),
    encryptedNonce: text("encrypted_nonce").notNull(),
    returnPath: text("return_path").notNull().default("/"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex("auth_transactions_state_hash_unique").on(table.stateHash),
    index("auth_transactions_expiry_idx").on(table.expiresAt),
  ],
);

export const connectorConfigs = sqliteTable(
  "connector_configs",
  {
    id: text("id").primaryKey(),
    type: text("type", {
      enum: [
        "jellyfin",
        "seerr",
        "radarr",
        "sonarr",
        "prowlarr",
        "bazarr",
        "qbittorrent",
        "sabnzbd",
      ],
    }).notNull(),
    displayName: text("display_name").notNull(),
    baseUrl: text("base_url").notNull(),
    encryptedCredentials: text("encrypted_credentials").notNull(),
    tlsPolicy: text("tls_policy", { enum: ["strict", "allow_self_signed"] })
      .notNull()
      .default("strict"),
    insecureHttpApproved: integer("insecure_http_approved", { mode: "boolean" })
      .notNull()
      .default(false),
    capabilitySnapshotJson: text("capability_snapshot_json").notNull().default("{}"),
    healthState: text("health_state", { enum: ["unknown", "healthy", "degraded", "offline"] })
      .notNull()
      .default("unknown"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index("connector_configs_type_idx").on(table.type),
    check(
      "connector_configs_type_check",
      sql`${table.type} in ('jellyfin', 'seerr', 'radarr', 'sonarr', 'prowlarr', 'bazarr', 'qbittorrent', 'sabnzbd')`,
    ),
    check(
      "connector_configs_tls_policy_check",
      sql`${table.tlsPolicy} in ('strict', 'allow_self_signed')`,
    ),
    check(
      "connector_configs_capability_snapshot_json_check",
      sql`json_valid(${table.capabilitySnapshotJson}) and json_type(${table.capabilitySnapshotJson}) = 'object'`,
    ),
    check(
      "connector_configs_health_state_check",
      sql`${table.healthState} in ('unknown', 'healthy', 'degraded', 'offline')`,
    ),
    check(
      "connector_configs_insecure_http_approved_check",
      sql`${table.insecureHttpApproved} in (0, 1)`,
    ),
    check("connector_configs_enabled_check", sql`${table.enabled} in (0, 1)`),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    outcome: text("outcome", { enum: ["success", "denied", "failure"] }).notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    ipHash: text("ip_hash"),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("audit_events_actor_idx").on(table.actorUserId),
    index("audit_events_type_created_idx").on(table.eventType, table.createdAt),
    check("audit_events_outcome_check", sql`${table.outcome} in ('success', 'denied', 'failure')`),
    check(
      "audit_events_metadata_json_check",
      sql`json_valid(${table.metadataJson}) and json_type(${table.metadataJson}) = 'object'`,
    ),
  ],
);

export const operationalFailures = sqliteTable(
  "operational_failures",
  {
    id: text("id").primaryKey(),
    component: text("component").notNull(),
    operation: text("operation").notNull(),
    category: text("category").notNull(),
    safeMessage: text("safe_message").notNull(),
    contextJson: text("context_json").notNull().default("{}"),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("operational_failures_component_idx").on(table.component, table.resolvedAt),
    check(
      "operational_failures_context_json_check",
      sql`json_valid(${table.contextJson}) and json_type(${table.contextJson}) = 'object'`,
    ),
  ],
);
