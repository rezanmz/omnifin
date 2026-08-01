CREATE TABLE `acquisition_queue_recovery_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`event_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`event_snapshot_json` text,
	`response_json` text,
	`failure_code` text,
	`mutation_started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "acquisition_queue_recovery_operations_id_check" CHECK(length("acquisition_queue_recovery_operations"."id") = 43
        and substr("acquisition_queue_recovery_operations"."id", 1, 21) = 'acquisition_recovery_'
        and substr("acquisition_queue_recovery_operations"."id", 22) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "acquisition_queue_recovery_operations_event_id_check" CHECK(length("acquisition_queue_recovery_operations"."event_id") = 34
        and substr("acquisition_queue_recovery_operations"."event_id", 1, 12) = 'acquisition_'
        and substr("acquisition_queue_recovery_operations"."event_id", 13) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "acquisition_queue_recovery_operations_key_hash_check" CHECK(length("acquisition_queue_recovery_operations"."idempotency_key_hash") = 43
        and "acquisition_queue_recovery_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "acquisition_queue_recovery_operations_fingerprint_hash_check" CHECK(length("acquisition_queue_recovery_operations"."fingerprint_hash") = 43
        and "acquisition_queue_recovery_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "acquisition_queue_recovery_operations_state_check" CHECK("acquisition_queue_recovery_operations"."state" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "acquisition_queue_recovery_operations_event_snapshot_check" CHECK("acquisition_queue_recovery_operations"."event_snapshot_json" is null
        or (json_valid("acquisition_queue_recovery_operations"."event_snapshot_json") and json_type("acquisition_queue_recovery_operations"."event_snapshot_json") = 'object')),
	CONSTRAINT "acquisition_queue_recovery_operations_response_json_check" CHECK("acquisition_queue_recovery_operations"."response_json" is null
        or (json_valid("acquisition_queue_recovery_operations"."response_json") and json_type("acquisition_queue_recovery_operations"."response_json") = 'object')),
	CONSTRAINT "acquisition_queue_recovery_operations_outcome_check" CHECK((
          "acquisition_queue_recovery_operations"."state" = 'pending'
          and "acquisition_queue_recovery_operations"."response_json" is null
          and "acquisition_queue_recovery_operations"."failure_code" is null
          and "acquisition_queue_recovery_operations"."completed_at" is null
        ) or (
          "acquisition_queue_recovery_operations"."state" = 'succeeded'
          and "acquisition_queue_recovery_operations"."event_snapshot_json" is not null
          and "acquisition_queue_recovery_operations"."response_json" is not null
          and "acquisition_queue_recovery_operations"."failure_code" is null
          and "acquisition_queue_recovery_operations"."mutation_started_at" is not null
          and "acquisition_queue_recovery_operations"."completed_at" is not null
        ) or (
          "acquisition_queue_recovery_operations"."state" = 'failed'
          and "acquisition_queue_recovery_operations"."response_json" is null
          and length("acquisition_queue_recovery_operations"."failure_code") between 1 and 64
          and "acquisition_queue_recovery_operations"."completed_at" is not null
        )),
	CONSTRAINT "acquisition_queue_recovery_operations_timestamp_order_check" CHECK(("acquisition_queue_recovery_operations"."mutation_started_at" is null or "acquisition_queue_recovery_operations"."mutation_started_at" >= "acquisition_queue_recovery_operations"."created_at")
        and ("acquisition_queue_recovery_operations"."completed_at" is null or "acquisition_queue_recovery_operations"."completed_at" >= "acquisition_queue_recovery_operations"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `acquisition_queue_recovery_operations_user_key_unique` ON `acquisition_queue_recovery_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `acquisition_queue_recovery_operations_state_created_idx` ON `acquisition_queue_recovery_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `acquisition_queue_recovery_operations_event_idx` ON `acquisition_queue_recovery_operations` (`connector_id`,`event_id`,`created_at`);