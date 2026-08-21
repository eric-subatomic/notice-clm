CREATE TABLE `clause_playbook_creation_receipts` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key_sha256` text NOT NULL,
	`request_sha256` text NOT NULL,
	`playbook_id` text NOT NULL,
	`playbook_version_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`, `idempotency_key_sha256`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`playbook_id`) REFERENCES `clause_playbooks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`playbook_version_id`) REFERENCES `clause_playbook_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_clause_playbook_creation_receipts_key_digest" CHECK(length("clause_playbook_creation_receipts"."idempotency_key_sha256") = 64 and lower("clause_playbook_creation_receipts"."idempotency_key_sha256") not glob '*[^0-9a-f]*'),
	CONSTRAINT "ck_clause_playbook_creation_receipts_request_digest" CHECK(length("clause_playbook_creation_receipts"."request_sha256") = 64 and lower("clause_playbook_creation_receipts"."request_sha256") not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_clause_playbook_creation_receipts_workspace_playbook` ON `clause_playbook_creation_receipts` (`workspace_id`,`playbook_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_clause_playbook_creation_receipts_workspace_version` ON `clause_playbook_creation_receipts` (`workspace_id`,`playbook_version_id`);--> statement-breakpoint
CREATE INDEX `idx_clause_playbook_creation_receipts_workspace_created` ON `clause_playbook_creation_receipts` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `governed_template_creation_receipts` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key_sha256` text NOT NULL,
	`request_sha256` text NOT NULL,
	`template_id` text NOT NULL,
	`template_version_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`, `idempotency_key_sha256`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `governed_templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_version_id`) REFERENCES `governed_template_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_governed_template_creation_receipts_key_digest" CHECK(length("governed_template_creation_receipts"."idempotency_key_sha256") = 64 and lower("governed_template_creation_receipts"."idempotency_key_sha256") not glob '*[^0-9a-f]*'),
	CONSTRAINT "ck_governed_template_creation_receipts_request_digest" CHECK(length("governed_template_creation_receipts"."request_sha256") = 64 and lower("governed_template_creation_receipts"."request_sha256") not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_governed_template_creation_receipts_workspace_template` ON `governed_template_creation_receipts` (`workspace_id`,`template_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_governed_template_creation_receipts_workspace_version` ON `governed_template_creation_receipts` (`workspace_id`,`template_version_id`);--> statement-breakpoint
CREATE INDEX `idx_governed_template_creation_receipts_workspace_created` ON `governed_template_creation_receipts` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TRIGGER `validate_governed_template_creation_receipt_insert_v20`
BEFORE INSERT ON `governed_template_creation_receipts`
WHEN NOT EXISTS (
	SELECT 1 FROM `governed_templates` AS `initial_template`
	JOIN `governed_template_versions` AS `initial_version`
		ON `initial_version`.`workspace_id` = `initial_template`.`workspace_id`
		AND `initial_version`.`template_id` = `initial_template`.`id`
	WHERE `initial_template`.`workspace_id` = NEW.`workspace_id`
		AND `initial_template`.`id` = NEW.`template_id`
		AND `initial_template`.`created_by_user_id` = NEW.`user_id`
		AND `initial_version`.`id` = NEW.`template_version_id`
		AND `initial_version`.`version` = 1
		AND `initial_version`.`created_by_user_id` = NEW.`user_id`
)
BEGIN SELECT RAISE(ABORT, 'invalid_governed_template_creation_receipt'); END;--> statement-breakpoint
CREATE TRIGGER `immutable_governed_template_creation_receipt_v20`
BEFORE UPDATE ON `governed_template_creation_receipts`
BEGIN SELECT RAISE(ABORT, 'immutable_governed_template_creation_receipt'); END;--> statement-breakpoint
CREATE TRIGGER `validate_clause_playbook_creation_receipt_insert_v20`
BEFORE INSERT ON `clause_playbook_creation_receipts`
WHEN NOT EXISTS (
	SELECT 1 FROM `clause_playbooks` AS `initial_playbook`
	JOIN `clause_playbook_versions` AS `initial_version`
		ON `initial_version`.`workspace_id` = `initial_playbook`.`workspace_id`
		AND `initial_version`.`playbook_id` = `initial_playbook`.`id`
	WHERE `initial_playbook`.`workspace_id` = NEW.`workspace_id`
		AND `initial_playbook`.`id` = NEW.`playbook_id`
		AND `initial_playbook`.`created_by_user_id` = NEW.`user_id`
		AND `initial_version`.`id` = NEW.`playbook_version_id`
		AND `initial_version`.`version` = 1
		AND `initial_version`.`created_by_user_id` = NEW.`user_id`
)
BEGIN SELECT RAISE(ABORT, 'invalid_clause_playbook_creation_receipt'); END;--> statement-breakpoint
CREATE TRIGGER `immutable_clause_playbook_creation_receipt_v20`
BEFORE UPDATE ON `clause_playbook_creation_receipts`
BEGIN SELECT RAISE(ABORT, 'immutable_clause_playbook_creation_receipt'); END;--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 20, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary' AND `version` = 19;
