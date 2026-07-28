CREATE TABLE `media_references` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`service_identity_link_id` text NOT NULL,
	`link_revision` integer NOT NULL,
	`item_digest` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`last_used_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_identity_link_id`,`user_id`) REFERENCES `service_identity_links`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_references_id_check" CHECK(length("media_references"."id") = 28
        and substr("media_references"."id", 1, 6) = 'media_'
        and substr("media_references"."id", 7) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_references_item_digest_check" CHECK(length("media_references"."item_digest") = 22
        and "media_references"."item_digest" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_references_payload_check" CHECK(length("media_references"."encrypted_payload") between 1 and 32768),
	CONSTRAINT "media_references_link_revision_check" CHECK("media_references"."link_revision" between 0 and 2147483647),
	CONSTRAINT "media_references_timestamp_order_check" CHECK("media_references"."created_at" >= 0
        and "media_references"."created_at" <= "media_references"."updated_at"
        and "media_references"."created_at" <= "media_references"."last_used_at"
        and "media_references"."last_used_at" < "media_references"."expires_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_references_link_item_unique` ON `media_references` (`service_identity_link_id`,`link_revision`,`item_digest`);--> statement-breakpoint
CREATE INDEX `media_references_user_last_used_idx` ON `media_references` (`user_id`,`last_used_at`);--> statement-breakpoint
CREATE INDEX `media_references_expiry_idx` ON `media_references` (`expires_at`);