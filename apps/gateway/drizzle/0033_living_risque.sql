PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_download_queue_bulk_operations` (
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
	CONSTRAINT "download_queue_bulk_operations_id_check" CHECK(length("__new_download_queue_bulk_operations"."id") = 36
        and substr("__new_download_queue_bulk_operations"."id", 1, 14) = 'download_bulk_'
        and substr("__new_download_queue_bulk_operations"."id", 15) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_bulk_operations_key_hash_check" CHECK(length("__new_download_queue_bulk_operations"."idempotency_key_hash") = 43
        and "__new_download_queue_bulk_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_bulk_operations_fingerprint_hash_check" CHECK(length("__new_download_queue_bulk_operations"."fingerprint_hash") = 43
        and "__new_download_queue_bulk_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_bulk_operations_state_check" CHECK("__new_download_queue_bulk_operations"."state" in ('pending', 'quarantined', 'succeeded')),
	CONSTRAINT "download_queue_bulk_operations_request_json_check" CHECK(json_valid("__new_download_queue_bulk_operations"."request_json") and json_type("__new_download_queue_bulk_operations"."request_json") = 'object'),
	CONSTRAINT "download_queue_bulk_operations_results_json_check" CHECK(json_valid("__new_download_queue_bulk_operations"."results_json") and json_type("__new_download_queue_bulk_operations"."results_json") = 'array'),
	CONSTRAINT "download_queue_bulk_operations_response_json_check" CHECK("__new_download_queue_bulk_operations"."response_json" is null
        or (json_valid("__new_download_queue_bulk_operations"."response_json") and json_type("__new_download_queue_bulk_operations"."response_json") = 'object')),
	CONSTRAINT "download_queue_bulk_operations_outcome_check" CHECK((
          "__new_download_queue_bulk_operations"."state" = 'pending'
          and "__new_download_queue_bulk_operations"."response_json" is null
          and "__new_download_queue_bulk_operations"."completed_at" is null
        ) or (
          "__new_download_queue_bulk_operations"."state" = 'quarantined'
          and "__new_download_queue_bulk_operations"."response_json" is null
          and "__new_download_queue_bulk_operations"."completed_at" is not null
        ) or (
          "__new_download_queue_bulk_operations"."state" = 'succeeded'
          and "__new_download_queue_bulk_operations"."response_json" is not null
          and "__new_download_queue_bulk_operations"."completed_at" is not null
        )),
	CONSTRAINT "download_queue_bulk_operations_timestamp_order_check" CHECK("__new_download_queue_bulk_operations"."completed_at" is null or "__new_download_queue_bulk_operations"."completed_at" >= "__new_download_queue_bulk_operations"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_download_queue_bulk_operations`("id", "user_id", "idempotency_key_hash", "fingerprint_hash", "state", "request_json", "results_json", "response_json", "completed_at", "created_at", "updated_at") SELECT "id", "user_id", "idempotency_key_hash", "fingerprint_hash", "state", "request_json", "results_json", "response_json", "completed_at", "created_at", "updated_at" FROM `download_queue_bulk_operations`;--> statement-breakpoint
DROP TABLE `download_queue_bulk_operations`;--> statement-breakpoint
ALTER TABLE `__new_download_queue_bulk_operations` RENAME TO `download_queue_bulk_operations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `download_queue_bulk_operations_user_key_unique` ON `download_queue_bulk_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `download_queue_bulk_operations_state_created_idx` ON `download_queue_bulk_operations` (`state`,`created_at`);