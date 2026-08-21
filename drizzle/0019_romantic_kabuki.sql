ALTER TABLE `agreements` ADD `workflow_policy_sha256` text;--> statement-breakpoint
ALTER TABLE `agreements` ADD `workflow_approval_lanes` text;--> statement-breakpoint
ALTER TABLE `intake_forms` ADD `template_version_id` text REFERENCES governed_template_versions(id) ON DELETE restrict;--> statement-breakpoint
CREATE INDEX `idx_agreements_workspace_workflow_policy` ON `agreements` (`workspace_id`,`workflow_definition_id`,`workflow_policy_sha256`);--> statement-breakpoint
CREATE INDEX `idx_intake_forms_workspace_template_version` ON `intake_forms` (`workspace_id`,`template_version_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agreement_parties_workspace_agreement_role_primary` ON `agreement_parties` (`workspace_id`,`agreement_id`,`role`) WHERE `primary` = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agreement_parties_legal_entity_identity`
ON `agreement_parties` (`workspace_id`,`agreement_id`,`role`,`legal_entity_id`)
WHERE `legal_entity_id` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agreement_parties_counterparty_identity`
ON `agreement_parties` (`workspace_id`,`agreement_id`,`role`,`counterparty_id`)
WHERE `counterparty_id` IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER `validate_agreement_party_scope_update_v19`
BEFORE UPDATE ON `agreement_parties`
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
CREATE TABLE `clause_playbook_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`playbook_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`rules` text NOT NULL,
	`content_sha256` text NOT NULL,
	`change_summary` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`published_by_user_id` text,
	`published_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`playbook_id`) REFERENCES `clause_playbooks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`published_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_clause_playbook_versions_version" CHECK("clause_playbook_versions"."version" > 0),
	CONSTRAINT "ck_clause_playbook_versions_status" CHECK("clause_playbook_versions"."status" in ('draft', 'published')),
	CONSTRAINT "ck_clause_playbook_versions_rules" CHECK(json_valid("clause_playbook_versions"."rules") = 1 and json_type("clause_playbook_versions"."rules") = 'object' and length("clause_playbook_versions"."rules") between 2 and 262144),
	CONSTRAINT "ck_clause_playbook_versions_digest" CHECK(length("clause_playbook_versions"."content_sha256") = 64 and lower("clause_playbook_versions"."content_sha256") not glob '*[^0-9a-f]*'),
	CONSTRAINT "ck_clause_playbook_versions_publisher" CHECK(("clause_playbook_versions"."status" = 'draft' and "clause_playbook_versions"."published_by_user_id" is null and "clause_playbook_versions"."published_at" is null) or ("clause_playbook_versions"."status" = 'published' and "clause_playbook_versions"."published_by_user_id" is not null and "clause_playbook_versions"."published_at" is not null and "clause_playbook_versions"."published_by_user_id" <> "clause_playbook_versions"."created_by_user_id"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_clause_playbook_versions_workspace_playbook_version` ON `clause_playbook_versions` (`workspace_id`,`playbook_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_clause_playbook_versions_workspace_playbook_status` ON `clause_playbook_versions` (`workspace_id`,`playbook_id`,`status`);--> statement-breakpoint
CREATE TABLE `clause_playbooks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`scope` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_published_version` integer,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_clause_playbooks_status" CHECK("clause_playbooks"."status" in ('draft', 'published', 'retired')),
	CONSTRAINT "ck_clause_playbooks_scope" CHECK(json_valid("clause_playbooks"."scope") = 1 and json_type("clause_playbooks"."scope") = 'object' and length("clause_playbooks"."scope") between 2 and 32768),
	CONSTRAINT "ck_clause_playbooks_published_version" CHECK("clause_playbooks"."current_published_version" is null or "clause_playbooks"."current_published_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_clause_playbooks_workspace_name` ON `clause_playbooks` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_clause_playbooks_workspace_status_updated` ON `clause_playbooks` (`workspace_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `extraction_proposal_citations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`fragment_id` text NOT NULL,
	`document_version_id` text NOT NULL,
	`document_version` integer NOT NULL,
	`document_sha256` text NOT NULL,
	`source_text_sha256` text NOT NULL,
	`start_offset` integer NOT NULL,
	`end_offset` integer NOT NULL,
	`quote` text NOT NULL,
	`quote_sha256` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proposal_id`) REFERENCES `extraction_proposals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fragment_id`) REFERENCES `repository_fragments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_version_id`) REFERENCES `agreement_document_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_extraction_proposal_citations_version" CHECK("extraction_proposal_citations"."document_version" > 0),
	CONSTRAINT "ck_extraction_proposal_citations_document_digest" CHECK(length("extraction_proposal_citations"."document_sha256") = 64 and lower("extraction_proposal_citations"."document_sha256") not glob '*[^0-9a-f]*'),
	CONSTRAINT "ck_extraction_proposal_citations_text_digest" CHECK(length("extraction_proposal_citations"."source_text_sha256") = 64 and lower("extraction_proposal_citations"."source_text_sha256") not glob '*[^0-9a-f]*'),
	CONSTRAINT "ck_extraction_proposal_citations_quote_digest" CHECK(length("extraction_proposal_citations"."quote_sha256") = 64 and lower("extraction_proposal_citations"."quote_sha256") not glob '*[^0-9a-f]*'),
	CONSTRAINT "ck_extraction_proposal_citations_offsets" CHECK("extraction_proposal_citations"."start_offset" >= 0 and "extraction_proposal_citations"."end_offset" > "extraction_proposal_citations"."start_offset" and length("extraction_proposal_citations"."quote") between 1 and 12000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_extraction_proposal_citations_workspace_proposal_fragment_offsets` ON `extraction_proposal_citations` (`workspace_id`,`proposal_id`,`fragment_id`,`start_offset`,`end_offset`);--> statement-breakpoint
CREATE INDEX `idx_extraction_proposal_citations_workspace_proposal` ON `extraction_proposal_citations` (`workspace_id`,`proposal_id`);--> statement-breakpoint
CREATE TABLE `extraction_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`document_version_id` text NOT NULL,
	`agreement_id` integer NOT NULL,
	`ingestion_item_id` text,
	`document_version` integer NOT NULL,
	`document_sha256` text NOT NULL,
	`source_text_sha256` text NOT NULL,
	`target_type` text NOT NULL,
	`target_field` text NOT NULL,
	`custom_field_definition_id` text,
	`proposed_value` text NOT NULL,
	`confidence_ppm` integer NOT NULL,
	`extractor` text NOT NULL,
	`extractor_version` text NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`application_status` text DEFAULT 'not_reviewed' NOT NULL,
	`blocker_code` text DEFAULT 'human_review_required' NOT NULL,
	`blocker_message` text DEFAULT 'A human reviewer must accept or reject this proposal.' NOT NULL,
	`reviewed_by_user_id` text,
	`reviewed_at` text,
	`review_reason` text,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_version_id`) REFERENCES `agreement_document_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agreement_id`) REFERENCES `agreements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ingestion_item_id`) REFERENCES `ingestion_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`custom_field_definition_id`) REFERENCES `custom_field_definitions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_extraction_proposals_document_version" CHECK("extraction_proposals"."document_version" > 0),
	CONSTRAINT "ck_extraction_proposals_document_digest" CHECK(length("extraction_proposals"."document_sha256") = 64 and lower("extraction_proposals"."document_sha256") not glob '*[^0-9a-f]*'),
	CONSTRAINT "ck_extraction_proposals_text_digest" CHECK(length("extraction_proposals"."source_text_sha256") = 64 and lower("extraction_proposals"."source_text_sha256") not glob '*[^0-9a-f]*'),
	CONSTRAINT "ck_extraction_proposals_target" CHECK(("extraction_proposals"."target_type" = 'agreement_field' and "extraction_proposals"."custom_field_definition_id" is null) or ("extraction_proposals"."target_type" = 'custom_field' and "extraction_proposals"."custom_field_definition_id" is not null)),
	CONSTRAINT "ck_extraction_proposals_value" CHECK(json_valid("extraction_proposals"."proposed_value") = 1 and length("extraction_proposals"."proposed_value") between 1 and 32768),
	CONSTRAINT "ck_extraction_proposals_confidence" CHECK("extraction_proposals"."confidence_ppm" between 0 and 1000000),
	CONSTRAINT "ck_extraction_proposals_status" CHECK("extraction_proposals"."status" in ('pending_review', 'accepted', 'rejected', 'superseded')),
	CONSTRAINT "ck_extraction_proposals_application" CHECK("extraction_proposals"."application_status" in ('not_reviewed', 'blocked')),
	CONSTRAINT "ck_extraction_proposals_review" CHECK(("extraction_proposals"."status" = 'pending_review' and "extraction_proposals"."reviewed_by_user_id" is null and "extraction_proposals"."reviewed_at" is null and "extraction_proposals"."review_reason" is null and "extraction_proposals"."application_status" = 'not_reviewed' and "extraction_proposals"."blocker_code" = 'human_review_required') or ("extraction_proposals"."status" in ('accepted', 'rejected', 'superseded') and "extraction_proposals"."reviewed_by_user_id" is not null and "extraction_proposals"."reviewed_at" is not null and length(trim("extraction_proposals"."review_reason")) between 3 and 4000 and "extraction_proposals"."application_status" = 'blocked'))
);
--> statement-breakpoint
CREATE INDEX `idx_extraction_proposals_workspace_status_updated` ON `extraction_proposals` (`workspace_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_extraction_proposals_workspace_document` ON `extraction_proposals` (`workspace_id`,`document_version_id`,`document_version`);--> statement-breakpoint
CREATE INDEX `idx_extraction_proposals_workspace_agreement` ON `extraction_proposals` (`workspace_id`,`agreement_id`);--> statement-breakpoint
CREATE TABLE `ingestion_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`idempotency_key_sha256` text NOT NULL,
	`request_sha256` text NOT NULL,
	`status` text NOT NULL,
	`item_count` integer NOT NULL,
	`accepted_count` integer DEFAULT 0 NOT NULL,
	`rejected_count` integer DEFAULT 0 NOT NULL,
	`blocker_code` text,
	`blocker_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_ingestion_batches_status" CHECK("ingestion_batches"."status" in ('awaiting_upload', 'review', 'completed', 'cancelled')),
	CONSTRAINT "ck_ingestion_batches_item_count" CHECK("ingestion_batches"."item_count" between 1 and 50),
	CONSTRAINT "ck_ingestion_batches_counts" CHECK("ingestion_batches"."accepted_count" >= 0 and "ingestion_batches"."rejected_count" >= 0 and "ingestion_batches"."accepted_count" + "ingestion_batches"."rejected_count" <= "ingestion_batches"."item_count"),
	CONSTRAINT "ck_ingestion_batches_key_digest" CHECK(length("ingestion_batches"."idempotency_key_sha256") = 64 and lower("ingestion_batches"."idempotency_key_sha256") not glob '*[^0-9a-f]*'),
	CONSTRAINT "ck_ingestion_batches_request_digest" CHECK(length("ingestion_batches"."request_sha256") = 64 and lower("ingestion_batches"."request_sha256") not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ingestion_batches_workspace_user_key` ON `ingestion_batches` (`workspace_id`,`created_by_user_id`,`idempotency_key_sha256`);--> statement-breakpoint
CREATE INDEX `idx_ingestion_batches_workspace_status_updated` ON `ingestion_batches` (`workspace_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `ingestion_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`source_sha256` text NOT NULL,
	`dedupe_sha256` text NOT NULL,
	`document_id` text,
	`duplicate_of_document_id` text,
	`status` text NOT NULL,
	`blocker_code` text,
	`blocker_message` text,
	`reviewed_by_user_id` text,
	`reviewed_at` text,
	`review_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`batch_id`) REFERENCES `ingestion_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`duplicate_of_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_ingestion_items_ordinal" CHECK("ingestion_items"."ordinal" between 0 and 49),
	CONSTRAINT "ck_ingestion_items_size" CHECK("ingestion_items"."size" between 1 and 20971520),
	CONSTRAINT "ck_ingestion_items_source_digest" CHECK(length("ingestion_items"."source_sha256") = 64 and lower("ingestion_items"."source_sha256") not glob '*[^0-9a-f]*'),
	CONSTRAINT "ck_ingestion_items_dedupe_digest" CHECK(length("ingestion_items"."dedupe_sha256") = 64 and lower("ingestion_items"."dedupe_sha256") not glob '*[^0-9a-f]*'),
	CONSTRAINT "ck_ingestion_items_status" CHECK("ingestion_items"."status" in ('awaiting_upload', 'duplicate', 'pending_extraction', 'review_required', 'accepted', 'rejected', 'failed')),
	CONSTRAINT "ck_ingestion_items_review" CHECK(("ingestion_items"."status" in ('accepted', 'rejected') and "ingestion_items"."reviewed_by_user_id" is not null and "ingestion_items"."reviewed_at" is not null and length(trim("ingestion_items"."review_reason")) between 3 and 4000) or ("ingestion_items"."status" not in ('accepted', 'rejected') and "ingestion_items"."reviewed_by_user_id" is null and "ingestion_items"."reviewed_at" is null and "ingestion_items"."review_reason" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ingestion_items_workspace_batch_ordinal` ON `ingestion_items` (`workspace_id`,`batch_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_ingestion_items_workspace_batch_status` ON `ingestion_items` (`workspace_id`,`batch_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_ingestion_items_workspace_dedupe` ON `ingestion_items` (`workspace_id`,`dedupe_sha256`);--> statement-breakpoint
CREATE TABLE `repository_fragments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`document_version_id` text NOT NULL,
	`agreement_id` integer NOT NULL,
	`document_version` integer NOT NULL,
	`document_sha256` text NOT NULL,
	`source_text_sha256` text NOT NULL,
	`ordinal` integer NOT NULL,
	`start_offset` integer NOT NULL,
	`end_offset` integer NOT NULL,
	`content` text NOT NULL,
	`content_sha256` text NOT NULL,
	`extractor` text NOT NULL,
	`extractor_version` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_version_id`) REFERENCES `agreement_document_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agreement_id`) REFERENCES `agreements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_repository_fragments_document_version" CHECK("repository_fragments"."document_version" > 0),
	CONSTRAINT "ck_repository_fragments_document_digest" CHECK(length("repository_fragments"."document_sha256") = 64 and lower("repository_fragments"."document_sha256") not glob '*[^0-9a-f]*'),
	CONSTRAINT "ck_repository_fragments_text_digest" CHECK(length("repository_fragments"."source_text_sha256") = 64 and lower("repository_fragments"."source_text_sha256") not glob '*[^0-9a-f]*'),
	CONSTRAINT "ck_repository_fragments_content_digest" CHECK(length("repository_fragments"."content_sha256") = 64 and lower("repository_fragments"."content_sha256") not glob '*[^0-9a-f]*'),
	CONSTRAINT "ck_repository_fragments_offsets" CHECK("repository_fragments"."ordinal" >= 0 and "repository_fragments"."start_offset" >= 0 and "repository_fragments"."end_offset" > "repository_fragments"."start_offset" and "repository_fragments"."end_offset" - "repository_fragments"."start_offset" <= 12000),
	CONSTRAINT "ck_repository_fragments_content" CHECK(length("repository_fragments"."content") between 1 and 12000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_repository_fragments_workspace_source_ordinal` ON `repository_fragments` (`workspace_id`,`document_version_id`,`source_text_sha256`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_repository_fragments_workspace_document` ON `repository_fragments` (`workspace_id`,`document_version_id`,`document_version`);--> statement-breakpoint
CREATE INDEX `idx_repository_fragments_workspace_agreement` ON `repository_fragments` (`workspace_id`,`agreement_id`);--> statement-breakpoint
CREATE INDEX `idx_repository_fragments_workspace_created` ON `repository_fragments` (`workspace_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER `validate_clause_playbook_version_scope_insert_v19`
BEFORE INSERT ON `clause_playbook_versions`
WHEN NOT EXISTS (
	SELECT 1 FROM `clause_playbooks`
	WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`playbook_id` AND `status` <> 'retired'
)
BEGIN SELECT RAISE(ABORT, 'invalid_clause_playbook_version_scope'); END;
--> statement-breakpoint
CREATE TRIGGER `immutable_published_clause_playbook_version_v19`
BEFORE UPDATE ON `clause_playbook_versions`
WHEN OLD.`status` = 'published'
BEGIN SELECT RAISE(ABORT, 'immutable_published_clause_playbook_version'); END;
--> statement-breakpoint
CREATE TRIGGER `validate_clause_playbook_lifecycle_v19`
BEFORE UPDATE OF `status`, `current_published_version` ON `clause_playbooks`
WHEN OLD.`status` = 'retired'
	OR (NEW.`status` = 'draft' AND OLD.`status` <> 'draft')
	OR (NEW.`status` = 'retired' AND OLD.`status` <> 'published')
	OR (OLD.`status` = 'published' AND NEW.`status` = 'published'
		AND NEW.`current_published_version` <= OLD.`current_published_version`)
	OR (NEW.`status` IN ('published', 'retired') AND NOT EXISTS (
		SELECT 1 FROM `clause_playbook_versions`
		WHERE `workspace_id` = NEW.`workspace_id` AND `playbook_id` = NEW.`id`
			AND `version` = NEW.`current_published_version` AND `status` = 'published'
	))
BEGIN SELECT RAISE(ABORT, 'invalid_clause_playbook_lifecycle'); END;
--> statement-breakpoint
CREATE TRIGGER `immutable_ingestion_batch_identity_v19`
BEFORE UPDATE OF `workspace_id`, `created_by_user_id`, `idempotency_key_sha256`, `request_sha256`, `item_count`, `created_at`
ON `ingestion_batches`
BEGIN SELECT RAISE(ABORT, 'immutable_ingestion_batch_identity'); END;
--> statement-breakpoint
CREATE TRIGGER `validate_ingestion_item_scope_insert_v19`
BEFORE INSERT ON `ingestion_items`
WHEN NOT EXISTS (
	SELECT 1 FROM `ingestion_batches`
	WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`batch_id`
		AND NEW.`ordinal` < `item_count` AND `status` <> 'cancelled'
)
	OR (NEW.`document_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `documents`
		WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`document_id`
			AND `sha256` = NEW.`source_sha256` AND `deleted_at` IS NULL
	))
	OR (NEW.`duplicate_of_document_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `documents`
		WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`duplicate_of_document_id`
			AND `sha256` = NEW.`source_sha256` AND `deleted_at` IS NULL
	))
BEGIN SELECT RAISE(ABORT, 'invalid_ingestion_item_scope'); END;
--> statement-breakpoint
CREATE TRIGGER `validate_ingestion_item_scope_update_v19`
BEFORE UPDATE OF `document_id`, `duplicate_of_document_id`, `status` ON `ingestion_items`
WHEN (NEW.`document_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `documents`
	WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`document_id`
		AND `sha256` = NEW.`source_sha256` AND `deleted_at` IS NULL
)) OR (NEW.`duplicate_of_document_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `documents`
	WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`duplicate_of_document_id`
		AND `sha256` = NEW.`source_sha256` AND `deleted_at` IS NULL
))
BEGIN SELECT RAISE(ABORT, 'invalid_ingestion_item_scope'); END;
--> statement-breakpoint
CREATE TRIGGER `immutable_ingestion_item_source_v19`
BEFORE UPDATE OF `workspace_id`, `batch_id`, `ordinal`, `file_name`, `content_type`, `size`, `source_sha256`, `dedupe_sha256`, `created_at`
ON `ingestion_items`
BEGIN SELECT RAISE(ABORT, 'immutable_ingestion_item_source'); END;
--> statement-breakpoint
CREATE TRIGGER `validate_ingestion_item_review_transition_v19`
BEFORE UPDATE OF `status` ON `ingestion_items`
WHEN NEW.`status` IN ('accepted', 'rejected') AND OLD.`status` <> 'review_required'
BEGIN SELECT RAISE(ABORT, 'invalid_ingestion_item_review_transition'); END;
--> statement-breakpoint
CREATE TRIGGER `validate_repository_fragment_source_insert_v19`
BEFORE INSERT ON `repository_fragments`
WHEN NOT EXISTS (
	SELECT 1 FROM `agreement_document_versions`
	WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`document_version_id`
		AND `agreement_id` = NEW.`agreement_id` AND `version` = NEW.`document_version`
		AND `sha256` = NEW.`document_sha256`
)
	OR NOT EXISTS (
		SELECT 1 FROM `agreements`
		WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`agreement_id` AND `deleted_at` IS NULL
	)
BEGIN SELECT RAISE(ABORT, 'invalid_repository_fragment_source'); END;
--> statement-breakpoint
CREATE TRIGGER `immutable_repository_fragment_v19`
BEFORE UPDATE ON `repository_fragments`
BEGIN SELECT RAISE(ABORT, 'immutable_repository_fragment'); END;
--> statement-breakpoint
CREATE TRIGGER `validate_extraction_proposal_source_insert_v19`
BEFORE INSERT ON `extraction_proposals`
WHEN NOT EXISTS (
	SELECT 1 FROM `agreement_document_versions`
	WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`document_version_id`
		AND `agreement_id` = NEW.`agreement_id` AND `version` = NEW.`document_version`
		AND `sha256` = NEW.`document_sha256`
)
	OR NOT EXISTS (
		SELECT 1 FROM `agreements`
		WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`agreement_id` AND `deleted_at` IS NULL
	)
	OR (NEW.`custom_field_definition_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `custom_field_definitions`
		WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`custom_field_definition_id`
			AND `resource_type` = 'agreement' AND `status` = 'active'
	))
	OR (NEW.`ingestion_item_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `ingestion_items` AS `source_item`
		JOIN `agreement_document_versions` AS `source_version`
			ON `source_version`.`workspace_id` = `source_item`.`workspace_id`
			AND `source_version`.`source_document_id` = `source_item`.`document_id`
		WHERE `source_item`.`workspace_id` = NEW.`workspace_id` AND `source_item`.`id` = NEW.`ingestion_item_id`
			AND `source_version`.`id` = NEW.`document_version_id`
	))
BEGIN SELECT RAISE(ABORT, 'invalid_extraction_proposal_source'); END;
--> statement-breakpoint
CREATE TRIGGER `immutable_extraction_proposal_basis_v19`
BEFORE UPDATE OF `workspace_id`, `document_version_id`, `agreement_id`, `ingestion_item_id`, `document_version`, `document_sha256`, `source_text_sha256`, `target_type`, `target_field`, `custom_field_definition_id`, `proposed_value`, `confidence_ppm`, `extractor`, `extractor_version`, `created_by_user_id`, `created_at`
ON `extraction_proposals`
BEGIN SELECT RAISE(ABORT, 'immutable_extraction_proposal_basis'); END;
--> statement-breakpoint
CREATE TRIGGER `validate_extraction_proposal_review_v19`
BEFORE UPDATE OF `status` ON `extraction_proposals`
WHEN OLD.`status` <> 'pending_review'
	OR NEW.`status` NOT IN ('accepted', 'rejected', 'superseded')
	OR NOT EXISTS (
		SELECT 1 FROM `agreement_document_versions`
		WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`document_version_id`
			AND `agreement_id` = NEW.`agreement_id` AND `version` = NEW.`document_version`
			AND `sha256` = NEW.`document_sha256`
	)
	OR NOT EXISTS (
		SELECT 1 FROM `agreements`
		WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`agreement_id` AND `deleted_at` IS NULL
	)
BEGIN SELECT RAISE(ABORT, 'invalid_extraction_proposal_review'); END;
--> statement-breakpoint
CREATE TRIGGER `validate_extraction_proposal_citation_insert_v19`
BEFORE INSERT ON `extraction_proposal_citations`
WHEN NOT EXISTS (
	SELECT 1
	FROM `extraction_proposals` AS `proposal`
	JOIN `repository_fragments` AS `fragment`
		ON `fragment`.`workspace_id` = `proposal`.`workspace_id`
		AND `fragment`.`document_version_id` = `proposal`.`document_version_id`
		AND `fragment`.`document_version` = `proposal`.`document_version`
		AND `fragment`.`document_sha256` = `proposal`.`document_sha256`
		AND `fragment`.`source_text_sha256` = `proposal`.`source_text_sha256`
	WHERE `proposal`.`workspace_id` = NEW.`workspace_id`
		AND `proposal`.`id` = NEW.`proposal_id`
		AND `fragment`.`id` = NEW.`fragment_id`
		AND NEW.`document_version_id` = `proposal`.`document_version_id`
		AND NEW.`document_version` = `proposal`.`document_version`
		AND NEW.`document_sha256` = `proposal`.`document_sha256`
		AND NEW.`source_text_sha256` = `proposal`.`source_text_sha256`
		AND NEW.`start_offset` >= `fragment`.`start_offset`
		AND NEW.`end_offset` <= `fragment`.`end_offset`
		AND NEW.`quote` = substr(
			`fragment`.`content`,
			NEW.`start_offset` - `fragment`.`start_offset` + 1,
			NEW.`end_offset` - NEW.`start_offset`
		)
)
BEGIN SELECT RAISE(ABORT, 'invalid_extraction_proposal_citation'); END;
--> statement-breakpoint
CREATE TRIGGER `immutable_extraction_proposal_citation_v19`
BEFORE UPDATE ON `extraction_proposal_citations`
BEGIN SELECT RAISE(ABORT, 'immutable_extraction_proposal_citation'); END;
--> statement-breakpoint
CREATE TRIGGER `validate_agreement_workflow_snapshot_insert_v19`
BEFORE INSERT ON `agreements`
WHEN NOT (
	(NEW.`workflow_policy_sha256` IS NULL AND NEW.`workflow_approval_lanes` IS NULL)
	OR (
		NEW.`workflow_definition_id` IS NOT NULL
		AND length(NEW.`workflow_policy_sha256`) = 64
		AND lower(NEW.`workflow_policy_sha256`) NOT GLOB '*[^0-9a-f]*'
		AND json_valid(NEW.`workflow_approval_lanes`) = 1
		AND json_type(NEW.`workflow_approval_lanes`) = 'array'
		AND json_array_length(NEW.`workflow_approval_lanes`) BETWEEN 1 AND 20
		AND length(NEW.`workflow_approval_lanes`) BETWEEN 3 AND 2048
		AND NOT EXISTS (
			SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.`workflow_approval_lanes`) THEN NEW.`workflow_approval_lanes` ELSE '[]' END)
			WHERE type <> 'text' OR length(trim(CAST(value AS TEXT))) NOT BETWEEN 1 AND 120
		)
		AND NOT EXISTS (
			SELECT 1
			FROM json_each(CASE WHEN json_valid(NEW.`workflow_approval_lanes`) THEN NEW.`workflow_approval_lanes` ELSE '[]' END) AS lane
			GROUP BY lower(trim(CAST(lane.value AS TEXT))) HAVING count(*) > 1
		)
		AND EXISTS (
			SELECT 1 FROM `workflow_definitions`
			WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`workflow_definition_id`
				AND `status` = 'published' AND `definition_sha256` = NEW.`workflow_policy_sha256`
		)
	)
)
BEGIN SELECT RAISE(ABORT, 'invalid_agreement_workflow_snapshot'); END;
--> statement-breakpoint
CREATE TRIGGER `validate_intake_form_template_version_insert_v19`
BEFORE INSERT ON `intake_forms`
WHEN (NEW.`template_id` IS NULL AND NEW.`template_version_id` IS NOT NULL)
	OR (NEW.`status` = 'published' AND NEW.`template_id` IS NOT NULL AND NEW.`template_version_id` IS NULL)
	OR (NEW.`template_version_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `governed_template_versions`
		WHERE `workspace_id` = NEW.`workspace_id` AND `template_id` = NEW.`template_id`
			AND `id` = NEW.`template_version_id` AND `status` = 'published'
	))
BEGIN SELECT RAISE(ABORT, 'invalid_intake_form_template_version'); END;
--> statement-breakpoint
CREATE TRIGGER `validate_intake_form_template_version_update_v19`
BEFORE UPDATE ON `intake_forms`
WHEN (NEW.`template_id` IS NULL AND NEW.`template_version_id` IS NOT NULL)
	OR (NEW.`status` = 'published' AND NEW.`template_id` IS NOT NULL AND NEW.`template_version_id` IS NULL)
	OR (NEW.`template_version_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `governed_template_versions`
		WHERE `workspace_id` = NEW.`workspace_id` AND `template_id` = NEW.`template_id`
			AND `id` = NEW.`template_version_id` AND `status` = 'published'
	))
