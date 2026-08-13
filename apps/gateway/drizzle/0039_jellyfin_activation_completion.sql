ALTER TABLE `invitations` ADD `activation_operation_id` text;
--> statement-breakpoint
ALTER TABLE `jellyfin_activation_operations` ADD `invitation_claimed_at` integer;
--> statement-breakpoint
ALTER TABLE `jellyfin_activation_operations` ADD `pending_oidc_session_id` text;
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
CREATE TRIGGER `invitations_activation_marker_guard`
BEFORE UPDATE OF activation_operation_id ON `invitations`
WHEN (OLD.activation_operation_id IS NOT NULL
  AND NEW.activation_operation_id IS NOT OLD.activation_operation_id)
  OR (OLD.activation_operation_id IS NULL AND NEW.activation_operation_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM jellyfin_activation_operations operation
      WHERE operation.id IS NEW.activation_operation_id
        AND operation.invitation_id IS NEW.id
        AND operation.invitation_claimed_at IS NOT NULL
        AND NEW.consumed_at IS NOT NULL
        AND operation.invitation_claimed_at IS NEW.consumed_at
        AND operation.pending_oidc_session_id IS NOT NULL
        AND NEW.revoked_at IS NULL
        AND operation.invitation_claimed_at < NEW.expires_at
        AND NEW.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)))
BEGIN SELECT RAISE(ABORT, 'invitation activation marker is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `invitations_consumption_binding_guard`
BEFORE UPDATE OF consumed_at ON `invitations`
WHEN OLD.activation_operation_id IS NOT NULL
  AND NEW.consumed_at IS NOT OLD.consumed_at
BEGIN SELECT RAISE(ABORT, 'claimed invitation consumption is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `invitations_revocation_binding_guard`
BEFORE UPDATE OF revoked_at ON `invitations`
WHEN OLD.activation_operation_id IS NOT NULL
  AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'claimed invitation cannot be revoked'); END;
--> statement-breakpoint
CREATE TRIGGER `jellyfin_activation_operations_claim_binding_guard`
BEFORE UPDATE OF invitation_id, invitation_claimed_at, pending_oidc_session_id
ON `jellyfin_activation_operations`
WHEN NEW.invitation_id IS NOT OLD.invitation_id
  OR NEW.invitation_claimed_at IS NOT OLD.invitation_claimed_at
  OR NEW.pending_oidc_session_id IS NOT OLD.pending_oidc_session_id
BEGIN SELECT RAISE(ABORT, 'activation claim binding is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `jellyfin_activation_operations_id_guard`
BEFORE UPDATE OF id ON `jellyfin_activation_operations`
WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT, CASE WHEN EXISTS (SELECT 1 FROM jellyfin_activation_cleanup_reservations WHERE operation_id IS OLD.id) THEN 'activation cleanup binding is immutable' ELSE 'activation marker binding mismatch' END); END;
--> statement-breakpoint
CREATE TRIGGER `jellyfin_activation_operations_marker_delete_guard`
BEFORE DELETE ON `jellyfin_activation_operations`
WHEN EXISTS (SELECT 1 FROM invitations WHERE activation_operation_id IS OLD.id)
BEGIN SELECT RAISE(ABORT, 'claimed activation operation cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER `jellyfin_activation_operations_completion_guard`
BEFORE UPDATE OF state, activation_status, activation_completed_link_id ON `jellyfin_activation_operations`
WHEN NEW.activation_status IS 'completed' AND NOT (NEW.state IS 'tombstoned'
  AND NEW.activation_completed_link_id IS NOT NULL AND EXISTS (SELECT 1 FROM service_identity_links link
    WHERE link.id IS NEW.activation_completed_link_id AND link.user_id IS NEW.user_id
      AND link.connector_id IS NEW.connector_id AND link.service IS 'jellyfin'
      AND link.provisioned_by_activation_id IS NEW.id))
BEGIN SELECT RAISE(ABORT, 'activation completion marker mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER `jellyfin_activation_operations_completion_restore_guard`
BEFORE UPDATE OF state, activation_status, activation_completed_link_id ON `jellyfin_activation_operations`
WHEN OLD.activation_status IS 'completed' AND (NEW.activation_status IS NOT 'completed'
  OR NEW.state IS NOT 'tombstoned' OR NEW.activation_completed_link_id IS NOT OLD.activation_completed_link_id)
BEGIN SELECT RAISE(ABORT, 'completed activation cannot be resurrected'); END;
