CREATE TABLE `purge_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`object_keys` text NOT NULL,
	`status` text DEFAULT 'storage_pending' NOT NULL,
	`guard_changes` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_attempt_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT "ck_purge_jobs_guard_changes" CHECK("purge_jobs"."guard_changes" = 1),
	CONSTRAINT "ck_purge_jobs_status" CHECK("purge_jobs"."status" in ('storage_pending', 'completed')),
	CONSTRAINT "ck_purge_jobs_resource_type" CHECK("purge_jobs"."resource_type" in ('agreement', 'document'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purge_jobs_workspace_resource` ON `purge_jobs` (`workspace_id`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `idx_purge_jobs_workspace_status_created_at` ON `purge_jobs` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 7, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary';
