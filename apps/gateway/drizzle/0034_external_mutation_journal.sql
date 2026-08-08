CREATE TABLE `download_queue_item_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`bulk_operation_id` text,
	`user_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`connector_instance_generation` integer NOT NULL,
	`connector_config_generation` integer NOT NULL,
	`item_digest` text NOT NULL,
	`kind` text NOT NULL,
	`idempotency_key_hash` text,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`failure_code` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`bulk_operation_id`) REFERENCES `download_queue_bulk_operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "download_queue_item_operations_id_check" CHECK(length("download_queue_item_operations"."id") = 46
        and substr("download_queue_item_operations"."id", 1, 24) = 'download_item_operation_'
        and substr("download_queue_item_operations"."id", 25) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_item_operations_kind_check" CHECK("download_queue_item_operations"."kind" in ('pause', 'resume', 'promote')),
	CONSTRAINT "download_queue_item_operations_parent_check" CHECK(("download_queue_item_operations"."bulk_operation_id" is null
          and "download_queue_item_operations"."idempotency_key_hash" is not null
          and length("download_queue_item_operations"."idempotency_key_hash") = 43
          and "download_queue_item_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*')
        or ("download_queue_item_operations"."bulk_operation_id" is not null and "download_queue_item_operations"."idempotency_key_hash" is null)),
	CONSTRAINT "download_queue_item_operations_snapshot_check" CHECK(typeof("download_queue_item_operations"."connector_instance_generation") = 'integer'
        and "download_queue_item_operations"."connector_instance_generation" between 0 and 9007199254740991
        and typeof("download_queue_item_operations"."connector_config_generation") = 'integer'
        and "download_queue_item_operations"."connector_config_generation" between 0 and 9007199254740991),
	CONSTRAINT "download_queue_item_operations_digest_check" CHECK(length("download_queue_item_operations"."item_digest") = 22
        and "download_queue_item_operations"."item_digest" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_item_operations_fingerprint_check" CHECK(length("download_queue_item_operations"."fingerprint_hash") = 43
        and "download_queue_item_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_item_operations_state_check" CHECK("download_queue_item_operations"."state" in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')),
	CONSTRAINT "download_queue_item_operations_outcome_check" CHECK(("download_queue_item_operations"."state" = 'pending' and "download_queue_item_operations"."failure_code" is null
          and "download_queue_item_operations"."completed_at" is null)
        or ("download_queue_item_operations"."state" in ('reconcile_required', 'uncertain', 'failed')
          and length("download_queue_item_operations"."failure_code") between 1 and 64
          and "download_queue_item_operations"."completed_at" is not null)
        or ("download_queue_item_operations"."state" = 'succeeded' and "download_queue_item_operations"."failure_code" is null
          and "download_queue_item_operations"."completed_at" is not null)),
	CONSTRAINT "download_queue_item_operations_timestamp_order_check" CHECK("download_queue_item_operations"."created_at" >= 0 and "download_queue_item_operations"."created_at" <= "download_queue_item_operations"."updated_at"
        and ("download_queue_item_operations"."completed_at" is null or "download_queue_item_operations"."completed_at" >= "download_queue_item_operations"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `download_queue_item_operations_user_key_unique` ON `download_queue_item_operations` (`user_id`,`idempotency_key_hash`) WHERE "download_queue_item_operations"."idempotency_key_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `download_queue_item_operations_bulk_target_unique` ON `download_queue_item_operations` (`bulk_operation_id`,`kind`,`item_digest`) WHERE "download_queue_item_operations"."bulk_operation_id" is not null;--> statement-breakpoint
CREATE INDEX `download_queue_item_operations_state_created_idx` ON `download_queue_item_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `external_mutation_dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`parent_operation_type` text NOT NULL,
	`parent_operation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`connector_instance_generation` integer NOT NULL,
	`connector_config_generation` integer NOT NULL,
	`state` text DEFAULT 'reserved' NOT NULL,
	`encrypted_normalized_request` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`dispatch_attempt_count` integer DEFAULT 0 NOT NULL,
	`dispatched_at` integer,
	`reconcile_required_at` integer,
	`uncertain_at` integer,
	`completed_at` integer,
	`failure_code` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "external_mutation_dispatches_id_check" CHECK(length("external_mutation_dispatches"."id") = 40
        and substr("external_mutation_dispatches"."id", 1, 18) = 'mutation_dispatch_'
        and substr("external_mutation_dispatches"."id", 19) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "external_mutation_dispatches_kind_check" CHECK("external_mutation_dispatches"."kind" in (
        'media_request.submit', 'media_issue.update', 'subtitle.download',
        'library.scan', 'library.item_refresh', 'library.metadata_update',
        'library.artwork_apply', 'library.remove_files', 'library.unmonitor',
        'library.remove_manager_record', 'user_media_state.update',
        'download_queue.remove', 'download_queue.pause', 'download_queue.resume',
        'download_queue.promote', 'acquisition.queue_recover', 'acquisition.grab',
        'acquisition.search',
        'saved.favorite', 'playback.progress'
      )),
	CONSTRAINT "external_mutation_dispatches_parent_kind_check" CHECK(("external_mutation_dispatches"."kind" = 'media_request.submit'
          and "external_mutation_dispatches"."parent_operation_type" = 'media_request_operation')
        or ("external_mutation_dispatches"."kind" = 'media_issue.update'
          and "external_mutation_dispatches"."parent_operation_type" = 'media_issue_operation')
        or ("external_mutation_dispatches"."kind" = 'subtitle.download'
          and "external_mutation_dispatches"."parent_operation_type" = 'subtitle_download_operation')
        or ("external_mutation_dispatches"."kind" in ('library.scan', 'library.item_refresh',
              'library.metadata_update', 'library.artwork_apply')
          and "external_mutation_dispatches"."parent_operation_type" = 'library_mutation_operation')
        or ("external_mutation_dispatches"."kind" in ('library.remove_files', 'library.unmonitor',
              'library.remove_manager_record')
          and "external_mutation_dispatches"."parent_operation_type" = 'library_removal_operation')
        or ("external_mutation_dispatches"."kind" = 'user_media_state.update'
          and "external_mutation_dispatches"."parent_operation_type" = 'user_media_state_operation')
        or ("external_mutation_dispatches"."kind" = 'download_queue.remove'
          and "external_mutation_dispatches"."parent_operation_type" = 'download_queue_removal_operation')
        or ("external_mutation_dispatches"."kind" in ('download_queue.pause', 'download_queue.resume',
              'download_queue.promote')
          and "external_mutation_dispatches"."parent_operation_type" = 'download_queue_item_operation')
        or ("external_mutation_dispatches"."kind" = 'acquisition.queue_recover'
          and "external_mutation_dispatches"."parent_operation_type" = 'acquisition_queue_recovery_operation')
        or ("external_mutation_dispatches"."kind" = 'acquisition.grab'
          and "external_mutation_dispatches"."parent_operation_type" = 'acquisition_grab_operation')
        or ("external_mutation_dispatches"."kind" = 'acquisition.search'
          and "external_mutation_dispatches"."parent_operation_type" = 'acquisition_search_operation')
        or ("external_mutation_dispatches"."kind" = 'saved.favorite'
          and "external_mutation_dispatches"."parent_operation_type" = 'saved_list_operation')
        or ("external_mutation_dispatches"."kind" = 'playback.progress'
          and "external_mutation_dispatches"."parent_operation_type" = 'playback_progress_operation')),
	CONSTRAINT "external_mutation_dispatches_parent_id_check" CHECK(length("external_mutation_dispatches"."parent_operation_id") between 1 and 128
        and "external_mutation_dispatches"."parent_operation_id" not glob '*[^A-Za-z0-9._:-]*'),
	CONSTRAINT "external_mutation_dispatches_snapshot_check" CHECK(length("external_mutation_dispatches"."user_id") between 1 and 128
        and length("external_mutation_dispatches"."connector_id") between 1 and 128
        and typeof("external_mutation_dispatches"."connector_instance_generation") = 'integer'
        and "external_mutation_dispatches"."connector_instance_generation" between 0 and 9007199254740991
        and typeof("external_mutation_dispatches"."connector_config_generation") = 'integer'
        and "external_mutation_dispatches"."connector_config_generation" between 0 and 9007199254740991),
	CONSTRAINT "external_mutation_dispatches_request_check" CHECK(length("external_mutation_dispatches"."encrypted_normalized_request") between 1 and 4194304),
	CONSTRAINT "external_mutation_dispatches_attempt_count_check" CHECK(typeof("external_mutation_dispatches"."dispatch_attempt_count") = 'integer'
        and "external_mutation_dispatches"."dispatch_attempt_count" between 0 and 2147483647),
	CONSTRAINT "external_mutation_dispatches_state_check" CHECK("external_mutation_dispatches"."state" in ('reserved', 'dispatched', 'reconcile_required',
        'uncertain', 'succeeded', 'failed')),
	CONSTRAINT "external_mutation_dispatches_state_invariants_check" CHECK((
          "external_mutation_dispatches"."state" = 'reserved'
          and length("external_mutation_dispatches"."lease_owner") between 1 and 128
          and "external_mutation_dispatches"."lease_expires_at" is not null
          and "external_mutation_dispatches"."dispatch_attempt_count" = 0
          and "external_mutation_dispatches"."dispatched_at" is null
          and "external_mutation_dispatches"."reconcile_required_at" is null
          and "external_mutation_dispatches"."uncertain_at" is null
          and "external_mutation_dispatches"."completed_at" is null
          and "external_mutation_dispatches"."failure_code" is null
        ) or (
          "external_mutation_dispatches"."state" = 'dispatched'
          and "external_mutation_dispatches"."lease_owner" is null
          and "external_mutation_dispatches"."lease_expires_at" is null
          and "external_mutation_dispatches"."dispatch_attempt_count" between 1 and 2147483647
          and "external_mutation_dispatches"."dispatched_at" is not null
          and "external_mutation_dispatches"."reconcile_required_at" is null
          and "external_mutation_dispatches"."uncertain_at" is null
          and "external_mutation_dispatches"."completed_at" is null
          and "external_mutation_dispatches"."failure_code" is null
        ) or (
          "external_mutation_dispatches"."state" = 'reconcile_required'
          and "external_mutation_dispatches"."lease_owner" is null
          and "external_mutation_dispatches"."lease_expires_at" is null
          and "external_mutation_dispatches"."dispatch_attempt_count" between 1 and 2147483647
          and "external_mutation_dispatches"."dispatched_at" is not null
          and "external_mutation_dispatches"."reconcile_required_at" is not null
          and "external_mutation_dispatches"."uncertain_at" is null
          and "external_mutation_dispatches"."completed_at" is null
          and length("external_mutation_dispatches"."failure_code") between 1 and 64
        ) or (
          "external_mutation_dispatches"."state" = 'uncertain'
          and "external_mutation_dispatches"."lease_owner" is null
          and "external_mutation_dispatches"."lease_expires_at" is null
          and "external_mutation_dispatches"."dispatch_attempt_count" between 1 and 2147483647
          and "external_mutation_dispatches"."dispatched_at" is not null
          and "external_mutation_dispatches"."uncertain_at" is not null
          and "external_mutation_dispatches"."completed_at" is not null
          and length("external_mutation_dispatches"."failure_code") between 1 and 64
        ) or (
          "external_mutation_dispatches"."state" = 'succeeded'
          and "external_mutation_dispatches"."lease_owner" is null
          and "external_mutation_dispatches"."lease_expires_at" is null
          and "external_mutation_dispatches"."dispatch_attempt_count" between 1 and 2147483647
          and "external_mutation_dispatches"."dispatched_at" is not null
          and "external_mutation_dispatches"."uncertain_at" is null
          and "external_mutation_dispatches"."completed_at" is not null
          and "external_mutation_dispatches"."failure_code" is null
        ) or (
          "external_mutation_dispatches"."state" = 'failed'
          and "external_mutation_dispatches"."lease_owner" is null
          and "external_mutation_dispatches"."lease_expires_at" is null
          and "external_mutation_dispatches"."reconcile_required_at" is null
          and "external_mutation_dispatches"."uncertain_at" is null
          and "external_mutation_dispatches"."completed_at" is not null
          and length("external_mutation_dispatches"."failure_code") between 1 and 64
          and (("external_mutation_dispatches"."dispatched_at" is null and "external_mutation_dispatches"."dispatch_attempt_count" = 0)
            or ("external_mutation_dispatches"."dispatched_at" is not null
              and "external_mutation_dispatches"."dispatch_attempt_count" between 1 and 2147483647))
        )),
	CONSTRAINT "external_mutation_dispatches_timestamp_order_check" CHECK("external_mutation_dispatches"."created_at" >= 0
        and "external_mutation_dispatches"."created_at" <= "external_mutation_dispatches"."updated_at"
        and ("external_mutation_dispatches"."lease_expires_at" is null or "external_mutation_dispatches"."lease_expires_at" >= "external_mutation_dispatches"."created_at")
        and ("external_mutation_dispatches"."dispatched_at" is null or "external_mutation_dispatches"."dispatched_at" >= "external_mutation_dispatches"."created_at")
        and ("external_mutation_dispatches"."reconcile_required_at" is null
          or "external_mutation_dispatches"."reconcile_required_at" >= "external_mutation_dispatches"."dispatched_at")
        and ("external_mutation_dispatches"."uncertain_at" is null or "external_mutation_dispatches"."uncertain_at" >= "external_mutation_dispatches"."dispatched_at")
        and ("external_mutation_dispatches"."completed_at" is null or "external_mutation_dispatches"."completed_at" >= "external_mutation_dispatches"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_mutation_dispatches_parent_kind_unique` ON `external_mutation_dispatches` (`parent_operation_type`,`parent_operation_id`,`kind`);--> statement-breakpoint
CREATE INDEX `external_mutation_dispatches_state_lease_idx` ON `external_mutation_dispatches` (`state`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `external_mutation_dispatches_connector_generation_idx` ON `external_mutation_dispatches` (`connector_id`,`connector_instance_generation`,`connector_config_generation`);--> statement-breakpoint
CREATE INDEX `external_mutation_dispatches_user_created_idx` ON `external_mutation_dispatches` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `external_mutation_target_locks` (
	`target_scope` text NOT NULL,
	`target_digest` text NOT NULL,
	`owner_dispatch_id` text NOT NULL,
	`acquired_at` integer NOT NULL,
	PRIMARY KEY(`target_scope`, `target_digest`),
	FOREIGN KEY (`owner_dispatch_id`) REFERENCES `external_mutation_dispatches`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "external_mutation_target_locks_scope_check" CHECK("external_mutation_target_locks"."target_scope" in ('media_request', 'media_issue', 'subtitle', 'library',
        'user_media_state', 'download_queue', 'acquisition', 'saved_favorite',
        'playback_progress')),
	CONSTRAINT "external_mutation_target_locks_digest_check" CHECK(length("external_mutation_target_locks"."target_digest") in (22, 43)
        and "external_mutation_target_locks"."target_digest" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "external_mutation_target_locks_timestamp_check" CHECK("external_mutation_target_locks"."acquired_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `external_mutation_target_locks_owner_idx` ON `external_mutation_target_locks` (`owner_dispatch_id`);--> statement-breakpoint
CREATE TABLE `playback_progress_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`playback_session_id` text NOT NULL,
	`session_revision` integer NOT NULL,
	`user_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`connector_instance_generation` integer NOT NULL,
	`connector_config_generation` integer NOT NULL,
	`position_seconds` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`failure_code` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "playback_progress_operations_id_check" CHECK(length("playback_progress_operations"."id") = 50
        and substr("playback_progress_operations"."id", 1, 28) = 'playback_progress_operation_'
        and substr("playback_progress_operations"."id", 29) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "playback_progress_operations_session_check" CHECK(length("playback_progress_operations"."playback_session_id") = 31
        and substr("playback_progress_operations"."playback_session_id", 1, 9) = 'playback_'
        and substr("playback_progress_operations"."playback_session_id", 10) not glob '*[^A-Za-z0-9_-]*'
        and typeof("playback_progress_operations"."session_revision") = 'integer'
        and "playback_progress_operations"."session_revision" between 0 and 2147483647),
	CONSTRAINT "playback_progress_operations_snapshot_check" CHECK(length("playback_progress_operations"."user_id") between 1 and 128
        and length("playback_progress_operations"."connector_id") between 1 and 128
        and typeof("playback_progress_operations"."connector_instance_generation") = 'integer'
        and "playback_progress_operations"."connector_instance_generation" between 0 and 9007199254740991
        and typeof("playback_progress_operations"."connector_config_generation") = 'integer'
        and "playback_progress_operations"."connector_config_generation" between 0 and 9007199254740991),
	CONSTRAINT "playback_progress_operations_position_check" CHECK("playback_progress_operations"."position_seconds" between 0 and 10000000),
	CONSTRAINT "playback_progress_operations_state_check" CHECK("playback_progress_operations"."state" in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')),
	CONSTRAINT "playback_progress_operations_outcome_check" CHECK(("playback_progress_operations"."state" = 'pending' and "playback_progress_operations"."failure_code" is null
          and "playback_progress_operations"."completed_at" is null)
        or ("playback_progress_operations"."state" in ('reconcile_required', 'uncertain', 'failed')
          and length("playback_progress_operations"."failure_code") between 1 and 64
          and "playback_progress_operations"."completed_at" is not null)
        or ("playback_progress_operations"."state" = 'succeeded' and "playback_progress_operations"."failure_code" is null
          and "playback_progress_operations"."completed_at" is not null)),
	CONSTRAINT "playback_progress_operations_timestamp_order_check" CHECK("playback_progress_operations"."created_at" >= 0 and "playback_progress_operations"."created_at" <= "playback_progress_operations"."updated_at"
        and ("playback_progress_operations"."completed_at" is null or "playback_progress_operations"."completed_at" >= "playback_progress_operations"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playback_progress_operations_session_revision_unique` ON `playback_progress_operations` (`playback_session_id`,`session_revision`);--> statement-breakpoint
CREATE INDEX `playback_progress_operations_state_created_idx` ON `playback_progress_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `playback_progress_operations_user_created_idx` ON `playback_progress_operations` (`user_id`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_acquisition_grab_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`response_json` text,
	`failure_code` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "acquisition_grab_operations_key_hash_check" CHECK(length("__new_acquisition_grab_operations"."idempotency_key_hash") = 43
        and "__new_acquisition_grab_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "acquisition_grab_operations_fingerprint_hash_check" CHECK(length("__new_acquisition_grab_operations"."fingerprint_hash") = 43
        and "__new_acquisition_grab_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "acquisition_grab_operations_state_check" CHECK("__new_acquisition_grab_operations"."state" in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')),
	CONSTRAINT "acquisition_grab_operations_response_json_check" CHECK("__new_acquisition_grab_operations"."response_json" is null
        or (json_valid("__new_acquisition_grab_operations"."response_json") and json_type("__new_acquisition_grab_operations"."response_json") = 'object')),
	CONSTRAINT "acquisition_grab_operations_outcome_check" CHECK((
          "__new_acquisition_grab_operations"."state" = 'pending'
          and "__new_acquisition_grab_operations"."response_json" is null
          and "__new_acquisition_grab_operations"."failure_code" is null
          and "__new_acquisition_grab_operations"."completed_at" is null
        ) or (
          "__new_acquisition_grab_operations"."state" = 'succeeded'
          and "__new_acquisition_grab_operations"."response_json" is not null
          and "__new_acquisition_grab_operations"."failure_code" is null
          and "__new_acquisition_grab_operations"."completed_at" is not null
        ) or (
          "__new_acquisition_grab_operations"."state" in ('reconcile_required', 'uncertain', 'failed')
          and "__new_acquisition_grab_operations"."response_json" is null
          and length("__new_acquisition_grab_operations"."failure_code") between 1 and 64
          and "__new_acquisition_grab_operations"."completed_at" is not null
        )),
	CONSTRAINT "acquisition_grab_operations_timestamp_order_check" CHECK("__new_acquisition_grab_operations"."completed_at" is null or "__new_acquisition_grab_operations"."completed_at" >= "__new_acquisition_grab_operations"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_acquisition_grab_operations`("id", "user_id", "idempotency_key_hash", "fingerprint_hash", "state", "response_json", "failure_code", "completed_at", "created_at", "updated_at") SELECT "id", "user_id", "idempotency_key_hash", "fingerprint_hash", CASE WHEN "state" = 'pending' THEN 'reconcile_required' ELSE "state" END, CASE WHEN "state" = 'pending' THEN NULL ELSE "response_json" END, CASE WHEN "state" = 'pending' THEN 'legacy_pending_reconcile' ELSE "failure_code" END, CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at") ELSE "completed_at" END, "created_at", CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at") ELSE "updated_at" END FROM `acquisition_grab_operations`;--> statement-breakpoint
DROP TABLE `acquisition_grab_operations`;--> statement-breakpoint
ALTER TABLE `__new_acquisition_grab_operations` RENAME TO `acquisition_grab_operations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `acquisition_grab_operations_user_key_unique` ON `acquisition_grab_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `acquisition_grab_operations_state_created_idx` ON `acquisition_grab_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_acquisition_search_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`response_json` text,
	`failure_code` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "acquisition_search_operations_key_hash_check" CHECK(length("__new_acquisition_search_operations"."idempotency_key_hash") = 43
        and "__new_acquisition_search_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "acquisition_search_operations_fingerprint_hash_check" CHECK(length("__new_acquisition_search_operations"."fingerprint_hash") = 43
        and "__new_acquisition_search_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "acquisition_search_operations_state_check" CHECK("__new_acquisition_search_operations"."state" in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')),
	CONSTRAINT "acquisition_search_operations_response_json_check" CHECK("__new_acquisition_search_operations"."response_json" is null
        or (json_valid("__new_acquisition_search_operations"."response_json") and json_type("__new_acquisition_search_operations"."response_json") = 'object')),
	CONSTRAINT "acquisition_search_operations_outcome_check" CHECK((
          "__new_acquisition_search_operations"."state" = 'pending'
          and "__new_acquisition_search_operations"."response_json" is null
          and "__new_acquisition_search_operations"."failure_code" is null
          and "__new_acquisition_search_operations"."completed_at" is null
        ) or (
          "__new_acquisition_search_operations"."state" = 'succeeded'
          and "__new_acquisition_search_operations"."response_json" is not null
          and "__new_acquisition_search_operations"."failure_code" is null
          and "__new_acquisition_search_operations"."completed_at" is not null
        ) or (
          "__new_acquisition_search_operations"."state" in ('reconcile_required', 'uncertain', 'failed')
          and "__new_acquisition_search_operations"."response_json" is null
          and length("__new_acquisition_search_operations"."failure_code") between 1 and 64
          and "__new_acquisition_search_operations"."completed_at" is not null
        )),
	CONSTRAINT "acquisition_search_operations_timestamp_order_check" CHECK("__new_acquisition_search_operations"."completed_at" is null or "__new_acquisition_search_operations"."completed_at" >= "__new_acquisition_search_operations"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_acquisition_search_operations`("id", "user_id", "idempotency_key_hash", "fingerprint_hash", "state", "response_json", "failure_code", "completed_at", "created_at", "updated_at") SELECT "id", "user_id", "idempotency_key_hash", "fingerprint_hash", CASE WHEN "state" = 'pending' THEN 'reconcile_required' ELSE "state" END, CASE WHEN "state" = 'pending' THEN NULL ELSE "response_json" END, CASE WHEN "state" = 'pending' THEN 'legacy_pending_reconcile' ELSE "failure_code" END, CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at") ELSE "completed_at" END, "created_at", CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at") ELSE "updated_at" END FROM `acquisition_search_operations`;--> statement-breakpoint
DROP TABLE `acquisition_search_operations`;--> statement-breakpoint
ALTER TABLE `__new_acquisition_search_operations` RENAME TO `acquisition_search_operations`;--> statement-breakpoint
CREATE UNIQUE INDEX `acquisition_search_operations_user_key_unique` ON `acquisition_search_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `acquisition_search_operations_state_created_idx` ON `acquisition_search_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_acquisition_queue_recovery_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`event_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`event_snapshot_json` text,
	`response_json` text,
	`failure_code` text,
	`mutation_started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "acquisition_queue_recovery_operations_id_check" CHECK(length("__new_acquisition_queue_recovery_operations"."id") = 43
        and substr("__new_acquisition_queue_recovery_operations"."id", 1, 21) = 'acquisition_recovery_'
        and substr("__new_acquisition_queue_recovery_operations"."id", 22) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "acquisition_queue_recovery_operations_event_id_check" CHECK(length("__new_acquisition_queue_recovery_operations"."event_id") = 34
        and substr("__new_acquisition_queue_recovery_operations"."event_id", 1, 12) = 'acquisition_'
        and substr("__new_acquisition_queue_recovery_operations"."event_id", 13) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "acquisition_queue_recovery_operations_key_hash_check" CHECK(length("__new_acquisition_queue_recovery_operations"."idempotency_key_hash") = 43
        and "__new_acquisition_queue_recovery_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "acquisition_queue_recovery_operations_fingerprint_hash_check" CHECK(length("__new_acquisition_queue_recovery_operations"."fingerprint_hash") = 43
        and "__new_acquisition_queue_recovery_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "acquisition_queue_recovery_operations_state_check" CHECK("__new_acquisition_queue_recovery_operations"."state" in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')),
	CONSTRAINT "acquisition_queue_recovery_operations_event_snapshot_check" CHECK("__new_acquisition_queue_recovery_operations"."event_snapshot_json" is null
        or (json_valid("__new_acquisition_queue_recovery_operations"."event_snapshot_json") and json_type("__new_acquisition_queue_recovery_operations"."event_snapshot_json") = 'object')),
	CONSTRAINT "acquisition_queue_recovery_operations_response_json_check" CHECK("__new_acquisition_queue_recovery_operations"."response_json" is null
        or (json_valid("__new_acquisition_queue_recovery_operations"."response_json") and json_type("__new_acquisition_queue_recovery_operations"."response_json") = 'object')),
	CONSTRAINT "acquisition_queue_recovery_operations_outcome_check" CHECK((
          "__new_acquisition_queue_recovery_operations"."state" = 'pending'
          and "__new_acquisition_queue_recovery_operations"."response_json" is null
          and "__new_acquisition_queue_recovery_operations"."failure_code" is null
          and "__new_acquisition_queue_recovery_operations"."completed_at" is null
        ) or (
          "__new_acquisition_queue_recovery_operations"."state" = 'succeeded'
          and "__new_acquisition_queue_recovery_operations"."event_snapshot_json" is not null
          and "__new_acquisition_queue_recovery_operations"."response_json" is not null
          and "__new_acquisition_queue_recovery_operations"."failure_code" is null
          and "__new_acquisition_queue_recovery_operations"."mutation_started_at" is not null
          and "__new_acquisition_queue_recovery_operations"."completed_at" is not null
        ) or (
          "__new_acquisition_queue_recovery_operations"."state" in ('reconcile_required', 'uncertain', 'failed')
          and "__new_acquisition_queue_recovery_operations"."response_json" is null
          and length("__new_acquisition_queue_recovery_operations"."failure_code") between 1 and 64
          and "__new_acquisition_queue_recovery_operations"."completed_at" is not null
        )),
	CONSTRAINT "acquisition_queue_recovery_operations_timestamp_order_check" CHECK(("__new_acquisition_queue_recovery_operations"."mutation_started_at" is null or "__new_acquisition_queue_recovery_operations"."mutation_started_at" >= "__new_acquisition_queue_recovery_operations"."created_at")
        and ("__new_acquisition_queue_recovery_operations"."completed_at" is null or "__new_acquisition_queue_recovery_operations"."completed_at" >= "__new_acquisition_queue_recovery_operations"."created_at"))
);
--> statement-breakpoint
INSERT INTO `__new_acquisition_queue_recovery_operations`("id", "user_id", "connector_id", "event_id", "idempotency_key_hash", "fingerprint_hash", "state", "event_snapshot_json", "response_json", "failure_code", "mutation_started_at", "completed_at", "created_at", "updated_at") SELECT "id", "user_id", "connector_id", "event_id", "idempotency_key_hash", "fingerprint_hash", CASE WHEN "state" = 'pending' AND "mutation_started_at" IS NOT NULL THEN 'uncertain' WHEN "state" = 'pending' THEN 'reconcile_required' ELSE "state" END, "event_snapshot_json", CASE WHEN "state" = 'pending' THEN NULL ELSE "response_json" END, CASE WHEN "state" = 'pending' AND "mutation_started_at" IS NOT NULL THEN 'legacy_post_boundary_uncertain' WHEN "state" = 'pending' THEN 'legacy_pending_reconcile' ELSE "failure_code" END, "mutation_started_at", CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at", coalesce("mutation_started_at", "created_at")) ELSE "completed_at" END, "created_at", CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at", coalesce("mutation_started_at", "created_at")) ELSE "updated_at" END FROM `acquisition_queue_recovery_operations`;--> statement-breakpoint
DROP TABLE `acquisition_queue_recovery_operations`;--> statement-breakpoint
ALTER TABLE `__new_acquisition_queue_recovery_operations` RENAME TO `acquisition_queue_recovery_operations`;--> statement-breakpoint
CREATE UNIQUE INDEX `acquisition_queue_recovery_operations_user_key_unique` ON `acquisition_queue_recovery_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `acquisition_queue_recovery_operations_state_created_idx` ON `acquisition_queue_recovery_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `acquisition_queue_recovery_operations_event_idx` ON `acquisition_queue_recovery_operations` (`connector_id`,`event_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_download_queue_removal_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`item_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`item_snapshot_json` text,
	`response_json` text,
	`failure_code` text,
	`mutation_started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "download_queue_removal_operations_id_check" CHECK(length("__new_download_queue_removal_operations"."id") = 39
        and substr("__new_download_queue_removal_operations"."id", 1, 17) = 'download_removal_'
        and substr("__new_download_queue_removal_operations"."id", 18) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_removal_operations_item_id_check" CHECK(length("__new_download_queue_removal_operations"."item_id") = 31
        and substr("__new_download_queue_removal_operations"."item_id", 1, 9) = 'download_'
        and substr("__new_download_queue_removal_operations"."item_id", 10) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_removal_operations_key_hash_check" CHECK(length("__new_download_queue_removal_operations"."idempotency_key_hash") = 43
        and "__new_download_queue_removal_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_removal_operations_fingerprint_hash_check" CHECK(length("__new_download_queue_removal_operations"."fingerprint_hash") = 43
        and "__new_download_queue_removal_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "download_queue_removal_operations_state_check" CHECK("__new_download_queue_removal_operations"."state" in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')),
	CONSTRAINT "download_queue_removal_operations_item_snapshot_check" CHECK("__new_download_queue_removal_operations"."item_snapshot_json" is null
        or (json_valid("__new_download_queue_removal_operations"."item_snapshot_json") and json_type("__new_download_queue_removal_operations"."item_snapshot_json") = 'object')),
	CONSTRAINT "download_queue_removal_operations_response_json_check" CHECK("__new_download_queue_removal_operations"."response_json" is null
        or (json_valid("__new_download_queue_removal_operations"."response_json") and json_type("__new_download_queue_removal_operations"."response_json") = 'object')),
	CONSTRAINT "download_queue_removal_operations_outcome_check" CHECK((
          "__new_download_queue_removal_operations"."state" = 'pending'
          and "__new_download_queue_removal_operations"."response_json" is null
          and "__new_download_queue_removal_operations"."failure_code" is null
          and "__new_download_queue_removal_operations"."completed_at" is null
        ) or (
          "__new_download_queue_removal_operations"."state" = 'succeeded'
          and "__new_download_queue_removal_operations"."item_snapshot_json" is not null
          and "__new_download_queue_removal_operations"."response_json" is not null
          and "__new_download_queue_removal_operations"."failure_code" is null
          and "__new_download_queue_removal_operations"."mutation_started_at" is not null
          and "__new_download_queue_removal_operations"."completed_at" is not null
        ) or (
          "__new_download_queue_removal_operations"."state" in ('reconcile_required', 'uncertain', 'failed')
          and "__new_download_queue_removal_operations"."response_json" is null
          and length("__new_download_queue_removal_operations"."failure_code") between 1 and 64
          and "__new_download_queue_removal_operations"."completed_at" is not null
        )),
	CONSTRAINT "download_queue_removal_operations_timestamp_order_check" CHECK(("__new_download_queue_removal_operations"."mutation_started_at" is null or "__new_download_queue_removal_operations"."mutation_started_at" >= "__new_download_queue_removal_operations"."created_at")
        and ("__new_download_queue_removal_operations"."completed_at" is null or "__new_download_queue_removal_operations"."completed_at" >= "__new_download_queue_removal_operations"."created_at"))
);
--> statement-breakpoint
INSERT INTO `__new_download_queue_removal_operations`("id", "user_id", "connector_id", "item_id", "idempotency_key_hash", "fingerprint_hash", "state", "item_snapshot_json", "response_json", "failure_code", "mutation_started_at", "completed_at", "created_at", "updated_at") SELECT "id", "user_id", "connector_id", "item_id", "idempotency_key_hash", "fingerprint_hash", CASE WHEN "state" = 'pending' AND "mutation_started_at" IS NOT NULL THEN 'uncertain' WHEN "state" = 'pending' THEN 'reconcile_required' ELSE "state" END, "item_snapshot_json", CASE WHEN "state" = 'pending' THEN NULL ELSE "response_json" END, CASE WHEN "state" = 'pending' AND "mutation_started_at" IS NOT NULL THEN 'legacy_post_boundary_uncertain' WHEN "state" = 'pending' THEN 'legacy_pending_reconcile' ELSE "failure_code" END, "mutation_started_at", CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at", coalesce("mutation_started_at", "created_at")) ELSE "completed_at" END, "created_at", CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at", coalesce("mutation_started_at", "created_at")) ELSE "updated_at" END FROM `download_queue_removal_operations`;--> statement-breakpoint
DROP TABLE `download_queue_removal_operations`;--> statement-breakpoint
ALTER TABLE `__new_download_queue_removal_operations` RENAME TO `download_queue_removal_operations`;--> statement-breakpoint
CREATE UNIQUE INDEX `download_queue_removal_operations_user_key_unique` ON `download_queue_removal_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `download_queue_removal_operations_state_created_idx` ON `download_queue_removal_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `download_queue_removal_operations_item_idx` ON `download_queue_removal_operations` (`connector_id`,`item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_library_mutation_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`reference_id` text,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`response_json` text,
	`failure_code` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "library_mutation_operations_id_check" CHECK(length("__new_library_mutation_operations"."id") = 40
        and substr("__new_library_mutation_operations"."id", 1, 18) = 'library_operation_'
        and substr("__new_library_mutation_operations"."id", 19) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_mutation_operations_kind_check" CHECK("__new_library_mutation_operations"."kind" in ('scan', 'item_refresh', 'metadata_update', 'artwork_apply')),
	CONSTRAINT "library_mutation_operations_reference_check" CHECK(("__new_library_mutation_operations"."kind" = 'scan' and "__new_library_mutation_operations"."reference_id" is null)
        or ("__new_library_mutation_operations"."kind" <> 'scan'
          and length("__new_library_mutation_operations"."reference_id") = 28
          and substr("__new_library_mutation_operations"."reference_id", 1, 6) = 'media_'
          and substr("__new_library_mutation_operations"."reference_id", 7) not glob '*[^A-Za-z0-9_-]*')),
	CONSTRAINT "library_mutation_operations_key_hash_check" CHECK(length("__new_library_mutation_operations"."idempotency_key_hash") = 43
        and "__new_library_mutation_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_mutation_operations_fingerprint_hash_check" CHECK(length("__new_library_mutation_operations"."fingerprint_hash") = 43
        and "__new_library_mutation_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_mutation_operations_state_check" CHECK("__new_library_mutation_operations"."state" in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')),
	CONSTRAINT "library_mutation_operations_response_json_check" CHECK("__new_library_mutation_operations"."response_json" is null
        or (json_valid("__new_library_mutation_operations"."response_json") and json_type("__new_library_mutation_operations"."response_json") = 'object')),
	CONSTRAINT "library_mutation_operations_outcome_check" CHECK((
          "__new_library_mutation_operations"."state" = 'pending'
          and "__new_library_mutation_operations"."response_json" is null
          and "__new_library_mutation_operations"."failure_code" is null
          and "__new_library_mutation_operations"."completed_at" is null
        ) or (
          "__new_library_mutation_operations"."state" = 'succeeded'
          and "__new_library_mutation_operations"."response_json" is not null
          and "__new_library_mutation_operations"."failure_code" is null
          and "__new_library_mutation_operations"."completed_at" is not null
        ) or (
          "__new_library_mutation_operations"."state" in ('reconcile_required', 'uncertain', 'failed')
          and "__new_library_mutation_operations"."response_json" is null
          and length("__new_library_mutation_operations"."failure_code") between 1 and 64
          and "__new_library_mutation_operations"."completed_at" is not null
        )),
	CONSTRAINT "library_mutation_operations_timestamp_order_check" CHECK("__new_library_mutation_operations"."completed_at" is null or "__new_library_mutation_operations"."completed_at" >= "__new_library_mutation_operations"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_library_mutation_operations`("id", "user_id", "kind", "reference_id", "idempotency_key_hash", "fingerprint_hash", "state", "response_json", "failure_code", "completed_at", "created_at", "updated_at") SELECT "id", "user_id", "kind", "reference_id", "idempotency_key_hash", "fingerprint_hash", CASE WHEN "state" = 'pending' THEN 'reconcile_required' ELSE "state" END, CASE WHEN "state" = 'pending' THEN NULL ELSE "response_json" END, CASE WHEN "state" = 'pending' THEN 'legacy_pending_reconcile' ELSE "failure_code" END, CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at") ELSE "completed_at" END, "created_at", CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at") ELSE "updated_at" END FROM `library_mutation_operations`;--> statement-breakpoint
DROP TABLE `library_mutation_operations`;--> statement-breakpoint
ALTER TABLE `__new_library_mutation_operations` RENAME TO `library_mutation_operations`;--> statement-breakpoint
CREATE UNIQUE INDEX `library_mutation_operations_user_key_unique` ON `library_mutation_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `library_mutation_operations_state_created_idx` ON `library_mutation_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `library_mutation_operations_reference_idx` ON `library_mutation_operations` (`reference_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_library_removal_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`service_identity_link_id` text NOT NULL,
	`link_revision` integer NOT NULL,
	`media_reference_id` text NOT NULL,
	`preview_id` text NOT NULL,
	`mode` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`target_digest` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`response_json` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`failure_code` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "library_removal_operations_id_check" CHECK(length("__new_library_removal_operations"."id") = 48
        and substr("__new_library_removal_operations"."id", 1, 26) = 'library_removal_operation_'
        and substr("__new_library_removal_operations"."id", 27) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_removal_operations_preview_id_check" CHECK(length("__new_library_removal_operations"."preview_id") = 46
        and substr("__new_library_removal_operations"."preview_id", 1, 24) = 'library_removal_preview_'
        and substr("__new_library_removal_operations"."preview_id", 25) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_removal_operations_reference_id_check" CHECK(length("__new_library_removal_operations"."media_reference_id") = 28
        and substr("__new_library_removal_operations"."media_reference_id", 1, 6) = 'media_'
        and substr("__new_library_removal_operations"."media_reference_id", 7) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_removal_operations_session_id_check" CHECK(length("__new_library_removal_operations"."session_id") between 1 and 128
        and "__new_library_removal_operations"."session_id" not glob '*[^A-Za-z0-9._:-]*'),
	CONSTRAINT "library_removal_operations_link_id_check" CHECK(length("__new_library_removal_operations"."service_identity_link_id") between 1 and 128
        and "__new_library_removal_operations"."service_identity_link_id" not glob '*[^A-Za-z0-9._:-]*'),
	CONSTRAINT "library_removal_operations_link_revision_check" CHECK("__new_library_removal_operations"."link_revision" between 0 and 2147483647),
	CONSTRAINT "library_removal_operations_mode_check" CHECK("__new_library_removal_operations"."mode" in (
        'delete_files_keep_monitored',
        'delete_files_and_unmonitor',
        'remove_from_radarr_and_delete_files',
        'delete_unmanaged_files'
      )),
	CONSTRAINT "library_removal_operations_key_hash_check" CHECK(length("__new_library_removal_operations"."idempotency_key_hash") = 43
        and "__new_library_removal_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_removal_operations_fingerprint_hash_check" CHECK(length("__new_library_removal_operations"."fingerprint_hash") = 43
        and "__new_library_removal_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_removal_operations_target_digest_check" CHECK(length("__new_library_removal_operations"."target_digest") = 22
        and "__new_library_removal_operations"."target_digest" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_removal_operations_state_check" CHECK("__new_library_removal_operations"."state" in ('running', 'succeeded', 'reconcile_required', 'uncertain', 'failed')),
	CONSTRAINT "library_removal_operations_response_check" CHECK(length("__new_library_removal_operations"."response_json") between 2 and 16384
        and json_valid("__new_library_removal_operations"."response_json")
        and json_type("__new_library_removal_operations"."response_json") = 'object'),
	CONSTRAINT "library_removal_operations_payload_check" CHECK(length("__new_library_removal_operations"."encrypted_payload") between 1 and 65536),
	CONSTRAINT "library_removal_operations_outcome_check" CHECK((
          "__new_library_removal_operations"."state" = 'running'
          and "__new_library_removal_operations"."failure_code" is null
          and "__new_library_removal_operations"."completed_at" is null
        ) or (
          "__new_library_removal_operations"."state" = 'succeeded'
          and "__new_library_removal_operations"."failure_code" is null
          and "__new_library_removal_operations"."completed_at" is not null
        ) or (
          "__new_library_removal_operations"."state" in ('reconcile_required', 'uncertain', 'failed')
          and length("__new_library_removal_operations"."failure_code") between 1 and 64
          and "__new_library_removal_operations"."completed_at" is not null
        )),
	CONSTRAINT "library_removal_operations_timestamp_order_check" CHECK("__new_library_removal_operations"."created_at" >= 0
        and "__new_library_removal_operations"."created_at" <= "__new_library_removal_operations"."updated_at"
        and "__new_library_removal_operations"."created_at" <= "__new_library_removal_operations"."started_at"
        and ("__new_library_removal_operations"."completed_at" is null
          or ("__new_library_removal_operations"."completed_at" >= "__new_library_removal_operations"."started_at"
            and "__new_library_removal_operations"."completed_at" <= "__new_library_removal_operations"."updated_at")))
);
--> statement-breakpoint
INSERT INTO `__new_library_removal_operations`("id", "user_id", "session_id", "service_identity_link_id", "link_revision", "media_reference_id", "preview_id", "mode", "idempotency_key_hash", "fingerprint_hash", "target_digest", "state", "response_json", "encrypted_payload", "failure_code", "started_at", "completed_at", "created_at", "updated_at") SELECT "id", "user_id", "session_id", "service_identity_link_id", "link_revision", "media_reference_id", "preview_id", "mode", "idempotency_key_hash", "fingerprint_hash", "target_digest", CASE WHEN "state" = 'running' AND EXISTS (SELECT 1 FROM json_each("response_json", '$.stages') WHERE json_extract(value, '$.state') = 'uncertain') THEN 'uncertain' WHEN "state" = 'running' THEN 'reconcile_required' ELSE "state" END, "response_json", "encrypted_payload", CASE WHEN "state" = 'running' AND EXISTS (SELECT 1 FROM json_each("response_json", '$.stages') WHERE json_extract(value, '$.state') = 'uncertain') THEN 'legacy_post_boundary_uncertain' WHEN "state" = 'running' THEN 'legacy_pending_reconcile' ELSE "failure_code" END, "started_at", CASE WHEN "state" = 'running' THEN max("created_at", "started_at", "updated_at") ELSE "completed_at" END, "created_at", CASE WHEN "state" = 'running' THEN max("created_at", "started_at", "updated_at") ELSE "updated_at" END FROM `library_removal_operations`;--> statement-breakpoint
DROP TABLE `library_removal_operations`;--> statement-breakpoint
ALTER TABLE `__new_library_removal_operations` RENAME TO `library_removal_operations`;--> statement-breakpoint
CREATE UNIQUE INDEX `library_removal_operations_user_key_unique` ON `library_removal_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_removal_operations_preview_unique` ON `library_removal_operations` (`preview_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_removal_operations_running_target_unique` ON `library_removal_operations` (`target_digest`) WHERE "library_removal_operations"."state" = 'running';--> statement-breakpoint
CREATE INDEX `library_removal_operations_state_created_idx` ON `library_removal_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `library_removal_operations_reference_idx` ON `library_removal_operations` (`media_reference_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_media_issue_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`source` text NOT NULL,
	`desired_status` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`response_json` text,
	`failure_code` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_issue_operations_id_check" CHECK(length("__new_media_issue_operations"."id") = 38
        and substr("__new_media_issue_operations"."id", 1, 16) = 'issue_operation_'
        and substr("__new_media_issue_operations"."id", 17) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_issue_operations_issue_id_check" CHECK(length("__new_media_issue_operations"."issue_id") = 28
        and substr("__new_media_issue_operations"."issue_id", 1, 6) = 'issue_'
        and substr("__new_media_issue_operations"."issue_id", 7) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_issue_operations_source_check" CHECK("__new_media_issue_operations"."source" in ('omnifin', 'seerr')),
	CONSTRAINT "media_issue_operations_desired_status_check" CHECK("__new_media_issue_operations"."desired_status" in ('open', 'resolved')),
	CONSTRAINT "media_issue_operations_key_hash_check" CHECK(length("__new_media_issue_operations"."idempotency_key_hash") = 43
        and "__new_media_issue_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_issue_operations_fingerprint_hash_check" CHECK(length("__new_media_issue_operations"."fingerprint_hash") = 43
        and "__new_media_issue_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_issue_operations_state_check" CHECK("__new_media_issue_operations"."state" in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')),
	CONSTRAINT "media_issue_operations_response_json_check" CHECK("__new_media_issue_operations"."response_json" is null
        or (json_valid("__new_media_issue_operations"."response_json") and json_type("__new_media_issue_operations"."response_json") = 'object')),
	CONSTRAINT "media_issue_operations_outcome_check" CHECK((
          "__new_media_issue_operations"."state" = 'pending'
          and "__new_media_issue_operations"."response_json" is null
          and "__new_media_issue_operations"."failure_code" is null
          and "__new_media_issue_operations"."completed_at" is null
        ) or (
          "__new_media_issue_operations"."state" = 'succeeded'
          and "__new_media_issue_operations"."response_json" is not null
          and "__new_media_issue_operations"."failure_code" is null
          and "__new_media_issue_operations"."completed_at" is not null
        ) or (
          "__new_media_issue_operations"."state" in ('reconcile_required', 'uncertain', 'failed')
          and "__new_media_issue_operations"."response_json" is null
          and length("__new_media_issue_operations"."failure_code") between 1 and 64
          and "__new_media_issue_operations"."completed_at" is not null
        )),
	CONSTRAINT "media_issue_operations_timestamp_order_check" CHECK("__new_media_issue_operations"."completed_at" is null or "__new_media_issue_operations"."completed_at" >= "__new_media_issue_operations"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_media_issue_operations`("id", "user_id", "issue_id", "source", "desired_status", "idempotency_key_hash", "fingerprint_hash", "state", "response_json", "failure_code", "completed_at", "created_at", "updated_at") SELECT "id", "user_id", "issue_id", "source", "desired_status", "idempotency_key_hash", "fingerprint_hash", CASE WHEN "state" = 'pending' AND "source" = 'seerr' THEN 'reconcile_required' ELSE "state" END, CASE WHEN "state" = 'pending' AND "source" = 'seerr' THEN NULL ELSE "response_json" END, CASE WHEN "state" = 'pending' AND "source" = 'seerr' THEN 'legacy_pending_reconcile' ELSE "failure_code" END, CASE WHEN "state" = 'pending' AND "source" = 'seerr' THEN max("created_at", "updated_at") ELSE "completed_at" END, "created_at", CASE WHEN "state" = 'pending' AND "source" = 'seerr' THEN max("created_at", "updated_at") ELSE "updated_at" END FROM `media_issue_operations`;--> statement-breakpoint
DROP TABLE `media_issue_operations`;--> statement-breakpoint
ALTER TABLE `__new_media_issue_operations` RENAME TO `media_issue_operations`;--> statement-breakpoint
CREATE UNIQUE INDEX `media_issue_operations_user_key_unique` ON `media_issue_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `media_issue_operations_state_created_idx` ON `media_issue_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `media_issue_operations_issue_created_idx` ON `media_issue_operations` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_media_request_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`response_json` text,
	`failure_code` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_request_operations_key_hash_check" CHECK(length("__new_media_request_operations"."idempotency_key_hash") = 43
        and "__new_media_request_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_request_operations_fingerprint_hash_check" CHECK(length("__new_media_request_operations"."fingerprint_hash") = 43
        and "__new_media_request_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_request_operations_state_check" CHECK("__new_media_request_operations"."state" in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')),
	CONSTRAINT "media_request_operations_response_json_check" CHECK("__new_media_request_operations"."response_json" is null
        or (json_valid("__new_media_request_operations"."response_json") and json_type("__new_media_request_operations"."response_json") = 'object')),
	CONSTRAINT "media_request_operations_outcome_check" CHECK((
          "__new_media_request_operations"."state" = 'pending'
          and "__new_media_request_operations"."response_json" is null
          and "__new_media_request_operations"."failure_code" is null
          and "__new_media_request_operations"."completed_at" is null
        ) or (
          "__new_media_request_operations"."state" = 'succeeded'
          and "__new_media_request_operations"."response_json" is not null
          and "__new_media_request_operations"."failure_code" is null
          and "__new_media_request_operations"."completed_at" is not null
        ) or (
          "__new_media_request_operations"."state" in ('reconcile_required', 'uncertain', 'failed')
          and "__new_media_request_operations"."response_json" is null
          and length("__new_media_request_operations"."failure_code") between 1 and 64
          and "__new_media_request_operations"."completed_at" is not null
        )),
	CONSTRAINT "media_request_operations_timestamp_order_check" CHECK("__new_media_request_operations"."completed_at" is null or "__new_media_request_operations"."completed_at" >= "__new_media_request_operations"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_media_request_operations`("id", "user_id", "idempotency_key_hash", "fingerprint_hash", "state", "response_json", "failure_code", "completed_at", "created_at", "updated_at") SELECT "id", "user_id", "idempotency_key_hash", "fingerprint_hash", CASE WHEN "state" = 'pending' THEN 'reconcile_required' ELSE "state" END, CASE WHEN "state" = 'pending' THEN NULL ELSE "response_json" END, CASE WHEN "state" = 'pending' THEN 'legacy_pending_reconcile' ELSE "failure_code" END, CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at") ELSE "completed_at" END, "created_at", CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at") ELSE "updated_at" END FROM `media_request_operations`;--> statement-breakpoint
DROP TABLE `media_request_operations`;--> statement-breakpoint
ALTER TABLE `__new_media_request_operations` RENAME TO `media_request_operations`;--> statement-breakpoint
CREATE UNIQUE INDEX `media_request_operations_user_key_unique` ON `media_request_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `media_request_operations_state_created_idx` ON `media_request_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_saved_list_operations` (
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
	CONSTRAINT "saved_list_operations_id_check" CHECK(length("__new_saved_list_operations"."id") = 38
        and substr("__new_saved_list_operations"."id", 1, 16) = 'saved_operation_'
        and substr("__new_saved_list_operations"."id", 17) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "saved_list_operations_kind_check" CHECK("__new_saved_list_operations"."kind" in ('create_list', 'restore_list', 'add_item', 'reorder_items', 'favorite')),
	CONSTRAINT "saved_list_operations_key_hash_check" CHECK(length("__new_saved_list_operations"."idempotency_key_hash") = 43
        and "__new_saved_list_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "saved_list_operations_fingerprint_hash_check" CHECK(length("__new_saved_list_operations"."fingerprint_hash") = 22
        and "__new_saved_list_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "saved_list_operations_state_check" CHECK("__new_saved_list_operations"."state" in ('pending', 'succeeded', 'reconcile_required', 'uncertain', 'failed')),
	CONSTRAINT "saved_list_operations_response_check" CHECK("__new_saved_list_operations"."encrypted_response" is null
        or length("__new_saved_list_operations"."encrypted_response") between 1 and 131072),
	CONSTRAINT "saved_list_operations_outcome_check" CHECK((
          "__new_saved_list_operations"."state" = 'pending'
          and "__new_saved_list_operations"."encrypted_response" is null
          and "__new_saved_list_operations"."failure_code" is null
          and "__new_saved_list_operations"."completed_at" is null
        ) or (
          "__new_saved_list_operations"."state" = 'succeeded'
          and "__new_saved_list_operations"."encrypted_response" is not null
          and "__new_saved_list_operations"."failure_code" is null
          and "__new_saved_list_operations"."completed_at" is not null
        ) or (
          "__new_saved_list_operations"."state" in ('reconcile_required', 'uncertain', 'failed')
          and "__new_saved_list_operations"."encrypted_response" is null
          and length("__new_saved_list_operations"."failure_code") between 1 and 64
          and "__new_saved_list_operations"."completed_at" is not null
        )),
	CONSTRAINT "saved_list_operations_timestamp_order_check" CHECK("__new_saved_list_operations"."completed_at" is null or "__new_saved_list_operations"."completed_at" >= "__new_saved_list_operations"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_saved_list_operations`("id", "user_id", "kind", "resource_id", "idempotency_key_hash", "fingerprint_hash", "state", "encrypted_response", "failure_code", "completed_at", "created_at", "updated_at") SELECT "id", "user_id", "kind", "resource_id", "idempotency_key_hash", "fingerprint_hash", CASE WHEN "state" = 'pending' AND "kind" = 'favorite' THEN 'reconcile_required' ELSE "state" END, CASE WHEN "state" = 'pending' AND "kind" = 'favorite' THEN NULL ELSE "encrypted_response" END, CASE WHEN "state" = 'pending' AND "kind" = 'favorite' THEN 'legacy_pending_reconcile' ELSE "failure_code" END, CASE WHEN "state" = 'pending' AND "kind" = 'favorite' THEN max("created_at", "updated_at") ELSE "completed_at" END, "created_at", CASE WHEN "state" = 'pending' AND "kind" = 'favorite' THEN max("created_at", "updated_at") ELSE "updated_at" END FROM `saved_list_operations`;--> statement-breakpoint
DROP TABLE `saved_list_operations`;--> statement-breakpoint
ALTER TABLE `__new_saved_list_operations` RENAME TO `saved_list_operations`;--> statement-breakpoint
CREATE UNIQUE INDEX `saved_list_operations_user_key_unique` ON `saved_list_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `saved_list_operations_state_created_idx` ON `saved_list_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `saved_list_operations_resource_idx` ON `saved_list_operations` (`user_id`,`resource_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_subtitle_download_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`search_id` text NOT NULL,
	`result_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`response_json` text,
	`failure_code` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "subtitle_download_operations_id_check" CHECK(length("__new_subtitle_download_operations"."id") = 40
        and substr("__new_subtitle_download_operations"."id", 1, 18) = 'subtitle_download_'
        and substr("__new_subtitle_download_operations"."id", 19) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "subtitle_download_operations_search_id_check" CHECK(length("__new_subtitle_download_operations"."search_id") = 38
        and substr("__new_subtitle_download_operations"."search_id", 1, 16) = 'subtitle_search_'
        and substr("__new_subtitle_download_operations"."search_id", 17) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "subtitle_download_operations_result_id_check" CHECK(length("__new_subtitle_download_operations"."result_id") = 38
        and substr("__new_subtitle_download_operations"."result_id", 1, 16) = 'subtitle_result_'
        and substr("__new_subtitle_download_operations"."result_id", 17) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "subtitle_download_operations_key_hash_check" CHECK(length("__new_subtitle_download_operations"."idempotency_key_hash") = 43
        and "__new_subtitle_download_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "subtitle_download_operations_fingerprint_hash_check" CHECK(length("__new_subtitle_download_operations"."fingerprint_hash") = 43
        and "__new_subtitle_download_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "subtitle_download_operations_state_check" CHECK("__new_subtitle_download_operations"."state" in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')),
	CONSTRAINT "subtitle_download_operations_response_json_check" CHECK("__new_subtitle_download_operations"."response_json" is null
        or (json_valid("__new_subtitle_download_operations"."response_json") and json_type("__new_subtitle_download_operations"."response_json") = 'object')),
	CONSTRAINT "subtitle_download_operations_outcome_check" CHECK((
          "__new_subtitle_download_operations"."state" = 'pending'
          and "__new_subtitle_download_operations"."response_json" is null
          and "__new_subtitle_download_operations"."failure_code" is null
          and "__new_subtitle_download_operations"."completed_at" is null
        ) or (
          "__new_subtitle_download_operations"."state" = 'succeeded'
          and "__new_subtitle_download_operations"."response_json" is not null
          and "__new_subtitle_download_operations"."failure_code" is null
          and "__new_subtitle_download_operations"."completed_at" is not null
        ) or (
          "__new_subtitle_download_operations"."state" in ('reconcile_required', 'uncertain', 'failed')
          and "__new_subtitle_download_operations"."response_json" is null
          and length("__new_subtitle_download_operations"."failure_code") between 1 and 64
          and "__new_subtitle_download_operations"."completed_at" is not null
        )),
	CONSTRAINT "subtitle_download_operations_timestamp_order_check" CHECK("__new_subtitle_download_operations"."completed_at" is null or "__new_subtitle_download_operations"."completed_at" >= "__new_subtitle_download_operations"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_subtitle_download_operations`("id", "user_id", "search_id", "result_id", "idempotency_key_hash", "fingerprint_hash", "state", "response_json", "failure_code", "completed_at", "created_at", "updated_at") SELECT "id", "user_id", "search_id", "result_id", "idempotency_key_hash", "fingerprint_hash", CASE WHEN "state" = 'pending' THEN 'reconcile_required' ELSE "state" END, CASE WHEN "state" = 'pending' THEN NULL ELSE "response_json" END, CASE WHEN "state" = 'pending' THEN 'legacy_pending_reconcile' ELSE "failure_code" END, CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at") ELSE "completed_at" END, "created_at", CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at") ELSE "updated_at" END FROM `subtitle_download_operations`;--> statement-breakpoint
DROP TABLE `subtitle_download_operations`;--> statement-breakpoint
ALTER TABLE `__new_subtitle_download_operations` RENAME TO `subtitle_download_operations`;--> statement-breakpoint
CREATE UNIQUE INDEX `subtitle_download_operations_user_key_unique` ON `subtitle_download_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `subtitle_download_operations_state_created_idx` ON `subtitle_download_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_user_media_state_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reference_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`response_json` text,
	`failure_code` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reference_id`) REFERENCES `media_references`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_media_state_operations_id_check" CHECK(length("__new_user_media_state_operations"."id") = 39
        and substr("__new_user_media_state_operations"."id", 1, 17) = 'user_media_state_'
        and substr("__new_user_media_state_operations"."id", 18) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "user_media_state_operations_reference_check" CHECK(length("__new_user_media_state_operations"."reference_id") = 28
        and substr("__new_user_media_state_operations"."reference_id", 1, 6) = 'media_'
        and substr("__new_user_media_state_operations"."reference_id", 7) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "user_media_state_operations_key_hash_check" CHECK(length("__new_user_media_state_operations"."idempotency_key_hash") = 43
        and "__new_user_media_state_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "user_media_state_operations_fingerprint_hash_check" CHECK(length("__new_user_media_state_operations"."fingerprint_hash") = 43
        and "__new_user_media_state_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "user_media_state_operations_state_check" CHECK("__new_user_media_state_operations"."state" in ('pending', 'reconcile_required', 'uncertain', 'succeeded', 'failed')),
	CONSTRAINT "user_media_state_operations_response_json_check" CHECK("__new_user_media_state_operations"."response_json" is null
        or (json_valid("__new_user_media_state_operations"."response_json") and json_type("__new_user_media_state_operations"."response_json") = 'object')),
	CONSTRAINT "user_media_state_operations_outcome_check" CHECK((
          "__new_user_media_state_operations"."state" = 'pending'
          and "__new_user_media_state_operations"."response_json" is null
          and "__new_user_media_state_operations"."failure_code" is null
          and "__new_user_media_state_operations"."completed_at" is null
        ) or (
          "__new_user_media_state_operations"."state" = 'succeeded'
          and "__new_user_media_state_operations"."response_json" is not null
          and "__new_user_media_state_operations"."failure_code" is null
          and "__new_user_media_state_operations"."completed_at" is not null
        ) or (
          "__new_user_media_state_operations"."state" in ('reconcile_required', 'uncertain', 'failed')
          and "__new_user_media_state_operations"."response_json" is null
          and length("__new_user_media_state_operations"."failure_code") between 1 and 64
          and "__new_user_media_state_operations"."completed_at" is not null
        )),
	CONSTRAINT "user_media_state_operations_timestamp_order_check" CHECK("__new_user_media_state_operations"."completed_at" is null or "__new_user_media_state_operations"."completed_at" >= "__new_user_media_state_operations"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_user_media_state_operations`("id", "user_id", "reference_id", "idempotency_key_hash", "fingerprint_hash", "state", "response_json", "failure_code", "completed_at", "created_at", "updated_at") SELECT "id", "user_id", "reference_id", "idempotency_key_hash", "fingerprint_hash", CASE WHEN "state" = 'pending' THEN 'reconcile_required' ELSE "state" END, CASE WHEN "state" = 'pending' THEN NULL ELSE "response_json" END, CASE WHEN "state" = 'pending' THEN 'legacy_pending_reconcile' ELSE "failure_code" END, CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at") ELSE "completed_at" END, "created_at", CASE WHEN "state" = 'pending' THEN max("created_at", "updated_at") ELSE "updated_at" END FROM `user_media_state_operations`;--> statement-breakpoint
DROP TABLE `user_media_state_operations`;--> statement-breakpoint
ALTER TABLE `__new_user_media_state_operations` RENAME TO `user_media_state_operations`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_media_state_operations_user_key_unique` ON `user_media_state_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `user_media_state_operations_state_created_idx` ON `user_media_state_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `user_media_state_operations_reference_idx` ON `user_media_state_operations` (`reference_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `connector_configs` ADD `instance_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_configs` ADD `config_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_configs` ADD `instance_identity_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `connector_configs_id_instance_generation_unique` ON `connector_configs` (`id`,`instance_generation`);--> statement-breakpoint
ALTER TABLE `discovery_artwork_references` ADD `connector_instance_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `external_issue_references` ADD `connector_instance_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jellyfin_quick_connect_transactions` ADD `connector_instance_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_request_profile_preferences` ADD `connector_instance_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `service_identity_links` ADD `connector_instance_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `subtitle_searches` ADD `connector_instance_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `connector_configs` SET `config_generation` = `updated_at`;--> statement-breakpoint
UPDATE `download_queue_bulk_operations`
SET `state` = 'quarantined',
    `completed_at` = max(`created_at`, `updated_at`),
    `updated_at` = max(`created_at`, `updated_at`)
WHERE `state` = 'pending';--> statement-breakpoint
CREATE TRIGGER `connector_configs_generation_insert_guard`
BEFORE INSERT ON `connector_configs`
BEGIN
	SELECT RAISE(ABORT, 'connector generation invalid')
	WHERE typeof(NEW.`instance_generation`) <> 'integer'
		OR NEW.`instance_generation` NOT BETWEEN 0 AND 9007199254740991
		OR typeof(NEW.`config_generation`) <> 'integer'
		OR NEW.`config_generation` NOT BETWEEN 0 AND 9007199254740991
		OR (NEW.`instance_identity_hash` IS NOT NULL AND (
			length(NEW.`instance_identity_hash`) <> 43
			OR NEW.`instance_identity_hash` GLOB '*[^A-Za-z0-9_-]*'
		));
END;--> statement-breakpoint
CREATE TRIGGER `connector_configs_generation_update_guard`
BEFORE UPDATE OF `instance_generation`, `config_generation`, `instance_identity_hash`
ON `connector_configs`
BEGIN
	SELECT RAISE(ABORT, 'connector generation invalid')
	WHERE typeof(NEW.`instance_generation`) <> 'integer'
		OR NEW.`instance_generation` NOT BETWEEN 0 AND 9007199254740991
		OR typeof(NEW.`config_generation`) <> 'integer'
		OR NEW.`config_generation` NOT BETWEEN 0 AND 9007199254740991
		OR (NEW.`instance_identity_hash` IS NOT NULL AND (
			length(NEW.`instance_identity_hash`) <> 43
			OR NEW.`instance_identity_hash` GLOB '*[^A-Za-z0-9_-]*'
		));
END;--> statement-breakpoint
CREATE TRIGGER `service_identity_links_connector_generation_insert_guard`
BEFORE INSERT ON `service_identity_links`
WHEN typeof(NEW.`connector_instance_generation`) <> 'integer'
	OR NEW.`connector_instance_generation` NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'connector generation invalid'); END;--> statement-breakpoint
CREATE TRIGGER `service_identity_links_connector_generation_update_guard`
BEFORE UPDATE OF `connector_instance_generation` ON `service_identity_links`
WHEN typeof(NEW.`connector_instance_generation`) <> 'integer'
	OR NEW.`connector_instance_generation` NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'connector generation invalid'); END;--> statement-breakpoint
CREATE TRIGGER `media_request_profile_preferences_connector_generation_insert_guard`
BEFORE INSERT ON `media_request_profile_preferences`
WHEN typeof(NEW.`connector_instance_generation`) <> 'integer'
	OR NEW.`connector_instance_generation` NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'connector generation invalid'); END;--> statement-breakpoint
CREATE TRIGGER `media_request_profile_preferences_connector_generation_update_guard`
BEFORE UPDATE OF `connector_instance_generation` ON `media_request_profile_preferences`
WHEN typeof(NEW.`connector_instance_generation`) <> 'integer'
	OR NEW.`connector_instance_generation` NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'connector generation invalid'); END;--> statement-breakpoint
CREATE TRIGGER `discovery_artwork_references_connector_generation_insert_guard`
BEFORE INSERT ON `discovery_artwork_references`
WHEN typeof(NEW.`connector_instance_generation`) <> 'integer'
	OR NEW.`connector_instance_generation` NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'connector generation invalid'); END;--> statement-breakpoint
CREATE TRIGGER `discovery_artwork_references_connector_generation_update_guard`
BEFORE UPDATE OF `connector_instance_generation` ON `discovery_artwork_references`
WHEN typeof(NEW.`connector_instance_generation`) <> 'integer'
	OR NEW.`connector_instance_generation` NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'connector generation invalid'); END;--> statement-breakpoint
CREATE TRIGGER `external_issue_references_connector_generation_insert_guard`
BEFORE INSERT ON `external_issue_references`
WHEN typeof(NEW.`connector_instance_generation`) <> 'integer'
	OR NEW.`connector_instance_generation` NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'connector generation invalid'); END;--> statement-breakpoint
CREATE TRIGGER `external_issue_references_connector_generation_update_guard`
BEFORE UPDATE OF `connector_instance_generation` ON `external_issue_references`
WHEN typeof(NEW.`connector_instance_generation`) <> 'integer'
	OR NEW.`connector_instance_generation` NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'connector generation invalid'); END;--> statement-breakpoint
CREATE TRIGGER `subtitle_searches_connector_generation_insert_guard`
BEFORE INSERT ON `subtitle_searches`
WHEN typeof(NEW.`connector_instance_generation`) <> 'integer'
	OR NEW.`connector_instance_generation` NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'connector generation invalid'); END;--> statement-breakpoint
CREATE TRIGGER `subtitle_searches_connector_generation_update_guard`
BEFORE UPDATE OF `connector_instance_generation` ON `subtitle_searches`
WHEN typeof(NEW.`connector_instance_generation`) <> 'integer'
	OR NEW.`connector_instance_generation` NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'connector generation invalid'); END;--> statement-breakpoint
CREATE TRIGGER `jellyfin_quick_connect_transactions_connector_generation_insert_guard`
BEFORE INSERT ON `jellyfin_quick_connect_transactions`
WHEN typeof(NEW.`connector_instance_generation`) <> 'integer'
	OR NEW.`connector_instance_generation` NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'connector generation invalid'); END;--> statement-breakpoint
CREATE TRIGGER `jellyfin_quick_connect_transactions_connector_generation_update_guard`
BEFORE UPDATE OF `connector_instance_generation` ON `jellyfin_quick_connect_transactions`
WHEN typeof(NEW.`connector_instance_generation`) <> 'integer'
	OR NEW.`connector_instance_generation` NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'connector generation invalid'); END;
