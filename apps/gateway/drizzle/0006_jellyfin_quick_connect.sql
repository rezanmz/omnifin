CREATE TABLE `jellyfin_quick_connect_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`connector_type` text DEFAULT 'jellyfin' NOT NULL,
	`browser_binding_hash` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`expires_at` integer NOT NULL,
	`next_poll_at` integer NOT NULL,
	`poll_count` integer DEFAULT 0 NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`connector_id`,`connector_type`) REFERENCES `connector_configs`(`id`,`type`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "jellyfin_quick_connect_transactions_binding_hash_check" CHECK(length("jellyfin_quick_connect_transactions"."browser_binding_hash") = 43
        and "jellyfin_quick_connect_transactions"."browser_binding_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "jellyfin_quick_connect_transactions_connector_type_check" CHECK("jellyfin_quick_connect_transactions"."connector_type" = 'jellyfin'),
	CONSTRAINT "jellyfin_quick_connect_transactions_poll_count_check" CHECK(typeof("jellyfin_quick_connect_transactions"."poll_count") = 'integer' and "jellyfin_quick_connect_transactions"."poll_count" between 0 and 512),
	CONSTRAINT "jellyfin_quick_connect_transactions_timestamp_order_check" CHECK("jellyfin_quick_connect_transactions"."created_at" < "jellyfin_quick_connect_transactions"."expires_at"
        and "jellyfin_quick_connect_transactions"."next_poll_at" >= "jellyfin_quick_connect_transactions"."created_at"
        and "jellyfin_quick_connect_transactions"."next_poll_at" <= "jellyfin_quick_connect_transactions"."expires_at"
        and ("jellyfin_quick_connect_transactions"."consumed_at" is null or (
          "jellyfin_quick_connect_transactions"."consumed_at" >= "jellyfin_quick_connect_transactions"."created_at"
          and "jellyfin_quick_connect_transactions"."consumed_at" <= "jellyfin_quick_connect_transactions"."expires_at"
        )))
);
--> statement-breakpoint
CREATE INDEX `jellyfin_quick_connect_transactions_expiry_idx` ON `jellyfin_quick_connect_transactions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `jellyfin_quick_connect_transactions_browser_expiry_idx` ON `jellyfin_quick_connect_transactions` (`browser_binding_hash`,`expires_at`);