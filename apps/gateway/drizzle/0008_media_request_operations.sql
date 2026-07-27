CREATE TABLE `media_request_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`response_json` text,
	`failure_code` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_request_operations_key_hash_check" CHECK(length("media_request_operations"."idempotency_key_hash") = 43
        and "media_request_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_request_operations_fingerprint_hash_check" CHECK(length("media_request_operations"."fingerprint_hash") = 43
        and "media_request_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_request_operations_state_check" CHECK("media_request_operations"."state" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "media_request_operations_response_json_check" CHECK("media_request_operations"."response_json" is null
        or (json_valid("media_request_operations"."response_json") and json_type("media_request_operations"."response_json") = 'object')),
	CONSTRAINT "media_request_operations_outcome_check" CHECK((
          "media_request_operations"."state" = 'pending'
          and "media_request_operations"."response_json" is null
          and "media_request_operations"."failure_code" is null
          and "media_request_operations"."completed_at" is null
        ) or (
          "media_request_operations"."state" = 'succeeded'
          and "media_request_operations"."response_json" is not null
          and "media_request_operations"."failure_code" is null
          and "media_request_operations"."completed_at" is not null
        ) or (
          "media_request_operations"."state" = 'failed'
          and "media_request_operations"."response_json" is null
          and length("media_request_operations"."failure_code") between 1 and 64
          and "media_request_operations"."completed_at" is not null
        )),
	CONSTRAINT "media_request_operations_timestamp_order_check" CHECK("media_request_operations"."completed_at" is null or "media_request_operations"."completed_at" >= "media_request_operations"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_request_operations_user_key_unique` ON `media_request_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `media_request_operations_state_created_idx` ON `media_request_operations` (`state`,`created_at`);
