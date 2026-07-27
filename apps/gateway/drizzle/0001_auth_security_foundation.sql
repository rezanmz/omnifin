CREATE UNIQUE INDEX `connector_configs_id_type_unique` ON `connector_configs` (`id`,`type`);--> statement-breakpoint
CREATE TABLE `__new_service_identity_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`service` text NOT NULL,
	`connector_id` text,
	`external_server_id` text NOT NULL,
	`external_user_id` text NOT NULL,
	`external_username` text NOT NULL,
	`external_display_name` text NOT NULL,
	`encrypted_access_token` text,
	`device_id` text NOT NULL,
	`token_created_at` integer,
	`health_state` text DEFAULT 'relink_required' NOT NULL,
	`last_verified_at` integer,
	`revoked_at` integer,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_id`,`service`) REFERENCES `connector_configs`(`id`,`type`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "service_identity_links_service_check" CHECK("__new_service_identity_links"."service" = 'jellyfin'),
	CONSTRAINT "service_identity_links_health_state_check" CHECK("__new_service_identity_links"."health_state" in ('linked', 'unavailable', 'relink_required', 'revoked')),
	CONSTRAINT "service_identity_links_health_attribution_check" CHECK((
          "__new_service_identity_links"."health_state" in ('linked', 'unavailable')
          and "__new_service_identity_links"."connector_id" is not null
          and "__new_service_identity_links"."encrypted_access_token" is not null
          and "__new_service_identity_links"."token_created_at" is not null
          and "__new_service_identity_links"."revoked_at" is null
        ) or (
          "__new_service_identity_links"."health_state" = 'relink_required'
          and "__new_service_identity_links"."encrypted_access_token" is null
          and "__new_service_identity_links"."token_created_at" is null
          and "__new_service_identity_links"."revoked_at" is null
        ) or (
          "__new_service_identity_links"."health_state" = 'revoked'
          and "__new_service_identity_links"."encrypted_access_token" is null
          and "__new_service_identity_links"."revoked_at" is not null
        )),
	CONSTRAINT "service_identity_links_revision_check" CHECK("__new_service_identity_links"."revision" between 0 and 2147483647),
	CONSTRAINT "service_identity_links_timestamp_order_check" CHECK("__new_service_identity_links"."revoked_at" is null or "__new_service_identity_links"."revoked_at" >= "__new_service_identity_links"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_service_identity_links`(
	"id",
	"user_id",
	"service",
	"connector_id",
	"external_server_id",
	"external_user_id",
	"external_username",
	"external_display_name",
	"encrypted_access_token",
	"device_id",
	"token_created_at",
	"health_state",
	"last_verified_at",
	"revoked_at",
	"revision",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"user_id",
	"service",
	null,
	'legacy-server:' || lower(hex(cast("id" as blob))),
	"external_user_id",
	"external_username",
	"external_username",
	null,
	'legacy-device:' || lower(hex(cast("id" as blob))),
	null,
	'relink_required',
	"last_verified_at",
	null,
	1,
	"created_at",
	"updated_at"
FROM `service_identity_links`;--> statement-breakpoint
DROP TABLE `service_identity_links`;--> statement-breakpoint
ALTER TABLE `__new_service_identity_links` RENAME TO `service_identity_links`;--> statement-breakpoint
CREATE UNIQUE INDEX `service_identity_links_user_service_unique` ON `service_identity_links` (`user_id`,`service`);--> statement-breakpoint
CREATE UNIQUE INDEX `service_identity_links_session_binding_unique` ON `service_identity_links` (`id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `service_identity_links_external_unique` ON `service_identity_links` (`connector_id`,`external_server_id`,`external_user_id`);--> statement-breakpoint
CREATE INDEX `service_identity_links_connector_idx` ON `service_identity_links` (`connector_id`);--> statement-breakpoint
ALTER TABLE `audit_events` ADD COLUMN `__legacy_session_id` text;--> statement-breakpoint
ALTER TABLE `audit_events` ADD COLUMN `__legacy_session_auth_method` text;--> statement-breakpoint
UPDATE `audit_events`
SET
	`__legacy_session_id` = `session_id`,
	`__legacy_session_auth_method` = (
		select `auth_method`
		from `sessions`
		where `sessions`.`id` = `audit_events`.`session_id`
	);--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text,
	`auth_method` text NOT NULL,
	`oidc_provider_id` text,
	`external_identity_id` text,
	`service_identity_link_id` text,
	`oidc_session_id_hash` text,
	`encrypted_id_token_hint` text,
	`csrf_token_hash` text NOT NULL,
	`encrypted_csrf_token` text NOT NULL,
	`ip_hash` text,
	`user_agent_hash` text,
	`last_rotated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`absolute_expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`external_identity_id`,`user_id`,`oidc_provider_id`) REFERENCES `external_identities`(`id`,`user_id`,`provider_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_identity_link_id`,`user_id`) REFERENCES `service_identity_links`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sessions_auth_method_check" CHECK("__new_sessions"."auth_method" in ('oidc', 'jellyfin', 'recovery')),
	CONSTRAINT "sessions_auth_attribution_check" CHECK((
        "__new_sessions"."auth_method" = 'oidc'
        and "__new_sessions"."user_id" is not null
        and "__new_sessions"."oidc_provider_id" is not null
        and "__new_sessions"."external_identity_id" is not null
      ) or (
        "__new_sessions"."auth_method" = 'jellyfin'
        and "__new_sessions"."user_id" is not null
        and "__new_sessions"."oidc_provider_id" is null
        and "__new_sessions"."external_identity_id" is null
        and "__new_sessions"."service_identity_link_id" is not null
        and "__new_sessions"."oidc_session_id_hash" is null
        and "__new_sessions"."encrypted_id_token_hint" is null
      ) or (
        "__new_sessions"."auth_method" = 'recovery'
        and "__new_sessions"."user_id" is null
        and "__new_sessions"."oidc_provider_id" is null
        and "__new_sessions"."external_identity_id" is null
        and "__new_sessions"."service_identity_link_id" is null
        and "__new_sessions"."oidc_session_id_hash" is null
        and "__new_sessions"."encrypted_id_token_hint" is null
      )),
	CONSTRAINT "sessions_token_hash_check" CHECK(length("__new_sessions"."token_hash") = 43 and "__new_sessions"."token_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "sessions_csrf_hash_check" CHECK(length("__new_sessions"."csrf_token_hash") = 43
        and "__new_sessions"."csrf_token_hash" not glob '*[^A-Za-z0-9_-]*'
        and length("__new_sessions"."encrypted_csrf_token") between 1 and 8192),
	CONSTRAINT "sessions_privacy_hashes_check" CHECK(("__new_sessions"."oidc_session_id_hash" is null or (
          length("__new_sessions"."oidc_session_id_hash") = 22
          and "__new_sessions"."oidc_session_id_hash" not glob '*[^A-Za-z0-9_-]*'
        )) and ("__new_sessions"."ip_hash" is null or (
          length("__new_sessions"."ip_hash") = 22
          and "__new_sessions"."ip_hash" not glob '*[^A-Za-z0-9_-]*'
        )) and ("__new_sessions"."user_agent_hash" is null or (
          length("__new_sessions"."user_agent_hash") = 22
          and "__new_sessions"."user_agent_hash" not glob '*[^A-Za-z0-9_-]*'
        ))),
	CONSTRAINT "sessions_timestamp_order_check" CHECK("__new_sessions"."created_at" <= "__new_sessions"."last_rotated_at"
        and "__new_sessions"."last_rotated_at" <= "__new_sessions"."last_seen_at"
        and "__new_sessions"."last_seen_at" <= "__new_sessions"."expires_at"
        and "__new_sessions"."expires_at" <= "__new_sessions"."absolute_expires_at"
        and ("__new_sessions"."revoked_at" is null or "__new_sessions"."revoked_at" >= "__new_sessions"."created_at"))
);
--> statement-breakpoint
INSERT INTO `__new_sessions`(
	"id",
	"token_hash",
	"user_id",
	"auth_method",
	"oidc_provider_id",
	"external_identity_id",
	"service_identity_link_id",
	"oidc_session_id_hash",
	"encrypted_id_token_hint",
	"csrf_token_hash",
	"encrypted_csrf_token",
	"ip_hash",
	"user_agent_hash",
	"last_rotated_at",
	"last_seen_at",
	"expires_at",
	"absolute_expires_at",
	"revoked_at",
	"created_at"
)
SELECT
	"id",
	substr(lower(hex(randomblob(32))), 1, 43),
	case when "auth_method" = 'recovery' then null else "user_id" end,
	"auth_method",
	"oidc_provider_id",
	"external_identity_id",
	case
		when "auth_method" = 'jellyfin' then (
			select "id"
			from `service_identity_links`
			where `service_identity_links`.`user_id` = `sessions`.`user_id`
				and `service_identity_links`.`service` = 'jellyfin'
			limit 1
		)
		else null
	end,
	null,
	null,
	substr(lower(hex(randomblob(32))), 1, 43),
	'legacy-revoked',
	null,
	null,
	"created_at",
	max("last_seen_at", "created_at"),
	max("expires_at", "last_seen_at", "created_at"),
	max("absolute_expires_at", "expires_at", "last_seen_at", "created_at"),
	max(cast(unixepoch('subsec') * 1000 as integer), "created_at"),
	"created_at"
