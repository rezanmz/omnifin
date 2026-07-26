import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
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
    roleSource: text("role_source", {
      enum: ["default", "oidc_mapping", "manual", "recovery_bootstrap"],
    })
      .notNull()
      .default("default"),
    status: text("status", { enum: ["active", "pending_link", "disabled"] })
      .notNull()
      .default("pending_link"),
    ...timestamps,
  },
  (table) => [
    index("users_status_idx").on(table.status),
    check("users_role_check", sql`${table.role} in ('viewer', 'requester', 'operator', 'admin')`),
    check(
      "users_role_source_check",
      sql`${table.roleSource} in ('default', 'oidc_mapping', 'manual', 'recovery_bootstrap')`,
    ),
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
    tokenEndpointAuthMethod: text("token_endpoint_auth_method", {
      enum: ["client_secret_basic", "client_secret_post", "none"],
    })
      .notNull()
      .default("none"),
    idTokenSigningAlg: text("id_token_signing_alg", {
      enum: [
        "RS256",
        "RS384",
        "RS512",
        "PS256",
        "PS384",
        "PS512",
        "ES256",
        "ES384",
        "ES512",
        "EdDSA",
      ],
    })
      .notNull()
      .default("RS256"),
    scopes: text("scopes").notNull().default("openid profile email"),
    claimConfigJson: text("claim_config_json").notNull().default("{}"),
    approvedEndpointOriginsJson: text("approved_endpoint_origins_json").notNull().default("[]"),
    discoveryState: text("discovery_state", { enum: ["unchecked", "ready", "failed"] })
      .notNull()
      .default("unchecked"),
    discoveryCapabilitiesJson: text("discovery_capabilities_json").notNull().default("{}"),
    discoveryCheckedAt: integer("discovery_checked_at", { mode: "timestamp_ms" }),
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
      "oidc_providers_token_endpoint_auth_method_check",
      sql`${table.tokenEndpointAuthMethod} in ('client_secret_basic', 'client_secret_post', 'none')`,
    ),
    check(
      "oidc_providers_id_token_signing_alg_check",
      sql`${table.idTokenSigningAlg} in ('RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA')`,
    ),
    check(
      "oidc_providers_client_secret_check",
      sql`(
          ${table.tokenEndpointAuthMethod} = 'none'
          and ${table.encryptedClientSecret} is null
        ) or (
          ${table.tokenEndpointAuthMethod} in ('client_secret_basic', 'client_secret_post')
          and ${table.encryptedClientSecret} is not null
          and length(${table.encryptedClientSecret}) between 1 and 8192
        )`,
    ),
    check(
      "oidc_providers_claim_config_json_check",
      sql`json_valid(${table.claimConfigJson}) and json_type(${table.claimConfigJson}) = 'object'`,
    ),
    check(
      "oidc_providers_approved_endpoint_origins_json_check",
      sql`length(${table.approvedEndpointOriginsJson}) between 2 and 4096
        and json_valid(${table.approvedEndpointOriginsJson})
        and json_type(${table.approvedEndpointOriginsJson}) = 'array'
        and json_array_length(${table.approvedEndpointOriginsJson}) between 0 and 16`,
    ),
    check(
      "oidc_providers_discovery_state_check",
      sql`${table.discoveryState} in ('unchecked', 'ready', 'failed')`,
    ),
    check(
      "oidc_providers_discovery_capabilities_json_check",
      sql`length(${table.discoveryCapabilitiesJson}) between 2 and 8192
        and json_valid(${table.discoveryCapabilitiesJson})
        and json_type(${table.discoveryCapabilitiesJson}) = 'object'`,
    ),
    check(
      "oidc_providers_discovery_attribution_check",
      sql`(
          ${table.discoveryState} = 'unchecked'
          and ${table.discoveryCheckedAt} is null
          and json(${table.discoveryCapabilitiesJson}) = '{}'
        ) or (
          ${table.discoveryState} = 'failed'
          and ${table.discoveryCheckedAt} is not null
        ) or (
          ${table.discoveryState} = 'ready'
          and ${table.discoveryCheckedAt} is not null
          and json(${table.discoveryCapabilitiesJson}) <> '{}'
          and json_array_length(${table.approvedEndpointOriginsJson}) between 1 and 16
        )`,
    ),
    check(
      "oidc_providers_discovery_timestamp_check",
      sql`${table.discoveryCheckedAt} is null or ${table.discoveryCheckedAt} >= ${table.createdAt}`,
    ),
    check(
      "oidc_providers_allow_jit_provisioning_check",
      sql`${table.allowJitProvisioning} in (0, 1)`,
    ),
    check("oidc_providers_enabled_check", sql`${table.enabled} in (0, 1)`),
  ],
);

