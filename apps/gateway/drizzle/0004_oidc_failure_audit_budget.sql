CREATE TABLE `audit_budget_entries` (
	`scope` text NOT NULL,
	`generation` integer NOT NULL,
	`slot` integer NOT NULL,
	`bucket_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `generation`, `slot`),
	FOREIGN KEY (`scope`) REFERENCES `audit_budget_scopes`(`scope`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "audit_budget_entries_scope_check" CHECK("audit_budget_entries"."scope" = 'auth.oidc.failure:v1'),
	CONSTRAINT "audit_budget_entries_generation_check" CHECK(typeof("audit_budget_entries"."generation") = 'integer'
        and "audit_budget_entries"."generation" between 1 and 9007199254740990),
	CONSTRAINT "audit_budget_entries_slot_check" CHECK(typeof("audit_budget_entries"."slot") = 'integer' and "audit_budget_entries"."slot" between 0 and 126),
	CONSTRAINT "audit_budget_entries_bucket_hash_check" CHECK(length("audit_budget_entries"."bucket_hash") = 22
        and "audit_budget_entries"."bucket_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "audit_budget_entries_created_at_check" CHECK(typeof("audit_budget_entries"."created_at") = 'integer'
        and "audit_budget_entries"."created_at" between 0 and 8640000000000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_budget_entries_bucket_unique` ON `audit_budget_entries` (`scope`,`generation`,`bucket_hash`);--> statement-breakpoint
CREATE TABLE `audit_budget_scopes` (
	`scope` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`window_started_at` integer NOT NULL,
	`clock_watermark_at` integer NOT NULL,
	`rollback_started_at` integer,
	`saturated` integer DEFAULT false NOT NULL,
	`suppressed_count` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "audit_budget_scopes_scope_check" CHECK("audit_budget_scopes"."scope" = 'auth.oidc.failure:v1'),
	CONSTRAINT "audit_budget_scopes_generation_check" CHECK(typeof("audit_budget_scopes"."generation") = 'integer'
        and "audit_budget_scopes"."generation" between 1 and 9007199254740990),
	CONSTRAINT "audit_budget_scopes_timestamp_check" CHECK(typeof("audit_budget_scopes"."window_started_at") = 'integer'
        and "audit_budget_scopes"."window_started_at" between 0 and 8640000000000000
        and typeof("audit_budget_scopes"."clock_watermark_at") = 'integer'
        and "audit_budget_scopes"."clock_watermark_at" between 0 and 8640000000000000
        and "audit_budget_scopes"."window_started_at" <= "audit_budget_scopes"."clock_watermark_at"
        and ("audit_budget_scopes"."rollback_started_at" is null or (
          typeof("audit_budget_scopes"."rollback_started_at") = 'integer'
          and "audit_budget_scopes"."rollback_started_at" between 0 and 8640000000000000
          and "audit_budget_scopes"."rollback_started_at" <= "audit_budget_scopes"."clock_watermark_at"
        ))),
	CONSTRAINT "audit_budget_scopes_saturated_check" CHECK("audit_budget_scopes"."saturated" in (0, 1)),
	CONSTRAINT "audit_budget_scopes_suppressed_count_check" CHECK(typeof("audit_budget_scopes"."suppressed_count") = 'integer'
        and "audit_budget_scopes"."suppressed_count" between 0 and 4096)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_budget_scopes_scope_generation_unique` ON `audit_budget_scopes` (`scope`,`generation`);--> statement-breakpoint
CREATE TRIGGER `audit_budget_scopes_delete_protected`
BEFORE DELETE ON `audit_budget_scopes`
BEGIN
	SELECT RAISE(ABORT, 'audit_budget_scope_is_persistent');
END;--> statement-breakpoint
CREATE TRIGGER `audit_budget_scopes_update_guarded`
BEFORE UPDATE ON `audit_budget_scopes`
WHEN NEW.`scope` <> OLD.`scope`
	OR NEW.`generation` < OLD.`generation`
	OR NEW.`generation` > OLD.`generation` + 1
	OR NEW.`clock_watermark_at` < OLD.`clock_watermark_at`
	OR (
		NEW.`generation` = OLD.`generation`
		AND (
			NEW.`window_started_at` < OLD.`window_started_at`
			OR NEW.`saturated` < OLD.`saturated`
			OR NEW.`suppressed_count` < OLD.`suppressed_count`
			OR (
				OLD.`rollback_started_at` IS NULL
				AND NEW.`rollback_started_at` IS NULL
				AND NEW.`window_started_at` <> OLD.`window_started_at`
			)
			OR (
				OLD.`rollback_started_at` IS NULL
				AND NEW.`rollback_started_at` IS NOT NULL
				AND (
					NEW.`window_started_at` <> OLD.`window_started_at`
					OR NEW.`clock_watermark_at` <> OLD.`clock_watermark_at`
					OR NEW.`saturated` <> OLD.`saturated`
					OR NEW.`suppressed_count` <> OLD.`suppressed_count`
				)
			)
			OR (
				OLD.`rollback_started_at` IS NOT NULL
				AND NEW.`rollback_started_at` IS NOT NULL
				AND (
					NEW.`rollback_started_at` > OLD.`rollback_started_at`
					OR NEW.`window_started_at` <> OLD.`window_started_at`
					OR NEW.`clock_watermark_at` <> OLD.`clock_watermark_at`
				)
			)
			OR (
				OLD.`rollback_started_at` IS NOT NULL
				AND NEW.`rollback_started_at` IS NULL
				AND (
					NEW.`window_started_at` <> NEW.`clock_watermark_at`
					OR NEW.`saturated` <> OLD.`saturated`
					OR NEW.`suppressed_count` <> OLD.`suppressed_count`
				)
			)
		)
	)
	OR (
		NEW.`generation` = OLD.`generation` + 1
		AND (
			NEW.`saturated` <> 0
			OR NEW.`suppressed_count` <> 0
			OR (
				NEW.`rollback_started_at` IS NULL
				AND NEW.`window_started_at` <> NEW.`clock_watermark_at`
			)
			OR (
				NEW.`rollback_started_at` IS NOT NULL
				AND (
					NEW.`window_started_at` <> NEW.`rollback_started_at`
					OR NEW.`clock_watermark_at` <> OLD.`clock_watermark_at`
				)
			)
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'audit_budget_scope_transition_is_invalid');
END;--> statement-breakpoint
CREATE TRIGGER `audit_budget_entries_insert_current_generation`
BEFORE INSERT ON `audit_budget_entries`
WHEN NEW.`generation` <> COALESCE((
	SELECT `generation`
	FROM `audit_budget_scopes`
	WHERE `scope` = NEW.`scope`
), 0)
BEGIN
	SELECT RAISE(ABORT, 'audit_budget_entry_generation_is_not_current');
END;--> statement-breakpoint
CREATE TRIGGER `audit_budget_entries_update_immutable`
BEFORE UPDATE ON `audit_budget_entries`
BEGIN
	SELECT RAISE(ABORT, 'audit_budget_entry_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `audit_budget_entries_current_generation_delete_protected`
BEFORE DELETE ON `audit_budget_entries`
WHEN OLD.`generation` >= COALESCE((
	SELECT `generation`
	FROM `audit_budget_scopes`
	WHERE `scope` = OLD.`scope`
), 0)
BEGIN
	SELECT RAISE(ABORT, 'audit_budget_current_generation_is_persistent');
END;
