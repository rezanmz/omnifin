ALTER TABLE `oidc_providers` ADD `token_endpoint_auth_method` text DEFAULT 'none' NOT NULL
	CONSTRAINT "oidc_providers_token_endpoint_auth_method_check"
	CHECK(`token_endpoint_auth_method` in ('client_secret_basic', 'client_secret_post', 'none'));--> statement-breakpoint
ALTER TABLE `oidc_providers` ADD `id_token_signing_alg` text DEFAULT 'RS256' NOT NULL
	CONSTRAINT "oidc_providers_id_token_signing_alg_check"
	CHECK(`id_token_signing_alg` in ('RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'));--> statement-breakpoint
ALTER TABLE `oidc_providers` ADD `approved_endpoint_origins_json` text DEFAULT '[]' NOT NULL
	CONSTRAINT "oidc_providers_approved_endpoint_origins_json_check"
	CHECK(length(`approved_endpoint_origins_json`) between 2 and 4096
		and json_valid(`approved_endpoint_origins_json`)
		and json_type(`approved_endpoint_origins_json`) = 'array'
		and json_array_length(`approved_endpoint_origins_json`) between 0 and 16);--> statement-breakpoint
ALTER TABLE `oidc_providers` ADD `discovery_capabilities_json` text DEFAULT '{}' NOT NULL
	CONSTRAINT "oidc_providers_discovery_capabilities_json_check"
	CHECK(length(`discovery_capabilities_json`) between 2 and 8192
		and json_valid(`discovery_capabilities_json`)
		and json_type(`discovery_capabilities_json`) = 'object');--> statement-breakpoint
ALTER TABLE `oidc_providers` ADD `discovery_checked_at` integer
	CONSTRAINT "oidc_providers_discovery_timestamp_check"
	CHECK(`discovery_checked_at` is null or `discovery_checked_at` >= `created_at`);--> statement-breakpoint
ALTER TABLE `oidc_providers` ADD `discovery_state` text DEFAULT 'unchecked' NOT NULL
	CONSTRAINT "oidc_providers_discovery_state_check"
	CHECK(`discovery_state` in ('unchecked', 'ready', 'failed'))
	CONSTRAINT "oidc_providers_discovery_attribution_check"
	CHECK((
			`discovery_state` = 'unchecked'
			and `discovery_checked_at` is null
			and json(`discovery_capabilities_json`) = '{}'
		) or (
			`discovery_state` = 'failed'
			and `discovery_checked_at` is not null
		) or (
			`discovery_state` = 'ready'
			and `discovery_checked_at` is not null
			and json(`discovery_capabilities_json`) <> '{}'
			and json_array_length(`approved_endpoint_origins_json`) between 1 and 16
		));--> statement-breakpoint
UPDATE `oidc_providers`
SET
	`token_endpoint_auth_method` = case
		when length(`encrypted_client_secret`) between 1 and 8192 then 'client_secret_basic'
		else 'none'
	end,
	`encrypted_client_secret` = case
		when length(`encrypted_client_secret`) between 1 and 8192 then `encrypted_client_secret`
		else null
	end,
	`enabled` = 0,
	`discovery_state` = 'unchecked',
	`discovery_capabilities_json` = '{}',
	`discovery_checked_at` = null,
	`approved_endpoint_origins_json` = '[]';--> statement-breakpoint
CREATE TRIGGER `oidc_providers_client_secret_insert_check`
BEFORE INSERT ON `oidc_providers`
WHEN NEW.`token_endpoint_auth_method` in ('client_secret_basic', 'client_secret_post', 'none')
	and NOT (
	(
		NEW.`token_endpoint_auth_method` = 'none'
		and NEW.`encrypted_client_secret` is null
	) or (
		NEW.`token_endpoint_auth_method` in ('client_secret_basic', 'client_secret_post')
		and NEW.`encrypted_client_secret` is not null
		and length(NEW.`encrypted_client_secret`) between 1 and 8192
	)
)
BEGIN
	SELECT RAISE(ABORT, 'oidc_providers_client_secret_check');
END;--> statement-breakpoint
CREATE TRIGGER `oidc_providers_client_secret_update_check`
BEFORE UPDATE OF `token_endpoint_auth_method`, `encrypted_client_secret` ON `oidc_providers`
WHEN NEW.`token_endpoint_auth_method` in ('client_secret_basic', 'client_secret_post', 'none')
	and NOT (
	(
		NEW.`token_endpoint_auth_method` = 'none'
		and NEW.`encrypted_client_secret` is null
	) or (
		NEW.`token_endpoint_auth_method` in ('client_secret_basic', 'client_secret_post')
		and NEW.`encrypted_client_secret` is not null
		and length(NEW.`encrypted_client_secret`) between 1 and 8192
	)
)
BEGIN
	SELECT RAISE(ABORT, 'oidc_providers_client_secret_check');
END;--> statement-breakpoint
UPDATE `sessions`
SET `encrypted_id_token_hint` = null
WHERE `encrypted_id_token_hint` is not null
	and length(`encrypted_id_token_hint`) not between 1 and 32768;--> statement-breakpoint
CREATE TRIGGER `sessions_id_token_hint_insert_check`
BEFORE INSERT ON `sessions`
WHEN NEW.`encrypted_id_token_hint` is not null
	and length(NEW.`encrypted_id_token_hint`) not between 1 and 32768
BEGIN
	SELECT RAISE(ABORT, 'sessions_id_token_hint_check');
END;--> statement-breakpoint
CREATE TRIGGER `sessions_id_token_hint_update_check`
BEFORE UPDATE OF `encrypted_id_token_hint` ON `sessions`
WHEN NEW.`encrypted_id_token_hint` is not null
	and length(NEW.`encrypted_id_token_hint`) not between 1 and 32768
BEGIN
	SELECT RAISE(ABORT, 'sessions_id_token_hint_check');
END;--> statement-breakpoint
CREATE TABLE `oidc_logout_receipts` (
	`provider_id` text NOT NULL,
	`jti_hash` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`received_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `oidc_providers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "oidc_logout_receipts_jti_hash_check" CHECK(length("oidc_logout_receipts"."jti_hash") = 43 and "oidc_logout_receipts"."jti_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "oidc_logout_receipts_timestamp_order_check" CHECK("oidc_logout_receipts"."issued_at" >= 0
		and "oidc_logout_receipts"."received_at" >= 0
		and "oidc_logout_receipts"."issued_at" >= "oidc_logout_receipts"."received_at" - 300000
		and "oidc_logout_receipts"."issued_at" <= "oidc_logout_receipts"."received_at" + 300000
		and "oidc_logout_receipts"."received_at" < "oidc_logout_receipts"."expires_at")
);--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_logout_receipts_provider_jti_unique` ON `oidc_logout_receipts` (`provider_id`,`jti_hash`);--> statement-breakpoint
CREATE INDEX `oidc_logout_receipts_expiry_idx` ON `oidc_logout_receipts` (`expires_at`);
