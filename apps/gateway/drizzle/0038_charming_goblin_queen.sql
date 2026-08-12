CREATE TABLE `jellyfin_activation_cleanup_reservations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`operation_revision` integer NOT NULL,
	`lease_owner` text NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`attempt_count` integer DEFAULT 1 NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `jellyfin_activation_operations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "jellyfin_activation_cleanup_reservations_attempt_check" CHECK("jellyfin_activation_cleanup_reservations"."attempt_count" between 1 and 8),
	CONSTRAINT "jellyfin_activation_cleanup_reservations_state_check" CHECK("jellyfin_activation_cleanup_reservations"."state" in ('dispatched', 'uncertain', 'confirmed'))
);
--> statement-breakpoint
CREATE INDEX `jellyfin_activation_cleanup_reservations_state_idx` ON `jellyfin_activation_cleanup_reservations` (`state`,`lease_expires_at`);
--> statement-breakpoint
CREATE TRIGGER `service_identity_links_activation_cleanup_insert_guard`
BEFORE INSERT ON `service_identity_links`
WHEN NEW.service = 'jellyfin' AND EXISTS (
  SELECT 1
  FROM jellyfin_activation_operations operation
  JOIN jellyfin_activation_cleanup_reservations cleanup ON cleanup.operation_id = operation.id
  WHERE cleanup.state = 'dispatched'
    AND operation.user_id = NEW.user_id
    AND operation.connector_id = NEW.connector_id
)
BEGIN SELECT RAISE(ABORT, 'activation cleanup is dispatched'); END;
--> statement-breakpoint
CREATE TRIGGER `jellyfin_activation_operations_cleanup_update_guard`
BEFORE UPDATE OF id, user_id, connector_id, connector_config_generation,
  connector_instance_generation, connector_instance_identity_hash, provisioning_revision
ON `jellyfin_activation_operations`
WHEN EXISTS (
  SELECT 1
  FROM jellyfin_activation_cleanup_reservations cleanup
  WHERE cleanup.operation_id = OLD.id
    AND cleanup.state = 'dispatched'
    AND (
      NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.connector_id <> OLD.connector_id
      OR NEW.connector_config_generation <> OLD.connector_config_generation
      OR NEW.connector_instance_generation <> OLD.connector_instance_generation
      OR coalesce(NEW.connector_instance_identity_hash, '') <> coalesce(OLD.connector_instance_identity_hash, '')
      OR NEW.provisioning_revision <> OLD.provisioning_revision
    )
)
BEGIN SELECT RAISE(ABORT, 'activation cleanup binding is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `service_identity_links_activation_cleanup_update_guard`
BEFORE UPDATE OF user_id, service, connector_id, provisioned_by_activation_id ON `service_identity_links`
WHEN NEW.service = 'jellyfin' AND EXISTS (
  SELECT 1
  FROM jellyfin_activation_operations operation
  JOIN jellyfin_activation_cleanup_reservations cleanup ON cleanup.operation_id = operation.id
  WHERE cleanup.state = 'dispatched'
    AND operation.user_id = NEW.user_id
    AND operation.connector_id = NEW.connector_id
)
BEGIN SELECT RAISE(ABORT, 'activation cleanup is dispatched'); END;
