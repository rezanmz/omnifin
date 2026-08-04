CREATE TABLE `media_download_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`public_token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`service_identity_link_id` text NOT NULL,
	`link_revision` integer NOT NULL,
	`reference_id` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`state` text DEFAULT 'prepared' NOT NULL,
	`bytes_transferred` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reference_id`) REFERENCES `media_references`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_identity_link_id`,`user_id`) REFERENCES `service_identity_links`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_download_grants_id_check" CHECK(length("media_download_grants"."id") = 37
        and substr("media_download_grants"."id", 1, 15) = 'download_grant_'
        and substr("media_download_grants"."id", 16) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_download_grants_public_token_hash_check" CHECK(length("media_download_grants"."public_token_hash") = 43
        and "media_download_grants"."public_token_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_download_grants_link_revision_check" CHECK("media_download_grants"."link_revision" between 0 and 2147483647),
	CONSTRAINT "media_download_grants_payload_check" CHECK(length("media_download_grants"."encrypted_payload") between 1 and 32768),
	CONSTRAINT "media_download_grants_filename_check" CHECK(length("media_download_grants"."filename") between 1 and 240),
	CONSTRAINT "media_download_grants_content_type_check" CHECK(length("media_download_grants"."content_type") between 3 and 128),
	CONSTRAINT "media_download_grants_size_check" CHECK("media_download_grants"."size_bytes" between 1 and 140737488355328
        and "media_download_grants"."bytes_transferred" between 0 and "media_download_grants"."size_bytes"),
	CONSTRAINT "media_download_grants_state_check" CHECK("media_download_grants"."state" in ('prepared', 'streaming', 'completed', 'cancelled', 'failed')),
	CONSTRAINT "media_download_grants_timestamp_order_check" CHECK("media_download_grants"."created_at" < "media_download_grants"."expires_at"
        and "media_download_grants"."updated_at" >= "media_download_grants"."created_at"
        and ("media_download_grants"."started_at" is null or "media_download_grants"."started_at" between "media_download_grants"."created_at" and "media_download_grants"."updated_at")
        and ("media_download_grants"."completed_at" is null or (
          "media_download_grants"."started_at" is not null
          and "media_download_grants"."completed_at" between "media_download_grants"."started_at" and "media_download_grants"."updated_at"
        )))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_download_grants_public_token_unique` ON `media_download_grants` (`public_token_hash`);--> statement-breakpoint
CREATE INDEX `media_download_grants_user_expiry_idx` ON `media_download_grants` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `media_download_grants_session_idx` ON `media_download_grants` (`session_id`);--> statement-breakpoint
CREATE INDEX `media_download_grants_expiry_idx` ON `media_download_grants` (`expires_at`);