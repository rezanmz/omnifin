-- Persist stable upstream profile references without retaining browser routing envelopes.
CREATE TABLE `media_request_profile_preferences` (
	`connector_id` text NOT NULL,
	`kind` text NOT NULL,
	`is_4k` integer NOT NULL,
	`destination_id` integer NOT NULL,
	`profile_id` integer NOT NULL,
	`updated_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`connector_id`, `kind`, `is_4k`),
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "media_request_profile_preferences_kind_check" CHECK("media_request_profile_preferences"."kind" in ('movie', 'series')),
	CONSTRAINT "media_request_profile_preferences_is_4k_check" CHECK("media_request_profile_preferences"."is_4k" in (0, 1)),
	CONSTRAINT "media_request_profile_preferences_destination_check" CHECK("media_request_profile_preferences"."destination_id" between 0 and 2147483647),
	CONSTRAINT "media_request_profile_preferences_profile_check" CHECK("media_request_profile_preferences"."profile_id" between 1 and 2147483647)
);
