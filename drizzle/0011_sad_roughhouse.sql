CREATE TABLE `integration_diagnostics` (
	`workspace_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`configuration_fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`tested_at` text NOT NULL,
	`detail` text NOT NULL,
	`tested_by_user_id` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `integration_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_integration_diagnostics_id" CHECK("integration_diagnostics"."integration_id" in ('docuseal', 'scanner', 'delivery', 'crm')),
	CONSTRAINT "ck_integration_diagnostics_status" CHECK("integration_diagnostics"."status" in ('passed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_integration_diagnostics_workspace_status` ON `integration_diagnostics` (`workspace_id`,`status`);--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 11, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary';
