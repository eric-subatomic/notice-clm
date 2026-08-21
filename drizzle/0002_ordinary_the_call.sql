CREATE TABLE `agreement_events` (
	`id` text PRIMARY KEY NOT NULL,
	`agreement_id` integer NOT NULL,
	`type` text NOT NULL,
	`actor` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agreement_events_agreement_id_created_at` ON `agreement_events` (`agreement_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`agreement_id` integer NOT NULL,
	`role` text NOT NULL,
	`approver` text NOT NULL,
	`status` text NOT NULL,
	`due` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_approval_requests_status` ON `approval_requests` (`status`);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_agreement_id` ON `approval_requests` (`agreement_id`);--> statement-breakpoint
CREATE TABLE `obligations` (
	`id` text PRIMARY KEY NOT NULL,
	`agreement_id` integer NOT NULL,
	`title` text NOT NULL,
	`due_date` text NOT NULL,
	`owner` text NOT NULL,
	`status` text NOT NULL,
	`cadence` text NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_obligations_status_due_date` ON `obligations` (`status`,`due_date`);--> statement-breakpoint
CREATE INDEX `idx_obligations_agreement_id` ON `obligations` (`agreement_id`);--> statement-breakpoint
ALTER TABLE `agreements` ADD `department` text DEFAULT 'Legal' NOT NULL;--> statement-breakpoint
ALTER TABLE `agreements` ADD `risk` text DEFAULT 'Low' NOT NULL;--> statement-breakpoint
ALTER TABLE `agreements` ADD `approval_status` text DEFAULT 'Not required' NOT NULL;--> statement-breakpoint
ALTER TABLE `agreements` ADD `signature_status` text DEFAULT 'Not sent' NOT NULL;--> statement-breakpoint
ALTER TABLE `agreements` ADD `effective_date` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `agreements` ADD `expiration_date` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_agreements_stage` ON `agreements` (`stage`);--> statement-breakpoint
CREATE INDEX `idx_agreements_side` ON `agreements` (`side`);--> statement-breakpoint
CREATE INDEX `idx_agreements_owner` ON `agreements` (`owner`);--> statement-breakpoint
ALTER TABLE `documents` ADD `extraction_mode` text DEFAULT 'Metadata classification' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_documents_agreement_id` ON `documents` (`agreement_id`);