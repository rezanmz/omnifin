CREATE TABLE `library_artwork_searches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`service_identity_link_id` text NOT NULL,
	`link_revision` integer NOT NULL,
	`media_reference_id` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_reference_id`) REFERENCES `media_references`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_identity_link_id`,`user_id`) REFERENCES `service_identity_links`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "library_artwork_searches_id_check" CHECK(length("library_artwork_searches"."id") = 45
        and substr("library_artwork_searches"."id", 1, 23) = 'library_artwork_search_'
        and substr("library_artwork_searches"."id", 24) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_artwork_searches_payload_check" CHECK(length("library_artwork_searches"."encrypted_payload") between 1 and 4194304),
	CONSTRAINT "library_artwork_searches_link_revision_check" CHECK("library_artwork_searches"."link_revision" between 0 and 2147483647),
	CONSTRAINT "library_artwork_searches_timestamp_order_check" CHECK("library_artwork_searches"."created_at" >= 0
        and "library_artwork_searches"."created_at" <= "library_artwork_searches"."updated_at"
        and "library_artwork_searches"."created_at" < "library_artwork_searches"."expires_at")
);
--> statement-breakpoint
CREATE INDEX `library_artwork_searches_user_created_idx` ON `library_artwork_searches` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `library_artwork_searches_expiry_idx` ON `library_artwork_searches` (`expires_at`);--> statement-breakpoint
CREATE INDEX `library_artwork_searches_media_idx` ON `library_artwork_searches` (`media_reference_id`);--> statement-breakpoint
CREATE TABLE `library_mutation_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`reference_id` text,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`response_json` text,
	`failure_code` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "library_mutation_operations_id_check" CHECK(length("library_mutation_operations"."id") = 40
        and substr("library_mutation_operations"."id", 1, 18) = 'library_operation_'
        and substr("library_mutation_operations"."id", 19) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_mutation_operations_kind_check" CHECK("library_mutation_operations"."kind" in ('scan', 'item_refresh', 'metadata_update', 'artwork_apply')),
	CONSTRAINT "library_mutation_operations_reference_check" CHECK(("library_mutation_operations"."kind" = 'scan' and "library_mutation_operations"."reference_id" is null)
        or ("library_mutation_operations"."kind" <> 'scan'
          and length("library_mutation_operations"."reference_id") = 28
          and substr("library_mutation_operations"."reference_id", 1, 6) = 'media_'
          and substr("library_mutation_operations"."reference_id", 7) not glob '*[^A-Za-z0-9_-]*')),
	CONSTRAINT "library_mutation_operations_key_hash_check" CHECK(length("library_mutation_operations"."idempotency_key_hash") = 43
        and "library_mutation_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_mutation_operations_fingerprint_hash_check" CHECK(length("library_mutation_operations"."fingerprint_hash") = 43
        and "library_mutation_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_mutation_operations_state_check" CHECK("library_mutation_operations"."state" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "library_mutation_operations_response_json_check" CHECK("library_mutation_operations"."response_json" is null
        or (json_valid("library_mutation_operations"."response_json") and json_type("library_mutation_operations"."response_json") = 'object')),
	CONSTRAINT "library_mutation_operations_outcome_check" CHECK((
          "library_mutation_operations"."state" = 'pending'
          and "library_mutation_operations"."response_json" is null
          and "library_mutation_operations"."failure_code" is null
          and "library_mutation_operations"."completed_at" is null
        ) or (
          "library_mutation_operations"."state" = 'succeeded'
          and "library_mutation_operations"."response_json" is not null
          and "library_mutation_operations"."failure_code" is null
          and "library_mutation_operations"."completed_at" is not null
        ) or (
          "library_mutation_operations"."state" = 'failed'
          and "library_mutation_operations"."response_json" is null
          and length("library_mutation_operations"."failure_code") between 1 and 64
          and "library_mutation_operations"."completed_at" is not null
        )),
	CONSTRAINT "library_mutation_operations_timestamp_order_check" CHECK("library_mutation_operations"."completed_at" is null or "library_mutation_operations"."completed_at" >= "library_mutation_operations"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_mutation_operations_user_key_unique` ON `library_mutation_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `library_mutation_operations_state_created_idx` ON `library_mutation_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `library_mutation_operations_reference_idx` ON `library_mutation_operations` (`reference_id`,`created_at`);