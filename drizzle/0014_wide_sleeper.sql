CREATE TABLE `document_comparisons` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agreement_id` integer NOT NULL,
	`round_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`base_sha256` text,
	`proposed_sha256` text,
	`base_text_sha256` text,
	`proposed_text_sha256` text,
	`extractor` text,
	`provenance` text,
	`status` text DEFAULT 'ready' NOT NULL,
	`decision_note` text,
	`decided_by_user_id` text,
	`decided_at` text,
	`resulting_document_version` integer,
	`resulting_sha256` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "ck_document_comparisons_status" CHECK("document_comparisons"."status" in ('ready', 'manual_required', 'accepted', 'rejected', 'superseded')),
	CONSTRAINT "ck_document_comparisons_base_sha256" CHECK("document_comparisons"."base_sha256" is null or length("document_comparisons"."base_sha256") = 64),
	CONSTRAINT "ck_document_comparisons_proposed_sha256" CHECK("document_comparisons"."proposed_sha256" is null or length("document_comparisons"."proposed_sha256") = 64),
	CONSTRAINT "ck_document_comparisons_base_text_sha256" CHECK("document_comparisons"."base_text_sha256" is null or length("document_comparisons"."base_text_sha256") = 64),
	CONSTRAINT "ck_document_comparisons_proposed_text_sha256" CHECK("document_comparisons"."proposed_text_sha256" is null or length("document_comparisons"."proposed_text_sha256") = 64),
	CONSTRAINT "ck_document_comparisons_resulting_sha256" CHECK("document_comparisons"."resulting_sha256" is null or length("document_comparisons"."resulting_sha256") = 64),
	CONSTRAINT "ck_document_comparisons_resulting_version" CHECK("document_comparisons"."resulting_document_version" is null or "document_comparisons"."resulting_document_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_document_comparisons_workspace_round_submission` ON `document_comparisons` (`workspace_id`,`round_id`,`submission_id`);--> statement-breakpoint
CREATE INDEX `idx_document_comparisons_workspace_agreement_round` ON `document_comparisons` (`workspace_id`,`agreement_id`,`round_id`);--> statement-breakpoint
CREATE INDEX `idx_document_comparisons_workspace_status_updated_at` ON `document_comparisons` (`workspace_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `negotiation_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agreement_id` integer NOT NULL,
	`round_number` integer NOT NULL,
	`status` text DEFAULT 'prepared' NOT NULL,
	`active_key` text,
	`alias_code` text NOT NULL,
	`counterparty_email` text,
	`counterparty_name` text,
	`base_document_version` integer,
	`base_document_id` text,
	`base_sha256` text NOT NULL,
	`outbound_document_id` text NOT NULL,
	`outbound_sha256` text NOT NULL,
	`portal_token_hash` text,
	`portal_expires_at` text,
	`delivery_method` text,
	`provider_message_id` text,
	`resolved_document_version` integer,
	`resolved_sha256` text,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`sent_at` text,
	`resolved_at` text,
	`closed_at` text,
	CONSTRAINT "ck_negotiation_rounds_number" CHECK("negotiation_rounds"."round_number" > 0),
	CONSTRAINT "ck_negotiation_rounds_status" CHECK("negotiation_rounds"."status" in ('prepared', 'outbound', 'returned', 'review', 'resolved', 'closed')),
	CONSTRAINT "ck_negotiation_rounds_delivery_method" CHECK("negotiation_rounds"."delivery_method" is null or "negotiation_rounds"."delivery_method" in ('manual', 'email_gateway', 'portal')),
	CONSTRAINT "ck_negotiation_rounds_base_sha256" CHECK(length("negotiation_rounds"."base_sha256") = 64),
	CONSTRAINT "ck_negotiation_rounds_outbound_sha256" CHECK(length("negotiation_rounds"."outbound_sha256") = 64),
	CONSTRAINT "ck_negotiation_rounds_portal_token_hash" CHECK("negotiation_rounds"."portal_token_hash" is null or length("negotiation_rounds"."portal_token_hash") = 64),
	CONSTRAINT "ck_negotiation_rounds_resolved_sha256" CHECK("negotiation_rounds"."resolved_sha256" is null or length("negotiation_rounds"."resolved_sha256") = 64),
	CONSTRAINT "ck_negotiation_rounds_baseline" CHECK(("negotiation_rounds"."base_document_version" is not null and "negotiation_rounds"."base_document_id" is null) or ("negotiation_rounds"."base_document_version" is null and "negotiation_rounds"."base_document_id" is not null)),
	CONSTRAINT "ck_negotiation_rounds_base_version" CHECK("negotiation_rounds"."base_document_version" is null or "negotiation_rounds"."base_document_version" > 0),
	CONSTRAINT "ck_negotiation_rounds_resolved_version" CHECK("negotiation_rounds"."resolved_document_version" is null or "negotiation_rounds"."resolved_document_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_negotiation_rounds_workspace_agreement_round` ON `negotiation_rounds` (`workspace_id`,`agreement_id`,`round_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_negotiation_rounds_workspace_active_key` ON `negotiation_rounds` (`workspace_id`,`active_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_negotiation_rounds_workspace_alias_code` ON `negotiation_rounds` (`workspace_id`,`alias_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_negotiation_rounds_workspace_portal_token_hash` ON `negotiation_rounds` (`workspace_id`,`portal_token_hash`);--> statement-breakpoint
CREATE INDEX `idx_negotiation_rounds_workspace_agreement_status` ON `negotiation_rounds` (`workspace_id`,`agreement_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_negotiation_rounds_workspace_updated_at` ON `negotiation_rounds` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `negotiation_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agreement_id` integer NOT NULL,
	`round_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`sender_email` text,
	`sender_name` text,
	`provider_message_id` text,
	`document_id` text,
	`document_sha256` text,
	`review_text_object_key` text,
	`review_text_sha256` text,
	`review_text_size` integer,
	`review_text_provenance` text,
	`reviewed_by_user_id` text,
	`reviewed_at` text,
	`decision_note` text,
	`created_at` text NOT NULL,
	CONSTRAINT "ck_negotiation_submissions_source" CHECK("negotiation_submissions"."source" in ('email', 'portal', 'manual')),
	CONSTRAINT "ck_negotiation_submissions_status" CHECK("negotiation_submissions"."status" in ('ready', 'sender_review', 'quarantined', 'rejected', 'promoted', 'late', 'no_attachment')),
	CONSTRAINT "ck_negotiation_submissions_document_sha256" CHECK("negotiation_submissions"."document_sha256" is null or length("negotiation_submissions"."document_sha256") = 64),
	CONSTRAINT "ck_negotiation_submissions_review_text_sha256" CHECK("negotiation_submissions"."review_text_sha256" is null or length("negotiation_submissions"."review_text_sha256") = 64),
	CONSTRAINT "ck_negotiation_submissions_review_text_size" CHECK("negotiation_submissions"."review_text_size" is null or "negotiation_submissions"."review_text_size" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_negotiation_submissions_workspace_round_document` ON `negotiation_submissions` (`workspace_id`,`round_id`,`document_id`);--> statement-breakpoint
CREATE INDEX `idx_negotiation_submissions_workspace_agreement_round` ON `negotiation_submissions` (`workspace_id`,`agreement_id`,`round_id`);--> statement-breakpoint
CREATE INDEX `idx_negotiation_submissions_workspace_status_created_at` ON `negotiation_submissions` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_negotiation_submissions_workspace_provider_message` ON `negotiation_submissions` (`workspace_id`,`provider_message_id`);--> statement-breakpoint
ALTER TABLE `documents` ADD `role` text DEFAULT 'supporting' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `direction` text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `negotiation_round_id` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `provider_message_id` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `parent_sha256` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `original_sender_email` text;--> statement-breakpoint
-- Version 13 had exactly two supported document writers: user imports and
-- DocuSeal signed evidence. Preserve that provenance deterministically before
-- the new defaults can make every legacy row look like an internal attachment.
-- Packet linkage is authoritative; the remaining predicates cover additional
-- artifacts from a multi-document DocuSeal completion where only the first
-- document was stored on signature_packets.evidence_document_id.
UPDATE `documents`
SET
	`role` = CASE
		WHEN EXISTS (
			SELECT 1
			FROM `signature_packets` AS `legacy_signature_packet`
			WHERE `legacy_signature_packet`.`workspace_id` = `documents`.`workspace_id`
				AND `legacy_signature_packet`.`evidence_document_id` = `documents`.`id`
		)
		OR `documents`.`created_by_user_id` = 'system:docuseal'
		OR `documents`.`extraction_mode` = 'Signed artifact; extraction intentionally skipped'
		OR substr(
			`documents`.`object_key`,
			1,
			length('workspaces/' || `documents`.`workspace_id` || '/signed/')
		) = 'workspaces/' || `documents`.`workspace_id` || '/signed/'
		THEN 'signed_artifact'
		ELSE 'initial_source'
	END,
	`direction` = 'inbound'
WHERE `role` = 'supporting'
	AND `direction` = 'internal'
	AND `negotiation_round_id` IS NULL;--> statement-breakpoint
-- Restore the provider lineage used by the idempotent DocuSeal artifact-reuse
-- fence. The first artifact may be linked directly from the packet; sibling
-- artifacts are bound by the exact v13 packet path. Rows without an
-- unambiguous live packet remain signed evidence but intentionally fail closed
-- for reuse instead of borrowing another packet's identity.
UPDATE `documents`
SET
	`provider_message_id` = COALESCE(
		`provider_message_id`,
		(
			SELECT `path_packet`.`submission_id`
			FROM `signature_packets` AS `path_packet`
			WHERE `path_packet`.`workspace_id` = `documents`.`workspace_id`
				AND `path_packet`.`agreement_id` = `documents`.`agreement_id`
				AND `path_packet`.`submission_id` IS NOT NULL
				AND length(`path_packet`.`submission_id`) > 0
				AND length(`path_packet`.`document_sha256`) = 64
				AND substr(
					`documents`.`object_key`,
					1,
					length('workspaces/' || `documents`.`workspace_id` || '/signed/' || `documents`.`agreement_id` || '/' || `path_packet`.`id` || '/')
				) = 'workspaces/' || `documents`.`workspace_id` || '/signed/' || `documents`.`agreement_id` || '/' || `path_packet`.`id` || '/'
			ORDER BY `path_packet`.`id`
			LIMIT 1
		),
		(
			SELECT `direct_packet`.`submission_id`
			FROM `signature_packets` AS `direct_packet`
			WHERE `direct_packet`.`workspace_id` = `documents`.`workspace_id`
				AND `direct_packet`.`agreement_id` = `documents`.`agreement_id`
				AND `direct_packet`.`evidence_document_id` = `documents`.`id`
				AND `direct_packet`.`submission_id` IS NOT NULL
				AND length(`direct_packet`.`submission_id`) > 0
				AND length(`direct_packet`.`document_sha256`) = 64
				AND 1 = (
					SELECT count(*)
					FROM `signature_packets` AS `reference_packet`
					WHERE `reference_packet`.`workspace_id` = `documents`.`workspace_id`
						AND `reference_packet`.`agreement_id` = `documents`.`agreement_id`
						AND `reference_packet`.`evidence_document_id` = `documents`.`id`
				)
			LIMIT 1
		)
	),
	`parent_sha256` = COALESCE(
		`parent_sha256`,
		(
			SELECT `path_packet`.`document_sha256`
			FROM `signature_packets` AS `path_packet`
			WHERE `path_packet`.`workspace_id` = `documents`.`workspace_id`
				AND `path_packet`.`agreement_id` = `documents`.`agreement_id`
				AND `path_packet`.`submission_id` IS NOT NULL
				AND length(`path_packet`.`submission_id`) > 0
				AND length(`path_packet`.`document_sha256`) = 64
				AND substr(
					`documents`.`object_key`,
					1,
					length('workspaces/' || `documents`.`workspace_id` || '/signed/' || `documents`.`agreement_id` || '/' || `path_packet`.`id` || '/')
				) = 'workspaces/' || `documents`.`workspace_id` || '/signed/' || `documents`.`agreement_id` || '/' || `path_packet`.`id` || '/'
			ORDER BY `path_packet`.`id`
			LIMIT 1
		),
		(
			SELECT `direct_packet`.`document_sha256`
			FROM `signature_packets` AS `direct_packet`
			WHERE `direct_packet`.`workspace_id` = `documents`.`workspace_id`
				AND `direct_packet`.`agreement_id` = `documents`.`agreement_id`
				AND `direct_packet`.`evidence_document_id` = `documents`.`id`
				AND `direct_packet`.`submission_id` IS NOT NULL
				AND length(`direct_packet`.`submission_id`) > 0
				AND length(`direct_packet`.`document_sha256`) = 64
				AND 1 = (
					SELECT count(*)
					FROM `signature_packets` AS `reference_packet`
					WHERE `reference_packet`.`workspace_id` = `documents`.`workspace_id`
						AND `reference_packet`.`agreement_id` = `documents`.`agreement_id`
						AND `reference_packet`.`evidence_document_id` = `documents`.`id`
				)
			LIMIT 1
		)
	)
WHERE `role` = 'signed_artifact'
	AND `direction` = 'inbound'
	AND `negotiation_round_id` IS NULL
	AND (`provider_message_id` IS NULL OR `parent_sha256` IS NULL);--> statement-breakpoint
CREATE INDEX `idx_documents_workspace_role` ON `documents` (`workspace_id`,`role`);--> statement-breakpoint
CREATE INDEX `idx_documents_workspace_negotiation_round` ON `documents` (`workspace_id`,`negotiation_round_id`);--> statement-breakpoint
CREATE TABLE `document_upload_receipts` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`key_digest` text NOT NULL,
	`request_digest` text NOT NULL,
	`document_id` text NOT NULL,
	`response_json` text NOT NULL,
	`response_status` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`linked_at` text,
	PRIMARY KEY(`workspace_id`, `user_id`, `key_digest`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_document_upload_receipts_key_digest" CHECK(length(`key_digest`) = 64),
	CONSTRAINT "ck_document_upload_receipts_request_digest" CHECK(length(`request_digest`) = 64),
	CONSTRAINT "ck_document_upload_receipts_response_status" CHECK(`response_status` in (201, 202)),
	CONSTRAINT "ck_document_upload_receipts_response_json" CHECK(json_valid(`response_json`) = 1 and length(`response_json`) between 2 and 65536),
	CONSTRAINT "ck_document_upload_receipts_expiry" CHECK(`expires_at` > `created_at`)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_document_upload_receipts_workspace_document` ON `document_upload_receipts` (`workspace_id`,`document_id`);--> statement-breakpoint
CREATE INDEX `idx_document_upload_receipts_workspace_expiry` ON `document_upload_receipts` (`workspace_id`,`expires_at`);--> statement-breakpoint
ALTER TABLE `webhook_receipts` ADD `aggregate_type` text;--> statement-breakpoint
ALTER TABLE `webhook_receipts` ADD `aggregate_id` text;--> statement-breakpoint
CREATE INDEX `idx_webhook_receipts_workspace_aggregate` ON `webhook_receipts` (`workspace_id`,`aggregate_type`,`aggregate_id`);--> statement-breakpoint
CREATE TABLE `agreement_creation_receipts` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_sha256` text NOT NULL,
	`creation_mode` text NOT NULL,
	`agreement_id` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`, `idempotency_key`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agreement_id`) REFERENCES `agreements`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_agreement_creation_receipts_key" CHECK(length(`idempotency_key`) = 36),
	CONSTRAINT "ck_agreement_creation_receipts_digest" CHECK(length(`request_sha256`) = 64),
	CONSTRAINT "ck_agreement_creation_receipts_mode" CHECK(`creation_mode` in ('manual', 'generated', 'imported'))
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agreement_creation_receipts_workspace_agreement` ON `agreement_creation_receipts` (`workspace_id`,`agreement_id`);--> statement-breakpoint
CREATE INDEX `idx_agreement_creation_receipts_workspace_created_at` ON `agreement_creation_receipts` (`workspace_id`,`created_at`);--> statement-breakpoint
UPDATE `webhook_receipts`
SET
	`aggregate_type` = 'signature_packet',
	`aggregate_id` = (
		SELECT min(`legacy_signature_packet`.`id`)
		FROM `signature_packets` AS `legacy_signature_packet`
		WHERE `legacy_signature_packet`.`workspace_id` = `webhook_receipts`.`workspace_id`
			AND `legacy_signature_packet`.`provider` = 'docuseal'
			AND `legacy_signature_packet`.`submission_id` = substr(
				`webhook_receipts`.`provider_event_id`,
				instr(`webhook_receipts`.`provider_event_id`, ':') + 1,
				instr(substr(`webhook_receipts`.`provider_event_id`, instr(`webhook_receipts`.`provider_event_id`, ':') + 1), ':') - 1
			)
	)
WHERE `provider` = 'docuseal'
	AND `provider_event_id` IS NOT NULL
	AND `aggregate_type` IS NULL
	AND `aggregate_id` IS NULL
	AND instr(`provider_event_id`, ':') > 0
	AND instr(substr(`provider_event_id`, instr(`provider_event_id`, ':') + 1), ':') > 1
	AND 1 = (
		SELECT count(*)
		FROM `signature_packets` AS `legacy_signature_packet`
		WHERE `legacy_signature_packet`.`workspace_id` = `webhook_receipts`.`workspace_id`
			AND `legacy_signature_packet`.`provider` = 'docuseal'
			AND `legacy_signature_packet`.`submission_id` = substr(
				`webhook_receipts`.`provider_event_id`,
				instr(`webhook_receipts`.`provider_event_id`, ':') + 1,
				instr(substr(`webhook_receipts`.`provider_event_id`, instr(`webhook_receipts`.`provider_event_id`, ':') + 1), ':') - 1
			)
	);--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 14, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary' AND `version` = 13;
