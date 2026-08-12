ALTER TABLE `invitations` ADD `activation_operation_id` text;
--> statement-breakpoint
ALTER TABLE `jellyfin_activation_operations` ADD `activation_status` text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE `jellyfin_activation_operations` ADD `activation_completed_link_id` text;
--> statement-breakpoint
ALTER TABLE `jellyfin_activation_operations` ADD `completed_at` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_activation_operation_unique` ON `invitations` (`activation_operation_id`) WHERE `activation_operation_id` is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX `jellyfin_activation_operations_completed_link_unique` ON `jellyfin_activation_operations` (`activation_completed_link_id`) WHERE `activation_completed_link_id` is not null;
--> statement-breakpoint
CREATE TRIGGER `jellyfin_activation_operations_completion_guard`
BEFORE UPDATE OF state, activation_status, activation_completed_link_id ON `jellyfin_activation_operations`
WHEN NEW.activation_status = 'completed' AND NOT (
  NEW.state = 'tombstoned' AND NEW.activation_completed_link_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM service_identity_links link
    WHERE link.id = NEW.activation_completed_link_id AND link.user_id = NEW.user_id
      AND link.connector_id = NEW.connector_id AND link.service = 'jellyfin'
      AND link.provisioned_by_activation_id = NEW.id
  )
)
BEGIN SELECT RAISE(ABORT, 'activation completion marker mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER `jellyfin_activation_operations_completion_restore_guard`
BEFORE UPDATE OF state, activation_status, activation_completed_link_id ON `jellyfin_activation_operations`
WHEN OLD.activation_status = 'completed' AND (NEW.activation_status <> 'completed' OR NEW.state <> 'tombstoned')
BEGIN SELECT RAISE(ABORT, 'completed activation cannot be resurrected'); END;
--> statement-breakpoint
CREATE TRIGGER `invitations_activation_operation_binding_guard`
BEFORE UPDATE OF activation_operation_id ON `invitations`
WHEN NEW.activation_operation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM jellyfin_activation_operations operation
  WHERE operation.id = NEW.activation_operation_id AND operation.invitation_id = NEW.id
)
BEGIN SELECT RAISE(ABORT, 'invitation activation binding mismatch'); END;