export const oidcLogoutReceipts = sqliteTable(
  "oidc_logout_receipts",
  {
    providerId: text("provider_id")
      .notNull()
      .references(() => oidcProviders.id, { onDelete: "cascade" }),
    jtiHash: text("jti_hash").notNull(),
    issuedAt: integer("issued_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    receivedAt: integer("received_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    uniqueIndex("oidc_logout_receipts_provider_jti_unique").on(table.providerId, table.jtiHash),
    index("oidc_logout_receipts_expiry_idx").on(table.expiresAt),
    check(
      "oidc_logout_receipts_jti_hash_check",
      sql`length(${table.jtiHash}) = 43 and ${table.jtiHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "oidc_logout_receipts_timestamp_order_check",
      sql`${table.issuedAt} >= 0
        and ${table.receivedAt} >= 0
        and ${table.issuedAt} >= ${table.receivedAt} - 300000
        and ${table.issuedAt} <= ${table.receivedAt} + 300000
        and ${table.receivedAt} < ${table.expiresAt}`,
    ),
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
    uniqueIndex("connector_configs_id_type_unique").on(table.id, table.type),
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

export const serviceIdentityLinks = sqliteTable(
  "service_identity_links",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    service: text("service", { enum: ["jellyfin"] }).notNull(),
    connectorId: text("connector_id"),
    externalServerId: text("external_server_id").notNull(),
    externalUserId: text("external_user_id").notNull(),
    externalUsername: text("external_username").notNull(),
    externalDisplayName: text("external_display_name").notNull(),
    encryptedAccessToken: text("encrypted_access_token"),
    deviceId: text("device_id").notNull(),
    tokenCreatedAt: integer("token_created_at", { mode: "timestamp_ms" }),
    healthState: text("health_state", {
      enum: ["linked", "unavailable", "relink_required", "revoked"],
    })
      .notNull()
      .default("relink_required"),
    lastVerifiedAt: integer("last_verified_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    revision: integer("revision").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("service_identity_links_user_service_unique").on(table.userId, table.service),
    uniqueIndex("service_identity_links_session_binding_unique").on(table.id, table.userId),
    uniqueIndex("service_identity_links_external_unique").on(
      table.connectorId,
      table.externalServerId,
      table.externalUserId,
    ),
    index("service_identity_links_connector_idx").on(table.connectorId),
    foreignKey({
      columns: [table.connectorId, table.service],
      foreignColumns: [connectorConfigs.id, connectorConfigs.type],
      name: "service_identity_links_connector_type_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("service_identity_links_service_check", sql`${table.service} = 'jellyfin'`),
    check(
      "service_identity_links_health_state_check",
      sql`${table.healthState} in ('linked', 'unavailable', 'relink_required', 'revoked')`,
    ),
    check(
      "service_identity_links_health_attribution_check",
      sql`(
          ${table.healthState} in ('linked', 'unavailable')
          and ${table.connectorId} is not null
          and ${table.encryptedAccessToken} is not null
          and ${table.tokenCreatedAt} is not null
          and ${table.revokedAt} is null
        ) or (
          ${table.healthState} = 'relink_required'
          and ${table.encryptedAccessToken} is null
          and ${table.tokenCreatedAt} is null
          and ${table.revokedAt} is null
        ) or (
          ${table.healthState} = 'revoked'
          and ${table.encryptedAccessToken} is null
          and ${table.revokedAt} is not null
        )`,
    ),
    check("service_identity_links_revision_check", sql`${table.revision} between 0 and 2147483647`),
    check(
      "service_identity_links_timestamp_order_check",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
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
    serviceIdentityLinkId: text("service_identity_link_id"),
    oidcSessionIdHash: text("oidc_session_id_hash"),
    encryptedIdTokenHint: text("encrypted_id_token_hint"),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    encryptedCsrfToken: text("encrypted_csrf_token").notNull(),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    lastRotatedAt: integer("last_rotated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
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
    index("sessions_service_identity_link_idx").on(table.serviceIdentityLinkId),
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
    foreignKey({
      columns: [table.serviceIdentityLinkId, table.userId],
      foreignColumns: [serviceIdentityLinks.id, serviceIdentityLinks.userId],
      name: "sessions_service_identity_link_fk",
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
        and ${table.serviceIdentityLinkId} is not null
        and ${table.oidcSessionIdHash} is null
        and ${table.encryptedIdTokenHint} is null
      ) or (
        ${table.authMethod} = 'recovery'
        and ${table.userId} is null
        and ${table.oidcProviderId} is null
        and ${table.externalIdentityId} is null
        and ${table.serviceIdentityLinkId} is null
        and ${table.oidcSessionIdHash} is null
        and ${table.encryptedIdTokenHint} is null
      )`,
    ),
    check(
      "sessions_token_hash_check",
      sql`length(${table.tokenHash}) = 43 and ${table.tokenHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "sessions_csrf_hash_check",
      sql`length(${table.csrfTokenHash}) = 43
        and ${table.csrfTokenHash} not glob '*[^A-Za-z0-9_-]*'
        and length(${table.encryptedCsrfToken}) between 1 and 8192`,
    ),
    check(
      "sessions_privacy_hashes_check",
      sql`(${table.oidcSessionIdHash} is null or (
          length(${table.oidcSessionIdHash}) = 22
          and ${table.oidcSessionIdHash} not glob '*[^A-Za-z0-9_-]*'
        )) and (${table.ipHash} is null or (
          length(${table.ipHash}) = 22
          and ${table.ipHash} not glob '*[^A-Za-z0-9_-]*'
        )) and (${table.userAgentHash} is null or (
          length(${table.userAgentHash}) = 22
          and ${table.userAgentHash} not glob '*[^A-Za-z0-9_-]*'
        ))`,
    ),
    check(
      "sessions_id_token_hint_check",
      sql`${table.encryptedIdTokenHint} is null or length(${table.encryptedIdTokenHint}) between 1 and 32768`,
    ),
    check(
      "sessions_timestamp_order_check",
      sql`${table.createdAt} <= ${table.lastRotatedAt}
        and ${table.lastRotatedAt} <= ${table.lastSeenAt}
        and ${table.lastSeenAt} <= ${table.expiresAt}
        and ${table.expiresAt} <= ${table.absoluteExpiresAt}
        and (${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const sessionSecretReservations = sqliteTable(
  "session_secret_reservations",
  {
    secretHash: text("secret_hash").primaryKey(),
    purpose: text("purpose", { enum: ["bearer", "csrf"] }).notNull(),
    originSessionId: text("origin_session_id").notNull(),
    reservedAt: integer("reserved_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("session_secret_reservations_attribution_unique").on(
      table.secretHash,
      table.purpose,
      table.originSessionId,
    ),
    index("session_secret_reservations_origin_idx").on(table.originSessionId, table.purpose),
    check(
      "session_secret_reservations_secret_hash_check",
      sql`length(${table.secretHash}) = 43
        and ${table.secretHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "session_secret_reservations_origin_session_id_check",
      sql`length(${table.originSessionId}) between 1 and 128
        and ${table.originSessionId} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check("session_secret_reservations_purpose_check", sql`${table.purpose} in ('bearer', 'csrf')`),
    check("session_secret_reservations_reserved_at_check", sql`${table.reservedAt} >= 0`),
  ],
);

export const sessionRotationAliases = sqliteTable(
  "session_rotation_aliases",
  {
    tokenHash: text("token_hash").primaryKey(),
    purpose: text("purpose", { enum: ["bearer"] })
      .notNull()
      .default("bearer"),
    state: text("state", { enum: ["rotation_grace"] })
      .notNull()
      .default("rotation_grace"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    validFrom: integer("valid_from", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("session_rotation_aliases_session_idx").on(table.sessionId),
    index("session_rotation_aliases_expiry_idx").on(table.expiresAt),
    foreignKey({
      columns: [table.tokenHash, table.purpose, table.sessionId],
      foreignColumns: [
        sessionSecretReservations.secretHash,
        sessionSecretReservations.purpose,
        sessionSecretReservations.originSessionId,
      ],
      name: "session_rotation_aliases_reservation_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "session_rotation_aliases_token_hash_check",
      sql`length(${table.tokenHash}) = 43
        and ${table.tokenHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check("session_rotation_aliases_purpose_check", sql`${table.purpose} = 'bearer'`),
    check("session_rotation_aliases_state_check", sql`${table.state} = 'rotation_grace'`),
    check(
      "session_rotation_aliases_timestamp_order_check",
      sql`${table.validFrom} >= 0
        and ${table.expiresAt} > ${table.validFrom}
        and ${table.expiresAt} <= ${table.validFrom} + 10000`,
    ),
  ],
);

export const auditBudgetScopes = sqliteTable(
  "audit_budget_scopes",
  {
    scope: text("scope").primaryKey(),
    generation: integer("generation").notNull(),
    windowStartedAt: integer("window_started_at", { mode: "timestamp_ms" }).notNull(),
    clockWatermarkAt: integer("clock_watermark_at", { mode: "timestamp_ms" }).notNull(),
    rollbackStartedAt: integer("rollback_started_at", { mode: "timestamp_ms" }),
    saturated: integer("saturated", { mode: "boolean" }).notNull().default(false),
    suppressedCount: integer("suppressed_count").notNull().default(0),
  },
  (table) => [
    uniqueIndex("audit_budget_scopes_scope_generation_unique").on(table.scope, table.generation),
    check("audit_budget_scopes_scope_check", sql`${table.scope} = 'auth.oidc.failure:v1'`),
    check(
      "audit_budget_scopes_generation_check",
      sql`typeof(${table.generation}) = 'integer'
        and ${table.generation} between 1 and 9007199254740990`,
    ),
    check(
      "audit_budget_scopes_timestamp_check",
      sql`typeof(${table.windowStartedAt}) = 'integer'
        and ${table.windowStartedAt} between 0 and 8640000000000000
        and typeof(${table.clockWatermarkAt}) = 'integer'
        and ${table.clockWatermarkAt} between 0 and 8640000000000000
        and ${table.windowStartedAt} <= ${table.clockWatermarkAt}
        and (${table.rollbackStartedAt} is null or (
          typeof(${table.rollbackStartedAt}) = 'integer'
          and ${table.rollbackStartedAt} between 0 and 8640000000000000
          and ${table.rollbackStartedAt} <= ${table.clockWatermarkAt}
        ))`,
    ),
    check("audit_budget_scopes_saturated_check", sql`${table.saturated} in (0, 1)`),
    check(
      "audit_budget_scopes_suppressed_count_check",
      sql`typeof(${table.suppressedCount}) = 'integer'
        and ${table.suppressedCount} between 0 and 4096`,
    ),
  ],
);

export const auditBudgetEntries = sqliteTable(
  "audit_budget_entries",
  {
    scope: text("scope").notNull(),
    generation: integer("generation").notNull(),
    slot: integer("slot").notNull(),
    bucketHash: text("bucket_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.scope, table.generation, table.slot],
      name: "audit_budget_entries_scope_generation_slot_pk",
    }),
    uniqueIndex("audit_budget_entries_bucket_unique").on(
      table.scope,
      table.generation,
      table.bucketHash,
    ),
    foreignKey({
      columns: [table.scope],
      foreignColumns: [auditBudgetScopes.scope],
      name: "audit_budget_entries_scope_fk",
    })
      .onDelete("cascade")
      .onUpdate("restrict"),
    check("audit_budget_entries_scope_check", sql`${table.scope} = 'auth.oidc.failure:v1'`),
    check(
      "audit_budget_entries_generation_check",
      sql`typeof(${table.generation}) = 'integer'
        and ${table.generation} between 1 and 9007199254740990`,
    ),
    check(
      "audit_budget_entries_slot_check",
      sql`typeof(${table.slot}) = 'integer' and ${table.slot} between 0 and 126`,
    ),
    check(
      "audit_budget_entries_bucket_hash_check",
      sql`length(${table.bucketHash}) = 22
        and ${table.bucketHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "audit_budget_entries_created_at_check",
      sql`typeof(${table.createdAt}) = 'integer'
        and ${table.createdAt} between 0 and 8640000000000000`,
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
    browserBindingHash: text("browser_binding_hash").notNull(),
    encryptedCodeVerifier: text("encrypted_code_verifier").notNull(),
    encryptedNonce: text("encrypted_nonce").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    returnPath: text("return_path").notNull().default("/"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex("auth_transactions_state_hash_unique").on(table.stateHash),
    index("auth_transactions_expiry_idx").on(table.expiresAt),
    check(
      "auth_transactions_hashes_check",
      sql`length(${table.stateHash}) = 43
        and ${table.stateHash} not glob '*[^A-Za-z0-9_-]*'
        and length(${table.browserBindingHash}) = 43
        and ${table.browserBindingHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "auth_transactions_redirect_uri_check",
      sql`length(${table.redirectUri}) between 8 and 2048
        and (${table.redirectUri} like 'https://%' or ${table.redirectUri} like 'http://%')
        and instr(${table.redirectUri}, '#') = 0`,
    ),
    check(
      "auth_transactions_return_path_check",
      sql`length(${table.returnPath}) between 1 and 2048
        and substr(${table.returnPath}, 1, 1) = '/'
        and substr(${table.returnPath}, 1, 2) <> '//'
        and instr(${table.returnPath}, char(92)) = 0`,
    ),
    check(
      "auth_transactions_timestamp_order_check",
      sql`${table.createdAt} < ${table.expiresAt}
        and (${table.consumedAt} is null or (
          ${table.consumedAt} >= ${table.createdAt}
          and ${table.consumedAt} <= ${table.expiresAt}
        ))`,
    ),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    actorSessionId: text("actor_session_id"),
    actorAuthMethod: text("actor_auth_method", {
      enum: ["oidc", "jellyfin", "recovery"],
    }),
    eventType: text("event_type").notNull(),
    outcome: text("outcome", { enum: ["success", "denied", "failure"] }).notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    requestId: text("request_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    ipHash: text("ip_hash"),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("audit_events_actor_idx").on(table.actorUserId),
    index("audit_events_actor_session_idx").on(table.actorSessionId, table.actorAuthMethod),
    index("audit_events_type_created_idx").on(table.eventType, table.createdAt),
    index("audit_events_request_idx").on(table.requestId),
    check("audit_events_outcome_check", sql`${table.outcome} in ('success', 'denied', 'failure')`),
    check(
      "audit_events_metadata_json_check",
      sql`json_valid(${table.metadataJson}) and json_type(${table.metadataJson}) = 'object'`,
    ),
    check(
      "audit_events_request_id_check",
      sql`${table.requestId} is null or length(${table.requestId}) between 1 and 128`,
    ),
    check(
      "audit_events_actor_session_check",
      sql`(
          ${table.actorSessionId} is null
          and ${table.actorAuthMethod} is null
        ) or (
          ${table.actorSessionId} is not null
          and ${table.actorAuthMethod} is not null
          and ${table.actorAuthMethod} in ('oidc', 'jellyfin', 'recovery')
        )`,
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
