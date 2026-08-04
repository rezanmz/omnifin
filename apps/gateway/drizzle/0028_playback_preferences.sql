-- Semantic playback preferences follow private saved-list state.
CREATE TABLE `playback_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`preferences_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "playback_preferences_schema_version_check" CHECK("playback_preferences"."schema_version" = 1),
	CONSTRAINT "playback_preferences_json_check" CHECK(length("playback_preferences"."preferences_json") between 2 and 8192
        and json_valid("playback_preferences"."preferences_json")
        and json_type("playback_preferences"."preferences_json") = 'object'),
	CONSTRAINT "playback_preferences_revision_check" CHECK("playback_preferences"."revision" between 1 and 2147483647),
	CONSTRAINT "playback_preferences_timestamp_order_check" CHECK("playback_preferences"."created_at" >= 0
        and "playback_preferences"."created_at" <= "playback_preferences"."updated_at")
);
