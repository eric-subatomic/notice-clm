CREATE TABLE `crm_legacy_cleanup_attestations` (
	`workspace_id` text NOT NULL,
	`agreement_id` integer NOT NULL,
	`event_id` text NOT NULL,
	`event_payload_sha256` text NOT NULL,
	`provider_selection` text NOT NULL,
	`reason` text NOT NULL,
	`attested_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `event_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_crm_legacy_cleanup_provider" CHECK("crm_legacy_cleanup_attestations"."provider_selection" in ('Salesforce', 'HubSpot', 'Custom CRM')),
	CONSTRAINT "ck_crm_legacy_cleanup_digest" CHECK(length("crm_legacy_cleanup_attestations"."event_payload_sha256") = 64)
);
--> statement-breakpoint
CREATE INDEX `idx_crm_legacy_cleanup_workspace_agreement` ON `crm_legacy_cleanup_attestations` (`workspace_id`,`agreement_id`);
--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 13, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary';
