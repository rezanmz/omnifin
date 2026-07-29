CREATE TABLE `download_queue_removal_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`item_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`item_snapshot_json` text,
	`response_json` text,
	`failure_code` text,
	`mutation_started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "download_queue_removal_operations_id_check" CHECK(length("download_queue_removal_operations"."id") = 39
        and substr("download_queue_removal_operations"."id", 1, 17) = 'download_removal_'
        and substr("download_queue_removal_operations"."id", 18) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_removal_operations_item_id_check" CHECK(length("download_queue_removal_operations"."item_id") = 31
        and substr("download_queue_removal_operations"."item_id", 1, 9) = 'download_'
        and substr("download_queue_removal_operations"."item_id", 10) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_removal_operations_key_hash_check" CHECK(length("download_queue_removal_operations"."idempotency_key_hash") = 43
        and "download_queue_removal_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_removal_operations_fingerprint_hash_check" CHECK(length("download_queue_removal_operations"."fingerprint_hash") = 43
        and "download_queue_removal_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_removal_operations_state_check" CHECK("download_queue_removal_operations"."state" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "download_queue_removal_operations_item_snapshot_check" CHECK("download_queue_removal_operations"."item_snapshot_json" is null
        or (json_valid("download_queue_removal_operations"."item_snapshot_json") and json_type("download_queue_removal_operations"."item_snapshot_json") = 'object')),
	CONSTRAINT "download_queue_removal_operations_response_json_check" CHECK("download_queue_removal_operations"."response_json" is null
        or (json_valid("download_queue_removal_operations"."response_json") and json_type("download_queue_removal_operations"."response_json") = 'object')),
	CONSTRAINT "download_queue_removal_operations_outcome_check" CHECK((
          "download_queue_removal_operations"."state" = 'pending'
          and "download_queue_removal_operations"."response_json" is null
          and "download_queue_removal_operations"."failure_code" is null
          and "download_queue_removal_operations"."completed_at" is null
        ) or (
          "download_queue_removal_operations"."state" = 'succeeded'
          and "download_queue_removal_operations"."item_snapshot_json" is not null
          and "download_queue_removal_operations"."response_json" is not null
          and "download_queue_removal_operations"."failure_code" is null
          and "download_queue_removal_operations"."mutation_started_at" is not null
          and "download_queue_removal_operations"."completed_at" is not null
        ) or (
          "download_queue_removal_operations"."state" = 'failed'
          and "download_queue_removal_operations"."response_json" is null
          and length("download_queue_removal_operations"."failure_code") between 1 and 64
          and "download_queue_removal_operations"."completed_at" is not null
        )),
	CONSTRAINT "download_queue_removal_operations_timestamp_order_check" CHECK(("download_queue_removal_operations"."mutation_started_at" is null or "download_queue_removal_operations"."mutation_started_at" >= "download_queue_removal_operations"."created_at")
        and ("download_queue_removal_operations"."completed_at" is null or "download_queue_removal_operations"."completed_at" >= "download_queue_removal_operations"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `download_queue_removal_operations_user_key_unique` ON `download_queue_removal_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `download_queue_removal_operations_state_created_idx` ON `download_queue_removal_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `download_queue_removal_operations_item_idx` ON `download_queue_removal_operations` (`connector_id`,`item_id`,`created_at`);