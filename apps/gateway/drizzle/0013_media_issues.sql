CREATE TABLE `media_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`service_identity_link_id` text NOT NULL,
	`media_reference_id` text NOT NULL,
	`playback_session_id` text NOT NULL,
	`category` text NOT NULL,
	`encrypted_description` text,
	`position_seconds` integer NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`encrypted_resolution` text,
	`resolved_by_user_id` text,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_reference_id`) REFERENCES `media_references`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`service_identity_link_id`,`user_id`) REFERENCES `service_identity_links`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_issues_id_check" CHECK(length("media_issues"."id") = 28
        and substr("media_issues"."id", 1, 6) = 'issue_'
        and substr("media_issues"."id", 7) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_issues_playback_session_id_check" CHECK(length("media_issues"."playback_session_id") = 31
        and substr("media_issues"."playback_session_id", 1, 9) = 'playback_'
        and substr("media_issues"."playback_session_id", 10) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_issues_category_check" CHECK("media_issues"."category" in ('audio', 'buffering', 'subtitles', 'sync', 'video_quality', 'other')),
	CONSTRAINT "media_issues_description_check" CHECK("media_issues"."encrypted_description" is null or length("media_issues"."encrypted_description") between 1 and 8192),
	CONSTRAINT "media_issues_position_check" CHECK("media_issues"."position_seconds" between 0 and 10000000),
	CONSTRAINT "media_issues_state_check" CHECK("media_issues"."state" in ('open', 'resolved')),
	CONSTRAINT "media_issues_resolution_check" CHECK((
          "media_issues"."state" = 'open'
          and "media_issues"."encrypted_resolution" is null
          and "media_issues"."resolved_by_user_id" is null
          and "media_issues"."resolved_at" is null
        ) or (
          "media_issues"."state" = 'resolved'
          and "media_issues"."encrypted_resolution" is not null
          and length("media_issues"."encrypted_resolution") between 1 and 8192
          and "media_issues"."resolved_by_user_id" is not null
          and "media_issues"."resolved_at" is not null
        )),
	CONSTRAINT "media_issues_timestamp_order_check" CHECK("media_issues"."created_at" >= 0
        and "media_issues"."created_at" <= "media_issues"."updated_at"
        and ("media_issues"."resolved_at" is null or "media_issues"."resolved_at" between "media_issues"."created_at" and "media_issues"."updated_at"))
);
--> statement-breakpoint
CREATE INDEX `media_issues_state_created_idx` ON `media_issues` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `media_issues_user_created_idx` ON `media_issues` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `media_issues_media_created_idx` ON `media_issues` (`media_reference_id`,`created_at`);