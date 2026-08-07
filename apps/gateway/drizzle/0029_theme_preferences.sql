PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`role_source` text DEFAULT 'default' NOT NULL,
	`status` text DEFAULT 'pending_link' NOT NULL,
	`theme_preference` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "users_role_check" CHECK("__new_users"."role" in ('viewer', 'requester', 'operator', 'admin')),
	CONSTRAINT "users_role_source_check" CHECK("__new_users"."role_source" in ('default', 'oidc_mapping', 'manual', 'recovery_bootstrap')),
	CONSTRAINT "users_status_check" CHECK("__new_users"."status" in ('active', 'pending_link', 'disabled')),
	CONSTRAINT "users_theme_preference_check" CHECK("__new_users"."theme_preference" is null or "__new_users"."theme_preference" in ('system', 'light', 'dark'))
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "display_name", "role", "role_source", "status", "created_at", "updated_at") SELECT "id", "display_name", "role", "role_source", "status", "created_at", "updated_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);
