-- Guarded removal execution state follows media-request profile preferences.
CREATE TABLE `library_removal_operations` (
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
	CONSTRAINT "library_removal_operations_id_check" CHECK(length("library_removal_operations"."id") = 48
        and substr("library_removal_operations"."id", 1, 26) = 'library_removal_operation_'
        and substr("library_removal_operations"."id", 27) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_removal_operations_preview_id_check" CHECK(length("library_removal_operations"."preview_id") = 46
        and substr("library_removal_operations"."preview_id", 1, 24) = 'library_removal_preview_'
        and substr("library_removal_operations"."preview_id", 25) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_removal_operations_reference_id_check" CHECK(length("library_removal_operations"."media_reference_id") = 28
        and substr("library_removal_operations"."media_reference_id", 1, 6) = 'media_'
        and substr("library_removal_operations"."media_reference_id", 7) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_removal_operations_session_id_check" CHECK(length("library_removal_operations"."session_id") between 1 and 128
        and "library_removal_operations"."session_id" not glob '*[^A-Za-z0-9._:-]*'),
	CONSTRAINT "library_removal_operations_link_id_check" CHECK(length("library_removal_operations"."service_identity_link_id") between 1 and 128
        and "library_removal_operations"."service_identity_link_id" not glob '*[^A-Za-z0-9._:-]*'),
	CONSTRAINT "library_removal_operations_link_revision_check" CHECK("library_removal_operations"."link_revision" between 0 and 2147483647),
	CONSTRAINT "library_removal_operations_mode_check" CHECK("library_removal_operations"."mode" in (
        'delete_files_keep_monitored',
        'delete_files_and_unmonitor',
        'remove_from_radarr_and_delete_files',
        'delete_unmanaged_files'
      )),
	CONSTRAINT "library_removal_operations_key_hash_check" CHECK(length("library_removal_operations"."idempotency_key_hash") = 43
        and "library_removal_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_removal_operations_fingerprint_hash_check" CHECK(length("library_removal_operations"."fingerprint_hash") = 43
        and "library_removal_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_removal_operations_target_digest_check" CHECK(length("library_removal_operations"."target_digest") = 22
        and "library_removal_operations"."target_digest" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_removal_operations_state_check" CHECK("library_removal_operations"."state" in ('running', 'succeeded', 'reconcile_required', 'failed')),
	CONSTRAINT "library_removal_operations_response_check" CHECK(length("library_removal_operations"."response_json") between 2 and 16384
        and json_valid("library_removal_operations"."response_json")
        and json_type("library_removal_operations"."response_json") = 'object'),
	CONSTRAINT "library_removal_operations_payload_check" CHECK(length("library_removal_operations"."encrypted_payload") between 1 and 65536),
	CONSTRAINT "library_removal_operations_outcome_check" CHECK((
          "library_removal_operations"."state" = 'running'
          and "library_removal_operations"."failure_code" is null
          and "library_removal_operations"."completed_at" is null
        ) or (
          "library_removal_operations"."state" = 'succeeded'
          and "library_removal_operations"."failure_code" is null
          and "library_removal_operations"."completed_at" is not null
        ) or (
          "library_removal_operations"."state" in ('reconcile_required', 'failed')
          and length("library_removal_operations"."failure_code") between 1 and 64
          and "library_removal_operations"."completed_at" is not null
        )),
	CONSTRAINT "library_removal_operations_timestamp_order_check" CHECK("library_removal_operations"."created_at" >= 0
        and "library_removal_operations"."created_at" <= "library_removal_operations"."updated_at"
        and "library_removal_operations"."created_at" <= "library_removal_operations"."started_at"
        and ("library_removal_operations"."completed_at" is null
          or ("library_removal_operations"."completed_at" >= "library_removal_operations"."started_at"
            and "library_removal_operations"."completed_at" <= "library_removal_operations"."updated_at")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_removal_operations_user_key_unique` ON `library_removal_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_removal_operations_preview_unique` ON `library_removal_operations` (`preview_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_removal_operations_running_target_unique` ON `library_removal_operations` (`target_digest`) WHERE `state` = 'running';--> statement-breakpoint
CREATE INDEX `library_removal_operations_state_created_idx` ON `library_removal_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `library_removal_operations_reference_idx` ON `library_removal_operations` (`media_reference_id`,`created_at`);
