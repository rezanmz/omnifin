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

export const databaseKeyVerifiers = sqliteTable(
  "database_key_verifiers",
  {
    id: integer("id").primaryKey(),
    formatVersion: integer("format_version").notNull().default(1),
    verifier: text("verifier").notNull(),
  },
  (table) => [
    check("database_key_verifiers_singleton_check", sql`${table.id} = 1`),
    check("database_key_verifiers_format_check", sql`${table.formatVersion} = 1`),
    check(
      "database_key_verifiers_value_check",
      sql`length(${table.verifier}) = 43 and ${table.verifier} not glob '*[^A-Za-z0-9_-]*'`,
    ),
  ],
);

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
    themePreference: text("theme_preference", {
      enum: ["system", "light", "dark"],
    }),
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
    check(
      "users_theme_preference_check",
      sql`${table.themePreference} is null or ${table.themePreference} in ('system', 'light', 'dark')`,
    ),
  ],
);

export const playbackPreferences = sqliteTable(
  "playback_preferences",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull().default(1),
    preferencesJson: text("preferences_json").notNull(),
    revision: integer("revision").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    check("playback_preferences_schema_version_check", sql`${table.schemaVersion} = 1`),
    check(
      "playback_preferences_json_check",
      sql`length(${table.preferencesJson}) between 2 and 8192
        and json_valid(${table.preferencesJson})
        and json_type(${table.preferencesJson}) = 'object'`,
    ),
    check("playback_preferences_revision_check", sql`${table.revision} between 1 and 2147483647`),
    check(
      "playback_preferences_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}`,
    ),
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
    uniqueIndex("external_identities_id_user_unique").on(table.id, table.userId),
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
    publicUiUrl: text("public_ui_url"),
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
    instanceGeneration: integer("instance_generation").notNull().default(0),
    configGeneration: integer("config_generation").notNull().default(0),
    instanceIdentityHash: text("instance_identity_hash"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("connector_configs_id_type_unique").on(table.id, table.type),
    uniqueIndex("connector_configs_id_instance_generation_unique").on(
      table.id,
      table.instanceGeneration,
    ),
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

export const jellyfinProvisioningConfigs = sqliteTable(
  "jellyfin_provisioning_configs",
  {
    connectorId: text("connector_id")
      .primaryKey()
      .references(() => connectorConfigs.id, { onDelete: "cascade" }),
    connectorRevision: text("connector_revision").notNull(),
    connectorInstanceGeneration: integer("connector_instance_generation").notNull(),
    connectorInstanceIdentityHash: text("connector_instance_identity_hash"),
    encryptedConfiguration: text("encrypted_configuration").notNull(),
    revision: integer("revision").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    check(
      "jellyfin_provisioning_connector_revision_check",
      sql`length(${table.connectorRevision}) between 16 and 128 and ${table.connectorRevision} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "jellyfin_provisioning_instance_generation_check",
      sql`${table.connectorInstanceGeneration} between 0 and 9007199254740991`,
    ),
    check("jellyfin_provisioning_revision_check", sql`${table.revision} between 0 and 2147483647`),
  ],
);

export const jellyfinActivationOperations = sqliteTable(
  "jellyfin_activation_operations",
  {
    id: text("id").primaryKey(),
    invitationId: text("invitation_id")
      .notNull()
      .references(() => invitations.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    externalIdentityId: text("external_identity_id")
      .notNull()
      .references(() => externalIdentities.id, { onDelete: "restrict" }),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectorConfigs.id, { onDelete: "restrict" }),
    connectorConfigGeneration: integer("connector_config_generation").notNull(),
    connectorInstanceGeneration: integer("connector_instance_generation").notNull(),
    connectorInstanceIdentityHash: text("connector_instance_identity_hash"),
    provisioningRevision: integer("provisioning_revision").notNull(),
    state: text("state", {
      enum: [
        "reserved",
        "create_dispatched",
        "created",
        "policy_pending",
        "auth_pending",
        "manual_required",
        "tombstoned",
      ],
    })
      .notNull()
      .default("reserved"),
    revision: integer("revision").notNull().default(0),
    encryptedStageArtifact: text("encrypted_stage_artifact"),
    artifactRevision: integer("artifact_revision").notNull().default(0),
    cleanupEligible: integer("cleanup_eligible", { mode: "boolean" }).notNull().default(false),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    createAttemptCount: integer("create_attempt_count").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    cleanupAttemptCount: integer("cleanup_attempt_count").notNull().default(0),
    failureCode: text("failure_code"),
    reservedAt: integer("reserved_at", { mode: "timestamp_ms" }).notNull(),
    createDispatchedAt: integer("create_dispatched_at", { mode: "timestamp_ms" }),
    createdIdRecordedAt: integer("created_id_recorded_at", { mode: "timestamp_ms" }),
    manualRequiredAt: integer("manual_required_at", { mode: "timestamp_ms" }),
    tombstonedAt: integer("tombstoned_at", { mode: "timestamp_ms" }),
    activationStatus: text("activation_status", { enum: ["pending", "completed"] })
      .notNull()
      .default("pending"),
    activationCompletedLinkId: text("activation_completed_link_id"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("jellyfin_activation_operations_invitation_unique").on(table.invitationId),
    uniqueIndex("jellyfin_activation_operations_user_unique").on(table.userId),
    uniqueIndex("jellyfin_activation_operations_external_identity_unique").on(
      table.externalIdentityId,
    ),
    uniqueIndex("jellyfin_activation_operations_id_user_connector_unique").on(
      table.id,
      table.userId,
      table.connectorId,
    ),
    index("jellyfin_activation_operations_state_idx").on(table.state, table.updatedAt),
    index("jellyfin_activation_operations_lease_idx").on(table.leaseExpiresAt),
    uniqueIndex("jellyfin_activation_operations_completed_link_unique")
      .on(table.activationCompletedLinkId)
      .where(sql`${table.activationCompletedLinkId} is not null`),
    check(
      "jellyfin_activation_operations_activation_status_check",
      sql`${table.activationStatus} in ('pending', 'completed')`,
    ),
    foreignKey({
      columns: [table.externalIdentityId, table.userId],
      foreignColumns: [externalIdentities.id, externalIdentities.userId],
      name: "jellyfin_activation_operations_identity_user_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "jellyfin_activation_operations_id_check",
      sql`length(${table.id}) between 10 and 128 and substr(${table.id}, 1, 9) = 'jellyfin_' and substr(${table.id}, 10) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "jellyfin_activation_operations_generation_check",
      sql`${table.connectorConfigGeneration} between 0 and 9007199254740991 and ${table.connectorInstanceGeneration} between 0 and 9007199254740991`,
    ),
    check(
      "jellyfin_activation_operations_identity_hash_check",
      sql`${table.connectorInstanceIdentityHash} is null or (length(${table.connectorInstanceIdentityHash}) between 16 and 128 and ${table.connectorInstanceIdentityHash} not glob '*[^A-Za-z0-9_-]*')`,
    ),
    check(
      "jellyfin_activation_operations_provisioning_revision_check",
      sql`${table.provisioningRevision} between 0 and 2147483647`,
    ),
    check(
      "jellyfin_activation_operations_state_check",
      sql`${table.state} in ('reserved', 'create_dispatched', 'created', 'policy_pending', 'auth_pending', 'manual_required', 'tombstoned')`,
    ),
    check(
      "jellyfin_activation_operations_revision_check",
      sql`${table.revision} between 0 and 2147483647 and ${table.artifactRevision} between 0 and 2147483647`,
    ),
    check(
      "jellyfin_activation_operations_attempt_check",
      sql`${table.createAttemptCount} between 0 and 1 and ${table.retryCount} between 0 and 8 and ${table.cleanupAttemptCount} between 0 and 8 and ${table.cleanupEligible} in (0, 1)`,
    ),
    check(
      "jellyfin_activation_operations_failure_code_check",
      sql`${table.failureCode} is null or (length(${table.failureCode}) between 1 and 64 and ${table.failureCode} not glob '*[^a-z0-9_]*')`,
    ),
    check(
      "jellyfin_activation_operations_lease_check",
      sql`(${table.leaseOwner} is null and ${table.leaseExpiresAt} is null) or (${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null and length(${table.leaseOwner}) between 1 and 128 and ${table.leaseExpiresAt} >= 0)`,
    ),
    check(
      "jellyfin_activation_operations_state_attribution_check",
      sql`(${table.state} = 'reserved' and ${table.createAttemptCount} = 0 and ${table.createDispatchedAt} is null and ${table.createdIdRecordedAt} is null and ${table.manualRequiredAt} is null and ${table.tombstonedAt} is null and ${table.encryptedStageArtifact} is null and ${table.cleanupEligible} = 0) or (${table.state} = 'create_dispatched' and ${table.createAttemptCount} = 1 and ${table.createDispatchedAt} is not null and ${table.createdIdRecordedAt} is null and ${table.manualRequiredAt} is null and ${table.tombstonedAt} is null and ${table.encryptedStageArtifact} is null and ${table.cleanupEligible} = 0) or (${table.state} in ('created', 'policy_pending', 'auth_pending') and ${table.createAttemptCount} = 1 and ${table.createDispatchedAt} is not null and ${table.createdIdRecordedAt} is not null and ${table.manualRequiredAt} is null and ${table.tombstonedAt} is null and ${table.encryptedStageArtifact} is not null and ${table.cleanupEligible} = 1) or (${table.state} = 'manual_required' and ${table.manualRequiredAt} is not null and ${table.tombstonedAt} is null and ((${table.encryptedStageArtifact} is null and ${table.cleanupEligible} = 0) or (${table.encryptedStageArtifact} is not null and ${table.cleanupEligible} = 1))) or (${table.state} = 'tombstoned' and ${table.tombstonedAt} is not null and ${table.encryptedStageArtifact} is null and ${table.cleanupEligible} = 0)`,
    ),
    check(
      "jellyfin_activation_operations_timestamp_order_check",
      sql`${table.createdAt} >= 0 and ${table.createdAt} <= ${table.updatedAt} and ${table.reservedAt} >= ${table.createdAt} and (${table.createDispatchedAt} is null or ${table.createDispatchedAt} >= ${table.reservedAt}) and (${table.createdIdRecordedAt} is null or ${table.createDispatchedAt} is not null and ${table.createdIdRecordedAt} >= ${table.createDispatchedAt}) and (${table.manualRequiredAt} is null or ${table.manualRequiredAt} >= ${table.createdAt}) and (${table.tombstonedAt} is null or ${table.tombstonedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const jellyfinActivationCleanupReservations = sqliteTable(
  "jellyfin_activation_cleanup_reservations",
  {
    operationId: text("operation_id")
      .primaryKey()
      .references(() => jellyfinActivationOperations.id, { onDelete: "restrict" }),
    operationRevision: integer("operation_revision").notNull(),
    leaseOwner: text("lease_owner").notNull(),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(1),
    state: text("state", { enum: ["dispatched", "uncertain", "confirmed"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("jellyfin_activation_cleanup_reservations_state_idx").on(
      table.state,
      table.leaseExpiresAt,
    ),
    check(
      "jellyfin_activation_cleanup_reservations_attempt_check",
      sql`${table.attemptCount} between 1 and 8`,
    ),
    check(
      "jellyfin_activation_cleanup_reservations_state_check",
      sql`${table.state} in ('dispatched', 'uncertain', 'confirmed')`,
    ),
  ],
);

export const mediaRequestProfilePreferences = sqliteTable(
  "media_request_profile_preferences",
  {
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectorConfigs.id, { onDelete: "cascade" }),
    connectorInstanceGeneration: integer("connector_instance_generation").notNull().default(0),
    kind: text("kind", { enum: ["movie", "series"] }).notNull(),
    is4k: integer("is_4k", { mode: "boolean" }).notNull(),
    destinationId: integer("destination_id").notNull(),
    profileId: integer("profile_id").notNull(),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.connectorId, table.kind, table.is4k] }),
    check(
      "media_request_profile_preferences_kind_check",
      sql`${table.kind} in ('movie', 'series')`,
    ),
    check("media_request_profile_preferences_is_4k_check", sql`${table.is4k} in (0, 1)`),
    check(
      "media_request_profile_preferences_destination_check",
      sql`${table.destinationId} between 0 and 2147483647`,
    ),
    check(
      "media_request_profile_preferences_profile_check",
      sql`${table.profileId} between 1 and 2147483647`,
    ),
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
    connectorInstanceGeneration: integer("connector_instance_generation").notNull().default(0),
    externalServerId: text("external_server_id").notNull(),
    externalUserId: text("external_user_id").notNull(),
    externalUsername: text("external_username").notNull(),
    externalDisplayName: text("external_display_name").notNull(),
    encryptedAccessToken: text("encrypted_access_token"),
    provisionedByActivationId: text("provisioned_by_activation_id"),
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
    uniqueIndex("service_identity_links_provisioned_by_activation_unique")
      .on(table.provisionedByActivationId)
      .where(sql`${table.provisionedByActivationId} is not null`),
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

export const mediaReferences = sqliteTable(
  "media_references",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serviceIdentityLinkId: text("service_identity_link_id").notNull(),
    linkRevision: integer("link_revision").notNull(),
    itemDigest: text("item_digest").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("media_references_id_user_unique").on(table.id, table.userId),
    uniqueIndex("media_references_link_item_unique").on(
      table.serviceIdentityLinkId,
      table.linkRevision,
      table.itemDigest,
    ),
    index("media_references_user_last_used_idx").on(table.userId, table.lastUsedAt),
    index("media_references_expiry_idx").on(table.expiresAt),
    foreignKey({
      columns: [table.serviceIdentityLinkId, table.userId],
      foreignColumns: [serviceIdentityLinks.id, serviceIdentityLinks.userId],
      name: "media_references_service_identity_link_fk",
    }).onDelete("cascade"),
    check(
      "media_references_id_check",
      sql`length(${table.id}) = 28
        and substr(${table.id}, 1, 6) = 'media_'
        and substr(${table.id}, 7) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "media_references_item_digest_check",
      sql`length(${table.itemDigest}) = 22
        and ${table.itemDigest} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "media_references_payload_check",
      sql`length(${table.encryptedPayload}) between 1 and 32768`,
    ),
    check(
      "media_references_link_revision_check",
      sql`${table.linkRevision} between 0 and 2147483647`,
    ),
    check(
      "media_references_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}
        and ${table.createdAt} <= ${table.lastUsedAt}
        and ${table.lastUsedAt} < ${table.expiresAt}`,
    ),
  ],
);

export const discoveryArtworkReferences = sqliteTable(
  "discovery_artwork_references",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectorConfigs.id, { onDelete: "cascade" }),
    connectorInstanceGeneration: integer("connector_instance_generation").notNull().default(0),
    itemDigest: text("item_digest").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("discovery_artwork_references_user_item_unique").on(
      table.userId,
      table.connectorId,
      table.itemDigest,
    ),
    index("discovery_artwork_references_user_last_used_idx").on(table.userId, table.lastUsedAt),
    index("discovery_artwork_references_expiry_idx").on(table.expiresAt),
    check(
      "discovery_artwork_references_id_check",
      sql`length(${table.id}) = 36
        and substr(${table.id}, 1, 14) = 'discovery_art_'
        and substr(${table.id}, 15) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "discovery_artwork_references_item_digest_check",
      sql`length(${table.itemDigest}) = 22
        and ${table.itemDigest} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "discovery_artwork_references_payload_check",
      sql`length(${table.encryptedPayload}) between 1 and 4096`,
    ),
    check(
      "discovery_artwork_references_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}
        and ${table.createdAt} <= ${table.lastUsedAt}
        and ${table.lastUsedAt} < ${table.expiresAt}`,
    ),
  ],
);

export const playbackSessions = sqliteTable(
  "playback_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serviceIdentityLinkId: text("service_identity_link_id").notNull(),
    linkRevision: integer("link_revision").notNull(),
    mediaReferenceId: text("media_reference_id")
      .notNull()
      .references(() => mediaReferences.id, { onDelete: "cascade" }),
    encryptedPayload: text("encrypted_payload").notNull(),
    state: text("state", { enum: ["negotiated", "playing", "paused", "stopped"] }).notNull(),
    positionSeconds: integer("position_seconds").notNull(),
    revision: integer("revision").notNull().default(0),
    lastReportedAt: integer("last_reported_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("playback_sessions_user_updated_idx").on(table.userId, table.updatedAt),
    index("playback_sessions_expiry_idx").on(table.expiresAt),
    foreignKey({
      columns: [table.serviceIdentityLinkId, table.userId],
      foreignColumns: [serviceIdentityLinks.id, serviceIdentityLinks.userId],
      name: "playback_sessions_service_identity_link_fk",
    }).onDelete("cascade"),
    check(
      "playback_sessions_id_check",
      sql`length(${table.id}) = 31
        and substr(${table.id}, 1, 9) = 'playback_'
        and substr(${table.id}, 10) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "playback_sessions_payload_check",
      sql`length(${table.encryptedPayload}) between 1 and 65536`,
    ),
    check(
      "playback_sessions_state_check",
      sql`${table.state} in ('negotiated', 'playing', 'paused', 'stopped')`,
    ),
    check("playback_sessions_position_check", sql`${table.positionSeconds} between 0 and 10000000`),
    check(
      "playback_sessions_link_revision_check",
      sql`${table.linkRevision} between 0 and 2147483647`,
    ),
    check("playback_sessions_revision_check", sql`${table.revision} between 0 and 2147483647`),
    check(
      "playback_sessions_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}
        and ${table.createdAt} < ${table.expiresAt}
        and (${table.lastReportedAt} is null or ${table.lastReportedAt} between ${table.createdAt} and ${table.updatedAt})`,
    ),
  ],
);

export const playbackAssetHandles = sqliteTable(
  "playback_asset_handles",
  {
    id: text("id").primaryKey(),
    playbackSessionId: text("playback_session_id")
      .notNull()
      .references(() => playbackSessions.id, { onDelete: "cascade" }),
    targetDigest: text("target_digest").notNull(),
    encryptedTarget: text("encrypted_target").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("playback_asset_handles_session_target_idx").on(
      table.playbackSessionId,
      table.targetDigest,
    ),
    index("playback_asset_handles_expiry_idx").on(table.expiresAt),
    check(
      "playback_asset_handles_id_check",
      sql`length(${table.id}) = 31
        and substr(${table.id}, 1, 9) = 'asset_h1.'
        and substr(${table.id}, 10) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "playback_asset_handles_target_digest_check",
      sql`length(${table.targetDigest}) = 22
        and ${table.targetDigest} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "playback_asset_handles_target_check",
      sql`length(${table.encryptedTarget}) between 1 and 65536`,
    ),
    check(
      "playback_asset_handles_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}
        and ${table.createdAt} <= ${table.lastUsedAt}
        and ${table.lastUsedAt} < ${table.expiresAt}`,
    ),
  ],
);