FROM `sessions`
WHERE "auth_method" <> 'jellyfin'
	OR EXISTS (
		select 1
		from `service_identity_links`
		where `service_identity_links`.`user_id` = `sessions`.`user_id`
			and `service_identity_links`.`service` = 'jellyfin'
	);--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_external_identity_idx` ON `sessions` (`external_identity_id`);--> statement-breakpoint
CREATE INDEX `sessions_service_identity_link_idx` ON `sessions` (`service_identity_link_id`);--> statement-breakpoint
CREATE INDEX `sessions_oidc_sid_idx` ON `sessions` (`oidc_provider_id`,`oidc_session_id_hash`);--> statement-breakpoint
CREATE TABLE `__new_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`session_id` text,
	`actor_session_id` text,
	`actor_auth_method` text,
	`event_type` text NOT NULL,
	`outcome` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`request_id` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`ip_hash` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_events_outcome_check" CHECK("__new_audit_events"."outcome" in ('success', 'denied', 'failure')),
	CONSTRAINT "audit_events_metadata_json_check" CHECK(json_valid("__new_audit_events"."metadata_json") and json_type("__new_audit_events"."metadata_json") = 'object'),
	CONSTRAINT "audit_events_request_id_check" CHECK("__new_audit_events"."request_id" is null or length("__new_audit_events"."request_id") between 1 and 128),
	CONSTRAINT "audit_events_actor_session_check" CHECK((
          "__new_audit_events"."actor_session_id" is null
          and "__new_audit_events"."actor_auth_method" is null
        ) or (
          "__new_audit_events"."actor_session_id" is not null
          and "__new_audit_events"."actor_auth_method" is not null
          and "__new_audit_events"."actor_auth_method" in ('oidc', 'jellyfin', 'recovery')
        ))
);
--> statement-breakpoint
INSERT INTO `__new_audit_events`(
	"id",
	"actor_user_id",
	"session_id",
	"actor_session_id",
	"actor_auth_method",
	"event_type",
	"outcome",
	"target_type",
	"target_id",
	"request_id",
	"metadata_json",
	"ip_hash",
	"created_at"
)
SELECT
	`audit_events`.`id`,
	`audit_events`.`actor_user_id`,
	case
		when exists (
			select 1
			from `sessions`
			where `sessions`.`id` = `audit_events`.`__legacy_session_id`
		) then `audit_events`.`__legacy_session_id`
		else null
		end,
	`audit_events`.`__legacy_session_id`,
	`audit_events`.`__legacy_session_auth_method`,
	`audit_events`.`event_type`,
	`audit_events`.`outcome`,
	`audit_events`.`target_type`,
	`audit_events`.`target_id`,
	null,
	`audit_events`.`metadata_json`,
	`audit_events`.`ip_hash`,
	`audit_events`.`created_at`
