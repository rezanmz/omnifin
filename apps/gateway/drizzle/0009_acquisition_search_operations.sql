CREATE TABLE `acquisition_search_operations` (
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
	CONSTRAINT "acquisition_search_operations_key_hash_check" CHECK(length("acquisition_search_operations"."idempotency_key_hash") = 43
        and "acquisition_search_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "acquisition_search_operations_fingerprint_hash_check" CHECK(length("acquisition_search_operations"."fingerprint_hash") = 43
        and "acquisition_search_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "acquisition_search_operations_state_check" CHECK("acquisition_search_operations"."state" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "acquisition_search_operations_response_json_check" CHECK("acquisition_search_operations"."response_json" is null
        or (json_valid("acquisition_search_operations"."response_json") and json_type("acquisition_search_operations"."response_json") = 'object')),
	CONSTRAINT "acquisition_search_operations_outcome_check" CHECK((
          "acquisition_search_operations"."state" = 'pending'
          and "acquisition_search_operations"."response_json" is null
          and "acquisition_search_operations"."failure_code" is null
          and "acquisition_search_operations"."completed_at" is null
        ) or (
          "acquisition_search_operations"."state" = 'succeeded'
          and "acquisition_search_operations"."response_json" is not null
          and "acquisition_search_operations"."failure_code" is null
          and "acquisition_search_operations"."completed_at" is not null
        ) or (
          "acquisition_search_operations"."state" = 'failed'
          and "acquisition_search_operations"."response_json" is null
          and length("acquisition_search_operations"."failure_code") between 1 and 64
          and "acquisition_search_operations"."completed_at" is not null
        )),
	CONSTRAINT "acquisition_search_operations_timestamp_order_check" CHECK("acquisition_search_operations"."completed_at" is null or "acquisition_search_operations"."completed_at" >= "acquisition_search_operations"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `acquisition_search_operations_user_key_unique` ON `acquisition_search_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `acquisition_search_operations_state_created_idx` ON `acquisition_search_operations` (`state`,`created_at`);