CREATE TABLE `session_rotation_aliases` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`purpose` text DEFAULT 'bearer' NOT NULL,
	`state` text DEFAULT 'rotation_grace' NOT NULL,
	`session_id` text NOT NULL,
	`valid_from` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`token_hash`,`purpose`,`session_id`) REFERENCES `session_secret_reservations`(`secret_hash`,`purpose`,`origin_session_id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "session_rotation_aliases_token_hash_check" CHECK(length("session_rotation_aliases"."token_hash") = 43
        and "session_rotation_aliases"."token_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "session_rotation_aliases_purpose_check" CHECK("session_rotation_aliases"."purpose" = 'bearer'),
	CONSTRAINT "session_rotation_aliases_state_check" CHECK("session_rotation_aliases"."state" = 'rotation_grace'),
	CONSTRAINT "session_rotation_aliases_timestamp_order_check" CHECK("session_rotation_aliases"."valid_from" >= 0
        and "session_rotation_aliases"."expires_at" > "session_rotation_aliases"."valid_from"
        and "session_rotation_aliases"."expires_at" <= "session_rotation_aliases"."valid_from" + 10000)
);
--> statement-breakpoint
CREATE INDEX `session_rotation_aliases_session_idx` ON `session_rotation_aliases` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_rotation_aliases_expiry_idx` ON `session_rotation_aliases` (`expires_at`);--> statement-breakpoint
CREATE TABLE `session_secret_reservations` (
	`secret_hash` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`origin_session_id` text NOT NULL,
	`reserved_at` integer NOT NULL,
	CONSTRAINT "session_secret_reservations_secret_hash_check" CHECK(length("session_secret_reservations"."secret_hash") = 43
        and "session_secret_reservations"."secret_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "session_secret_reservations_origin_session_id_check" CHECK(length("session_secret_reservations"."origin_session_id") between 1 and 128
        and "session_secret_reservations"."origin_session_id" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "session_secret_reservations_purpose_check" CHECK("session_secret_reservations"."purpose" in ('bearer', 'csrf')),
	CONSTRAINT "session_secret_reservations_reserved_at_check" CHECK("session_secret_reservations"."reserved_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_secret_reservations_attribution_unique` ON `session_secret_reservations` (`secret_hash`,`purpose`,`origin_session_id`);--> statement-breakpoint
CREATE INDEX `session_secret_reservations_origin_idx` ON `session_secret_reservations` (`origin_session_id`,`purpose`);--> statement-breakpoint
INSERT INTO `session_secret_reservations` (
	`secret_hash`,
	`purpose`,
	`origin_session_id`,
	`reserved_at`
)
SELECT
	`token_hash`,
	'bearer',
	`id`,
	`last_rotated_at`
FROM `sessions`
UNION ALL
SELECT
	`csrf_token_hash`,
	'csrf',
	`id`,
	`created_at`
FROM `sessions`;--> statement-breakpoint
CREATE TRIGGER `sessions_secret_reservations_insert`
AFTER INSERT ON `sessions`
BEGIN
	INSERT OR IGNORE INTO `session_secret_reservations` (
		`secret_hash`,
		`purpose`,
		`origin_session_id`,
		`reserved_at`
	) VALUES (
		NEW.`token_hash`,
		'bearer',
		NEW.`id`,
		NEW.`created_at`
	);
	SELECT CASE
		WHEN changes() <> 1 THEN RAISE(ABORT, 'session_secret_reservation_collision')
	END;
	INSERT OR IGNORE INTO `session_secret_reservations` (
		`secret_hash`,
		`purpose`,
		`origin_session_id`,
		`reserved_at`
	) VALUES (
		NEW.`csrf_token_hash`,
		'csrf',
		NEW.`id`,
		NEW.`created_at`
	);
	SELECT CASE
		WHEN changes() <> 1 THEN RAISE(ABORT, 'session_secret_reservation_collision')
	END;
END;--> statement-breakpoint
CREATE TRIGGER `sessions_secret_reservations_bearer_update`
AFTER UPDATE OF `token_hash` ON `sessions`
WHEN NEW.`token_hash` <> OLD.`token_hash`
BEGIN
	INSERT OR IGNORE INTO `session_secret_reservations` (
		`secret_hash`,
		`purpose`,
		`origin_session_id`,
		`reserved_at`
	) VALUES (
		NEW.`token_hash`,
		'bearer',
		NEW.`id`,
		NEW.`last_rotated_at`
	);
	SELECT CASE
		WHEN changes() <> 1 THEN RAISE(ABORT, 'session_secret_reservation_collision')
	END;
	INSERT INTO `session_rotation_aliases` (
		`token_hash`,
		`purpose`,
		`state`,
		`session_id`,
		`valid_from`,
		`expires_at`
	)
	SELECT
		OLD.`token_hash`,
		'bearer',
		'rotation_grace',
		NEW.`id`,
		NEW.`last_rotated_at`,
		min(NEW.`last_rotated_at` + 10000, NEW.`expires_at`, NEW.`absolute_expires_at`)
	WHERE NEW.`revoked_at` is null;
END;--> statement-breakpoint
CREATE TRIGGER `sessions_secret_reservations_csrf_update`
AFTER UPDATE OF `csrf_token_hash` ON `sessions`
WHEN NEW.`csrf_token_hash` <> OLD.`csrf_token_hash`
BEGIN
	INSERT OR IGNORE INTO `session_secret_reservations` (
		`secret_hash`,
		`purpose`,
		`origin_session_id`,
		`reserved_at`
	) VALUES (
		NEW.`csrf_token_hash`,
		'csrf',
		NEW.`id`,
		NEW.`last_seen_at`
	);
	SELECT CASE
		WHEN changes() <> 1 THEN RAISE(ABORT, 'session_secret_reservation_collision')
	END;
END;--> statement-breakpoint
CREATE TRIGGER `sessions_rotation_aliases_revoke`
AFTER UPDATE OF `revoked_at` ON `sessions`
WHEN NEW.`revoked_at` is not null
BEGIN
	DELETE FROM `session_rotation_aliases`
	WHERE `session_id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `session_secret_reservations_update_immutable`
BEFORE UPDATE ON `session_secret_reservations`
BEGIN
	SELECT RAISE(ABORT, 'session_secret_reservations_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `session_secret_reservations_delete_immutable`
BEFORE DELETE ON `session_secret_reservations`
BEGIN
	SELECT RAISE(ABORT, 'session_secret_reservations_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `session_rotation_aliases_update_immutable`
BEFORE UPDATE ON `session_rotation_aliases`
BEGIN
	SELECT RAISE(ABORT, 'session_rotation_aliases_immutable');
END;
