CREATE TABLE `playback_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`service_identity_link_id` text NOT NULL,
	`link_revision` integer NOT NULL,
	`media_reference_id` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`state` text NOT NULL,
	`position_seconds` integer NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`last_reported_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_reference_id`) REFERENCES `media_references`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_identity_link_id`,`user_id`) REFERENCES `service_identity_links`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "playback_sessions_id_check" CHECK(length("playback_sessions"."id") = 31
        and substr("playback_sessions"."id", 1, 9) = 'playback_'
        and substr("playback_sessions"."id", 10) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "playback_sessions_payload_check" CHECK(length("playback_sessions"."encrypted_payload") between 1 and 65536),
	CONSTRAINT "playback_sessions_state_check" CHECK("playback_sessions"."state" in ('negotiated', 'playing', 'paused', 'stopped')),
	CONSTRAINT "playback_sessions_position_check" CHECK("playback_sessions"."position_seconds" between 0 and 10000000),
	CONSTRAINT "playback_sessions_link_revision_check" CHECK("playback_sessions"."link_revision" between 0 and 2147483647),
	CONSTRAINT "playback_sessions_revision_check" CHECK("playback_sessions"."revision" between 0 and 2147483647),
	CONSTRAINT "playback_sessions_timestamp_order_check" CHECK("playback_sessions"."created_at" >= 0
        and "playback_sessions"."created_at" <= "playback_sessions"."updated_at"
        and "playback_sessions"."created_at" < "playback_sessions"."expires_at"
        and ("playback_sessions"."last_reported_at" is null or "playback_sessions"."last_reported_at" between "playback_sessions"."created_at" and "playback_sessions"."updated_at"))
);
--> statement-breakpoint
CREATE INDEX `playback_sessions_user_updated_idx` ON `playback_sessions` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `playback_sessions_expiry_idx` ON `playback_sessions` (`expires_at`);