CREATE TABLE `agreement_document_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agreement_id` integer NOT NULL,
	`version` integer NOT NULL,
	`label` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`source_document_id` text,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agreement_document_versions_workspace_agreement_version` ON `agreement_document_versions` (`workspace_id`,`agreement_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_agreement_document_versions_workspace_created_at` ON `agreement_document_versions` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agreement_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agreement_id` integer NOT NULL,
	`version` integer NOT NULL,
	`snapshot` text NOT NULL,
	`source_event_id` text,
	`checksum_sha256` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agreement_versions_workspace_agreement_version` ON `agreement_versions` (`workspace_id`,`agreement_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_agreement_versions_workspace_created_at` ON `agreement_versions` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`topic` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` text NOT NULL,
	`locked_at` text,
	`processed_at` text,
	`last_error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_outbox_events_status_available_at` ON `outbox_events` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `idx_outbox_events_workspace_created_at` ON `outbox_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `signature_packets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agreement_id` integer NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`submission_id` text,
	`status` text NOT NULL,
	`signers` text NOT NULL,
	`evidence_document_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_signature_packets_workspace_provider_external` ON `signature_packets` (`workspace_id`,`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_signature_packets_workspace_agreement` ON `signature_packets` (`workspace_id`,`agreement_id`);--> statement-breakpoint
CREATE INDEX `idx_signature_packets_workspace_status` ON `signature_packets` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_provider` text NOT NULL,
	`identity_subject` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_users_identity` ON `users` (`identity_provider`,`identity_subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `webhook_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_event_id` text,
	`payload_digest` text NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`received_at` text NOT NULL,
	`processed_at` text,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_webhook_receipts_workspace_provider_event` ON `webhook_receipts` (`workspace_id`,`provider`,`provider_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_webhook_receipts_workspace_provider_digest` ON `webhook_receipts` (`workspace_id`,`provider`,`payload_digest`);--> statement-breakpoint
CREATE INDEX `idx_webhook_receipts_workspace_received_at` ON `webhook_receipts` (`workspace_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `workspace_memberships` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_memberships_user_status` ON `workspace_memberships` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_workspace_memberships_workspace_role` ON `workspace_memberships` (`workspace_id`,`role`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workspaces_slug` ON `workspaces` (`slug`);--> statement-breakpoint
ALTER TABLE `agreement_events` ADD `workspace_id` text DEFAULT '__unassigned__' NOT NULL;--> statement-breakpoint
ALTER TABLE `agreement_events` ADD `actor_user_id` text;--> statement-breakpoint
ALTER TABLE `agreement_events` ADD `actor_email` text;--> statement-breakpoint
ALTER TABLE `agreement_events` ADD `previous_hash` text;--> statement-breakpoint
ALTER TABLE `agreement_events` ADD `event_hash` text;--> statement-breakpoint
ALTER TABLE `agreement_events` ADD `sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_agreement_events_workspace_agreement_created_at` ON `agreement_events` (`workspace_id`,`agreement_id`,`created_at`);--> statement-breakpoint
UPDATE `agreement_events` AS `target`
SET `sequence` = (
	SELECT count(*)
	FROM `agreement_events` AS `candidate`
	WHERE `candidate`.`workspace_id` = `target`.`workspace_id`
		AND `candidate`.`agreement_id` = `target`.`agreement_id`
		AND `candidate`.`rowid` <= `target`.`rowid`
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agreement_events_workspace_agreement_sequence` ON `agreement_events` (`workspace_id`,`agreement_id`,`sequence`);--> statement-breakpoint
ALTER TABLE `agreements` ADD `workspace_id` text DEFAULT '__unassigned__' NOT NULL;--> statement-breakpoint
ALTER TABLE `agreements` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `agreements` ADD `created_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `agreements` ADD `updated_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `agreements` ADD `created_by_user_id` text;--> statement-breakpoint
ALTER TABLE `agreements` ADD `updated_by_user_id` text;--> statement-breakpoint
ALTER TABLE `agreements` ADD `legal_hold` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agreements` ADD `retention_until` text;--> statement-breakpoint
ALTER TABLE `agreements` ADD `deleted_at` text;--> statement-breakpoint
CREATE INDEX `idx_agreements_workspace_stage` ON `agreements` (`workspace_id`,`stage`);--> statement-breakpoint
CREATE INDEX `idx_agreements_workspace_owner` ON `agreements` (`workspace_id`,`owner`);--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `workspace_id` text DEFAULT '__unassigned__' NOT NULL;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `approver_user_id` text;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `decided_by_user_id` text;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `decided_at` text;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `comment` text;--> statement-breakpoint
CREATE INDEX `idx_approval_requests_workspace_status` ON `approval_requests` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_workspace_agreement_id` ON `approval_requests` (`workspace_id`,`agreement_id`);--> statement-breakpoint
ALTER TABLE `documents` ADD `workspace_id` text DEFAULT '__unassigned__' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `sha256` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `scan_status` text DEFAULT 'unscanned' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `scan_provider` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `scanned_at` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `created_by_user_id` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `legal_hold` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `retention_until` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `deleted_at` text;--> statement-breakpoint
CREATE INDEX `idx_documents_workspace_agreement_id` ON `documents` (`workspace_id`,`agreement_id`);--> statement-breakpoint
CREATE INDEX `idx_documents_workspace_scan_status` ON `documents` (`workspace_id`,`scan_status`);--> statement-breakpoint
ALTER TABLE `language_blocks` ADD `workspace_id` text DEFAULT '__unassigned__' NOT NULL;--> statement-breakpoint
ALTER TABLE `language_blocks` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_language_blocks_workspace` ON `language_blocks` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `obligations` ADD `workspace_id` text DEFAULT '__unassigned__' NOT NULL;--> statement-breakpoint
ALTER TABLE `obligations` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `obligations` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `obligations` ADD `completed_by_user_id` text;--> statement-breakpoint
ALTER TABLE `obligations` ADD `completed_at` text;--> statement-breakpoint
ALTER TABLE `obligations` ADD `completion_evidence` text;--> statement-breakpoint
CREATE INDEX `idx_obligations_workspace_status_due_date` ON `obligations` (`workspace_id`,`status`,`due_date`);--> statement-breakpoint
CREATE INDEX `idx_obligations_workspace_agreement_id` ON `obligations` (`workspace_id`,`agreement_id`);