export const mediaIssues = sqliteTable(
  "media_issues",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serviceIdentityLinkId: text("service_identity_link_id").notNull(),
    mediaReferenceId: text("media_reference_id")
      .notNull()
      .references(() => mediaReferences.id, { onDelete: "cascade" }),
    playbackSessionId: text("playback_session_id").notNull(),
    category: text("category", {
      enum: ["audio", "buffering", "subtitles", "sync", "video_quality", "other"],
    }).notNull(),
    encryptedDescription: text("encrypted_description"),
    positionSeconds: integer("position_seconds").notNull(),
    state: text("state", { enum: ["open", "resolved"] })
      .notNull()
      .default("open"),
    encryptedResolution: text("encrypted_resolution"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    index("media_issues_state_created_idx").on(table.state, table.createdAt),
    index("media_issues_user_created_idx").on(table.userId, table.createdAt),
    index("media_issues_media_created_idx").on(table.mediaReferenceId, table.createdAt),
    foreignKey({
      columns: [table.serviceIdentityLinkId, table.userId],
      foreignColumns: [serviceIdentityLinks.id, serviceIdentityLinks.userId],
      name: "media_issues_service_identity_link_fk",
    }).onDelete("cascade"),
    check(
      "media_issues_id_check",
      sql`length(${table.id}) = 28
        and substr(${table.id}, 1, 6) = 'issue_'
        and substr(${table.id}, 7) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "media_issues_playback_session_id_check",
      sql`length(${table.playbackSessionId}) = 31
        and substr(${table.playbackSessionId}, 1, 9) = 'playback_'
        and substr(${table.playbackSessionId}, 10) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "media_issues_category_check",
      sql`${table.category} in ('audio', 'buffering', 'subtitles', 'sync', 'video_quality', 'other')`,
    ),
    check(
      "media_issues_description_check",
      sql`${table.encryptedDescription} is null or length(${table.encryptedDescription}) between 1 and 8192`,
    ),
    check("media_issues_position_check", sql`${table.positionSeconds} between 0 and 10000000`),
    check("media_issues_state_check", sql`${table.state} in ('open', 'resolved')`),
    check(
      "media_issues_resolution_check",
      sql`(
          ${table.state} = 'open'
          and ${table.encryptedResolution} is null
          and ${table.resolvedByUserId} is null
          and ${table.resolvedAt} is null
        ) or (
          ${table.state} = 'resolved'
          and ${table.encryptedResolution} is not null
          and length(${table.encryptedResolution}) between 1 and 8192
          and ${table.resolvedByUserId} is not null
          and ${table.resolvedAt} is not null
        )`,
    ),
    check(
      "media_issues_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}
        and (${table.resolvedAt} is null or ${table.resolvedAt} between ${table.createdAt} and ${table.updatedAt})`,
    ),
  ],
);

export const externalIssueReferences = sqliteTable(
  "external_issue_references",
  {
    id: text("id").primaryKey(),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectorConfigs.id, { onDelete: "cascade" }),
    connectorInstanceGeneration: integer("connector_instance_generation").notNull().default(0),
    upstreamIdDigest: text("upstream_id_digest").notNull(),
    encryptedUpstreamId: text("encrypted_upstream_id").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("external_issue_references_connector_digest_unique").on(
      table.connectorId,
      table.upstreamIdDigest,
    ),
    index("external_issue_references_expiry_idx").on(table.expiresAt),
    check(
      "external_issue_references_id_check",
      sql`length(${table.id}) = 28
        and substr(${table.id}, 1, 6) = 'issue_'
        and substr(${table.id}, 7) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "external_issue_references_digest_check",
      sql`length(${table.upstreamIdDigest}) = 22
        and ${table.upstreamIdDigest} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "external_issue_references_payload_check",
      sql`length(${table.encryptedUpstreamId}) between 1 and 8192`,
    ),
    check(
      "external_issue_references_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}
        and ${table.createdAt} <= ${table.lastUsedAt}
        and ${table.lastUsedAt} < ${table.expiresAt}`,
    ),
  ],
);

