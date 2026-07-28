CREATE TABLE `subtitle_download_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`search_id` text NOT NULL,
	`result_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`response_json` text,
	`failure_code` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "subtitle_download_operations_id_check" CHECK(length("subtitle_download_operations"."id") = 40
        and substr("subtitle_download_operations"."id", 1, 18) = 'subtitle_download_'
        and substr("subtitle_download_operations"."id", 19) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "subtitle_download_operations_search_id_check" CHECK(length("subtitle_download_operations"."search_id") = 38
        and substr("subtitle_download_operations"."search_id", 1, 16) = 'subtitle_search_'
        and substr("subtitle_download_operations"."search_id", 17) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "subtitle_download_operations_result_id_check" CHECK(length("subtitle_download_operations"."result_id") = 38
        and substr("subtitle_download_operations"."result_id", 1, 16) = 'subtitle_result_'
        and substr("subtitle_download_operations"."result_id", 17) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "subtitle_download_operations_key_hash_check" CHECK(length("subtitle_download_operations"."idempotency_key_hash") = 43
        and "subtitle_download_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "subtitle_download_operations_fingerprint_hash_check" CHECK(length("subtitle_download_operations"."fingerprint_hash") = 43
        and "subtitle_download_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "subtitle_download_operations_state_check" CHECK("subtitle_download_operations"."state" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "subtitle_download_operations_response_json_check" CHECK("subtitle_download_operations"."response_json" is null
        or (json_valid("subtitle_download_operations"."response_json") and json_type("subtitle_download_operations"."response_json") = 'object')),
	CONSTRAINT "subtitle_download_operations_outcome_check" CHECK((
          "subtitle_download_operations"."state" = 'pending'
          and "subtitle_download_operations"."response_json" is null
          and "subtitle_download_operations"."failure_code" is null
          and "subtitle_download_operations"."completed_at" is null
        ) or (
          "subtitle_download_operations"."state" = 'succeeded'
          and "subtitle_download_operations"."response_json" is not null
          and "subtitle_download_operations"."failure_code" is null
          and "subtitle_download_operations"."completed_at" is not null
        ) or (
          "subtitle_download_operations"."state" = 'failed'
          and "subtitle_download_operations"."response_json" is null
          and length("subtitle_download_operations"."failure_code") between 1 and 64
          and "subtitle_download_operations"."completed_at" is not null
        )),
	CONSTRAINT "subtitle_download_operations_timestamp_order_check" CHECK("subtitle_download_operations"."completed_at" is null or "subtitle_download_operations"."completed_at" >= "subtitle_download_operations"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subtitle_download_operations_user_key_unique` ON `subtitle_download_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `subtitle_download_operations_state_created_idx` ON `subtitle_download_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `subtitle_searches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`service_identity_link_id` text NOT NULL,
	`link_revision` integer NOT NULL,
	`media_reference_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_reference_id`) REFERENCES `media_references`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_identity_link_id`,`user_id`) REFERENCES `service_identity_links`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "subtitle_searches_id_check" CHECK(length("subtitle_searches"."id") = 38
        and substr("subtitle_searches"."id", 1, 16) = 'subtitle_search_'
        and substr("subtitle_searches"."id", 17) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "subtitle_searches_payload_check" CHECK(length("subtitle_searches"."encrypted_payload") between 1 and 4194304),
	CONSTRAINT "subtitle_searches_link_revision_check" CHECK("subtitle_searches"."link_revision" between 0 and 2147483647),
	CONSTRAINT "subtitle_searches_timestamp_order_check" CHECK("subtitle_searches"."created_at" >= 0
        and "subtitle_searches"."created_at" <= "subtitle_searches"."updated_at"
        and "subtitle_searches"."created_at" < "subtitle_searches"."expires_at")
);
--> statement-breakpoint
CREATE INDEX `subtitle_searches_user_created_idx` ON `subtitle_searches` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `subtitle_searches_expiry_idx` ON `subtitle_searches` (`expires_at`);--> statement-breakpoint
CREATE INDEX `subtitle_searches_media_idx` ON `subtitle_searches` (`media_reference_id`);
