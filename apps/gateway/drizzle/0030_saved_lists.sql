-- Private saved-list state follows guarded library-removal operations.
CREATE TABLE `saved_catalog_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`identity_digest` text NOT NULL,
	`encrypted_identity` text NOT NULL,
	`encrypted_snapshot` text NOT NULL,
	`library_reference_id` text,
	`library_reference_user_id` text,
	`last_resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`library_reference_id`,`library_reference_user_id`) REFERENCES `media_references`(`id`,`user_id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "saved_catalog_items_id_check" CHECK(length("saved_catalog_items"."id") = 30
        and substr("saved_catalog_items"."id", 1, 8) = 'catalog_'
        and substr("saved_catalog_items"."id", 9) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "saved_catalog_items_identity_digest_check" CHECK(length("saved_catalog_items"."identity_digest") = 22
        and "saved_catalog_items"."identity_digest" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "saved_catalog_items_identity_check" CHECK(length("saved_catalog_items"."encrypted_identity") between 1 and 16384),
	CONSTRAINT "saved_catalog_items_snapshot_check" CHECK(length("saved_catalog_items"."encrypted_snapshot") between 1 and 65536),
	CONSTRAINT "saved_catalog_items_library_reference_check" CHECK((
          "saved_catalog_items"."library_reference_id" is null
          and "saved_catalog_items"."library_reference_user_id" is null
        ) or (
          length("saved_catalog_items"."library_reference_id") = 28
          and substr("saved_catalog_items"."library_reference_id", 1, 6) = 'media_'
          and substr("saved_catalog_items"."library_reference_id", 7) not glob '*[^A-Za-z0-9_-]*'
          and "saved_catalog_items"."library_reference_user_id" = "saved_catalog_items"."user_id"
        )),
	CONSTRAINT "saved_catalog_items_timestamp_order_check" CHECK("saved_catalog_items"."created_at" >= 0
        and "saved_catalog_items"."created_at" <= "saved_catalog_items"."updated_at"
        and ("saved_catalog_items"."last_resolved_at" is null or "saved_catalog_items"."last_resolved_at" between "saved_catalog_items"."created_at" and "saved_catalog_items"."updated_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_catalog_items_id_user_unique` ON `saved_catalog_items` (`id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `saved_catalog_items_user_identity_unique` ON `saved_catalog_items` (`user_id`,`identity_digest`);--> statement-breakpoint
CREATE INDEX `saved_catalog_items_user_updated_idx` ON `saved_catalog_items` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `saved_catalog_items_library_reference_idx` ON `saved_catalog_items` (`library_reference_id`);--> statement-breakpoint
CREATE TABLE `saved_list_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`list_id` text NOT NULL,
	`catalog_item_id` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_id`,`user_id`) REFERENCES `saved_lists`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`catalog_item_id`,`user_id`) REFERENCES `saved_catalog_items`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "saved_list_items_id_check" CHECK(length("saved_list_items"."id") = 33
        and substr("saved_list_items"."id", 1, 11) = 'saved_item_'
        and substr("saved_list_items"."id", 12) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "saved_list_items_position_check" CHECK("saved_list_items"."position" between 0 and 499),
	CONSTRAINT "saved_list_items_timestamp_order_check" CHECK("saved_list_items"."created_at" >= 0 and "saved_list_items"."created_at" <= "saved_list_items"."updated_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_list_items_list_catalog_unique` ON `saved_list_items` (`list_id`,`catalog_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `saved_list_items_list_position_unique` ON `saved_list_items` (`list_id`,`position`);--> statement-breakpoint
CREATE INDEX `saved_list_items_user_created_idx` ON `saved_list_items` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `saved_list_items_catalog_idx` ON `saved_list_items` (`catalog_item_id`);--> statement-breakpoint
CREATE TABLE `saved_list_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`resource_id` text,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`encrypted_response` text,
	`failure_code` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "saved_list_operations_id_check" CHECK(length("saved_list_operations"."id") = 38
        and substr("saved_list_operations"."id", 1, 16) = 'saved_operation_'
        and substr("saved_list_operations"."id", 17) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "saved_list_operations_kind_check" CHECK("saved_list_operations"."kind" in ('create_list', 'restore_list', 'add_item', 'reorder_items', 'favorite')),
	CONSTRAINT "saved_list_operations_key_hash_check" CHECK(length("saved_list_operations"."idempotency_key_hash") = 43
        and "saved_list_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "saved_list_operations_fingerprint_hash_check" CHECK(length("saved_list_operations"."fingerprint_hash") = 22
        and "saved_list_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "saved_list_operations_state_check" CHECK("saved_list_operations"."state" in ('pending', 'succeeded', 'reconcile_required', 'failed')),
	CONSTRAINT "saved_list_operations_response_check" CHECK("saved_list_operations"."encrypted_response" is null
        or length("saved_list_operations"."encrypted_response") between 1 and 131072),
	CONSTRAINT "saved_list_operations_outcome_check" CHECK((
          "saved_list_operations"."state" = 'pending'
          and "saved_list_operations"."encrypted_response" is null
          and "saved_list_operations"."failure_code" is null
          and "saved_list_operations"."completed_at" is null
        ) or (
          "saved_list_operations"."state" = 'succeeded'
          and "saved_list_operations"."encrypted_response" is not null
          and "saved_list_operations"."failure_code" is null
          and "saved_list_operations"."completed_at" is not null
        ) or (
          "saved_list_operations"."state" in ('reconcile_required', 'failed')
          and "saved_list_operations"."encrypted_response" is null
          and length("saved_list_operations"."failure_code") between 1 and 64
          and "saved_list_operations"."completed_at" is not null
        )),
	CONSTRAINT "saved_list_operations_timestamp_order_check" CHECK("saved_list_operations"."completed_at" is null or "saved_list_operations"."completed_at" >= "saved_list_operations"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_list_operations_user_key_unique` ON `saved_list_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `saved_list_operations_state_created_idx` ON `saved_list_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `saved_list_operations_resource_idx` ON `saved_list_operations` (`user_id`,`resource_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `saved_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`encrypted_name` text NOT NULL,
	`encrypted_description` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer,
	`undo_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "saved_lists_id_check" CHECK(length("saved_lists"."id") = 33
        and substr("saved_lists"."id", 1, 11) = 'saved_list_'
        and substr("saved_lists"."id", 12) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "saved_lists_kind_check" CHECK("saved_lists"."kind" in ('watch_later', 'custom')),
	CONSTRAINT "saved_lists_name_check" CHECK(length("saved_lists"."encrypted_name") between 1 and 4096),
	CONSTRAINT "saved_lists_description_check" CHECK("saved_lists"."encrypted_description" is null
        or length("saved_lists"."encrypted_description") between 1 and 8192),
	CONSTRAINT "saved_lists_revision_check" CHECK("saved_lists"."revision" between 0 and 2147483647),
	CONSTRAINT "saved_lists_deletion_check" CHECK((
          "saved_lists"."kind" = 'watch_later'
          and "saved_lists"."deleted_at" is null
          and "saved_lists"."undo_expires_at" is null
        ) or (
          "saved_lists"."kind" = 'custom'
          and (
            ("saved_lists"."deleted_at" is null and "saved_lists"."undo_expires_at" is null)
            or ("saved_lists"."deleted_at" is not null and "saved_lists"."undo_expires_at" > "saved_lists"."deleted_at")
          )
        )),
	CONSTRAINT "saved_lists_timestamp_order_check" CHECK("saved_lists"."created_at" >= 0
        and "saved_lists"."created_at" <= "saved_lists"."updated_at"
        and ("saved_lists"."deleted_at" is null or "saved_lists"."deleted_at" between "saved_lists"."created_at" and "saved_lists"."updated_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_lists_id_user_unique` ON `saved_lists` (`id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `saved_lists_user_watch_later_unique` ON `saved_lists` (`user_id`) WHERE "saved_lists"."kind" = 'watch_later';--> statement-breakpoint
CREATE INDEX `saved_lists_user_updated_idx` ON `saved_lists` (`user_id`,`deleted_at`,`updated_at`);--> statement-breakpoint
CREATE INDEX `saved_lists_undo_expiry_idx` ON `saved_lists` (`undo_expires_at`);--> statement-breakpoint
CREATE TABLE `saved_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`service_identity_link_id` text NOT NULL,
	`link_revision` integer NOT NULL,
	`identity_digest` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`last_used_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_identity_link_id`,`user_id`) REFERENCES `service_identity_links`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "saved_targets_id_check" CHECK(length("saved_targets"."id") = 34
        and substr("saved_targets"."id", 1, 12) = 'save_target_'
        and substr("saved_targets"."id", 13) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "saved_targets_identity_digest_check" CHECK(length("saved_targets"."identity_digest") = 22
        and "saved_targets"."identity_digest" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "saved_targets_payload_check" CHECK(length("saved_targets"."encrypted_payload") between 1 and 65536),
	CONSTRAINT "saved_targets_link_revision_check" CHECK("saved_targets"."link_revision" between 0 and 2147483647),
	CONSTRAINT "saved_targets_timestamp_order_check" CHECK("saved_targets"."created_at" >= 0
        and "saved_targets"."created_at" <= "saved_targets"."updated_at"
        and "saved_targets"."created_at" <= "saved_targets"."last_used_at"
        and "saved_targets"."last_used_at" < "saved_targets"."expires_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_targets_user_identity_unique` ON `saved_targets` (`user_id`,`service_identity_link_id`,`link_revision`,`identity_digest`);--> statement-breakpoint
CREATE INDEX `saved_targets_expiry_idx` ON `saved_targets` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_references_id_user_unique` ON `media_references` (`id`,`user_id`);--> statement-breakpoint
CREATE TRIGGER `saved_catalog_media_reference_before_delete`
BEFORE DELETE ON `media_references`
WHEN EXISTS (
	SELECT 1 FROM `saved_catalog_items`
	WHERE `library_reference_id` = OLD.`id`
		AND `library_reference_user_id` = OLD.`user_id`
)
BEGIN
	SELECT CASE WHEN EXISTS (
		SELECT 1
		FROM `saved_lists`
		JOIN `saved_list_items` ON `saved_list_items`.`list_id` = `saved_lists`.`id`
		JOIN `saved_catalog_items` ON `saved_catalog_items`.`id` = `saved_list_items`.`catalog_item_id`
		WHERE `saved_lists`.`user_id` = OLD.`user_id`
			AND `saved_lists`.`deleted_at` IS NULL
			AND `saved_catalog_items`.`library_reference_id` = OLD.`id`
			AND `saved_lists`.`revision` >= 2147483647
	) THEN RAISE(ABORT, 'saved list revision exhausted') END;
	UPDATE `saved_lists`
	SET `revision` = `revision` + 1,
		`updated_at` = max(`updated_at`, unixepoch('subsec') * 1000)
	WHERE `user_id` = OLD.`user_id`
		AND `deleted_at` IS NULL
		AND `id` IN (
			SELECT `saved_list_items`.`list_id`
			FROM `saved_list_items`
			JOIN `saved_catalog_items` ON `saved_catalog_items`.`id` = `saved_list_items`.`catalog_item_id`
			WHERE `saved_list_items`.`user_id` = OLD.`user_id`
				AND `saved_catalog_items`.`library_reference_id` = OLD.`id`
		);
	UPDATE `saved_catalog_items`
	SET `library_reference_id` = NULL,
		`library_reference_user_id` = NULL,
		`last_resolved_at` = NULL,
		`updated_at` = max(`updated_at`, unixepoch('subsec') * 1000)
	WHERE `user_id` = OLD.`user_id`
		AND `library_reference_id` = OLD.`id`;
END;
