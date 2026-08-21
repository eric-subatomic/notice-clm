CREATE TABLE `agreement_parties` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agreement_id` integer NOT NULL,
	`role` text NOT NULL,
	`legal_entity_id` text,
	`counterparty_id` text,
	`primary` integer DEFAULT false NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agreement_id`) REFERENCES `agreements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`legal_entity_id`) REFERENCES `legal_entities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`counterparty_id`) REFERENCES `counterparties`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_agreement_parties_role" CHECK("agreement_parties"."role" in ('our_entity', 'counterparty', 'guarantor', 'affiliate', 'other')),
	CONSTRAINT "ck_agreement_parties_exact_target" CHECK(("agreement_parties"."legal_entity_id" is null) <> ("agreement_parties"."counterparty_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agreement_parties_workspace_agreement_role_target` ON `agreement_parties` (`workspace_id`,`agreement_id`,`role`,`legal_entity_id`,`counterparty_id`);--> statement-breakpoint
CREATE INDEX `idx_agreement_parties_workspace_agreement` ON `agreement_parties` (`workspace_id`,`agreement_id`);--> statement-breakpoint
CREATE INDEX `idx_agreement_parties_workspace_counterparty` ON `agreement_parties` (`workspace_id`,`counterparty_id`);--> statement-breakpoint
CREATE INDEX `idx_agreement_parties_workspace_entity` ON `agreement_parties` (`workspace_id`,`legal_entity_id`);--> statement-breakpoint
CREATE TABLE `agreement_relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_agreement_id` integer NOT NULL,
	`target_agreement_id` integer NOT NULL,
	`relationship_type` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_agreement_id`) REFERENCES `agreements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_agreement_id`) REFERENCES `agreements`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_agreement_relationships_type" CHECK("agreement_relationships"."relationship_type" in ('master', 'amends', 'order_under', 'dpa_for', 'renews', 'supersedes', 'related')),
	CONSTRAINT "ck_agreement_relationships_distinct" CHECK("agreement_relationships"."source_agreement_id" <> "agreement_relationships"."target_agreement_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agreement_relationships_workspace_source_target_type` ON `agreement_relationships` (`workspace_id`,`source_agreement_id`,`target_agreement_id`,`relationship_type`);--> statement-breakpoint
CREATE INDEX `idx_agreement_relationships_workspace_source` ON `agreement_relationships` (`workspace_id`,`source_agreement_id`);--> statement-breakpoint
CREATE INDEX `idx_agreement_relationships_workspace_target` ON `agreement_relationships` (`workspace_id`,`target_agreement_id`);--> statement-breakpoint
CREATE TABLE `approval_lane_authorities` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`lane` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`currency_code` text DEFAULT 'USD' NOT NULL,
	`amount_limit_minor` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`reason` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_approval_lane_authorities_subject" CHECK("approval_lane_authorities"."subject_type" in ('user', 'group')),
	CONSTRAINT "ck_approval_lane_authorities_currency" CHECK(length("approval_lane_authorities"."currency_code") = 3 and "approval_lane_authorities"."currency_code" = upper("approval_lane_authorities"."currency_code")),
	CONSTRAINT "ck_approval_lane_authorities_limit" CHECK("approval_lane_authorities"."amount_limit_minor" is null or "approval_lane_authorities"."amount_limit_minor" >= 0),
	CONSTRAINT "ck_approval_lane_authorities_status" CHECK("approval_lane_authorities"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_approval_lane_authorities_workspace_lane_subject_currency` ON `approval_lane_authorities` (`workspace_id`,`lane`,`subject_type`,`subject_id`,`currency_code`);--> statement-breakpoint
CREATE INDEX `idx_approval_lane_authorities_workspace_lane_status` ON `approval_lane_authorities` (`workspace_id`,`lane`,`status`);--> statement-breakpoint
CREATE TABLE `counterparties` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`legal_name` text NOT NULL,
	`display_name` text NOT NULL,
	`domain` text DEFAULT '' NOT NULL,
	`jurisdiction` text DEFAULT '' NOT NULL,
	`registration_number` text DEFAULT '' NOT NULL,
	`external_id` text DEFAULT '' NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_counterparties_status" CHECK("counterparties"."status" in ('active', 'inactive', 'blocked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_counterparties_workspace_dedupe` ON `counterparties` (`workspace_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_counterparties_workspace_status_name` ON `counterparties` (`workspace_id`,`status`,`display_name`);--> statement-breakpoint
CREATE INDEX `idx_counterparties_workspace_external` ON `counterparties` (`workspace_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `custom_field_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`resource_type` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`data_type` text NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_custom_field_definitions_resource" CHECK("custom_field_definitions"."resource_type" in ('agreement', 'counterparty', 'legal_entity')),
	CONSTRAINT "ck_custom_field_definitions_type" CHECK("custom_field_definitions"."data_type" in ('text', 'number', 'date', 'boolean', 'single_select', 'multi_select')),
	CONSTRAINT "ck_custom_field_definitions_status" CHECK("custom_field_definitions"."status" in ('active', 'retired')),
	CONSTRAINT "ck_custom_field_definitions_options" CHECK(json_valid("custom_field_definitions"."options") = 1 and json_type("custom_field_definitions"."options") = 'array' and length("custom_field_definitions"."options") between 2 and 8192)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_custom_field_definitions_workspace_resource_key` ON `custom_field_definitions` (`workspace_id`,`resource_type`,`key`);--> statement-breakpoint
CREATE INDEX `idx_custom_field_definitions_workspace_status` ON `custom_field_definitions` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `custom_field_values` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`definition_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`definition_id`) REFERENCES `custom_field_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_custom_field_values_resource" CHECK("custom_field_values"."resource_type" in ('agreement', 'counterparty', 'legal_entity')),
	CONSTRAINT "ck_custom_field_values_json" CHECK(json_valid("custom_field_values"."value_json") = 1 and length("custom_field_values"."value_json") between 1 and 32768)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_custom_field_values_workspace_definition_resource` ON `custom_field_values` (`workspace_id`,`definition_id`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `idx_custom_field_values_workspace_resource` ON `custom_field_values` (`workspace_id`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE TABLE `governed_template_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`template_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`body` text NOT NULL,
	`variable_schema` text NOT NULL,
	`language_block_ids` text DEFAULT '[]' NOT NULL,
	`content_sha256` text NOT NULL,
	`change_summary` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`reviewed_by_user_id` text,
	`reviewed_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `governed_templates`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_governed_template_versions_status" CHECK("governed_template_versions"."status" in ('draft', 'published', 'retired')),
	CONSTRAINT "ck_governed_template_versions_schema" CHECK(json_valid("governed_template_versions"."variable_schema") = 1 and json_type("governed_template_versions"."variable_schema") = 'object' and length("governed_template_versions"."variable_schema") between 2 and 65536),
	CONSTRAINT "ck_governed_template_versions_blocks" CHECK(json_valid("governed_template_versions"."language_block_ids") = 1 and json_type("governed_template_versions"."language_block_ids") = 'array' and length("governed_template_versions"."language_block_ids") between 2 and 65536),
	CONSTRAINT "ck_governed_template_versions_digest" CHECK(length("governed_template_versions"."content_sha256") = 64 and lower("governed_template_versions"."content_sha256") not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_governed_template_versions_workspace_template_version` ON `governed_template_versions` (`workspace_id`,`template_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_governed_template_versions_workspace_status` ON `governed_template_versions` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `governed_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`agreement_type` text NOT NULL,
	`side` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_published_version` integer,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_governed_templates_side" CHECK("governed_templates"."side" in ('Sell-side', 'Buy-side', 'Corporate')),
	CONSTRAINT "ck_governed_templates_status" CHECK("governed_templates"."status" in ('draft', 'published', 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_governed_templates_workspace_name` ON `governed_templates` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_governed_templates_workspace_status` ON `governed_templates` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `intake_forms` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`form_schema` text NOT NULL,
	`template_id` text,
	`workflow_definition_id` text,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_intake_forms_status" CHECK("intake_forms"."status" in ('draft', 'published', 'retired')),
	CONSTRAINT "ck_intake_forms_schema" CHECK(json_valid("intake_forms"."form_schema") = 1 and json_type("intake_forms"."form_schema") = 'object' and length("intake_forms"."form_schema") between 2 and 65536)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_intake_forms_workspace_name` ON `intake_forms` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_intake_forms_workspace_status` ON `intake_forms` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `intake_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`form_id` text NOT NULL,
	`form_version` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`answers` text NOT NULL,
	`submitted_by_user_id` text NOT NULL,
	`agreement_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`submitted_at` text,
	`converted_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`form_id`) REFERENCES `intake_forms`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_intake_submissions_status" CHECK("intake_submissions"."status" in ('draft', 'submitted', 'converted', 'rejected')),
	CONSTRAINT "ck_intake_submissions_answers" CHECK(json_valid("intake_submissions"."answers") = 1 and json_type("intake_submissions"."answers") = 'object' and length("intake_submissions"."answers") between 2 and 131072)
);
--> statement-breakpoint
CREATE INDEX `idx_intake_submissions_workspace_status_updated` ON `intake_submissions` (`workspace_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_intake_submissions_workspace_form` ON `intake_submissions` (`workspace_id`,`form_id`);--> statement-breakpoint
CREATE TABLE `legal_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`legal_name` text NOT NULL,
	`display_name` text NOT NULL,
	`entity_type` text DEFAULT 'company' NOT NULL,
	`jurisdiction` text DEFAULT '' NOT NULL,
	`registration_number` text DEFAULT '' NOT NULL,
	`default_currency_code` text DEFAULT 'USD' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_legal_entities_status" CHECK("legal_entities"."status" in ('active', 'inactive')),
	CONSTRAINT "ck_legal_entities_currency" CHECK(length("legal_entities"."default_currency_code") = 3 and "legal_entities"."default_currency_code" = upper("legal_entities"."default_currency_code"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_legal_entities_workspace_name` ON `legal_entities` (`workspace_id`,`legal_name`);--> statement-breakpoint
CREATE INDEX `idx_legal_entities_workspace_status` ON `legal_entities` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`owner_user_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`name` text NOT NULL,
	`filter` text NOT NULL,
	`sort` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_saved_views_filter" CHECK(json_valid("saved_views"."filter") = 1 and json_type("saved_views"."filter") = 'object' and length("saved_views"."filter") between 2 and 16384),
	CONSTRAINT "ck_saved_views_sort" CHECK(json_valid("saved_views"."sort") = 1 and json_type("saved_views"."sort") = 'object' and length("saved_views"."sort") between 2 and 4096)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_saved_views_workspace_owner_resource_name` ON `saved_views` (`workspace_id`,`owner_user_id`,`resource_type`,`name`);--> statement-breakpoint
CREATE INDEX `idx_saved_views_workspace_resource_shared` ON `saved_views` (`workspace_id`,`resource_type`,`shared`);--> statement-breakpoint
CREATE TABLE `workflow_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`definition` text NOT NULL,
	`definition_sha256` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`updated_at` text NOT NULL,
	`published_by_user_id` text,
	`published_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_workflow_definitions_status" CHECK("workflow_definitions"."status" in ('draft', 'published', 'retired')),
	CONSTRAINT "ck_workflow_definitions_json" CHECK(json_valid("workflow_definitions"."definition") = 1 and json_type("workflow_definitions"."definition") = 'object' and length("workflow_definitions"."definition") between 2 and 65536),
	CONSTRAINT "ck_workflow_definitions_digest" CHECK(length("workflow_definitions"."definition_sha256") = 64 and lower("workflow_definitions"."definition_sha256") not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workflow_definitions_workspace_name_version` ON `workflow_definitions` (`workspace_id`,`name`,`version`);--> statement-breakpoint
CREATE INDEX `idx_workflow_definitions_workspace_name` ON `workflow_definitions` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_workflow_definitions_workspace_status` ON `workflow_definitions` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `workspace_group_members` (
	`workspace_id` text NOT NULL,
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `group_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `workspace_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_workspace_group_members_source" CHECK("workspace_group_members"."source" in ('manual', 'scim'))
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_group_members_workspace_user` ON `workspace_group_members` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `workspace_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`external_provider` text,
	`external_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_workspace_groups_status" CHECK("workspace_groups"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workspace_groups_workspace_name` ON `workspace_groups` (`workspace_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workspace_groups_workspace_external` ON `workspace_groups` (`workspace_id`,`external_provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_workspace_groups_workspace_status` ON `workspace_groups` (`workspace_id`,`status`);--> statement-breakpoint
ALTER TABLE `agreements` ADD `value_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agreements` ADD `currency_code` text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE `agreements` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `agreements` ADD `primary_counterparty_id` text;--> statement-breakpoint
ALTER TABLE `agreements` ADD `legal_entity_id` text;--> statement-breakpoint
ALTER TABLE `agreements` ADD `governed_template_version_id` text;--> statement-breakpoint
ALTER TABLE `agreements` ADD `workflow_definition_id` text;--> statement-breakpoint
UPDATE `agreements`
SET `value_minor` = CASE
	WHEN `value` > 90000000000000 THEN 9000000000000000
	ELSE `value` * 100
END,
	`currency_code` = 'USD';--> statement-breakpoint
UPDATE `approval_requests`
SET `status` = 'Superseded', `version` = `version` + 1
WHERE `status` IN ('Pending', 'Approved', 'Changes requested')
	AND EXISTS (
		SELECT 1 FROM `agreements`
		WHERE `agreements`.`workspace_id` = `approval_requests`.`workspace_id`
			AND `agreements`.`id` = `approval_requests`.`agreement_id`
			AND `agreements`.`stage` <> 'Active'
			AND `agreements`.`signature_status` <> 'Completed'
	);--> statement-breakpoint
UPDATE `signature_packets`
SET `status` = 'superseded', `active_key` = NULL,
	`updated_at` = CURRENT_TIMESTAMP, `version` = `version` + 1
WHERE `status` IN ('creating', 'pending', 'partially_signed', 'reconciling', 'archived', 'completed_review_required')
	AND EXISTS (
		SELECT 1 FROM `agreements`
		WHERE `agreements`.`workspace_id` = `signature_packets`.`workspace_id`
			AND `agreements`.`id` = `signature_packets`.`agreement_id`
			AND `agreements`.`stage` <> 'Active'
			AND `agreements`.`signature_status` <> 'Completed'
	);--> statement-breakpoint
UPDATE `agreements`
SET `risk` = 'Unassessed', `risk_disposition` = NULL,
	`risk_basis_hash` = NULL, `risk_document_version` = NULL,
	`risk_document_sha256` = NULL, `risk_decision_reason` = NULL,
	`risk_decided_by_user_id` = NULL, `risk_decided_at` = NULL,
	`approval_status` = 'Required', `signature_status` = 'Not sent',
	`stage` = CASE WHEN `stage` = 'Signature' THEN 'Review' ELSE `stage` END,
	`next_action` = 'Assess risk after the currency-aware basis upgrade',
	`version` = `version` + 1, `updated_at` = CURRENT_TIMESTAMP
WHERE `stage` <> 'Active' AND `signature_status` <> 'Completed';--> statement-breakpoint
CREATE INDEX `idx_agreements_workspace_owner_user` ON `agreements` (`workspace_id`,`owner_user_id`);--> statement-breakpoint
CREATE INDEX `idx_agreements_workspace_counterparty` ON `agreements` (`workspace_id`,`primary_counterparty_id`);--> statement-breakpoint
CREATE INDEX `idx_agreements_workspace_legal_entity` ON `agreements` (`workspace_id`,`legal_entity_id`);--> statement-breakpoint
CREATE INDEX `idx_agreements_workspace_live_currency_value` ON `agreements` (`workspace_id`,`deleted_at`,`currency_code`,`value_minor`,`id`);--> statement-breakpoint
CREATE TRIGGER `validate_agreement_enterprise_fields_insert_v18`
BEFORE INSERT ON `agreements`
WHEN NEW.`value_minor` < 0
	OR length(NEW.`currency_code`) <> 3
	OR NEW.`currency_code` <> upper(NEW.`currency_code`)
	OR (NEW.`owner_user_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `workspace_memberships` AS `owner_membership`
		JOIN `users` AS `owner_user` ON `owner_user`.`id` = `owner_membership`.`user_id`
		WHERE `owner_membership`.`workspace_id` = NEW.`workspace_id`
			AND `owner_membership`.`user_id` = NEW.`owner_user_id`
			AND `owner_membership`.`status` = 'active'
			AND `owner_user`.`status` = 'active'
	))
	OR (NEW.`primary_counterparty_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `counterparties` WHERE `workspace_id` = NEW.`workspace_id`
			AND `id` = NEW.`primary_counterparty_id` AND `status` = 'active'
	))
	OR (NEW.`legal_entity_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `legal_entities` WHERE `workspace_id` = NEW.`workspace_id`
			AND `id` = NEW.`legal_entity_id` AND `status` = 'active'
	))
	OR (NEW.`governed_template_version_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `governed_template_versions` AS `selected_version`
		JOIN `governed_templates` AS `selected_template`
			ON `selected_template`.`workspace_id` = `selected_version`.`workspace_id`
			AND `selected_template`.`id` = `selected_version`.`template_id`
		WHERE `selected_version`.`workspace_id` = NEW.`workspace_id`
			AND `selected_version`.`id` = NEW.`governed_template_version_id`
			AND `selected_version`.`status` = 'published'
			AND `selected_template`.`status` = 'published'
			AND `selected_template`.`current_published_version` = `selected_version`.`version`
	) AND NOT EXISTS (
		SELECT 1 FROM `intake_submissions` AS `converted_submission`
		JOIN `intake_forms` AS `pinned_form`
			ON `pinned_form`.`workspace_id` = `converted_submission`.`workspace_id`
			AND `pinned_form`.`id` = `converted_submission`.`form_id`
			AND `pinned_form`.`version` = `converted_submission`.`form_version`
		JOIN `governed_template_versions` AS `pinned_version`
			ON `pinned_version`.`workspace_id` = `pinned_form`.`workspace_id`
			AND `pinned_version`.`id` = `pinned_form`.`template_version_id`
		JOIN `governed_templates` AS `pinned_template`
			ON `pinned_template`.`workspace_id` = `pinned_version`.`workspace_id`
			AND `pinned_template`.`id` = `pinned_version`.`template_id`
		WHERE `converted_submission`.`workspace_id` = NEW.`workspace_id`
			AND `converted_submission`.`agreement_id` = NEW.`id`
			AND `converted_submission`.`status` = 'converted'
			AND `pinned_form`.`status` = 'published'
			AND `pinned_form`.`template_version_id` = NEW.`governed_template_version_id`
			AND `pinned_version`.`status` = 'published'
			AND `pinned_template`.`status` = 'published'
	))
	OR (NEW.`workflow_definition_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `workflow_definitions` WHERE `workspace_id` = NEW.`workspace_id`
			AND `id` = NEW.`workflow_definition_id` AND `status` = 'published'
	))
BEGIN SELECT RAISE(ABORT, 'invalid_agreement_enterprise_fields'); END;--> statement-breakpoint
CREATE TRIGGER `validate_agreement_enterprise_fields_update_v18`
BEFORE UPDATE OF `value_minor`, `currency_code`, `owner_user_id`, `primary_counterparty_id`, `legal_entity_id`, `governed_template_version_id`, `workflow_definition_id`, `workspace_id` ON `agreements`
WHEN NEW.`value_minor` < 0
	OR length(NEW.`currency_code`) <> 3
	OR NEW.`currency_code` <> upper(NEW.`currency_code`)
	OR ((NEW.`workspace_id` IS NOT OLD.`workspace_id` OR NEW.`owner_user_id` IS NOT OLD.`owner_user_id`)
		AND NEW.`owner_user_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `workspace_memberships` AS `owner_membership`
		JOIN `users` AS `owner_user` ON `owner_user`.`id` = `owner_membership`.`user_id`
		WHERE `owner_membership`.`workspace_id` = NEW.`workspace_id`
			AND `owner_membership`.`user_id` = NEW.`owner_user_id`
			AND `owner_membership`.`status` = 'active'
			AND `owner_user`.`status` = 'active'
	))
	OR ((NEW.`workspace_id` IS NOT OLD.`workspace_id` OR NEW.`primary_counterparty_id` IS NOT OLD.`primary_counterparty_id`)
		AND NEW.`primary_counterparty_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `counterparties` WHERE `workspace_id` = NEW.`workspace_id`
			AND `id` = NEW.`primary_counterparty_id` AND `status` = 'active'
	))
	OR ((NEW.`workspace_id` IS NOT OLD.`workspace_id` OR NEW.`legal_entity_id` IS NOT OLD.`legal_entity_id`)
		AND NEW.`legal_entity_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `legal_entities` WHERE `workspace_id` = NEW.`workspace_id`
			AND `id` = NEW.`legal_entity_id` AND `status` = 'active'
	))
	OR ((NEW.`workspace_id` IS NOT OLD.`workspace_id` OR NEW.`governed_template_version_id` IS NOT OLD.`governed_template_version_id`)
		AND NEW.`governed_template_version_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `governed_template_versions` AS `selected_version`
		JOIN `governed_templates` AS `selected_template`
			ON `selected_template`.`workspace_id` = `selected_version`.`workspace_id`
			AND `selected_template`.`id` = `selected_version`.`template_id`
		WHERE `selected_version`.`workspace_id` = NEW.`workspace_id`
			AND `selected_version`.`id` = NEW.`governed_template_version_id`
			AND `selected_version`.`status` = 'published'
			AND `selected_template`.`status` = 'published'
			AND `selected_template`.`current_published_version` = `selected_version`.`version`
	))
	OR ((NEW.`workspace_id` IS NOT OLD.`workspace_id` OR NEW.`workflow_definition_id` IS NOT OLD.`workflow_definition_id`)
		AND NEW.`workflow_definition_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `workflow_definitions` WHERE `workspace_id` = NEW.`workspace_id`
			AND `id` = NEW.`workflow_definition_id` AND `status` = 'published'
	))
BEGIN SELECT RAISE(ABORT, 'invalid_agreement_enterprise_fields'); END;--> statement-breakpoint
CREATE TRIGGER `validate_agreement_party_scope_insert_v18`
BEFORE INSERT ON `agreement_parties`
WHEN NOT EXISTS (
	SELECT 1 FROM `agreements` WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`agreement_id` AND `deleted_at` IS NULL
)
	OR (NEW.`legal_entity_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `legal_entities` WHERE `workspace_id` = NEW.`workspace_id`
			AND `id` = NEW.`legal_entity_id` AND `status` = 'active'
	))
	OR (NEW.`counterparty_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `counterparties` WHERE `workspace_id` = NEW.`workspace_id`
			AND `id` = NEW.`counterparty_id` AND `status` = 'active'
	))
BEGIN SELECT RAISE(ABORT, 'invalid_agreement_party_scope'); END;--> statement-breakpoint
CREATE TRIGGER `immutable_agreement_party_identity_v18`
BEFORE UPDATE OF `workspace_id`, `agreement_id`, `role`, `legal_entity_id`, `counterparty_id`, `created_by_user_id`, `created_at`
ON `agreement_parties`
BEGIN SELECT RAISE(ABORT, 'immutable_agreement_party_identity'); END;--> statement-breakpoint
CREATE TRIGGER `validate_agreement_relationship_scope_insert_v18`
BEFORE INSERT ON `agreement_relationships`
WHEN NOT EXISTS (
	SELECT 1 FROM `agreements` WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`source_agreement_id` AND `deleted_at` IS NULL
)
	OR NOT EXISTS (
	SELECT 1 FROM `agreements` WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`target_agreement_id` AND `deleted_at` IS NULL
)
BEGIN SELECT RAISE(ABORT, 'invalid_agreement_relationship_scope'); END;--> statement-breakpoint
CREATE TRIGGER `immutable_agreement_relationship_v18`
BEFORE UPDATE ON `agreement_relationships`
BEGIN SELECT RAISE(ABORT, 'immutable_agreement_relationship'); END;--> statement-breakpoint
CREATE TRIGGER `validate_workspace_group_member_scope_insert_v18`
BEFORE INSERT ON `workspace_group_members`
WHEN NOT EXISTS (
	SELECT 1 FROM `workspace_groups` WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`group_id` AND `status` = 'active'
)
	OR NOT EXISTS (
	SELECT 1 FROM `workspace_memberships` AS `group_membership`
	JOIN `users` AS `group_user` ON `group_user`.`id` = `group_membership`.`user_id`
	WHERE `group_membership`.`workspace_id` = NEW.`workspace_id`
		AND `group_membership`.`user_id` = NEW.`user_id`
		AND `group_membership`.`status` = 'active'
		AND `group_user`.`status` = 'active'
)
BEGIN SELECT RAISE(ABORT, 'invalid_workspace_group_member_scope'); END;--> statement-breakpoint
CREATE TRIGGER `validate_custom_field_value_insert_v18`
BEFORE INSERT ON `custom_field_values`
WHEN NOT EXISTS (
	SELECT 1 FROM `custom_field_definitions`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`definition_id`
		AND `resource_type` = NEW.`resource_type`
		AND `status` = 'active'
)
	OR NOT (
		(NEW.`resource_type` = 'agreement' AND EXISTS (
			SELECT 1 FROM `agreements` WHERE `workspace_id` = NEW.`workspace_id`
				AND CAST(`id` AS TEXT) = NEW.`resource_id` AND `deleted_at` IS NULL
		))
		OR (NEW.`resource_type` = 'counterparty' AND EXISTS (
			SELECT 1 FROM `counterparties` WHERE `workspace_id` = NEW.`workspace_id`
				AND `id` = NEW.`resource_id` AND `status` = 'active'
		))
		OR (NEW.`resource_type` = 'legal_entity' AND EXISTS (
			SELECT 1 FROM `legal_entities` WHERE `workspace_id` = NEW.`workspace_id`
				AND `id` = NEW.`resource_id` AND `status` = 'active'
		))
	)
BEGIN SELECT RAISE(ABORT, 'invalid_custom_field_value_scope'); END;--> statement-breakpoint
CREATE TRIGGER `validate_custom_field_value_update_v18`
BEFORE UPDATE ON `custom_field_values`
WHEN NOT EXISTS (
	SELECT 1 FROM `custom_field_definitions`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`definition_id`
		AND `resource_type` = NEW.`resource_type`
		AND `status` = 'active'
)
	OR NOT (
		(NEW.`resource_type` = 'agreement' AND EXISTS (
			SELECT 1 FROM `agreements` WHERE `workspace_id` = NEW.`workspace_id`
				AND CAST(`id` AS TEXT) = NEW.`resource_id` AND `deleted_at` IS NULL
		))
		OR (NEW.`resource_type` = 'counterparty' AND EXISTS (
			SELECT 1 FROM `counterparties` WHERE `workspace_id` = NEW.`workspace_id`
				AND `id` = NEW.`resource_id` AND `status` = 'active'
		))
		OR (NEW.`resource_type` = 'legal_entity' AND EXISTS (
			SELECT 1 FROM `legal_entities` WHERE `workspace_id` = NEW.`workspace_id`
				AND `id` = NEW.`resource_id` AND `status` = 'active'
		))
	)
BEGIN SELECT RAISE(ABORT, 'invalid_custom_field_value_scope'); END;--> statement-breakpoint
CREATE TRIGGER `immutable_custom_field_value_identity_v18`
BEFORE UPDATE OF `workspace_id`, `definition_id`, `resource_type`, `resource_id`
ON `custom_field_values`
BEGIN SELECT RAISE(ABORT, 'immutable_custom_field_value_identity'); END;--> statement-breakpoint
CREATE TRIGGER `validate_template_version_scope_insert_v18`
BEFORE INSERT ON `governed_template_versions`
WHEN NOT EXISTS (
	SELECT 1 FROM `governed_templates` WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`template_id` AND `status` <> 'retired'
)
BEGIN SELECT RAISE(ABORT, 'invalid_template_version_scope'); END;--> statement-breakpoint
CREATE TRIGGER `immutable_published_template_version_v18`
BEFORE UPDATE ON `governed_template_versions`
WHEN OLD.`status` IN ('published', 'retired')
BEGIN SELECT RAISE(ABORT, 'immutable_published_template_version'); END;--> statement-breakpoint
CREATE TRIGGER `immutable_published_workflow_definition_v18`
BEFORE UPDATE OF `name`, `description`, `definition`, `definition_sha256`, `created_by_user_id`, `created_at`
ON `workflow_definitions`
WHEN OLD.`status` IN ('published', 'retired')
BEGIN SELECT RAISE(ABORT, 'immutable_published_workflow_definition'); END;--> statement-breakpoint
CREATE TRIGGER `validate_approval_lane_authority_insert_v18`
BEFORE INSERT ON `approval_lane_authorities`
WHEN (NEW.`subject_type` = 'user' AND NOT EXISTS (
	SELECT 1 FROM `workspace_memberships` AS `authority_membership`
	JOIN `users` AS `authority_user` ON `authority_user`.`id` = `authority_membership`.`user_id`
	WHERE `authority_membership`.`workspace_id` = NEW.`workspace_id`
		AND `authority_membership`.`user_id` = NEW.`subject_id`
		AND `authority_membership`.`status` = 'active'
		AND `authority_user`.`status` = 'active'
)) OR (NEW.`subject_type` = 'group' AND NOT EXISTS (
	SELECT 1 FROM `workspace_groups` WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`subject_id` AND `status` = 'active'
))
BEGIN SELECT RAISE(ABORT, 'invalid_approval_lane_authority_subject'); END;--> statement-breakpoint
CREATE TRIGGER `immutable_approval_lane_authority_identity_v18`
BEFORE UPDATE OF `workspace_id`, `lane`, `subject_type`, `subject_id`
ON `approval_lane_authorities`
BEGIN SELECT RAISE(ABORT, 'immutable_approval_lane_authority_identity'); END;--> statement-breakpoint
CREATE TRIGGER `validate_intake_form_scope_insert_v18`
BEFORE INSERT ON `intake_forms`
WHEN (NEW.`template_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `governed_templates` WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`template_id` AND `status` <> 'retired'
)) OR (NEW.`workflow_definition_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `workflow_definitions` WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`workflow_definition_id` AND `status` = 'published'
))
BEGIN SELECT RAISE(ABORT, 'invalid_intake_form_scope'); END;--> statement-breakpoint
CREATE TRIGGER `validate_intake_form_scope_update_v18`
BEFORE UPDATE ON `intake_forms`
WHEN (NEW.`template_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `governed_templates` WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`template_id` AND `status` <> 'retired'
)) OR (NEW.`workflow_definition_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `workflow_definitions` WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`workflow_definition_id` AND `status` = 'published'
))
BEGIN SELECT RAISE(ABORT, 'invalid_intake_form_scope'); END;--> statement-breakpoint
CREATE TRIGGER `immutable_intake_form_workspace_v18`
BEFORE UPDATE OF `workspace_id` ON `intake_forms`
BEGIN SELECT RAISE(ABORT, 'immutable_intake_form_workspace'); END;--> statement-breakpoint
CREATE TRIGGER `validate_intake_submission_scope_insert_v18`
BEFORE INSERT ON `intake_submissions`
WHEN NOT EXISTS (
	SELECT 1 FROM `intake_forms` WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`form_id` AND `version` = NEW.`form_version` AND `status` = 'published'
)
	OR NOT EXISTS (
	SELECT 1 FROM `workspace_memberships` WHERE `workspace_id` = NEW.`workspace_id`
		AND `user_id` = NEW.`submitted_by_user_id` AND `status` = 'active'
)
BEGIN SELECT RAISE(ABORT, 'invalid_intake_submission_scope'); END;--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 18, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary' AND `version` = 17;
