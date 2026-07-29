CREATE TABLE `external_issue_references` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`upstream_id_digest` text NOT NULL,
	`encrypted_upstream_id` text NOT NULL,
	`last_used_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "external_issue_references_id_check" CHECK(length("external_issue_references"."id") = 28
        and substr("external_issue_references"."id", 1, 6) = 'issue_'
        and substr("external_issue_references"."id", 7) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "external_issue_references_digest_check" CHECK(length("external_issue_references"."upstream_id_digest") = 22
        and "external_issue_references"."upstream_id_digest" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "external_issue_references_payload_check" CHECK(length("external_issue_references"."encrypted_upstream_id") between 1 and 8192),
	CONSTRAINT "external_issue_references_timestamp_order_check" CHECK("external_issue_references"."created_at" >= 0
        and "external_issue_references"."created_at" <= "external_issue_references"."updated_at"
        and "external_issue_references"."created_at" <= "external_issue_references"."last_used_at"
        and "external_issue_references"."last_used_at" < "external_issue_references"."expires_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_issue_references_connector_digest_unique` ON `external_issue_references` (`connector_id`,`upstream_id_digest`);--> statement-breakpoint
CREATE INDEX `external_issue_references_expiry_idx` ON `external_issue_references` (`expires_at`);--> statement-breakpoint
CREATE TABLE `media_issue_operations` (
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
	CONSTRAINT "media_issue_operations_id_check" CHECK(length("media_issue_operations"."id") = 38
        and substr("media_issue_operations"."id", 1, 16) = 'issue_operation_'
        and substr("media_issue_operations"."id", 17) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_issue_operations_issue_id_check" CHECK(length("media_issue_operations"."issue_id") = 28
        and substr("media_issue_operations"."issue_id", 1, 6) = 'issue_'
        and substr("media_issue_operations"."issue_id", 7) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_issue_operations_source_check" CHECK("media_issue_operations"."source" in ('omnifin', 'seerr')),
	CONSTRAINT "media_issue_operations_desired_status_check" CHECK("media_issue_operations"."desired_status" in ('open', 'resolved')),
	CONSTRAINT "media_issue_operations_key_hash_check" CHECK(length("media_issue_operations"."idempotency_key_hash") = 43
        and "media_issue_operations"."idempotency_key_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_issue_operations_fingerprint_hash_check" CHECK(length("media_issue_operations"."fingerprint_hash") = 43
        and "media_issue_operations"."fingerprint_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "media_issue_operations_state_check" CHECK("media_issue_operations"."state" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "media_issue_operations_response_json_check" CHECK("media_issue_operations"."response_json" is null
        or (json_valid("media_issue_operations"."response_json") and json_type("media_issue_operations"."response_json") = 'object')),
	CONSTRAINT "media_issue_operations_outcome_check" CHECK((
          "media_issue_operations"."state" = 'pending'
          and "media_issue_operations"."response_json" is null
          and "media_issue_operations"."failure_code" is null
          and "media_issue_operations"."completed_at" is null
        ) or (
          "media_issue_operations"."state" = 'succeeded'
          and "media_issue_operations"."response_json" is not null
          and "media_issue_operations"."failure_code" is null
          and "media_issue_operations"."completed_at" is not null
        ) or (
          "media_issue_operations"."state" = 'failed'
          and "media_issue_operations"."response_json" is null
          and length("media_issue_operations"."failure_code") between 1 and 64
          and "media_issue_operations"."completed_at" is not null
        )),
	CONSTRAINT "media_issue_operations_timestamp_order_check" CHECK("media_issue_operations"."completed_at" is null or "media_issue_operations"."completed_at" >= "media_issue_operations"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_issue_operations_user_key_unique` ON `media_issue_operations` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `media_issue_operations_state_created_idx` ON `media_issue_operations` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `media_issue_operations_issue_created_idx` ON `media_issue_operations` (`issue_id`,`created_at`);
