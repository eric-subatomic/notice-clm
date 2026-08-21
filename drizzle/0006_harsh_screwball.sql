ALTER TABLE `approval_requests` ADD `basis_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `document_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `document_sha256` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `signature_packets` ADD `basis_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `signature_packets` ADD `document_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `signature_packets` ADD `document_sha256` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `signature_packets` ADD `active_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_signature_packets_workspace_active_key` ON `signature_packets` (`workspace_id`,`active_key`);--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 6, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary';
