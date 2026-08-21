ALTER TABLE `approval_requests` ADD `requested_by_user_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 8, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary';