export const subtitleSearches = sqliteTable(
  "subtitle_searches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serviceIdentityLinkId: text("service_identity_link_id").notNull(),
    linkRevision: integer("link_revision").notNull(),
    mediaReferenceId: text("media_reference_id")
      .notNull()
      .references(() => mediaReferences.id, { onDelete: "cascade" }),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectorConfigs.id, { onDelete: "cascade" }),
    connectorInstanceGeneration: integer("connector_instance_generation").notNull().default(0),
    encryptedPayload: text("encrypted_payload").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("subtitle_searches_user_created_idx").on(table.userId, table.createdAt),
    index("subtitle_searches_expiry_idx").on(table.expiresAt),
    index("subtitle_searches_media_idx").on(table.mediaReferenceId),
    foreignKey({
      columns: [table.serviceIdentityLinkId, table.userId],
      foreignColumns: [serviceIdentityLinks.id, serviceIdentityLinks.userId],
      name: "subtitle_searches_service_identity_link_fk",
    }).onDelete("cascade"),
    check(
      "subtitle_searches_id_check",
      sql`length(${table.id}) = 38
        and substr(${table.id}, 1, 16) = 'subtitle_search_'
        and substr(${table.id}, 17) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "subtitle_searches_payload_check",
      sql`length(${table.encryptedPayload}) between 1 and 4194304`,
    ),
    check(
      "subtitle_searches_link_revision_check",
      sql`${table.linkRevision} between 0 and 2147483647`,
    ),
    check(
      "subtitle_searches_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}
        and ${table.createdAt} < ${table.expiresAt}`,
    ),
  ],
);