BEGIN SELECT RAISE(ABORT, 'invalid_intake_form_template_version'); END;
--> statement-breakpoint
CREATE TRIGGER `immutable_published_intake_form_template_pin_v19`
BEFORE UPDATE OF `template_id`, `template_version_id` ON `intake_forms`
WHEN OLD.`status` IN ('published', 'retired')
BEGIN SELECT RAISE(ABORT, 'immutable_published_intake_form_template_pin'); END;
--> statement-breakpoint
CREATE TRIGGER `validate_agreement_workflow_snapshot_update_v19`
BEFORE UPDATE OF `workspace_id`, `workflow_definition_id`, `workflow_policy_sha256`, `workflow_approval_lanes` ON `agreements`
WHEN NOT (
	(NEW.`workflow_policy_sha256` IS NULL AND NEW.`workflow_approval_lanes` IS NULL)
	OR (
		NEW.`workflow_definition_id` IS NOT NULL
		AND length(NEW.`workflow_policy_sha256`) = 64
		AND lower(NEW.`workflow_policy_sha256`) NOT GLOB '*[^0-9a-f]*'
		AND json_valid(NEW.`workflow_approval_lanes`) = 1
		AND json_type(NEW.`workflow_approval_lanes`) = 'array'
		AND json_array_length(NEW.`workflow_approval_lanes`) BETWEEN 1 AND 20
		AND length(NEW.`workflow_approval_lanes`) BETWEEN 3 AND 2048
		AND NOT EXISTS (
			SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.`workflow_approval_lanes`) THEN NEW.`workflow_approval_lanes` ELSE '[]' END)
			WHERE type <> 'text' OR length(trim(CAST(value AS TEXT))) NOT BETWEEN 1 AND 120
		)
		AND NOT EXISTS (
			SELECT 1
			FROM json_each(CASE WHEN json_valid(NEW.`workflow_approval_lanes`) THEN NEW.`workflow_approval_lanes` ELSE '[]' END) AS lane
			GROUP BY lower(trim(CAST(lane.value AS TEXT))) HAVING count(*) > 1
		)
		AND EXISTS (
			SELECT 1 FROM `workflow_definitions`
			WHERE `workspace_id` = NEW.`workspace_id` AND `id` = NEW.`workflow_definition_id`
				AND (
					`status` = 'published'
					OR (`status` = 'retired' AND NEW.`workflow_definition_id` = OLD.`workflow_definition_id`)
				)
				AND `definition_sha256` = NEW.`workflow_policy_sha256`
		)
	)
)
BEGIN SELECT RAISE(ABORT, 'invalid_agreement_workflow_snapshot'); END;
--> statement-breakpoint
CREATE TRIGGER `immutable_governed_template_scope_v19`
BEFORE UPDATE OF `agreement_type`, `side` ON `governed_templates`
WHEN (NEW.`agreement_type` <> OLD.`agreement_type` OR NEW.`side` <> OLD.`side`)
	AND EXISTS (
		SELECT 1 FROM `governed_template_versions`
		WHERE `workspace_id` = OLD.`workspace_id` AND `template_id` = OLD.`id`
	)
