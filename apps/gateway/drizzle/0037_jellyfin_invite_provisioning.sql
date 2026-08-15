CREATE TABLE `jellyfin_invite_provisioning_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`invitation_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`connector_revision` text NOT NULL,
	`connector_instance_generation` integer NOT NULL,
	`connector_config_generation` integer NOT NULL,
	`connector_instance_identity_hash` text,
	`fingerprint_hash` text NOT NULL,
	`template_identifier` text NOT NULL,
	`state` text DEFAULT 'reserved' NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`create_attempt_count` integer DEFAULT 0 NOT NULL,
	`creating_at` integer,
	`provisioned_user_id` text,
	`provisioned_at` integer,
	`policy_pending_at` integer,
	`policy_completed_at` integer,
	`reconcile_required_at` integer,
	`uncertain_at` integer,
	`completed_at` integer,
	`failure_code` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`invitation_id`) REFERENCES `invitations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "jellyfin_invite_provisioning_operations_id_check" CHECK(length("jellyfin_invite_provisioning_operations"."id") = 58
        and substr("jellyfin_invite_provisioning_operations"."id", 1, 36) = 'jellyfin_invite_provision_operation_'
        and substr("jellyfin_invite_provisioning_operations"."id", 37) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "jellyfin_invite_provisioning_operations_invitation_check" CHECK(length("jellyfin_invite_provisioning_operations"."invitation_id") between 8 and 128
        and substr("jellyfin_invite_provisioning_operations"."invitation_id", 1, 7) = 'invite_'
        and substr("jellyfin_invite_provisioning_operations"."invitation_id", 8) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "jellyfin_invite_provisioning_operations_snapshot_check" CHECK(length("jellyfin_invite_provisioning_operations"."connector_id") between 1 and 128
        and length("jellyfin_invite_provisioning_operations"."connector_revision") between 16 and 128
        and "jellyfin_invite_provisioning_operations"."connector_revision" not glob '*[^A-Za-z0-9_-]*'
        and typeof("jellyfin_invite_provisioning_operations"."connector_instance_generation") = 'integer'
        and "jellyfin_invite_provisioning_operations"."connector_instance_generation" between 0 and 9007199254740991
        and typeof("jellyfin_invite_provisioning_operations"."connector_config_generation") = 'integer'
        and "jellyfin_invite_provisioning_operations"."connector_config_generation" between 0 and 9007199254740991
        and ("jellyfin_invite_provisioning_operations"."connector_instance_identity_hash" is null
          or (length("jellyfin_invite_provisioning_operations"."connector_instance_identity_hash") = 43
            and "jellyfin_invite_provisioning_operations"."connector_instance_identity_hash" not glob '*[^A-Za-z0-9_-]*'))),
	CONSTRAINT "jellyfin_invite_provisioning_operations_fingerprint_check" CHECK(length("jellyfin_invite_provisioning_operations"."fingerprint_hash") in (22, 43)
        and "jellyfin_invite_provisioning_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "jellyfin_invite_provisioning_operations_template_check" CHECK(length("jellyfin_invite_provisioning_operations"."template_identifier") between 1 and 128
        and "jellyfin_invite_provisioning_operations"."template_identifier" not glob '*[^A-Za-z0-9._:-]*'),
	CONSTRAINT "jellyfin_invite_provisioning_operations_provisioned_user_check" CHECK("jellyfin_invite_provisioning_operations"."provisioned_user_id" is null
        or (length("jellyfin_invite_provisioning_operations"."provisioned_user_id") between 1 and 256
          and "jellyfin_invite_provisioning_operations"."provisioned_user_id" not glob '*[^A-Za-z0-9._:-]*')),
	CONSTRAINT "jellyfin_invite_provisioning_operations_state_check" CHECK("jellyfin_invite_provisioning_operations"."state" in ('reserved', 'creating', 'created', 'policy_pending',
        'succeeded', 'failed', 'uncertain', 'reconcile_required')),
	CONSTRAINT "jellyfin_invite_provisioning_operations_attempt_count_check" CHECK(typeof("jellyfin_invite_provisioning_operations"."create_attempt_count") = 'integer'
        and "jellyfin_invite_provisioning_operations"."create_attempt_count" between 0 and 2147483647),
	CONSTRAINT "jellyfin_invite_provisioning_operations_state_invariants_check" CHECK((
          "jellyfin_invite_provisioning_operations"."state" = 'reserved'
          and length("jellyfin_invite_provisioning_operations"."lease_owner") between 1 and 128
          and "jellyfin_invite_provisioning_operations"."lease_expires_at" is not null
          and "jellyfin_invite_provisioning_operations"."create_attempt_count" = 0
          and "jellyfin_invite_provisioning_operations"."creating_at" is null
          and "jellyfin_invite_provisioning_operations"."provisioned_user_id" is null
          and "jellyfin_invite_provisioning_operations"."provisioned_at" is null
          and "jellyfin_invite_provisioning_operations"."policy_pending_at" is null
          and "jellyfin_invite_provisioning_operations"."policy_completed_at" is null
          and "jellyfin_invite_provisioning_operations"."reconcile_required_at" is null
          and "jellyfin_invite_provisioning_operations"."uncertain_at" is null
          and "jellyfin_invite_provisioning_operations"."completed_at" is null
          and "jellyfin_invite_provisioning_operations"."failure_code" is null
        ) or (
          "jellyfin_invite_provisioning_operations"."state" = 'creating'
          and "jellyfin_invite_provisioning_operations"."lease_owner" is null
          and "jellyfin_invite_provisioning_operations"."lease_expires_at" is null
          and "jellyfin_invite_provisioning_operations"."create_attempt_count" between 1 and 2147483647
          and "jellyfin_invite_provisioning_operations"."creating_at" is not null
          and "jellyfin_invite_provisioning_operations"."provisioned_user_id" is null
          and "jellyfin_invite_provisioning_operations"."provisioned_at" is null
          and "jellyfin_invite_provisioning_operations"."policy_pending_at" is null
          and "jellyfin_invite_provisioning_operations"."policy_completed_at" is null
          and "jellyfin_invite_provisioning_operations"."reconcile_required_at" is null
          and "jellyfin_invite_provisioning_operations"."uncertain_at" is null
          and "jellyfin_invite_provisioning_operations"."completed_at" is null
          and "jellyfin_invite_provisioning_operations"."failure_code" is null
        ) or (
          "jellyfin_invite_provisioning_operations"."state" = 'created'
          and "jellyfin_invite_provisioning_operations"."lease_owner" is null
          and "jellyfin_invite_provisioning_operations"."lease_expires_at" is null
          and "jellyfin_invite_provisioning_operations"."create_attempt_count" between 1 and 2147483647
          and "jellyfin_invite_provisioning_operations"."creating_at" is not null
          and "jellyfin_invite_provisioning_operations"."provisioned_user_id" is not null
          and "jellyfin_invite_provisioning_operations"."provisioned_at" is not null
          and "jellyfin_invite_provisioning_operations"."policy_pending_at" is null
          and "jellyfin_invite_provisioning_operations"."policy_completed_at" is null
          and "jellyfin_invite_provisioning_operations"."reconcile_required_at" is null
          and "jellyfin_invite_provisioning_operations"."uncertain_at" is null
          and "jellyfin_invite_provisioning_operations"."completed_at" is null
          and "jellyfin_invite_provisioning_operations"."failure_code" is null
        ) or (
          "jellyfin_invite_provisioning_operations"."state" = 'policy_pending'
          and "jellyfin_invite_provisioning_operations"."lease_owner" is null
          and "jellyfin_invite_provisioning_operations"."lease_expires_at" is null
          and "jellyfin_invite_provisioning_operations"."create_attempt_count" between 1 and 2147483647
          and "jellyfin_invite_provisioning_operations"."creating_at" is not null
          and "jellyfin_invite_provisioning_operations"."provisioned_user_id" is not null
          and "jellyfin_invite_provisioning_operations"."provisioned_at" is not null
          and "jellyfin_invite_provisioning_operations"."policy_pending_at" is not null
          and "jellyfin_invite_provisioning_operations"."policy_completed_at" is null
          and "jellyfin_invite_provisioning_operations"."reconcile_required_at" is null
          and "jellyfin_invite_provisioning_operations"."uncertain_at" is null
          and "jellyfin_invite_provisioning_operations"."completed_at" is null
          and "jellyfin_invite_provisioning_operations"."failure_code" is null
        ) or (
          "jellyfin_invite_provisioning_operations"."state" = 'succeeded'
          and "jellyfin_invite_provisioning_operations"."lease_owner" is null
          and "jellyfin_invite_provisioning_operations"."lease_expires_at" is null
          and "jellyfin_invite_provisioning_operations"."create_attempt_count" between 1 and 2147483647
          and "jellyfin_invite_provisioning_operations"."creating_at" is not null
          and "jellyfin_invite_provisioning_operations"."provisioned_user_id" is not null
          and "jellyfin_invite_provisioning_operations"."provisioned_at" is not null
          and "jellyfin_invite_provisioning_operations"."policy_pending_at" is not null
          and "jellyfin_invite_provisioning_operations"."policy_completed_at" is not null
          and "jellyfin_invite_provisioning_operations"."reconcile_required_at" is null
          and "jellyfin_invite_provisioning_operations"."uncertain_at" is null
          and "jellyfin_invite_provisioning_operations"."completed_at" is not null
          and "jellyfin_invite_provisioning_operations"."failure_code" is null
        ) or (
          "jellyfin_invite_provisioning_operations"."state" = 'failed'
          and "jellyfin_invite_provisioning_operations"."lease_owner" is null
          and "jellyfin_invite_provisioning_operations"."lease_expires_at" is null
          and "jellyfin_invite_provisioning_operations"."create_attempt_count" = 0
          and "jellyfin_invite_provisioning_operations"."creating_at" is null
          and "jellyfin_invite_provisioning_operations"."provisioned_user_id" is null
          and "jellyfin_invite_provisioning_operations"."provisioned_at" is null
          and "jellyfin_invite_provisioning_operations"."policy_pending_at" is null
          and "jellyfin_invite_provisioning_operations"."policy_completed_at" is null
          and "jellyfin_invite_provisioning_operations"."reconcile_required_at" is null
          and "jellyfin_invite_provisioning_operations"."uncertain_at" is null
          and "jellyfin_invite_provisioning_operations"."completed_at" is not null
          and length("jellyfin_invite_provisioning_operations"."failure_code") between 1 and 64
        ) or (
          "jellyfin_invite_provisioning_operations"."state" = 'reconcile_required'
          and "jellyfin_invite_provisioning_operations"."lease_owner" is null
          and "jellyfin_invite_provisioning_operations"."lease_expires_at" is null
          and "jellyfin_invite_provisioning_operations"."create_attempt_count" between 1 and 2147483647
          and "jellyfin_invite_provisioning_operations"."creating_at" is not null
          and "jellyfin_invite_provisioning_operations"."reconcile_required_at" is not null
          and "jellyfin_invite_provisioning_operations"."uncertain_at" is null
          and "jellyfin_invite_provisioning_operations"."completed_at" is null
          and length("jellyfin_invite_provisioning_operations"."failure_code") between 1 and 64
        ) or (
          "jellyfin_invite_provisioning_operations"."state" = 'uncertain'
          and "jellyfin_invite_provisioning_operations"."lease_owner" is null
          and "jellyfin_invite_provisioning_operations"."lease_expires_at" is null
          and "jellyfin_invite_provisioning_operations"."create_attempt_count" between 1 and 2147483647
          and "jellyfin_invite_provisioning_operations"."creating_at" is not null
          and "jellyfin_invite_provisioning_operations"."reconcile_required_at" is not null
          and "jellyfin_invite_provisioning_operations"."uncertain_at" is not null
          and "jellyfin_invite_provisioning_operations"."completed_at" is not null
          and length("jellyfin_invite_provisioning_operations"."failure_code") between 1 and 64
        )),
	CONSTRAINT "jellyfin_invite_provisioning_operations_timestamp_order_check" CHECK("jellyfin_invite_provisioning_operations"."created_at" >= 0
        and "jellyfin_invite_provisioning_operations"."created_at" <= "jellyfin_invite_provisioning_operations"."updated_at"
        and ("jellyfin_invite_provisioning_operations"."lease_expires_at" is null or "jellyfin_invite_provisioning_operations"."lease_expires_at" >= "jellyfin_invite_provisioning_operations"."created_at")
        and ("jellyfin_invite_provisioning_operations"."creating_at" is null or "jellyfin_invite_provisioning_operations"."creating_at" >= "jellyfin_invite_provisioning_operations"."created_at")
        and ("jellyfin_invite_provisioning_operations"."provisioned_at" is null or "jellyfin_invite_provisioning_operations"."provisioned_at" >= "jellyfin_invite_provisioning_operations"."creating_at")
        and (("jellyfin_invite_provisioning_operations"."provisioned_user_id" is null and "jellyfin_invite_provisioning_operations"."provisioned_at" is null)
          or ("jellyfin_invite_provisioning_operations"."provisioned_user_id" is not null and "jellyfin_invite_provisioning_operations"."provisioned_at" is not null))
        and ("jellyfin_invite_provisioning_operations"."policy_pending_at" is null
          or ("jellyfin_invite_provisioning_operations"."provisioned_at" is not null
            and "jellyfin_invite_provisioning_operations"."policy_pending_at" >= "jellyfin_invite_provisioning_operations"."provisioned_at"))
        and ("jellyfin_invite_provisioning_operations"."policy_completed_at" is null
          or ("jellyfin_invite_provisioning_operations"."policy_pending_at" is not null
            and "jellyfin_invite_provisioning_operations"."policy_completed_at" >= "jellyfin_invite_provisioning_operations"."policy_pending_at"))
        and ("jellyfin_invite_provisioning_operations"."reconcile_required_at" is null
          or "jellyfin_invite_provisioning_operations"."reconcile_required_at" >= "jellyfin_invite_provisioning_operations"."creating_at")
        and ("jellyfin_invite_provisioning_operations"."uncertain_at" is null
          or ("jellyfin_invite_provisioning_operations"."uncertain_at" >= "jellyfin_invite_provisioning_operations"."reconcile_required_at"
            and "jellyfin_invite_provisioning_operations"."uncertain_at" >= "jellyfin_invite_provisioning_operations"."creating_at"))
        and ("jellyfin_invite_provisioning_operations"."completed_at" is null or "jellyfin_invite_provisioning_operations"."completed_at" >= "jellyfin_invite_provisioning_operations"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jellyfin_invite_provisioning_operations_invitation_unique` ON `jellyfin_invite_provisioning_operations` (`invitation_id`);--> statement-breakpoint
CREATE INDEX `jellyfin_invite_provisioning_operations_state_lease_idx` ON `jellyfin_invite_provisioning_operations` (`state`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `jellyfin_invite_provisioning_operations_connector_generation_idx` ON `jellyfin_invite_provisioning_operations` (`connector_id`,`connector_instance_generation`,`connector_config_generation`);
