CREATE TABLE `workspace_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`actor` text NOT NULL,
	`subject_user_id` text,
	`subject_email` text,
	`detail` text NOT NULL,
	`previous_hash` text,
	`event_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workspace_events_workspace_sequence` ON `workspace_events` (`workspace_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_workspace_events_workspace_created_at` ON `workspace_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TRIGGER `prevent_last_active_admin_update`
BEFORE UPDATE OF `role`, `status` ON `workspace_memberships`
WHEN OLD.`role` = 'admin' AND OLD.`status` = 'active'
  AND (NEW.`role` <> 'admin' OR NEW.`status` <> 'active')
  AND (SELECT COUNT(*) FROM `workspace_memberships`
    WHERE `workspace_id` = OLD.`workspace_id` AND `role` = 'admin' AND `status` = 'active') <= 1
BEGIN SELECT RAISE(ABORT, 'last_active_admin'); END;--> statement-breakpoint
CREATE TRIGGER `prevent_last_active_admin_delete`
BEFORE DELETE ON `workspace_memberships`
WHEN OLD.`role` = 'admin' AND OLD.`status` = 'active'
  AND (SELECT COUNT(*) FROM `workspace_memberships`
    WHERE `workspace_id` = OLD.`workspace_id` AND `role` = 'admin' AND `status` = 'active') <= 1
BEGIN SELECT RAISE(ABORT, 'last_active_admin'); END;