export const subtitleDownloadOperations = sqliteTable(
  "subtitle_download_operations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    searchId: text("search_id").notNull(),
    resultId: text("result_id").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    state: text("state", {
      enum: ["pending", "reconcile_required", "uncertain", "succeeded", "failed"],
    })
      .notNull()
      .default("pending"),
    responseJson: text("response_json"),
    failureCode: text("failure_code"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("subtitle_download_operations_user_key_unique").on(
      table.userId,
      table.idempotencyKeyHash,
    ),
    index("subtitle_download_operations_state_created_idx").on(table.state, table.createdAt),
    check(
      "subtitle_download_operations_id_check",
      sql`length(${table.id}) = 40
        and substr(${table.id}, 1, 18) = 'subtitle_download_'
        and substr(${table.id}, 19) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "subtitle_download_operations_search_id_check",
      sql`length(${table.searchId}) = 38
        and substr(${table.searchId}, 1, 16) = 'subtitle_search_'
        and substr(${table.searchId}, 17) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "subtitle_download_operations_result_id_check",
      sql`length(${table.resultId}) = 38
        and substr(${table.resultId}, 1, 16) = 'subtitle_result_'
        and substr(${table.resultId}, 17) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "subtitle_download_operations_key_hash_check",
      sql`length(${table.idempotencyKeyHash}) = 43
        and ${table.idempotencyKeyHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "subtitle_download_operations_fingerprint_hash_check",
      sql`length(${table.fingerprintHash}) = 43
        and ${table.fingerprintHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "subtitle_download_operations_state_check",
      sql`${table.state} in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')`,
    ),
    check(
      "subtitle_download_operations_response_json_check",
      sql`${table.responseJson} is null
        or (json_valid(${table.responseJson}) and json_type(${table.responseJson}) = 'object')`,
    ),
    check(
      "subtitle_download_operations_outcome_check",
      sql`(
          ${table.state} = 'pending'
          and ${table.responseJson} is null
          and ${table.failureCode} is null
          and ${table.completedAt} is null
        ) or (
          ${table.state} = 'succeeded'
          and ${table.responseJson} is not null
          and ${table.failureCode} is null
          and ${table.completedAt} is not null
        ) or (
          ${table.state} in ('reconcile_required', 'uncertain', 'failed')
          and ${table.responseJson} is null
          and length(${table.failureCode}) between 1 and 64
          and ${table.completedAt} is not null
        )`,
    ),
    check(
      "subtitle_download_operations_timestamp_order_check",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const libraryArtworkSearches = sqliteTable(
  "library_artwork_searches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serviceIdentityLinkId: text("service_identity_link_id").notNull(),
    linkRevision: integer("link_revision").notNull(),
    mediaReferenceId: text("media_reference_id")
      .notNull()
      .references(() => mediaReferences.id, { onDelete: "cascade" }),
    encryptedPayload: text("encrypted_payload").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("library_artwork_searches_user_created_idx").on(table.userId, table.createdAt),
    index("library_artwork_searches_expiry_idx").on(table.expiresAt),
    index("library_artwork_searches_media_idx").on(table.mediaReferenceId),
    foreignKey({
      columns: [table.serviceIdentityLinkId, table.userId],
      foreignColumns: [serviceIdentityLinks.id, serviceIdentityLinks.userId],
      name: "library_artwork_searches_service_identity_link_fk",
    }).onDelete("cascade"),
    check(
      "library_artwork_searches_id_check",
      sql`length(${table.id}) = 45
        and substr(${table.id}, 1, 23) = 'library_artwork_search_'
        and substr(${table.id}, 24) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "library_artwork_searches_payload_check",
      sql`length(${table.encryptedPayload}) between 1 and 4194304`,
    ),
    check(
      "library_artwork_searches_link_revision_check",
      sql`${table.linkRevision} between 0 and 2147483647`,
    ),
    check(
      "library_artwork_searches_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}
        and ${table.createdAt} < ${table.expiresAt}`,
    ),
  ],
);

export const libraryMutationOperations = sqliteTable(
  "library_mutation_operations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["scan", "item_refresh", "metadata_update", "artwork_apply"],
    }).notNull(),
    referenceId: text("reference_id"),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    state: text("state", {
      enum: ["pending", "reconcile_required", "uncertain", "succeeded", "failed"],
    })
      .notNull()
      .default("pending"),
    responseJson: text("response_json"),
    failureCode: text("failure_code"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("library_mutation_operations_user_key_unique").on(
      table.userId,
      table.idempotencyKeyHash,
    ),
    index("library_mutation_operations_state_created_idx").on(table.state, table.createdAt),
    index("library_mutation_operations_reference_idx").on(table.referenceId, table.createdAt),
    check(
      "library_mutation_operations_id_check",
      sql`length(${table.id}) = 40
        and substr(${table.id}, 1, 18) = 'library_operation_'
        and substr(${table.id}, 19) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "library_mutation_operations_kind_check",
      sql`${table.kind} in ('scan', 'item_refresh', 'metadata_update', 'artwork_apply')`,
    ),
    check(
      "library_mutation_operations_reference_check",
      sql`(${table.kind} = 'scan' and ${table.referenceId} is null)
        or (${table.kind} <> 'scan'
          and length(${table.referenceId}) = 28
          and substr(${table.referenceId}, 1, 6) = 'media_'
          and substr(${table.referenceId}, 7) not glob '*[^A-Za-z0-9_-]*')`,
    ),
    check(
      "library_mutation_operations_key_hash_check",
      sql`length(${table.idempotencyKeyHash}) = 43
        and ${table.idempotencyKeyHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "library_mutation_operations_fingerprint_hash_check",
      sql`length(${table.fingerprintHash}) = 43
        and ${table.fingerprintHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "library_mutation_operations_state_check",
      sql`${table.state} in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')`,
    ),
    check(
      "library_mutation_operations_response_json_check",
      sql`${table.responseJson} is null
        or (json_valid(${table.responseJson}) and json_type(${table.responseJson}) = 'object')`,
    ),
    check(
      "library_mutation_operations_outcome_check",
      sql`(
          ${table.state} = 'pending'
          and ${table.responseJson} is null
          and ${table.failureCode} is null
          and ${table.completedAt} is null
        ) or (
          ${table.state} = 'succeeded'
          and ${table.responseJson} is not null
          and ${table.failureCode} is null
          and ${table.completedAt} is not null
        ) or (
          ${table.state} in ('reconcile_required', 'uncertain', 'failed')
          and ${table.responseJson} is null
          and length(${table.failureCode}) between 1 and 64
          and ${table.completedAt} is not null
        )`,
    ),
    check(
      "library_mutation_operations_timestamp_order_check",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const libraryRemovalPreviews = sqliteTable(
  "library_removal_previews",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    serviceIdentityLinkId: text("service_identity_link_id").notNull(),
    linkRevision: integer("link_revision").notNull(),
    mediaReferenceId: text("media_reference_id")
      .notNull()
      .references(() => mediaReferences.id, { onDelete: "cascade" }),
    encryptedPayload: text("encrypted_payload").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    index("library_removal_previews_expiry_idx").on(table.expiresAt),
    index("library_removal_previews_user_created_idx").on(table.userId, table.createdAt),
    foreignKey({
      columns: [table.serviceIdentityLinkId, table.userId],
      foreignColumns: [serviceIdentityLinks.id, serviceIdentityLinks.userId],
      name: "library_removal_previews_service_identity_link_fk",
    }).onDelete("cascade"),
    check(
      "library_removal_previews_id_check",
      sql`length(${table.id}) = 46
        and substr(${table.id}, 1, 24) = 'library_removal_preview_'
        and substr(${table.id}, 25) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "library_removal_previews_session_id_check",
      sql`length(${table.sessionId}) between 1 and 128
        and ${table.sessionId} not glob '*[^A-Za-z0-9._:-]*'`,
    ),
    check(
      "library_removal_previews_link_revision_check",
      sql`${table.linkRevision} between 0 and 2147483647`,
    ),
    check(
      "library_removal_previews_payload_check",
      sql`length(${table.encryptedPayload}) between 1 and 65536`,
    ),
    check(
      "library_removal_previews_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}
        and ${table.createdAt} < ${table.expiresAt}
        and (${table.consumedAt} is null
          or (${table.consumedAt} between ${table.createdAt} and ${table.expiresAt}
            and ${table.consumedAt} <= ${table.updatedAt}))`,
    ),
  ],
);

export const libraryRemovalOperations = sqliteTable(
  "library_removal_operations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    serviceIdentityLinkId: text("service_identity_link_id").notNull(),
    linkRevision: integer("link_revision").notNull(),
    mediaReferenceId: text("media_reference_id").notNull(),
    previewId: text("preview_id").notNull(),
    mode: text("mode", {
      enum: [
        "delete_files_keep_monitored",
        "delete_files_and_unmonitor",
        "remove_from_radarr_and_delete_files",
        "delete_unmanaged_files",
      ],
    }).notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    targetDigest: text("target_digest").notNull(),
    state: text("state", {
      enum: ["running", "succeeded", "reconcile_required", "uncertain", "failed"],
    })
      .notNull()
      .default("running"),
    responseJson: text("response_json").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    failureCode: text("failure_code"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("library_removal_operations_user_key_unique").on(
      table.userId,
      table.idempotencyKeyHash,
    ),
    uniqueIndex("library_removal_operations_preview_unique").on(table.previewId),
    uniqueIndex("library_removal_operations_running_target_unique")
      .on(table.targetDigest)
      .where(sql`${table.state} = 'running'`),
    index("library_removal_operations_state_created_idx").on(table.state, table.createdAt),
    index("library_removal_operations_reference_idx").on(table.mediaReferenceId, table.createdAt),
    check(
      "library_removal_operations_id_check",
      sql`length(${table.id}) = 48
        and substr(${table.id}, 1, 26) = 'library_removal_operation_'
        and substr(${table.id}, 27) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "library_removal_operations_preview_id_check",
      sql`length(${table.previewId}) = 46
        and substr(${table.previewId}, 1, 24) = 'library_removal_preview_'
        and substr(${table.previewId}, 25) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "library_removal_operations_reference_id_check",
      sql`length(${table.mediaReferenceId}) = 28
        and substr(${table.mediaReferenceId}, 1, 6) = 'media_'
        and substr(${table.mediaReferenceId}, 7) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "library_removal_operations_session_id_check",
      sql`length(${table.sessionId}) between 1 and 128
        and ${table.sessionId} not glob '*[^A-Za-z0-9._:-]*'`,
    ),
    check(
      "library_removal_operations_link_id_check",
      sql`length(${table.serviceIdentityLinkId}) between 1 and 128
        and ${table.serviceIdentityLinkId} not glob '*[^A-Za-z0-9._:-]*'`,
    ),
    check(
      "library_removal_operations_link_revision_check",
      sql`${table.linkRevision} between 0 and 2147483647`,
    ),
    check(
      "library_removal_operations_mode_check",
      sql`${table.mode} in (
        'delete_files_keep_monitored',
        'delete_files_and_unmonitor',
        'remove_from_radarr_and_delete_files',
        'delete_unmanaged_files'
      )`,
    ),
    check(
      "library_removal_operations_key_hash_check",
      sql`length(${table.idempotencyKeyHash}) = 43
        and ${table.idempotencyKeyHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "library_removal_operations_fingerprint_hash_check",
      sql`length(${table.fingerprintHash}) = 43
        and ${table.fingerprintHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "library_removal_operations_target_digest_check",
      sql`length(${table.targetDigest}) = 22
        and ${table.targetDigest} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "library_removal_operations_state_check",
      sql`${table.state} in ('running', 'succeeded', 'reconcile_required', 'uncertain', 'failed')`,
    ),
    check(
      "library_removal_operations_response_check",
      sql`length(${table.responseJson}) between 2 and 16384
        and json_valid(${table.responseJson})
        and json_type(${table.responseJson}) = 'object'`,
    ),
    check(
      "library_removal_operations_payload_check",
      sql`length(${table.encryptedPayload}) between 1 and 65536`,
    ),
    check(
      "library_removal_operations_outcome_check",
      sql`(
          ${table.state} = 'running'
          and ${table.failureCode} is null
          and ${table.completedAt} is null
        ) or (
          ${table.state} = 'succeeded'
          and ${table.failureCode} is null
          and ${table.completedAt} is not null
        ) or (
          ${table.state} in ('reconcile_required', 'uncertain', 'failed')
          and length(${table.failureCode}) between 1 and 64
          and ${table.completedAt} is not null
        )`,
    ),
    check(
      "library_removal_operations_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}
        and ${table.createdAt} <= ${table.startedAt}
        and (${table.completedAt} is null
          or (${table.completedAt} >= ${table.startedAt}
            and ${table.completedAt} <= ${table.updatedAt}))`,
    ),
  ],
);

export const userMediaStateOperations = sqliteTable(
  "user_media_state_operations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id")
      .notNull()
      .references(() => mediaReferences.id, { onDelete: "cascade" }),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    state: text("state", {
      enum: ["pending", "reconcile_required", "uncertain", "succeeded", "failed"],
    })
      .notNull()
      .default("pending"),
    responseJson: text("response_json"),
    failureCode: text("failure_code"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("user_media_state_operations_user_key_unique").on(
      table.userId,
      table.idempotencyKeyHash,
    ),
    index("user_media_state_operations_state_created_idx").on(table.state, table.createdAt),
    index("user_media_state_operations_reference_idx").on(table.referenceId, table.createdAt),
    check(
      "user_media_state_operations_id_check",
      sql`length(${table.id}) = 39
        and substr(${table.id}, 1, 17) = 'user_media_state_'
        and substr(${table.id}, 18) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "user_media_state_operations_reference_check",
      sql`length(${table.referenceId}) = 28
        and substr(${table.referenceId}, 1, 6) = 'media_'
        and substr(${table.referenceId}, 7) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "user_media_state_operations_key_hash_check",
      sql`length(${table.idempotencyKeyHash}) = 43
        and ${table.idempotencyKeyHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "user_media_state_operations_fingerprint_hash_check",
      sql`length(${table.fingerprintHash}) = 43
        and ${table.fingerprintHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "user_media_state_operations_state_check",
      sql`${table.state} in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')`,
    ),
    check(
      "user_media_state_operations_response_json_check",
      sql`${table.responseJson} is null
        or (json_valid(${table.responseJson}) and json_type(${table.responseJson}) = 'object')`,
    ),
    check(
      "user_media_state_operations_outcome_check",
      sql`(
          ${table.state} = 'pending'
          and ${table.responseJson} is null
          and ${table.failureCode} is null
          and ${table.completedAt} is null
        ) or (
          ${table.state} = 'succeeded'
          and ${table.responseJson} is not null
          and ${table.failureCode} is null
          and ${table.completedAt} is not null
        ) or (
          ${table.state} in ('reconcile_required', 'uncertain', 'failed')
          and ${table.responseJson} is null
          and length(${table.failureCode}) between 1 and 64
          and ${table.completedAt} is not null
        )`,
    ),
    check(
      "user_media_state_operations_timestamp_order_check",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const savedLists = sqliteTable(
  "saved_lists",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["watch_later", "custom"] }).notNull(),
    encryptedName: text("encrypted_name").notNull(),
    encryptedDescription: text("encrypted_description"),
    revision: integer("revision").notNull().default(0),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    undoExpiresAt: integer("undo_expires_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saved_lists_id_user_unique").on(table.id, table.userId),
    uniqueIndex("saved_lists_user_watch_later_unique")
      .on(table.userId)
      .where(sql`${table.kind} = 'watch_later'`),
    index("saved_lists_user_updated_idx").on(table.userId, table.deletedAt, table.updatedAt),
    index("saved_lists_undo_expiry_idx").on(table.undoExpiresAt),
    check(
      "saved_lists_id_check",
      sql`length(${table.id}) = 33
        and substr(${table.id}, 1, 11) = 'saved_list_'
        and substr(${table.id}, 12) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check("saved_lists_kind_check", sql`${table.kind} in ('watch_later', 'custom')`),
    check("saved_lists_name_check", sql`length(${table.encryptedName}) between 1 and 4096`),
    check(
      "saved_lists_description_check",
      sql`${table.encryptedDescription} is null
        or length(${table.encryptedDescription}) between 1 and 8192`,
    ),
    check("saved_lists_revision_check", sql`${table.revision} between 0 and 2147483647`),
    check(
      "saved_lists_deletion_check",
      sql`(
          ${table.kind} = 'watch_later'
          and ${table.deletedAt} is null
          and ${table.undoExpiresAt} is null
        ) or (
          ${table.kind} = 'custom'
          and (
            (${table.deletedAt} is null and ${table.undoExpiresAt} is null)
            or (${table.deletedAt} is not null and ${table.undoExpiresAt} > ${table.deletedAt})
          )
        )`,
    ),
    check(
      "saved_lists_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}
        and (${table.deletedAt} is null or ${table.deletedAt} between ${table.createdAt} and ${table.updatedAt})`,
    ),
  ],
);

export const savedCatalogItems = sqliteTable(
  "saved_catalog_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    identityDigest: text("identity_digest").notNull(),
    encryptedIdentity: text("encrypted_identity").notNull(),
    encryptedSnapshot: text("encrypted_snapshot").notNull(),
    libraryReferenceId: text("library_reference_id"),
    libraryReferenceUserId: text("library_reference_user_id"),
    lastResolvedAt: integer("last_resolved_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saved_catalog_items_id_user_unique").on(table.id, table.userId),
    uniqueIndex("saved_catalog_items_user_identity_unique").on(table.userId, table.identityDigest),
    index("saved_catalog_items_user_updated_idx").on(table.userId, table.updatedAt),
    index("saved_catalog_items_library_reference_idx").on(table.libraryReferenceId),
    foreignKey({
      columns: [table.libraryReferenceId, table.libraryReferenceUserId],
      foreignColumns: [mediaReferences.id, mediaReferences.userId],
      name: "saved_catalog_items_library_reference_fk",
    }).onDelete("set null"),
    check(
      "saved_catalog_items_id_check",
      sql`length(${table.id}) = 30
        and substr(${table.id}, 1, 8) = 'catalog_'
        and substr(${table.id}, 9) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "saved_catalog_items_identity_digest_check",
      sql`length(${table.identityDigest}) = 22
        and ${table.identityDigest} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "saved_catalog_items_identity_check",
      sql`length(${table.encryptedIdentity}) between 1 and 16384`,
    ),
    check(
      "saved_catalog_items_snapshot_check",
      sql`length(${table.encryptedSnapshot}) between 1 and 65536`,
    ),
    check(
      "saved_catalog_items_library_reference_check",
      sql`(
          ${table.libraryReferenceId} is null
          and ${table.libraryReferenceUserId} is null
        ) or (
          length(${table.libraryReferenceId}) = 28
          and substr(${table.libraryReferenceId}, 1, 6) = 'media_'
          and substr(${table.libraryReferenceId}, 7) not glob '*[^A-Za-z0-9_-]*'
          and ${table.libraryReferenceUserId} = ${table.userId}
        )`,
    ),
    check(
      "saved_catalog_items_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}
        and (${table.lastResolvedAt} is null or ${table.lastResolvedAt} between ${table.createdAt} and ${table.updatedAt})`,
    ),
  ],
);

export const savedListItems = sqliteTable(
  "saved_list_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    listId: text("list_id").notNull(),
    catalogItemId: text("catalog_item_id").notNull(),
    position: integer("position").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saved_list_items_list_catalog_unique").on(table.listId, table.catalogItemId),
    uniqueIndex("saved_list_items_list_position_unique").on(table.listId, table.position),
    index("saved_list_items_user_created_idx").on(table.userId, table.createdAt),
    index("saved_list_items_catalog_idx").on(table.catalogItemId),
    foreignKey({
      columns: [table.listId, table.userId],
      foreignColumns: [savedLists.id, savedLists.userId],
      name: "saved_list_items_list_owner_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.catalogItemId, table.userId],
      foreignColumns: [savedCatalogItems.id, savedCatalogItems.userId],
      name: "saved_list_items_catalog_owner_fk",
    }).onDelete("cascade"),
    check(
      "saved_list_items_id_check",
      sql`length(${table.id}) = 33
        and substr(${table.id}, 1, 11) = 'saved_item_'
        and substr(${table.id}, 12) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check("saved_list_items_position_check", sql`${table.position} between 0 and 499`),
    check(
      "saved_list_items_timestamp_order_check",
      sql`${table.createdAt} >= 0 and ${table.createdAt} <= ${table.updatedAt}`,
    ),
  ],
);

export const savedTargets = sqliteTable(
  "saved_targets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serviceIdentityLinkId: text("service_identity_link_id").notNull(),
    linkRevision: integer("link_revision").notNull(),
    identityDigest: text("identity_digest").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saved_targets_user_identity_unique").on(
      table.userId,
      table.serviceIdentityLinkId,
      table.linkRevision,
      table.identityDigest,
    ),
    index("saved_targets_expiry_idx").on(table.expiresAt),
    foreignKey({
      columns: [table.serviceIdentityLinkId, table.userId],
      foreignColumns: [serviceIdentityLinks.id, serviceIdentityLinks.userId],
      name: "saved_targets_service_identity_link_fk",
    }).onDelete("cascade"),
    check(
      "saved_targets_id_check",
      sql`length(${table.id}) = 34
        and substr(${table.id}, 1, 12) = 'save_target_'
        and substr(${table.id}, 13) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "saved_targets_identity_digest_check",
      sql`length(${table.identityDigest}) = 22
        and ${table.identityDigest} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "saved_targets_payload_check",
      sql`length(${table.encryptedPayload}) between 1 and 65536`,
    ),
    check("saved_targets_link_revision_check", sql`${table.linkRevision} between 0 and 2147483647`),
    check(
      "saved_targets_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}
        and ${table.createdAt} <= ${table.lastUsedAt}
        and ${table.lastUsedAt} < ${table.expiresAt}`,
    ),
  ],
);

export const savedListOperations = sqliteTable(
  "saved_list_operations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["create_list", "restore_list", "add_item", "reorder_items", "favorite"],
    }).notNull(),
    resourceId: text("resource_id"),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    state: text("state", {
      enum: ["pending", "succeeded", "reconcile_required", "uncertain", "failed"],
    })
      .notNull()
      .default("pending"),
    encryptedResponse: text("encrypted_response"),
    failureCode: text("failure_code"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saved_list_operations_user_key_unique").on(table.userId, table.idempotencyKeyHash),
    index("saved_list_operations_state_created_idx").on(table.state, table.createdAt),
    index("saved_list_operations_resource_idx").on(table.userId, table.resourceId, table.createdAt),
    check(
      "saved_list_operations_id_check",
      sql`length(${table.id}) = 38
        and substr(${table.id}, 1, 16) = 'saved_operation_'
        and substr(${table.id}, 17) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "saved_list_operations_kind_check",
      sql`${table.kind} in ('create_list', 'restore_list', 'add_item', 'reorder_items', 'favorite')`,
    ),
    check(
      "saved_list_operations_key_hash_check",
      sql`length(${table.idempotencyKeyHash}) = 43
        and ${table.idempotencyKeyHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "saved_list_operations_fingerprint_hash_check",
      sql`length(${table.fingerprintHash}) = 22
        and ${table.fingerprintHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "saved_list_operations_state_check",
      sql`${table.state} in ('pending', 'succeeded', 'reconcile_required', 'uncertain', 'failed')`,
    ),
    check(
      "saved_list_operations_response_check",
      sql`${table.encryptedResponse} is null
        or length(${table.encryptedResponse}) between 1 and 131072`,
    ),
    check(
      "saved_list_operations_outcome_check",
      sql`(
          ${table.state} = 'pending'
          and ${table.encryptedResponse} is null
          and ${table.failureCode} is null
          and ${table.completedAt} is null
        ) or (
          ${table.state} = 'succeeded'
          and ${table.encryptedResponse} is not null
          and ${table.failureCode} is null
          and ${table.completedAt} is not null
        ) or (
          ${table.state} in ('reconcile_required', 'uncertain', 'failed')
          and ${table.encryptedResponse} is null
          and length(${table.failureCode}) between 1 and 64
          and ${table.completedAt} is not null
        )`,
    ),
    check(
      "saved_list_operations_timestamp_order_check",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const downloadQueueRemovalOperations = sqliteTable(
  "download_queue_removal_operations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectorConfigs.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    state: text("state", {
      enum: ["pending", "reconcile_required", "uncertain", "succeeded", "failed"],
    })
      .notNull()
      .default("pending"),
    itemSnapshotJson: text("item_snapshot_json"),
    responseJson: text("response_json"),
    failureCode: text("failure_code"),
    mutationStartedAt: integer("mutation_started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("download_queue_removal_operations_user_key_unique").on(
      table.userId,
      table.idempotencyKeyHash,
    ),
    index("download_queue_removal_operations_state_created_idx").on(table.state, table.createdAt),
    index("download_queue_removal_operations_item_idx").on(
      table.connectorId,
      table.itemId,
      table.createdAt,
    ),
    check(
      "download_queue_removal_operations_id_check",
      sql`length(${table.id}) = 39
        and substr(${table.id}, 1, 17) = 'download_removal_'
        and substr(${table.id}, 18) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "download_queue_removal_operations_item_id_check",
      sql`length(${table.itemId}) = 31
        and substr(${table.itemId}, 1, 9) = 'download_'
        and substr(${table.itemId}, 10) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "download_queue_removal_operations_key_hash_check",
      sql`length(${table.idempotencyKeyHash}) = 43
        and ${table.idempotencyKeyHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "download_queue_removal_operations_fingerprint_hash_check",
      sql`length(${table.fingerprintHash}) = 43
        and ${table.fingerprintHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "download_queue_removal_operations_state_check",
      sql`${table.state} in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')`,
    ),
    check(
      "download_queue_removal_operations_item_snapshot_check",
      sql`${table.itemSnapshotJson} is null
        or (json_valid(${table.itemSnapshotJson}) and json_type(${table.itemSnapshotJson}) = 'object')`,
    ),
    check(
      "download_queue_removal_operations_response_json_check",
      sql`${table.responseJson} is null
        or (json_valid(${table.responseJson}) and json_type(${table.responseJson}) = 'object')`,
    ),
    check(
      "download_queue_removal_operations_outcome_check",
      sql`(
          ${table.state} = 'pending'
          and ${table.responseJson} is null
          and ${table.failureCode} is null
          and ${table.completedAt} is null
        ) or (
          ${table.state} = 'succeeded'
          and ${table.itemSnapshotJson} is not null
          and ${table.responseJson} is not null
          and ${table.failureCode} is null
          and ${table.mutationStartedAt} is not null
          and ${table.completedAt} is not null
        ) or (
          ${table.state} in ('reconcile_required', 'uncertain', 'failed')
          and ${table.responseJson} is null
          and length(${table.failureCode}) between 1 and 64
          and ${table.completedAt} is not null
        )`,
    ),
    check(
      "download_queue_removal_operations_timestamp_order_check",
      sql`(${table.mutationStartedAt} is null or ${table.mutationStartedAt} >= ${table.createdAt})
        and (${table.completedAt} is null or ${table.completedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const downloadQueueBulkOperations = sqliteTable(
  "download_queue_bulk_operations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    state: text("state", { enum: ["pending", "quarantined", "succeeded"] })
      .notNull()
      .default("pending"),
    requestJson: text("request_json").notNull(),
    resultsJson: text("results_json").notNull().default("[]"),
    responseJson: text("response_json"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("download_queue_bulk_operations_user_key_unique").on(
      table.userId,
      table.idempotencyKeyHash,
    ),
    index("download_queue_bulk_operations_state_created_idx").on(table.state, table.createdAt),
    check(
      "download_queue_bulk_operations_id_check",
      sql`length(${table.id}) = 36
        and substr(${table.id}, 1, 14) = 'download_bulk_'
        and substr(${table.id}, 15) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "download_queue_bulk_operations_key_hash_check",
      sql`length(${table.idempotencyKeyHash}) = 43
        and ${table.idempotencyKeyHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "download_queue_bulk_operations_fingerprint_hash_check",
      sql`length(${table.fingerprintHash}) = 43
        and ${table.fingerprintHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "download_queue_bulk_operations_state_check",
      sql`${table.state} in ('pending', 'quarantined', 'succeeded')`,
    ),
    check(
      "download_queue_bulk_operations_request_json_check",
      sql`json_valid(${table.requestJson}) and json_type(${table.requestJson}) = 'object'`,
    ),
    check(
      "download_queue_bulk_operations_results_json_check",
      sql`json_valid(${table.resultsJson}) and json_type(${table.resultsJson}) = 'array'`,
    ),
    check(
      "download_queue_bulk_operations_response_json_check",
      sql`${table.responseJson} is null
        or (json_valid(${table.responseJson}) and json_type(${table.responseJson}) = 'object')`,
    ),
    check(
      "download_queue_bulk_operations_outcome_check",
      sql`(
          ${table.state} = 'pending'
          and ${table.responseJson} is null
          and ${table.completedAt} is null
        ) or (
          ${table.state} = 'quarantined'
          and ${table.responseJson} is null
          and ${table.completedAt} is not null
        ) or (
          ${table.state} = 'succeeded'
          and ${table.responseJson} is not null
          and ${table.completedAt} is not null
        )`,
    ),
    check(
      "download_queue_bulk_operations_timestamp_order_check",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.createdAt}`,
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
    index("sessions_user_created_idx").on(table.userId, table.createdAt),
    index("sessions_user_active_idx").on(
      table.userId,
      table.revokedAt,
      table.expiresAt,
      table.absoluteExpiresAt,
    ),
    index("sessions_recovery_created_idx")
      .on(table.createdAt)
      .where(sql`${table.authMethod} = 'recovery'`),
    index("sessions_active_recovery_idx")
      .on(table.revokedAt)
      .where(sql`${table.authMethod} = 'recovery' and ${table.revokedAt} is null`),
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

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    registrationHandoffHash: text("registration_handoff_hash"),
    registrationHandoffExpiresAt: integer("registration_handoff_expires_at", {
      mode: "timestamp_ms",
    }),
    activationOperationId: text("activation_operation_id"),
    activationClaimedAt: integer("activation_claimed_at", { mode: "timestamp_ms" }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex("invitations_token_hash_unique").on(table.tokenHash),
    uniqueIndex("invitations_registration_handoff_hash_unique")
      .on(table.registrationHandoffHash)
      .where(sql`${table.registrationHandoffHash} is not null`),
    uniqueIndex("invitations_activation_operation_unique")
      .on(table.activationOperationId)
      .where(sql`${table.activationOperationId} is not null`),
    index("invitations_created_idx").on(table.createdAt, table.id),
    index("invitations_expiry_idx").on(table.expiresAt),
    check(
      "invitations_id_check",
      sql`length(${table.id}) between 8 and 128
        and substr(${table.id}, 1, 7) = 'invite_'
        and substr(${table.id}, 8) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "invitations_token_hash_check",
      sql`length(${table.tokenHash}) = 43 and ${table.tokenHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "invitations_registration_handoff_hash_check",
      sql`${table.registrationHandoffHash} is null or (
        length(${table.registrationHandoffHash}) = 43
        and ${table.registrationHandoffHash} not glob '*[^A-Za-z0-9_-]*'
      )`,
    ),
    check(
      "invitations_timestamp_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} < ${table.expiresAt}
        and (${table.consumedAt} is null or (${table.consumedAt} >= ${table.createdAt} and ${table.consumedAt} < ${table.expiresAt}))
        and (${table.revokedAt} is null or (${table.revokedAt} >= ${table.createdAt} and ${table.revokedAt} < ${table.expiresAt}))
        and (${table.consumedAt} is null or ${table.revokedAt} is null)
        and (${table.activationClaimedAt} is null or (
          ${table.consumedAt} is not null
          and ${table.activationClaimedAt} = ${table.consumedAt}
          and ${table.activationClaimedAt} < ${table.expiresAt}
        ))
        and ((${table.registrationHandoffHash} is null and ${table.registrationHandoffExpiresAt} is null)
          or (${table.registrationHandoffHash} is not null and ${table.registrationHandoffExpiresAt} is not null))
        and (${table.consumedAt} is null and ${table.revokedAt} is null
          or ${table.registrationHandoffHash} is null and ${table.registrationHandoffExpiresAt} is null)
        and (${table.registrationHandoffExpiresAt} is null
          or (${table.registrationHandoffExpiresAt} >= ${table.createdAt}
            and ${table.registrationHandoffExpiresAt} <= ${table.expiresAt}))`,
    ),
  ],
);

export const mediaDownloadGrants = sqliteTable(
  "media_download_grants",
  {
    id: text("id").primaryKey(),
    publicTokenHash: text("public_token_hash").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    serviceIdentityLinkId: text("service_identity_link_id").notNull(),
    linkRevision: integer("link_revision").notNull(),
    referenceId: text("reference_id")
      .notNull()
      .references(() => mediaReferences.id, { onDelete: "cascade" }),
    encryptedPayload: text("encrypted_payload").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    state: text("state", {
      enum: ["prepared", "streaming", "completed", "cancelled", "failed"],
    })
      .notNull()
      .default("prepared"),
    bytesTransferred: integer("bytes_transferred").notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("media_download_grants_public_token_unique").on(table.publicTokenHash),
    index("media_download_grants_user_expiry_idx").on(table.userId, table.expiresAt),
    index("media_download_grants_session_idx").on(table.sessionId),
    index("media_download_grants_expiry_idx").on(table.expiresAt),
    foreignKey({
      columns: [table.serviceIdentityLinkId, table.userId],
      foreignColumns: [serviceIdentityLinks.id, serviceIdentityLinks.userId],
      name: "media_download_grants_link_fk",
    }).onDelete("cascade"),
    check(
      "media_download_grants_id_check",
      sql`length(${table.id}) = 37
        and substr(${table.id}, 1, 15) = 'download_grant_'
        and substr(${table.id}, 16) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "media_download_grants_public_token_hash_check",
      sql`length(${table.publicTokenHash}) = 43
        and ${table.publicTokenHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "media_download_grants_link_revision_check",
      sql`${table.linkRevision} between 0 and 2147483647`,
    ),
    check(
      "media_download_grants_payload_check",
      sql`length(${table.encryptedPayload}) between 1 and 32768`,
    ),
    check("media_download_grants_filename_check", sql`length(${table.filename}) between 1 and 240`),
    check(
      "media_download_grants_content_type_check",
      sql`length(${table.contentType}) between 3 and 128`,
    ),
    check(
      "media_download_grants_size_check",
      sql`${table.sizeBytes} between 1 and 140737488355328
        and ${table.bytesTransferred} between 0 and ${table.sizeBytes}`,
    ),
    check(
      "media_download_grants_state_check",
      sql`${table.state} in ('prepared', 'streaming', 'completed', 'cancelled', 'failed')`,
    ),
    check(
      "media_download_grants_timestamp_order_check",
      sql`${table.createdAt} < ${table.expiresAt}
        and ${table.updatedAt} >= ${table.createdAt}
        and (${table.startedAt} is null or ${table.startedAt} between ${table.createdAt} and ${table.updatedAt})
        and (${table.completedAt} is null or (
          ${table.startedAt} is not null
          and ${table.completedAt} between ${table.startedAt} and ${table.updatedAt}
        ))`,
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

export const jellyfinQuickConnectTransactions = sqliteTable(
  "jellyfin_quick_connect_transactions",
  {
    id: text("id").primaryKey(),
    connectorId: text("connector_id").notNull(),
    connectorInstanceGeneration: integer("connector_instance_generation").notNull().default(0),
    connectorType: text("connector_type", { enum: ["jellyfin"] })
      .notNull()
      .default("jellyfin"),
    purpose: text("purpose", { enum: ["sign_in", "pairing", "bootstrap"] })
      .notNull()
      .default("sign_in"),
    pairingSessionId: text("pairing_session_id").references(() => sessions.id, {
      onDelete: "cascade",
    }),
    browserBindingHash: text("browser_binding_hash").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    nextPollAt: integer("next_poll_at", { mode: "timestamp_ms" }).notNull(),
    pollCount: integer("poll_count").notNull().default(0),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("jellyfin_quick_connect_transactions_expiry_idx").on(table.expiresAt),
    index("jellyfin_quick_connect_transactions_browser_expiry_idx").on(
      table.browserBindingHash,
      table.expiresAt,
    ),
    index("jellyfin_quick_connect_transactions_pairing_session_idx").on(
      table.pairingSessionId,
      table.expiresAt,
    ),
    foreignKey({
      columns: [table.connectorId, table.connectorType],
      foreignColumns: [connectorConfigs.id, connectorConfigs.type],
      name: "jellyfin_quick_connect_transactions_connector_type_fk",
    })
      .onDelete("cascade")
      .onUpdate("restrict"),
    check(
      "jellyfin_quick_connect_transactions_binding_hash_check",
      sql`length(${table.browserBindingHash}) = 43
        and ${table.browserBindingHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "jellyfin_quick_connect_transactions_connector_type_check",
      sql`${table.connectorType} = 'jellyfin'`,
    ),
    check(
      "jellyfin_quick_connect_transactions_purpose_check",
      sql`(${table.purpose} = 'sign_in' and ${table.pairingSessionId} is null)
        or (${table.purpose} in ('pairing', 'bootstrap') and ${table.pairingSessionId} is not null)`,
    ),
    check(
      "jellyfin_quick_connect_transactions_poll_count_check",
      sql`typeof(${table.pollCount}) = 'integer' and ${table.pollCount} between 0 and 512`,
    ),
    check(
      "jellyfin_quick_connect_transactions_timestamp_order_check",
      sql`${table.createdAt} < ${table.expiresAt}
        and ${table.nextPollAt} >= ${table.createdAt}
        and ${table.nextPollAt} <= ${table.expiresAt}
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

export const mediaRequestOperations = sqliteTable(
  "media_request_operations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    state: text("state", {
      enum: ["pending", "reconcile_required", "uncertain", "succeeded", "failed"],
    })
      .notNull()
      .default("pending"),
    responseJson: text("response_json"),
    failureCode: text("failure_code"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("media_request_operations_user_key_unique").on(
      table.userId,
      table.idempotencyKeyHash,
    ),
    index("media_request_operations_state_created_idx").on(table.state, table.createdAt),
    check(
      "media_request_operations_key_hash_check",
      sql`length(${table.idempotencyKeyHash}) = 43
        and ${table.idempotencyKeyHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "media_request_operations_fingerprint_hash_check",
      sql`length(${table.fingerprintHash}) = 43
        and ${table.fingerprintHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "media_request_operations_state_check",
      sql`${table.state} in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')`,
    ),
    check(
      "media_request_operations_response_json_check",
      sql`${table.responseJson} is null
        or (json_valid(${table.responseJson}) and json_type(${table.responseJson}) = 'object')`,
    ),
    check(
      "media_request_operations_outcome_check",
      sql`(
          ${table.state} = 'pending'
          and ${table.responseJson} is null
          and ${table.failureCode} is null
          and ${table.completedAt} is null
        ) or (
          ${table.state} = 'succeeded'
          and ${table.responseJson} is not null
          and ${table.failureCode} is null
          and ${table.completedAt} is not null
        ) or (
          ${table.state} in ('reconcile_required', 'uncertain', 'failed')
          and ${table.responseJson} is null
          and length(${table.failureCode}) between 1 and 64
          and ${table.completedAt} is not null
        )`,
    ),
    check(
      "media_request_operations_timestamp_order_check",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const mediaIssueOperations = sqliteTable(
  "media_issue_operations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    issueId: text("issue_id").notNull(),
    source: text("source", { enum: ["omnifin", "seerr"] }).notNull(),
    desiredStatus: text("desired_status", { enum: ["open", "resolved"] }).notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    state: text("state", {
      enum: ["pending", "reconcile_required", "uncertain", "succeeded", "failed"],
    })
      .notNull()
      .default("pending"),
    responseJson: text("response_json"),
    failureCode: text("failure_code"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("media_issue_operations_user_key_unique").on(
      table.userId,
      table.idempotencyKeyHash,
    ),
    index("media_issue_operations_state_created_idx").on(table.state, table.createdAt),
    index("media_issue_operations_issue_created_idx").on(table.issueId, table.createdAt),
    check(
      "media_issue_operations_id_check",
      sql`length(${table.id}) = 38
        and substr(${table.id}, 1, 16) = 'issue_operation_'
        and substr(${table.id}, 17) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "media_issue_operations_issue_id_check",
      sql`length(${table.issueId}) = 28
        and substr(${table.issueId}, 1, 6) = 'issue_'
        and substr(${table.issueId}, 7) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check("media_issue_operations_source_check", sql`${table.source} in ('omnifin', 'seerr')`),
    check(
      "media_issue_operations_desired_status_check",
      sql`${table.desiredStatus} in ('open', 'resolved')`,
    ),
    check(
      "media_issue_operations_key_hash_check",
      sql`length(${table.idempotencyKeyHash}) = 43
        and ${table.idempotencyKeyHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "media_issue_operations_fingerprint_hash_check",
      sql`length(${table.fingerprintHash}) = 43
        and ${table.fingerprintHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "media_issue_operations_state_check",
      sql`${table.state} in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')`,
    ),
    check(
      "media_issue_operations_response_json_check",
      sql`${table.responseJson} is null
        or (json_valid(${table.responseJson}) and json_type(${table.responseJson}) = 'object')`,
    ),
    check(
      "media_issue_operations_outcome_check",
      sql`(
          ${table.state} = 'pending'
          and ${table.responseJson} is null
          and ${table.failureCode} is null
          and ${table.completedAt} is null
        ) or (
          ${table.state} = 'succeeded'
          and ${table.responseJson} is not null
          and ${table.failureCode} is null
          and ${table.completedAt} is not null
        ) or (
          ${table.state} in ('reconcile_required', 'uncertain', 'failed')
          and ${table.responseJson} is null
          and length(${table.failureCode}) between 1 and 64
          and ${table.completedAt} is not null
        )`,
    ),
    check(
      "media_issue_operations_timestamp_order_check",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const acquisitionSearchOperations = sqliteTable(
  "acquisition_search_operations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    state: text("state", {
      enum: ["pending", "reconcile_required", "uncertain", "succeeded", "failed"],
    })
      .notNull()
      .default("pending"),
    responseJson: text("response_json"),
    failureCode: text("failure_code"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("acquisition_search_operations_user_key_unique").on(
      table.userId,
      table.idempotencyKeyHash,
    ),
    index("acquisition_search_operations_state_created_idx").on(table.state, table.createdAt),
    check(
      "acquisition_search_operations_key_hash_check",
      sql`length(${table.idempotencyKeyHash}) = 43
        and ${table.idempotencyKeyHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "acquisition_search_operations_fingerprint_hash_check",
      sql`length(${table.fingerprintHash}) = 43
        and ${table.fingerprintHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "acquisition_search_operations_state_check",
      sql`${table.state} in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')`,
    ),
    check(
      "acquisition_search_operations_response_json_check",
      sql`${table.responseJson} is null
        or (json_valid(${table.responseJson}) and json_type(${table.responseJson}) = 'object')`,
    ),
    check(
      "acquisition_search_operations_outcome_check",
      sql`(
          ${table.state} = 'pending'
          and ${table.responseJson} is null
          and ${table.failureCode} is null
          and ${table.completedAt} is null
        ) or (
          ${table.state} = 'succeeded'
          and ${table.responseJson} is not null
          and ${table.failureCode} is null
          and ${table.completedAt} is not null
        ) or (
          ${table.state} in ('reconcile_required', 'uncertain', 'failed')
          and ${table.responseJson} is null
          and length(${table.failureCode}) between 1 and 64
          and ${table.completedAt} is not null
        )`,
    ),
    check(
      "acquisition_search_operations_timestamp_order_check",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const acquisitionQueueRecoveryOperations = sqliteTable(
  "acquisition_queue_recovery_operations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectorConfigs.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    state: text("state", {
      enum: ["pending", "reconcile_required", "uncertain", "succeeded", "failed"],
    })
      .notNull()
      .default("pending"),
    eventSnapshotJson: text("event_snapshot_json"),
    responseJson: text("response_json"),
    failureCode: text("failure_code"),
    mutationStartedAt: integer("mutation_started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("acquisition_queue_recovery_operations_user_key_unique").on(
      table.userId,
      table.idempotencyKeyHash,
    ),
    index("acquisition_queue_recovery_operations_state_created_idx").on(
      table.state,
      table.createdAt,
    ),
    index("acquisition_queue_recovery_operations_event_idx").on(
      table.connectorId,
      table.eventId,
      table.createdAt,
    ),
    check(
      "acquisition_queue_recovery_operations_id_check",
      sql`length(${table.id}) = 43
        and substr(${table.id}, 1, 21) = 'acquisition_recovery_'
        and substr(${table.id}, 22) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "acquisition_queue_recovery_operations_event_id_check",
      sql`length(${table.eventId}) = 34
        and substr(${table.eventId}, 1, 12) = 'acquisition_'
        and substr(${table.eventId}, 13) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "acquisition_queue_recovery_operations_key_hash_check",
      sql`length(${table.idempotencyKeyHash}) = 43
        and ${table.idempotencyKeyHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "acquisition_queue_recovery_operations_fingerprint_hash_check",
      sql`length(${table.fingerprintHash}) = 43
        and ${table.fingerprintHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "acquisition_queue_recovery_operations_state_check",
      sql`${table.state} in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')`,
    ),
    check(
      "acquisition_queue_recovery_operations_event_snapshot_check",
      sql`${table.eventSnapshotJson} is null
        or (json_valid(${table.eventSnapshotJson}) and json_type(${table.eventSnapshotJson}) = 'object')`,
    ),
    check(
      "acquisition_queue_recovery_operations_response_json_check",
      sql`${table.responseJson} is null
        or (json_valid(${table.responseJson}) and json_type(${table.responseJson}) = 'object')`,
    ),
    check(
      "acquisition_queue_recovery_operations_outcome_check",
      sql`(
          ${table.state} = 'pending'
          and ${table.responseJson} is null
          and ${table.failureCode} is null
          and ${table.completedAt} is null
        ) or (
          ${table.state} = 'succeeded'
          and ${table.eventSnapshotJson} is not null
          and ${table.responseJson} is not null
          and ${table.failureCode} is null
          and ${table.mutationStartedAt} is not null
          and ${table.completedAt} is not null
        ) or (
          ${table.state} in ('reconcile_required', 'uncertain', 'failed')
          and ${table.responseJson} is null
          and length(${table.failureCode}) between 1 and 64
          and ${table.completedAt} is not null
        )`,
    ),
    check(
      "acquisition_queue_recovery_operations_timestamp_order_check",
      sql`(${table.mutationStartedAt} is null or ${table.mutationStartedAt} >= ${table.createdAt})
        and (${table.completedAt} is null or ${table.completedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const acquisitionGrabOperations = sqliteTable(
  "acquisition_grab_operations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    state: text("state", {
      enum: ["pending", "reconcile_required", "uncertain", "succeeded", "failed"],
    })
      .notNull()
      .default("pending"),
    responseJson: text("response_json"),
    failureCode: text("failure_code"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("acquisition_grab_operations_user_key_unique").on(
      table.userId,
      table.idempotencyKeyHash,
    ),
    index("acquisition_grab_operations_state_created_idx").on(table.state, table.createdAt),
    check(
      "acquisition_grab_operations_key_hash_check",
      sql`length(${table.idempotencyKeyHash}) = 43
        and ${table.idempotencyKeyHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "acquisition_grab_operations_fingerprint_hash_check",
      sql`length(${table.fingerprintHash}) = 43
        and ${table.fingerprintHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "acquisition_grab_operations_state_check",
      sql`${table.state} in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')`,
    ),
    check(
      "acquisition_grab_operations_response_json_check",
      sql`${table.responseJson} is null
        or (json_valid(${table.responseJson}) and json_type(${table.responseJson}) = 'object')`,
    ),
    check(
      "acquisition_grab_operations_outcome_check",
      sql`(
          ${table.state} = 'pending'
          and ${table.responseJson} is null
          and ${table.failureCode} is null
          and ${table.completedAt} is null
        ) or (
          ${table.state} = 'succeeded'
          and ${table.responseJson} is not null
          and ${table.failureCode} is null
          and ${table.completedAt} is not null
        ) or (
          ${table.state} in ('reconcile_required', 'uncertain', 'failed')
          and ${table.responseJson} is null
          and length(${table.failureCode}) between 1 and 64
          and ${table.completedAt} is not null
        )`,
    ),
    check(
      "acquisition_grab_operations_timestamp_order_check",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const externalMutationDispatches = sqliteTable(
  "external_mutation_dispatches",
  {
    id: text("id").primaryKey(),
    kind: text("kind", {
      enum: [
        "media_request.submit",
        "media_issue.update",
        "subtitle.download",
        "library.scan",
        "library.item_refresh",
        "library.metadata_update",
        "library.artwork_apply",
        "library.remove_files",
        "library.unmonitor",
        "library.remove_manager_record",
        "user_media_state.update",
        "download_queue.remove",
        "download_queue.pause",
        "download_queue.resume",
        "download_queue.promote",
        "acquisition.queue_recover",
        "acquisition.grab",
        "acquisition.search",
        "saved.favorite",
        "playback.progress",
      ],
    }).notNull(),
    parentOperationType: text("parent_operation_type", {
      enum: [
        "media_request_operation",
        "media_issue_operation",
        "subtitle_download_operation",
        "library_mutation_operation",
        "library_removal_operation",
        "user_media_state_operation",
        "download_queue_removal_operation",
        "download_queue_item_operation",
        "acquisition_queue_recovery_operation",
        "acquisition_grab_operation",
        "acquisition_search_operation",
        "saved_list_operation",
        "playback_progress_operation",
      ],
    }).notNull(),
    parentOperationId: text("parent_operation_id").notNull(),
    userId: text("user_id").notNull(),
    connectorId: text("connector_id").notNull(),
    connectorInstanceGeneration: integer("connector_instance_generation").notNull(),
    connectorConfigGeneration: integer("connector_config_generation").notNull(),
    state: text("state", {
      enum: ["reserved", "dispatched", "reconcile_required", "uncertain", "succeeded", "failed"],
    })
      .notNull()
      .default("reserved"),
    encryptedNormalizedRequest: text("encrypted_normalized_request").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    dispatchAttemptCount: integer("dispatch_attempt_count").notNull().default(0),
    dispatchedAt: integer("dispatched_at", { mode: "timestamp_ms" }),
    reconcileRequiredAt: integer("reconcile_required_at", { mode: "timestamp_ms" }),
    uncertainAt: integer("uncertain_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    failureCode: text("failure_code"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("external_mutation_dispatches_parent_kind_unique").on(
      table.parentOperationType,
      table.parentOperationId,
      table.kind,
    ),
    index("external_mutation_dispatches_state_lease_idx").on(table.state, table.leaseExpiresAt),
    index("external_mutation_dispatches_connector_generation_idx").on(
      table.connectorId,
      table.connectorInstanceGeneration,
      table.connectorConfigGeneration,
    ),
    index("external_mutation_dispatches_user_created_idx").on(table.userId, table.createdAt),
    check(
      "external_mutation_dispatches_id_check",
      sql`length(${table.id}) = 40
        and substr(${table.id}, 1, 18) = 'mutation_dispatch_'
        and substr(${table.id}, 19) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "external_mutation_dispatches_kind_check",
      sql`${table.kind} in (
        'media_request.submit', 'media_issue.update', 'subtitle.download',
        'library.scan', 'library.item_refresh', 'library.metadata_update',
        'library.artwork_apply', 'library.remove_files', 'library.unmonitor',
        'library.remove_manager_record', 'user_media_state.update',
        'download_queue.remove', 'download_queue.pause', 'download_queue.resume',
        'download_queue.promote', 'acquisition.queue_recover', 'acquisition.grab',
        'acquisition.search',
        'saved.favorite', 'playback.progress'
      )`,
    ),
    check(
      "external_mutation_dispatches_parent_kind_check",
      sql`(${table.kind} = 'media_request.submit'
          and ${table.parentOperationType} = 'media_request_operation')
        or (${table.kind} = 'media_issue.update'
          and ${table.parentOperationType} = 'media_issue_operation')
        or (${table.kind} = 'subtitle.download'
          and ${table.parentOperationType} = 'subtitle_download_operation')
        or (${table.kind} in ('library.scan', 'library.item_refresh',
              'library.metadata_update', 'library.artwork_apply')
          and ${table.parentOperationType} = 'library_mutation_operation')
        or (${table.kind} in ('library.remove_files', 'library.unmonitor',
              'library.remove_manager_record')
          and ${table.parentOperationType} = 'library_removal_operation')
        or (${table.kind} = 'user_media_state.update'
          and ${table.parentOperationType} = 'user_media_state_operation')
        or (${table.kind} = 'download_queue.remove'
          and ${table.parentOperationType} = 'download_queue_removal_operation')
        or (${table.kind} in ('download_queue.pause', 'download_queue.resume',
              'download_queue.promote')
          and ${table.parentOperationType} = 'download_queue_item_operation')
        or (${table.kind} = 'acquisition.queue_recover'
          and ${table.parentOperationType} = 'acquisition_queue_recovery_operation')
        or (${table.kind} = 'acquisition.grab'
          and ${table.parentOperationType} = 'acquisition_grab_operation')
        or (${table.kind} = 'acquisition.search'
          and ${table.parentOperationType} = 'acquisition_search_operation')
        or (${table.kind} = 'saved.favorite'
          and ${table.parentOperationType} = 'saved_list_operation')
        or (${table.kind} = 'playback.progress'
          and ${table.parentOperationType} = 'playback_progress_operation')`,
    ),
    check(
      "external_mutation_dispatches_parent_id_check",
      sql`length(${table.parentOperationId}) between 1 and 128
        and ${table.parentOperationId} not glob '*[^A-Za-z0-9._:-]*'`,
    ),
    check(
      "external_mutation_dispatches_snapshot_check",
      sql`length(${table.userId}) between 1 and 128
        and length(${table.connectorId}) between 1 and 128
        and typeof(${table.connectorInstanceGeneration}) = 'integer'
        and ${table.connectorInstanceGeneration} between 0 and 9007199254740991
        and typeof(${table.connectorConfigGeneration}) = 'integer'
        and ${table.connectorConfigGeneration} between 0 and 9007199254740991`,
    ),
    check(
      "external_mutation_dispatches_request_check",
      sql`length(${table.encryptedNormalizedRequest}) between 1 and 4194304`,
    ),
    check(
      "external_mutation_dispatches_attempt_count_check",
      sql`typeof(${table.dispatchAttemptCount}) = 'integer'
        and ${table.dispatchAttemptCount} between 0 and 2147483647`,
    ),
    check(
      "external_mutation_dispatches_state_check",
      sql`${table.state} in ('reserved', 'dispatched', 'reconcile_required',
        'uncertain', 'succeeded', 'failed')`,
    ),
    check(
      "external_mutation_dispatches_state_invariants_check",
      sql`(
          ${table.state} = 'reserved'
          and length(${table.leaseOwner}) between 1 and 128
          and ${table.leaseExpiresAt} is not null
          and ${table.dispatchAttemptCount} = 0
          and ${table.dispatchedAt} is null
          and ${table.reconcileRequiredAt} is null
          and ${table.uncertainAt} is null
          and ${table.completedAt} is null
          and ${table.failureCode} is null
        ) or (
          ${table.state} = 'dispatched'
          and ${table.leaseOwner} is null
          and ${table.leaseExpiresAt} is null
          and ${table.dispatchAttemptCount} between 1 and 2147483647
          and ${table.dispatchedAt} is not null
          and ${table.reconcileRequiredAt} is null
          and ${table.uncertainAt} is null
          and ${table.completedAt} is null
          and ${table.failureCode} is null
        ) or (
          ${table.state} = 'reconcile_required'
          and ${table.leaseOwner} is null
          and ${table.leaseExpiresAt} is null
          and ${table.dispatchAttemptCount} between 1 and 2147483647
          and ${table.dispatchedAt} is not null
          and ${table.reconcileRequiredAt} is not null
          and ${table.uncertainAt} is null
          and ${table.completedAt} is null
          and length(${table.failureCode}) between 1 and 64
        ) or (
          ${table.state} = 'uncertain'
          and ${table.leaseOwner} is null
          and ${table.leaseExpiresAt} is null
          and ${table.dispatchAttemptCount} between 1 and 2147483647
          and ${table.dispatchedAt} is not null
          and ${table.uncertainAt} is not null
          and ${table.completedAt} is not null
          and length(${table.failureCode}) between 1 and 64
        ) or (
          ${table.state} = 'succeeded'
          and ${table.leaseOwner} is null
          and ${table.leaseExpiresAt} is null
          and ${table.dispatchAttemptCount} between 1 and 2147483647
          and ${table.dispatchedAt} is not null
          and ${table.uncertainAt} is null
          and ${table.completedAt} is not null
          and ${table.failureCode} is null
        ) or (
          ${table.state} = 'failed'
          and ${table.leaseOwner} is null
          and ${table.leaseExpiresAt} is null
          and ${table.reconcileRequiredAt} is null
          and ${table.uncertainAt} is null
          and ${table.completedAt} is not null
          and length(${table.failureCode}) between 1 and 64
          and ((${table.dispatchedAt} is null and ${table.dispatchAttemptCount} = 0)
            or (${table.dispatchedAt} is not null
              and ${table.dispatchAttemptCount} between 1 and 2147483647))
        )`,
    ),
    check(
      "external_mutation_dispatches_timestamp_order_check",
      sql`${table.createdAt} >= 0
        and ${table.createdAt} <= ${table.updatedAt}
        and (${table.leaseExpiresAt} is null or ${table.leaseExpiresAt} >= ${table.createdAt})
        and (${table.dispatchedAt} is null or ${table.dispatchedAt} >= ${table.createdAt})
        and (${table.reconcileRequiredAt} is null
          or ${table.reconcileRequiredAt} >= ${table.dispatchedAt})
        and (${table.uncertainAt} is null or ${table.uncertainAt} >= ${table.dispatchedAt})
        and (${table.completedAt} is null or ${table.completedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const externalMutationTargetLocks = sqliteTable(
  "external_mutation_target_locks",
  {
    targetScope: text("target_scope", {
      enum: [
        "media_request",
        "media_issue",
        "subtitle",
        "library",
        "user_media_state",
        "download_queue",
        "acquisition",
        "saved_favorite",
        "playback_progress",
      ],
    }).notNull(),
    targetDigest: text("target_digest").notNull(),
    ownerDispatchId: text("owner_dispatch_id")
      .notNull()
      .references(() => externalMutationDispatches.id, { onDelete: "cascade" }),
    acquiredAt: integer("acquired_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.targetScope, table.targetDigest] }),
    index("external_mutation_target_locks_owner_idx").on(table.ownerDispatchId),
    check(
      "external_mutation_target_locks_scope_check",
      sql`${table.targetScope} in ('media_request', 'media_issue', 'subtitle', 'library',
        'user_media_state', 'download_queue', 'acquisition', 'saved_favorite',
        'playback_progress')`,
    ),
    check(
      "external_mutation_target_locks_digest_check",
      sql`length(${table.targetDigest}) in (22, 43)
        and ${table.targetDigest} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check("external_mutation_target_locks_timestamp_check", sql`${table.acquiredAt} >= 0`),
  ],
);

export const downloadQueueItemOperations = sqliteTable(
  "download_queue_item_operations",
  {
    id: text("id").primaryKey(),
    bulkOperationId: text("bulk_operation_id").references(() => downloadQueueBulkOperations.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectorConfigs.id, { onDelete: "restrict" }),
    connectorInstanceGeneration: integer("connector_instance_generation").notNull(),
    connectorConfigGeneration: integer("connector_config_generation").notNull(),
    itemDigest: text("item_digest").notNull(),
    kind: text("kind", { enum: ["pause", "resume", "promote"] }).notNull(),
    idempotencyKeyHash: text("idempotency_key_hash"),
    fingerprintHash: text("fingerprint_hash").notNull(),
    state: text("state", {
      enum: ["pending", "reconcile_required", "uncertain", "succeeded", "failed"],
    })
      .notNull()
      .default("pending"),
    failureCode: text("failure_code"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("download_queue_item_operations_user_key_unique")
      .on(table.userId, table.idempotencyKeyHash)
      .where(sql`${table.idempotencyKeyHash} is not null`),
    uniqueIndex("download_queue_item_operations_bulk_target_unique")
      .on(table.bulkOperationId, table.kind, table.itemDigest)
      .where(sql`${table.bulkOperationId} is not null`),
    index("download_queue_item_operations_state_created_idx").on(table.state, table.createdAt),
    check(
      "download_queue_item_operations_id_check",
      sql`length(${table.id}) = 46
        and substr(${table.id}, 1, 24) = 'download_item_operation_'
        and substr(${table.id}, 25) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "download_queue_item_operations_kind_check",
      sql`${table.kind} in ('pause', 'resume', 'promote')`,
    ),
    check(
      "download_queue_item_operations_parent_check",
      sql`(${table.bulkOperationId} is null
          and ${table.idempotencyKeyHash} is not null
          and length(${table.idempotencyKeyHash}) = 43
          and ${table.idempotencyKeyHash} not glob '*[^A-Za-z0-9_-]*')
        or (${table.bulkOperationId} is not null and ${table.idempotencyKeyHash} is null)`,
    ),
    check(
      "download_queue_item_operations_snapshot_check",
      sql`typeof(${table.connectorInstanceGeneration}) = 'integer'
        and ${table.connectorInstanceGeneration} between 0 and 9007199254740991
        and typeof(${table.connectorConfigGeneration}) = 'integer'
        and ${table.connectorConfigGeneration} between 0 and 9007199254740991`,
    ),
    check(
      "download_queue_item_operations_digest_check",
      sql`length(${table.itemDigest}) = 22
        and ${table.itemDigest} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "download_queue_item_operations_fingerprint_check",
      sql`length(${table.fingerprintHash}) = 43
        and ${table.fingerprintHash} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "download_queue_item_operations_state_check",
      sql`${table.state} in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')`,
    ),
    check(
      "download_queue_item_operations_outcome_check",
      sql`(${table.state} = 'pending' and ${table.failureCode} is null
          and ${table.completedAt} is null)
        or (${table.state} in ('reconcile_required', 'uncertain', 'failed')
          and length(${table.failureCode}) between 1 and 64
          and ${table.completedAt} is not null)
        or (${table.state} = 'succeeded' and ${table.failureCode} is null
          and ${table.completedAt} is not null)`,
    ),
    check(
      "download_queue_item_operations_timestamp_order_check",
      sql`${table.createdAt} >= 0 and ${table.createdAt} <= ${table.updatedAt}
        and (${table.completedAt} is null or ${table.completedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const playbackProgressOperations = sqliteTable(
  "playback_progress_operations",
  {
    id: text("id").primaryKey(),
    playbackSessionId: text("playback_session_id").notNull(),
    sessionRevision: integer("session_revision").notNull(),
    userId: text("user_id").notNull(),
    connectorId: text("connector_id").notNull(),
    connectorInstanceGeneration: integer("connector_instance_generation").notNull(),
    connectorConfigGeneration: integer("connector_config_generation").notNull(),
    positionSeconds: integer("position_seconds").notNull(),
    state: text("state", {
      enum: ["pending", "reconcile_required", "uncertain", "succeeded", "failed"],
    })
      .notNull()
      .default("pending"),
    failureCode: text("failure_code"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("playback_progress_operations_session_revision_unique").on(
      table.playbackSessionId,
      table.sessionRevision,
    ),
    index("playback_progress_operations_state_created_idx").on(table.state, table.createdAt),
    index("playback_progress_operations_user_created_idx").on(table.userId, table.createdAt),
    check(
      "playback_progress_operations_id_check",
      sql`length(${table.id}) = 50
        and substr(${table.id}, 1, 28) = 'playback_progress_operation_'
        and substr(${table.id}, 29) not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "playback_progress_operations_session_check",
      sql`length(${table.playbackSessionId}) = 31
        and substr(${table.playbackSessionId}, 1, 9) = 'playback_'
        and substr(${table.playbackSessionId}, 10) not glob '*[^A-Za-z0-9_-]*'
        and typeof(${table.sessionRevision}) = 'integer'
        and ${table.sessionRevision} between 0 and 2147483647`,
    ),
    check(
      "playback_progress_operations_snapshot_check",
      sql`length(${table.userId}) between 1 and 128
        and length(${table.connectorId}) between 1 and 128
        and typeof(${table.connectorInstanceGeneration}) = 'integer'
        and ${table.connectorInstanceGeneration} between 0 and 9007199254740991
        and typeof(${table.connectorConfigGeneration}) = 'integer'
        and ${table.connectorConfigGeneration} between 0 and 9007199254740991`,
    ),
    check(
      "playback_progress_operations_position_check",
      sql`${table.positionSeconds} between 0 and 10000000`,
    ),
    check(
      "playback_progress_operations_state_check",
      sql`${table.state} in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')`,
    ),
    check(
      "playback_progress_operations_outcome_check",
      sql`(${table.state} = 'pending' and ${table.failureCode} is null
          and ${table.completedAt} is null)
        or (${table.state} in ('reconcile_required', 'uncertain', 'failed')
          and length(${table.failureCode}) between 1 and 64
          and ${table.completedAt} is not null)
        or (${table.state} = 'succeeded' and ${table.failureCode} is null
          and ${table.completedAt} is not null)`,
    ),
    check(
      "playback_progress_operations_timestamp_order_check",
      sql`${table.createdAt} >= 0 and ${table.createdAt} <= ${table.updatedAt}
        and (${table.completedAt} is null or ${table.completedAt} >= ${table.createdAt})`,
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
