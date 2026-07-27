CREATE INDEX `sessions_user_created_idx` ON `sessions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sessions_user_active_idx` ON `sessions` (`user_id`,`revoked_at`,`expires_at`,`absolute_expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_recovery_created_idx` ON `sessions` (`created_at`) WHERE "sessions"."auth_method" = 'recovery';--> statement-breakpoint
CREATE INDEX `sessions_active_recovery_idx` ON `sessions` (`revoked_at`) WHERE "sessions"."auth_method" = 'recovery' and "sessions"."revoked_at" is null;
