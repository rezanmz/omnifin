PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_jellyfin_quick_connect_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`connector_type` text DEFAULT 'jellyfin' NOT NULL,
	`purpose` text DEFAULT 'sign_in' NOT NULL,
	`pairing_session_id` text,
	`browser_binding_hash` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`expires_at` integer NOT NULL,
	`next_poll_at` integer NOT NULL,
	`poll_count` integer DEFAULT 0 NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`pairing_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_id`,`connector_type`) REFERENCES `connector_configs`(`id`,`type`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "jellyfin_quick_connect_transactions_binding_hash_check" CHECK(length("__new_jellyfin_quick_connect_transactions"."browser_binding_hash") = 43
        and "__new_jellyfin_quick_connect_transactions"."browser_binding_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "jellyfin_quick_connect_transactions_connector_type_check" CHECK("__new_jellyfin_quick_connect_transactions"."connector_type" = 'jellyfin'),
	CONSTRAINT "jellyfin_quick_connect_transactions_purpose_check" CHECK(("__new_jellyfin_quick_connect_transactions"."purpose" = 'sign_in' and "__new_jellyfin_quick_connect_transactions"."pairing_session_id" is null)
        or ("__new_jellyfin_quick_connect_transactions"."purpose" = 'pairing' and "__new_jellyfin_quick_connect_transactions"."pairing_session_id" is not null)),
	CONSTRAINT "jellyfin_quick_connect_transactions_poll_count_check" CHECK(typeof("__new_jellyfin_quick_connect_transactions"."poll_count") = 'integer' and "__new_jellyfin_quick_connect_transactions"."poll_count" between 0 and 512),
	CONSTRAINT "jellyfin_quick_connect_transactions_timestamp_order_check" CHECK("__new_jellyfin_quick_connect_transactions"."created_at" < "__new_jellyfin_quick_connect_transactions"."expires_at"
        and "__new_jellyfin_quick_connect_transactions"."next_poll_at" >= "__new_jellyfin_quick_connect_transactions"."created_at"
        and "__new_jellyfin_quick_connect_transactions"."next_poll_at" <= "__new_jellyfin_quick_connect_transactions"."expires_at"
        and ("__new_jellyfin_quick_connect_transactions"."consumed_at" is null or (
          "__new_jellyfin_quick_connect_transactions"."consumed_at" >= "__new_jellyfin_quick_connect_transactions"."created_at"
          and "__new_jellyfin_quick_connect_transactions"."consumed_at" <= "__new_jellyfin_quick_connect_transactions"."expires_at"
        )))
);
--> statement-breakpoint
INSERT INTO `__new_jellyfin_quick_connect_transactions`("id", "connector_id", "connector_type", "purpose", "pairing_session_id", "browser_binding_hash", "encrypted_payload", "expires_at", "next_poll_at", "poll_count", "consumed_at", "created_at") SELECT "id", "connector_id", "connector_type", 'sign_in', NULL, "browser_binding_hash", "encrypted_payload", "expires_at", "next_poll_at", "poll_count", "consumed_at", "created_at" FROM `jellyfin_quick_connect_transactions`;--> statement-breakpoint
DROP TABLE `jellyfin_quick_connect_transactions`;--> statement-breakpoint
ALTER TABLE `__new_jellyfin_quick_connect_transactions` RENAME TO `jellyfin_quick_connect_transactions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `jellyfin_quick_connect_transactions_expiry_idx` ON `jellyfin_quick_connect_transactions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `jellyfin_quick_connect_transactions_browser_expiry_idx` ON `jellyfin_quick_connect_transactions` (`browser_binding_hash`,`expires_at`);--> statement-breakpoint
CREATE INDEX `jellyfin_quick_connect_transactions_pairing_session_idx` ON `jellyfin_quick_connect_transactions` (`pairing_session_id`,`expires_at`);
