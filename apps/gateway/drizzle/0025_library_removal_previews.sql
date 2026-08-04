-- Guarded library-removal previews follow the original-download grant migration.
CREATE TABLE `library_removal_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`service_identity_link_id` text NOT NULL,
	`link_revision` integer NOT NULL,
	`media_reference_id` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_reference_id`) REFERENCES `media_references`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_identity_link_id`,`user_id`) REFERENCES `service_identity_links`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "library_removal_previews_id_check" CHECK(length("library_removal_previews"."id") = 46
        and substr("library_removal_previews"."id", 1, 24) = 'library_removal_preview_'
        and substr("library_removal_previews"."id", 25) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "library_removal_previews_session_id_check" CHECK(length("library_removal_previews"."session_id") between 1 and 128
        and "library_removal_previews"."session_id" not glob '*[^A-Za-z0-9._:-]*'),
	CONSTRAINT "library_removal_previews_link_revision_check" CHECK("library_removal_previews"."link_revision" between 0 and 2147483647),
	CONSTRAINT "library_removal_previews_payload_check" CHECK(length("library_removal_previews"."encrypted_payload") between 1 and 65536),
	CONSTRAINT "library_removal_previews_timestamp_order_check" CHECK("library_removal_previews"."created_at" >= 0
        and "library_removal_previews"."created_at" <= "library_removal_previews"."updated_at"
        and "library_removal_previews"."created_at" < "library_removal_previews"."expires_at"
        and ("library_removal_previews"."consumed_at" is null
          or ("library_removal_previews"."consumed_at" between "library_removal_previews"."created_at" and "library_removal_previews"."expires_at"
            and "library_removal_previews"."consumed_at" <= "library_removal_previews"."updated_at")))
);
--> statement-breakpoint
CREATE INDEX `library_removal_previews_expiry_idx` ON `library_removal_previews` (`expires_at`);--> statement-breakpoint
CREATE INDEX `library_removal_previews_user_created_idx` ON `library_removal_previews` (`user_id`,`created_at`);
