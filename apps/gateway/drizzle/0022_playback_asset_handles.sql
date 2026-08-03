CREATE TABLE `playback_asset_handles` (
	`id` text PRIMARY KEY NOT NULL,
	`playback_session_id` text NOT NULL,
	`target_digest` text NOT NULL,
	`encrypted_target` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`playback_session_id`) REFERENCES `playback_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "playback_asset_handles_id_check" CHECK(length("playback_asset_handles"."id") = 31
        and substr("playback_asset_handles"."id", 1, 9) = 'asset_h1.'
        and substr("playback_asset_handles"."id", 10) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "playback_asset_handles_target_digest_check" CHECK(length("playback_asset_handles"."target_digest") = 22
        and "playback_asset_handles"."target_digest" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "playback_asset_handles_target_check" CHECK(length("playback_asset_handles"."encrypted_target") between 1 and 65536),
	CONSTRAINT "playback_asset_handles_timestamp_order_check" CHECK("playback_asset_handles"."created_at" >= 0
        and "playback_asset_handles"."created_at" <= "playback_asset_handles"."updated_at"
        and "playback_asset_handles"."created_at" <= "playback_asset_handles"."last_used_at"
        and "playback_asset_handles"."last_used_at" < "playback_asset_handles"."expires_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playback_asset_handles_session_target_idx` ON `playback_asset_handles` (`playback_session_id`,`target_digest`);--> statement-breakpoint
CREATE INDEX `playback_asset_handles_expiry_idx` ON `playback_asset_handles` (`expires_at`);