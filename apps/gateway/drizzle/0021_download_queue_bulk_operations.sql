CREATE TABLE `download_queue_bulk_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`request_json` text NOT NULL,
	`results_json` text DEFAULT '[]' NOT NULL,
	`response_json` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "download_queue_bulk_operations_id_check" CHECK(length("download_queue_bulk_operations"."id") = 36
        and substr("download_queue_bulk_operations"."id", 1, 14) = 'download_bulk_'
        and substr("download_queue_bulk_operations"."id", 15) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_bulk_operations_key_hash_check" CHECK(length("download_queue_bulk_operations"."idempotency_key_hash") = 43
        and "download_queue_bulk_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_bulk_operations_fingerprint_hash_check" CHECK(length("download_queue_bulk_operations"."fingerprint_hash") = 43
        and "download_queue_bulk_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_bulk_operations_state_check" CHECK("download_queue_bulk_operations"."state" in ('pending', 'succeeded')),
	CONSTRAINT "download_queue_bulk_operations_request_json_check" CHECK(json_valid("download_queue_bulk_operations"."request_json") and json_type("download_queue_bulk_operations"."request_json") = 'object'),
	CONSTRAINT "download_queue_bulk_operations_results_json_check" CHECK(json_valid("download_queue_bulk_operations"."results_json") and json_type("download_queue_bulk_operations"."results_json") = 'array'),
	CONSTRAINT "download_queue_bulk_operations_response_json_check" CHECK("download_queue_bulk_operations"."response_json" is null
        or (json_valid("download_queue_bulk_operations"."response_json") and json_type("download_queue_bulk_operations"."response_json") = 'object')),
	CONSTRAINT "download_queue_bulk_operations_outcome_check" CHECK((
          "download_queue_bulk_operations"."state" = 'pending'
          and "download_queue_bulk_operations"."response_json" is null
          and "download_queue_bulk_operations"."completed_at" is null
        ) or (
          "download_queue_bulk_operations"."state" = 'succeeded'
          and "download_queue_bulk_operations"."response_json" is not null
          and "download_queue_bulk_operations"."completed_at" is not null
        )),
	CONSTRAINT "download_queue_bulk_operations_timestamp_order_check" CHECK("download_queue_bulk_operations"."completed_at" is null or "download_queue_bulk_operations"."completed_at" >= "download_queue_bulk_operations"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `download_queue_bulk_operations_user_key_unique` ON `download_queue_bulk_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `download_queue_bulk_operations_state_created_idx` ON `download_queue_bulk_operations` (`state`,`created_at`);