BEGIN SELECT RAISE(ABORT, 'immutable_governed_template_scope'); END;
--> statement-breakpoint
CREATE TRIGGER `prevent_duplicate_agreement_party_v19`
BEFORE INSERT ON `agreement_parties`
WHEN EXISTS (
	SELECT 1 FROM `agreement_parties`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `agreement_id` = NEW.`agreement_id`
		AND `role` = NEW.`role`
		AND `legal_entity_id` IS NEW.`legal_entity_id`
		AND `counterparty_id` IS NEW.`counterparty_id`
)
BEGIN SELECT RAISE(ABORT, 'duplicate_agreement_party'); END;
--> statement-breakpoint
DROP INDEX IF EXISTS `uq_approval_lane_authorities_workspace_lane_subject_currency`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_approval_lane_authorities_active_identity`
ON `approval_lane_authorities` (`workspace_id`,`lane`,`subject_type`,`subject_id`,`currency_code`)
WHERE `status` = 'active';--> statement-breakpoint
CREATE TRIGGER `prevent_disable_group_with_active_authority_v19`
BEFORE UPDATE OF `status` ON `workspace_groups`
WHEN NEW.`status` = 'disabled' AND EXISTS (
	SELECT 1 FROM `approval_lane_authorities`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `subject_type` = 'group'
		AND `subject_id` = NEW.`id`
		AND `status` = 'active'
)
BEGIN SELECT RAISE(ABORT, 'group_has_active_authority'); END;--> statement-breakpoint
CREATE TRIGGER `immutable_clause_playbook_scope_v19`
BEFORE UPDATE OF `scope` ON `clause_playbooks`
WHEN NEW.`scope` <> OLD.`scope` AND EXISTS (
	SELECT 1 FROM `clause_playbook_versions`
	WHERE `workspace_id` = OLD.`workspace_id` AND `playbook_id` = OLD.`id`
)
BEGIN SELECT RAISE(ABORT, 'immutable_clause_playbook_scope'); END;--> statement-breakpoint
CREATE TRIGGER `validate_agreement_template_pin_insert_v19`
BEFORE INSERT ON `agreements`
WHEN NEW.`governed_template_version_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `governed_template_versions` AS `selected_version`
	JOIN `governed_templates` AS `selected_template`
		ON `selected_template`.`workspace_id` = `selected_version`.`workspace_id`
		AND `selected_template`.`id` = `selected_version`.`template_id`
	WHERE `selected_version`.`workspace_id` = NEW.`workspace_id`
		AND `selected_version`.`id` = NEW.`governed_template_version_id`
		AND `selected_version`.`status` = 'published'
		AND `selected_template`.`status` = 'published'
		AND `selected_template`.`current_published_version` = `selected_version`.`version`
)
AND NOT EXISTS (
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
)
BEGIN SELECT RAISE(ABORT, 'invalid_agreement_template_pin'); END;--> statement-breakpoint
CREATE TRIGGER `validate_agreement_template_pin_update_v19`
BEFORE UPDATE OF `workspace_id`, `governed_template_version_id` ON `agreements`
WHEN (NEW.`workspace_id` IS NOT OLD.`workspace_id`
		OR NEW.`governed_template_version_id` IS NOT OLD.`governed_template_version_id`)
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
)
BEGIN SELECT RAISE(ABORT, 'invalid_agreement_template_pin'); END;--> statement-breakpoint
CREATE TRIGGER `validate_custom_field_counterparty_active_insert_v19`
BEFORE INSERT ON `custom_field_values`
WHEN NEW.`resource_type` = 'counterparty' AND NOT EXISTS (
	SELECT 1 FROM `counterparties`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`resource_id`
		AND `status` = 'active'
)
BEGIN SELECT RAISE(ABORT, 'inactive_custom_field_counterparty'); END;--> statement-breakpoint
CREATE TRIGGER `validate_custom_field_counterparty_active_update_v19`
BEFORE UPDATE ON `custom_field_values`
WHEN NEW.`resource_type` = 'counterparty' AND NOT EXISTS (
	SELECT 1 FROM `counterparties`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`resource_id`
		AND `status` = 'active'
)
BEGIN SELECT RAISE(ABORT, 'inactive_custom_field_counterparty'); END;--> statement-breakpoint
CREATE TRIGGER `validate_published_intake_template_current_insert_v19`
BEFORE INSERT ON `intake_forms`
WHEN NEW.`status` = 'published' AND NEW.`template_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `governed_template_versions` AS `selected_version`
	JOIN `governed_templates` AS `selected_template`
		ON `selected_template`.`workspace_id` = `selected_version`.`workspace_id`
		AND `selected_template`.`id` = `selected_version`.`template_id`
	WHERE `selected_version`.`workspace_id` = NEW.`workspace_id`
		AND `selected_version`.`id` = NEW.`template_version_id`
		AND `selected_version`.`template_id` = NEW.`template_id`
		AND `selected_version`.`status` = 'published'
		AND `selected_template`.`status` = 'published'
		AND `selected_template`.`current_published_version` = `selected_version`.`version`
)
BEGIN SELECT RAISE(ABORT, 'intake_template_version_not_current'); END;--> statement-breakpoint
CREATE TRIGGER `validate_published_intake_template_current_update_v19`
BEFORE UPDATE ON `intake_forms`
WHEN NEW.`status` = 'published'
	AND (OLD.`status` <> 'published' OR NEW.`template_id` IS NOT OLD.`template_id` OR NEW.`template_version_id` IS NOT OLD.`template_version_id`)
	AND NEW.`template_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `governed_template_versions` AS `selected_version`
	JOIN `governed_templates` AS `selected_template`
		ON `selected_template`.`workspace_id` = `selected_version`.`workspace_id`
		AND `selected_template`.`id` = `selected_version`.`template_id`
	WHERE `selected_version`.`workspace_id` = NEW.`workspace_id`
		AND `selected_version`.`id` = NEW.`template_version_id`
		AND `selected_version`.`template_id` = NEW.`template_id`
		AND `selected_version`.`status` = 'published'
		AND `selected_template`.`status` = 'published'
		AND `selected_template`.`current_published_version` = `selected_version`.`version`
)
BEGIN SELECT RAISE(ABORT, 'intake_template_version_not_current'); END;--> statement-breakpoint
CREATE TRIGGER `validate_intake_submission_publish_state_v19`
BEFORE UPDATE OF `status` ON `intake_submissions`
WHEN OLD.`status` = 'draft' AND NEW.`status` = 'submitted' AND NOT EXISTS (
	SELECT 1 FROM `intake_forms`
	WHERE `workspace_id` = NEW.`workspace_id`
		AND `id` = NEW.`form_id`
		AND `version` = NEW.`form_version`
		AND `status` = 'published'
)
BEGIN SELECT RAISE(ABORT, 'intake_form_not_published'); END;--> statement-breakpoint
CREATE TRIGGER `prevent_repository_fragment_overlap_insert_v19`
BEFORE INSERT ON `repository_fragments`
WHEN EXISTS (
	SELECT 1 FROM `repository_fragments` AS `existing_fragment`
	WHERE `existing_fragment`.`workspace_id` = NEW.`workspace_id`
		AND `existing_fragment`.`document_version_id` = NEW.`document_version_id`
		AND `existing_fragment`.`source_text_sha256` = NEW.`source_text_sha256`
		AND NEW.`start_offset` < `existing_fragment`.`end_offset`
		AND NEW.`end_offset` > `existing_fragment`.`start_offset`
)
BEGIN SELECT RAISE(ABORT, 'repository_fragment_overlap'); END;--> statement-breakpoint
CREATE TRIGGER `bound_repository_fragment_total_insert_v19`
BEFORE INSERT ON `repository_fragments`
WHEN (SELECT count(*) FROM `repository_fragments` AS `existing_fragment`
	WHERE `existing_fragment`.`workspace_id` = NEW.`workspace_id`
		AND `existing_fragment`.`document_version_id` = NEW.`document_version_id`
		AND `existing_fragment`.`source_text_sha256` = NEW.`source_text_sha256`) >= 500
BEGIN SELECT RAISE(ABORT, 'repository_fragment_limit'); END;--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 19, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary' AND `version` = 18;
