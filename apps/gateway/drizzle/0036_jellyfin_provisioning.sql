CREATE TABLE `jellyfin_provisioning_configs` (
	`connector_id` text PRIMARY KEY NOT NULL,
	`connector_revision` text NOT NULL,
	`connector_instance_generation` integer NOT NULL,
	`connector_instance_identity_hash` text,
	`encrypted_configuration` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "jellyfin_provisioning_connector_revision_check" CHECK(length("jellyfin_provisioning_configs"."connector_revision") between 16 and 128 and "jellyfin_provisioning_configs"."connector_revision" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "jellyfin_provisioning_instance_generation_check" CHECK("jellyfin_provisioning_configs"."connector_instance_generation" between 0 and 9007199254740991),
	CONSTRAINT "jellyfin_provisioning_revision_check" CHECK("jellyfin_provisioning_configs"."revision" between 0 and 2147483647),
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON DELETE CASCADE
);
