CREATE TABLE `jellyfin_activation_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`invitation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`external_identity_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`connector_config_generation` integer NOT NULL,
	`connector_instance_generation` integer NOT NULL,
	`connector_instance_identity_hash` text,
	`provisioning_revision` integer NOT NULL,
	`state` text DEFAULT 'reserved' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`encrypted_stage_artifact` text,
	`artifact_revision` integer DEFAULT 0 NOT NULL,
	`cleanup_eligible` integer DEFAULT false NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`create_attempt_count` integer DEFAULT 0 NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`cleanup_attempt_count` integer DEFAULT 0 NOT NULL,
	`failure_code` text,
	`reserved_at` integer NOT NULL,
	`create_dispatched_at` integer,
	`created_id_recorded_at` integer,
	`manual_required_at` integer,
	`tombstoned_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`invitation_id`) REFERENCES `invitations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`external_identity_id`) REFERENCES `external_identities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`external_identity_id`,`user_id`) REFERENCES `external_identities`(`id`,`user_id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "jellyfin_activation_operations_id_check" CHECK(length("jellyfin_activation_operations"."id") between 8 and 128 and substr("jellyfin_activation_operations"."id", 1, 10) = 'jellyfin_' and substr("jellyfin_activation_operations"."id", 11) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "jellyfin_activation_operations_generation_check" CHECK("jellyfin_activation_operations"."connector_config_generation" between 0 and 9007199254740991 and "jellyfin_activation_operations"."connector_instance_generation" between 0 and 9007199254740991),
	CONSTRAINT "jellyfin_activation_operations_identity_hash_check" CHECK("jellyfin_activation_operations"."connector_instance_identity_hash" is null or (length("jellyfin_activation_operations"."connector_instance_identity_hash") between 16 and 128 and "jellyfin_activation_operations"."connector_instance_identity_hash" not glob '*[^A-Za-z0-9_-]*')),
	CONSTRAINT "jellyfin_activation_operations_provisioning_revision_check" CHECK("jellyfin_activation_operations"."provisioning_revision" between 0 and 2147483647),
	CONSTRAINT "jellyfin_activation_operations_state_check" CHECK("jellyfin_activation_operations"."state" in ('reserved', 'create_dispatched', 'created', 'policy_pending', 'auth_pending', 'manual_required', 'tombstoned')),
	CONSTRAINT "jellyfin_activation_operations_revision_check" CHECK("jellyfin_activation_operations"."revision" between 0 and 2147483647 and "jellyfin_activation_operations"."artifact_revision" between 0 and 2147483647),
	CONSTRAINT "jellyfin_activation_operations_attempt_check" CHECK("jellyfin_activation_operations"."create_attempt_count" between 0 and 1 and "jellyfin_activation_operations"."retry_count" between 0 and 8 and "jellyfin_activation_operations"."cleanup_attempt_count" between 0 and 8 and "jellyfin_activation_operations"."cleanup_eligible" in (0, 1)),
	CONSTRAINT "jellyfin_activation_operations_failure_code_check" CHECK("jellyfin_activation_operations"."failure_code" is null or (length("jellyfin_activation_operations"."failure_code") between 1 and 64 and "jellyfin_activation_operations"."failure_code" not glob '*[^a-z0-9_]*')),
	CONSTRAINT "jellyfin_activation_operations_lease_check" CHECK(("jellyfin_activation_operations"."lease_owner" is null and "jellyfin_activation_operations"."lease_expires_at" is null) or ("jellyfin_activation_operations"."lease_owner" is not null and "jellyfin_activation_operations"."lease_expires_at" is not null and length("jellyfin_activation_operations"."lease_owner") between 1 and 128 and "jellyfin_activation_operations"."lease_expires_at" >= 0)),
	CONSTRAINT "jellyfin_activation_operations_state_attribution_check" CHECK(("jellyfin_activation_operations"."state" = 'reserved' and "jellyfin_activation_operations"."create_attempt_count" = 0 and "jellyfin_activation_operations"."create_dispatched_at" is null and "jellyfin_activation_operations"."created_id_recorded_at" is null and "jellyfin_activation_operations"."manual_required_at" is null and "jellyfin_activation_operations"."tombstoned_at" is null and "jellyfin_activation_operations"."encrypted_stage_artifact" is null and "jellyfin_activation_operations"."cleanup_eligible" = 0) or ("jellyfin_activation_operations"."state" = 'create_dispatched' and "jellyfin_activation_operations"."create_attempt_count" = 1 and "jellyfin_activation_operations"."create_dispatched_at" is not null and "jellyfin_activation_operations"."created_id_recorded_at" is null and "jellyfin_activation_operations"."manual_required_at" is null and "jellyfin_activation_operations"."tombstoned_at" is null and "jellyfin_activation_operations"."encrypted_stage_artifact" is null and "jellyfin_activation_operations"."cleanup_eligible" = 0) or ("jellyfin_activation_operations"."state" in ('created', 'policy_pending', 'auth_pending') and "jellyfin_activation_operations"."create_attempt_count" = 1 and "jellyfin_activation_operations"."create_dispatched_at" is not null and "jellyfin_activation_operations"."created_id_recorded_at" is not null and "jellyfin_activation_operations"."manual_required_at" is null and "jellyfin_activation_operations"."tombstoned_at" is null and "jellyfin_activation_operations"."encrypted_stage_artifact" is not null and "jellyfin_activation_operations"."cleanup_eligible" = 1) or ("jellyfin_activation_operations"."state" = 'manual_required' and "jellyfin_activation_operations"."manual_required_at" is not null and "jellyfin_activation_operations"."tombstoned_at" is null and (("jellyfin_activation_operations"."encrypted_stage_artifact" is null and "jellyfin_activation_operations"."cleanup_eligible" = 0) or ("jellyfin_activation_operations"."encrypted_stage_artifact" is not null and "jellyfin_activation_operations"."cleanup_eligible" = 1))) or ("jellyfin_activation_operations"."state" = 'tombstoned' and "jellyfin_activation_operations"."tombstoned_at" is not null and "jellyfin_activation_operations"."encrypted_stage_artifact" is null and "jellyfin_activation_operations"."cleanup_eligible" = 0)),
	CONSTRAINT "jellyfin_activation_operations_timestamp_order_check" CHECK("jellyfin_activation_operations"."created_at" >= 0 and "jellyfin_activation_operations"."created_at" <= "jellyfin_activation_operations"."updated_at" and "jellyfin_activation_operations"."reserved_at" >= "jellyfin_activation_operations"."created_at" and ("jellyfin_activation_operations"."create_dispatched_at" is null or "jellyfin_activation_operations"."create_dispatched_at" >= "jellyfin_activation_operations"."reserved_at") and ("jellyfin_activation_operations"."created_id_recorded_at" is null or "jellyfin_activation_operations"."create_dispatched_at" is not null and "jellyfin_activation_operations"."created_id_recorded_at" >= "jellyfin_activation_operations"."create_dispatched_at") and ("jellyfin_activation_operations"."manual_required_at" is null or "jellyfin_activation_operations"."manual_required_at" >= "jellyfin_activation_operations"."created_at") and ("jellyfin_activation_operations"."tombstoned_at" is null or "jellyfin_activation_operations"."tombstoned_at" >= "jellyfin_activation_operations"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jellyfin_activation_operations_invitation_unique` ON `jellyfin_activation_operations` (`invitation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jellyfin_activation_operations_user_unique` ON `jellyfin_activation_operations` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jellyfin_activation_operations_external_identity_unique` ON `jellyfin_activation_operations` (`external_identity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jellyfin_activation_operations_id_user_connector_unique` ON `jellyfin_activation_operations` (`id`,`user_id`,`connector_id`);--> statement-breakpoint
CREATE INDEX `jellyfin_activation_operations_state_idx` ON `jellyfin_activation_operations` (`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `jellyfin_activation_operations_lease_idx` ON `jellyfin_activation_operations` (`lease_expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_service_identity_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`service` text NOT NULL,
	`connector_id` text,
	`connector_instance_generation` integer DEFAULT 0 NOT NULL,
	`external_server_id` text NOT NULL,
	`external_user_id` text NOT NULL,
	`external_username` text NOT NULL,
	`external_display_name` text NOT NULL,
	`encrypted_access_token` text,
	`provisioned_by_activation_id` text,
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
	FOREIGN KEY (`provisioned_by_activation_id`,`user_id`,`connector_id`) REFERENCES `jellyfin_activation_operations`(`id`,`user_id`,`connector_id`) ON UPDATE restrict ON DELETE restrict,
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
INSERT INTO `__new_service_identity_links`("id", "user_id", "service", "connector_id", "connector_instance_generation", "external_server_id", "external_user_id", "external_username", "external_display_name", "encrypted_access_token", "provisioned_by_activation_id", "device_id", "token_created_at", "health_state", "last_verified_at", "revoked_at", "revision", "created_at", "updated_at") SELECT "id", "user_id", "service", "connector_id", "connector_instance_generation", "external_server_id", "external_user_id", "external_username", "external_display_name", "encrypted_access_token", null, "device_id", "token_created_at", "health_state", "last_verified_at", "revoked_at", "revision", "created_at", "updated_at" FROM `service_identity_links`;--> statement-breakpoint
DROP TABLE `service_identity_links`;--> statement-breakpoint
ALTER TABLE `__new_service_identity_links` RENAME TO `service_identity_links`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TRIGGER `service_identity_links_connector_generation_insert_guard`
BEFORE INSERT ON `service_identity_links`
WHEN NEW.connector_id IS NOT NULL AND NEW.connector_instance_generation < (SELECT instance_generation FROM connector_configs WHERE id = NEW.connector_id)
BEGIN SELECT RAISE(ABORT, 'service identity connector generation is stale'); END;--> statement-breakpoint
CREATE TRIGGER `service_identity_links_connector_generation_update_guard`
BEFORE UPDATE OF connector_id, connector_instance_generation ON `service_identity_links`
WHEN NEW.connector_id IS NOT NULL AND NEW.connector_instance_generation < (SELECT instance_generation FROM connector_configs WHERE id = NEW.connector_id)
BEGIN SELECT RAISE(ABORT, 'service identity connector generation is stale'); END;--> statement-breakpoint
CREATE UNIQUE INDEX `service_identity_links_user_service_unique` ON `service_identity_links` (`user_id`,`service`);--> statement-breakpoint
CREATE UNIQUE INDEX `service_identity_links_session_binding_unique` ON `service_identity_links` (`id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `service_identity_links_external_unique` ON `service_identity_links` (`connector_id`,`external_server_id`,`external_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `service_identity_links_provisioned_by_activation_unique` ON `service_identity_links` (`provisioned_by_activation_id`) WHERE "service_identity_links"."provisioned_by_activation_id" is not null;--> statement-breakpoint
CREATE INDEX `service_identity_links_connector_idx` ON `service_identity_links` (`connector_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `external_identities_id_user_unique` ON `external_identities` (`id`,`user_id`);
