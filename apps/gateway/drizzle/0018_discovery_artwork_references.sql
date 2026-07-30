CREATE TABLE `discovery_artwork_references` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`item_digest` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`last_used_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "discovery_artwork_references_id_check" CHECK(length("discovery_artwork_references"."id") = 36
        and substr("discovery_artwork_references"."id", 1, 14) = 'discovery_art_'
        and substr("discovery_artwork_references"."id", 15) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "discovery_artwork_references_item_digest_check" CHECK(length("discovery_artwork_references"."item_digest") = 22
        and "discovery_artwork_references"."item_digest" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "discovery_artwork_references_payload_check" CHECK(length("discovery_artwork_references"."encrypted_payload") between 1 and 4096),
	CONSTRAINT "discovery_artwork_references_timestamp_order_check" CHECK("discovery_artwork_references"."created_at" >= 0
        and "discovery_artwork_references"."created_at" <= "discovery_artwork_references"."updated_at"
        and "discovery_artwork_references"."created_at" <= "discovery_artwork_references"."last_used_at"
        and "discovery_artwork_references"."last_used_at" < "discovery_artwork_references"."expires_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discovery_artwork_references_user_item_unique` ON `discovery_artwork_references` (`user_id`,`connector_id`,`item_digest`);--> statement-breakpoint
CREATE INDEX `discovery_artwork_references_user_last_used_idx` ON `discovery_artwork_references` (`user_id`,`last_used_at`);--> statement-breakpoint
CREATE INDEX `discovery_artwork_references_expiry_idx` ON `discovery_artwork_references` (`expires_at`);
