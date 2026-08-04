CREATE TABLE `user_media_state_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reference_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`response_json` text,
	`failure_code` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reference_id`) REFERENCES `media_references`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_media_state_operations_id_check" CHECK(length("user_media_state_operations"."id") = 39
        and substr("user_media_state_operations"."id", 1, 17) = 'user_media_state_'
        and substr("user_media_state_operations"."id", 18) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "user_media_state_operations_reference_check" CHECK(length("user_media_state_operations"."reference_id") = 28
        and substr("user_media_state_operations"."reference_id", 1, 6) = 'media_'
        and substr("user_media_state_operations"."reference_id", 7) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "user_media_state_operations_key_hash_check" CHECK(length("user_media_state_operations"."idempotency_key_hash") = 43
        and "user_media_state_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "user_media_state_operations_fingerprint_hash_check" CHECK(length("user_media_state_operations"."fingerprint_hash") = 43
        and "user_media_state_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "user_media_state_operations_state_check" CHECK("user_media_state_operations"."state" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "user_media_state_operations_response_json_check" CHECK("user_media_state_operations"."response_json" is null
        or (json_valid("user_media_state_operations"."response_json") and json_type("user_media_state_operations"."response_json") = 'object')),
	CONSTRAINT "user_media_state_operations_outcome_check" CHECK((
          "user_media_state_operations"."state" = 'pending'
          and "user_media_state_operations"."response_json" is null
          and "user_media_state_operations"."failure_code" is null
          and "user_media_state_operations"."completed_at" is null
        ) or (
          "user_media_state_operations"."state" = 'succeeded'
          and "user_media_state_operations"."response_json" is not null
          and "user_media_state_operations"."failure_code" is null
          and "user_media_state_operations"."completed_at" is not null
        ) or (
          "user_media_state_operations"."state" = 'failed'
          and "user_media_state_operations"."response_json" is null
          and length("user_media_state_operations"."failure_code") between 1 and 64
          and "user_media_state_operations"."completed_at" is not null
        )),
	CONSTRAINT "user_media_state_operations_timestamp_order_check" CHECK("user_media_state_operations"."completed_at" is null or "user_media_state_operations"."completed_at" >= "user_media_state_operations"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_media_state_operations_user_key_unique` ON `user_media_state_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `user_media_state_operations_state_created_idx` ON `user_media_state_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `user_media_state_operations_reference_idx` ON `user_media_state_operations` (`reference_id`,`created_at`);