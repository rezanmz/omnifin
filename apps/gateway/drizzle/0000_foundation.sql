CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`session_id` text,
	`event_type` text NOT NULL,
	`outcome` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`ip_hash` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_events_outcome_check" CHECK("audit_events"."outcome" in ('success', 'denied', 'failure')),
	CONSTRAINT "audit_events_metadata_json_check" CHECK(json_valid("audit_events"."metadata_json") and json_type("audit_events"."metadata_json") = 'object')
);
--> statement-breakpoint
CREATE INDEX `audit_events_actor_idx` ON `audit_events` (`actor_user_id`);--> statement-breakpoint
CREATE INDEX `audit_events_type_created_idx` ON `audit_events` (`event_type`,`created_at`);--> statement-breakpoint
CREATE TABLE `auth_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`state_hash` text NOT NULL,
	`provider_id` text NOT NULL,
	`encrypted_code_verifier` text NOT NULL,
	`encrypted_nonce` text NOT NULL,
	`return_path` text DEFAULT '/' NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `oidc_providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_transactions_state_hash_unique` ON `auth_transactions` (`state_hash`);--> statement-breakpoint
CREATE INDEX `auth_transactions_expiry_idx` ON `auth_transactions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `connector_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`display_name` text NOT NULL,
	`base_url` text NOT NULL,
	`encrypted_credentials` text NOT NULL,
	`tls_policy` text DEFAULT 'strict' NOT NULL,
	`insecure_http_approved` integer DEFAULT false NOT NULL,
	`capability_snapshot_json` text DEFAULT '{}' NOT NULL,
	`health_state` text DEFAULT 'unknown' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "connector_configs_type_check" CHECK("connector_configs"."type" in ('jellyfin', 'seerr', 'radarr', 'sonarr', 'prowlarr', 'bazarr', 'qbittorrent', 'sabnzbd')),
	CONSTRAINT "connector_configs_tls_policy_check" CHECK("connector_configs"."tls_policy" in ('strict', 'allow_self_signed')),
	CONSTRAINT "connector_configs_capability_snapshot_json_check" CHECK(json_valid("connector_configs"."capability_snapshot_json") and json_type("connector_configs"."capability_snapshot_json") = 'object'),
	CONSTRAINT "connector_configs_health_state_check" CHECK("connector_configs"."health_state" in ('unknown', 'healthy', 'degraded', 'offline')),
	CONSTRAINT "connector_configs_insecure_http_approved_check" CHECK("connector_configs"."insecure_http_approved" in (0, 1)),
	CONSTRAINT "connector_configs_enabled_check" CHECK("connector_configs"."enabled" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `connector_configs_type_idx` ON `connector_configs` (`type`);--> statement-breakpoint
CREATE TABLE `external_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`display_claims_json` text DEFAULT '{}' NOT NULL,
	`last_login_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`,`issuer`) REFERENCES `oidc_providers`(`id`,`issuer`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "external_identities_display_claims_json_check" CHECK(json_valid("external_identities"."display_claims_json") and json_type("external_identities"."display_claims_json") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_identities_issuer_subject_unique` ON `external_identities` (`issuer`,`subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `external_identities_session_binding_unique` ON `external_identities` (`id`,`user_id`,`provider_id`);--> statement-breakpoint
CREATE INDEX `external_identities_user_idx` ON `external_identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `oidc_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`encrypted_client_secret` text,
	`scopes` text DEFAULT 'openid profile email' NOT NULL,
	`claim_config_json` text DEFAULT '{}' NOT NULL,
	`allow_jit_provisioning` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "oidc_providers_claim_config_json_check" CHECK(json_valid("oidc_providers"."claim_config_json") and json_type("oidc_providers"."claim_config_json") = 'object'),
	CONSTRAINT "oidc_providers_allow_jit_provisioning_check" CHECK("oidc_providers"."allow_jit_provisioning" in (0, 1)),
	CONSTRAINT "oidc_providers_enabled_check" CHECK("oidc_providers"."enabled" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_providers_slug_unique` ON `oidc_providers` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_providers_issuer_unique` ON `oidc_providers` (`issuer`);--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_providers_id_issuer_unique` ON `oidc_providers` (`id`,`issuer`);--> statement-breakpoint
CREATE TABLE `operational_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`component` text NOT NULL,
	`operation` text NOT NULL,
	`category` text NOT NULL,
	`safe_message` text NOT NULL,
	`context_json` text DEFAULT '{}' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "operational_failures_context_json_check" CHECK(json_valid("operational_failures"."context_json") and json_type("operational_failures"."context_json") = 'object')
);
--> statement-breakpoint
CREATE INDEX `operational_failures_component_idx` ON `operational_failures` (`component`,`resolved_at`);--> statement-breakpoint
CREATE TABLE `role_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`claim_path_json` text NOT NULL,
	`operator` text NOT NULL,
	`values_json` text NOT NULL,
	`role` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `oidc_providers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "role_mappings_claim_path_json_check" CHECK(json_valid("role_mappings"."claim_path_json") and json_type("role_mappings"."claim_path_json") = 'array'),
	CONSTRAINT "role_mappings_values_json_check" CHECK(json_valid("role_mappings"."values_json") and json_type("role_mappings"."values_json") = 'array'),
	CONSTRAINT "role_mappings_operator_check" CHECK("role_mappings"."operator" in ('equals', 'contains_any', 'contains_all')),
	CONSTRAINT "role_mappings_role_check" CHECK("role_mappings"."role" in ('viewer', 'requester', 'operator', 'admin')),
	CONSTRAINT "role_mappings_priority_check" CHECK("role_mappings"."priority" between 0 and 10000),
	CONSTRAINT "role_mappings_enabled_check" CHECK("role_mappings"."enabled" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `role_mappings_provider_priority_idx` ON `role_mappings` (`provider_id`,`enabled`,`priority`);--> statement-breakpoint
CREATE TABLE `service_identity_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`service` text NOT NULL,
	`external_user_id` text NOT NULL,
	`external_username` text NOT NULL,
	`encrypted_access_token` text NOT NULL,
	`health_state` text DEFAULT 'healthy' NOT NULL,
	`last_verified_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "service_identity_links_service_check" CHECK("service_identity_links"."service" = 'jellyfin'),
	CONSTRAINT "service_identity_links_health_state_check" CHECK("service_identity_links"."health_state" in ('healthy', 'degraded', 'revoked', 'unreachable'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_identity_links_user_service_unique` ON `service_identity_links` (`user_id`,`service`);--> statement-breakpoint
CREATE UNIQUE INDEX `service_identity_links_external_unique` ON `service_identity_links` (`service`,`external_user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text,
	`auth_method` text NOT NULL,
	`oidc_provider_id` text,
	`external_identity_id` text,
	`oidc_session_id_hash` text,
	`csrf_token_hash` text NOT NULL,
	`ip_hash` text,
	`user_agent_hash` text,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`absolute_expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`external_identity_id`,`user_id`,`oidc_provider_id`) REFERENCES `external_identities`(`id`,`user_id`,`provider_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sessions_auth_method_check" CHECK("sessions"."auth_method" in ('oidc', 'jellyfin', 'recovery')),
	CONSTRAINT "sessions_auth_attribution_check" CHECK((
        "sessions"."auth_method" = 'oidc'
        and "sessions"."user_id" is not null
        and "sessions"."oidc_provider_id" is not null
        and "sessions"."external_identity_id" is not null
      ) or (
        "sessions"."auth_method" = 'jellyfin'
        and "sessions"."user_id" is not null
        and "sessions"."oidc_provider_id" is null
        and "sessions"."external_identity_id" is null
        and "sessions"."oidc_session_id_hash" is null
      ) or (
        "sessions"."auth_method" = 'recovery'
        and "sessions"."oidc_provider_id" is null
        and "sessions"."external_identity_id" is null
        and "sessions"."oidc_session_id_hash" is null
      )),
	CONSTRAINT "sessions_oidc_sid_hash_length_check" CHECK("sessions"."oidc_session_id_hash" is null or length("sessions"."oidc_session_id_hash") between 16 and 128)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_external_identity_idx` ON `sessions` (`external_identity_id`);--> statement-breakpoint
CREATE INDEX `sessions_oidc_sid_idx` ON `sessions` (`oidc_provider_id`,`oidc_session_id_hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`status` text DEFAULT 'pending_link' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "users_role_check" CHECK("users"."role" in ('viewer', 'requester', 'operator', 'admin')),
	CONSTRAINT "users_status_check" CHECK("users"."status" in ('active', 'pending_link', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);