FROM `audit_events`;--> statement-breakpoint
DROP TABLE `audit_events`;--> statement-breakpoint
ALTER TABLE `__new_audit_events` RENAME TO `audit_events`;--> statement-breakpoint
CREATE INDEX `audit_events_actor_idx` ON `audit_events` (`actor_user_id`);--> statement-breakpoint
CREATE INDEX `audit_events_actor_session_idx` ON `audit_events` (`actor_session_id`,`actor_auth_method`);--> statement-breakpoint
CREATE INDEX `audit_events_type_created_idx` ON `audit_events` (`event_type`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_request_idx` ON `audit_events` (`request_id`);--> statement-breakpoint
CREATE TABLE `__new_auth_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`state_hash` text NOT NULL,
	`provider_id` text NOT NULL,
	`browser_binding_hash` text NOT NULL,
	`encrypted_code_verifier` text NOT NULL,
	`encrypted_nonce` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`return_path` text DEFAULT '/' NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `oidc_providers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "auth_transactions_hashes_check" CHECK(length("__new_auth_transactions"."state_hash") = 43
        and "__new_auth_transactions"."state_hash" not glob '*[^A-Za-z0-9_-]*'
        and length("__new_auth_transactions"."browser_binding_hash") = 43
        and "__new_auth_transactions"."browser_binding_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "auth_transactions_redirect_uri_check" CHECK(length("__new_auth_transactions"."redirect_uri") between 8 and 2048
        and ("__new_auth_transactions"."redirect_uri" like 'https://%' or "__new_auth_transactions"."redirect_uri" like 'http://%')
        and instr("__new_auth_transactions"."redirect_uri", '#') = 0),
	CONSTRAINT "auth_transactions_return_path_check" CHECK(length("__new_auth_transactions"."return_path") between 1 and 2048
        and substr("__new_auth_transactions"."return_path", 1, 1) = '/'
        and substr("__new_auth_transactions"."return_path", 1, 2) <> '//'
        and instr("__new_auth_transactions"."return_path", char(92)) = 0),
	CONSTRAINT "auth_transactions_timestamp_order_check" CHECK("__new_auth_transactions"."created_at" < "__new_auth_transactions"."expires_at"
        and ("__new_auth_transactions"."consumed_at" is null or (
          "__new_auth_transactions"."consumed_at" >= "__new_auth_transactions"."created_at"
          and "__new_auth_transactions"."consumed_at" <= "__new_auth_transactions"."expires_at"
        )))
);
--> statement-breakpoint
DROP TABLE `auth_transactions`;--> statement-breakpoint
ALTER TABLE `__new_auth_transactions` RENAME TO `auth_transactions`;--> statement-breakpoint
CREATE UNIQUE INDEX `auth_transactions_state_hash_unique` ON `auth_transactions` (`state_hash`);--> statement-breakpoint
CREATE INDEX `auth_transactions_expiry_idx` ON `auth_transactions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `role_source` text DEFAULT 'default' NOT NULL
	CONSTRAINT "users_role_source_check"
	CHECK(`role_source` in ('default', 'oidc_mapping', 'manual', 'recovery_bootstrap'));--> statement-breakpoint
UPDATE `users` SET `role_source` = 'manual';
