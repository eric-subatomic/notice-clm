CREATE TABLE `agent_action_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`action_id` text NOT NULL,
	`plan_sha256` text NOT NULL,
	`request_sha256` text NOT NULL,
	`idempotency_key_sha256` text NOT NULL,
	`status` text DEFAULT 'executing' NOT NULL,
	`result` text,
	`agreement_event_ids` text NOT NULL,
	`provenance` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `agent_action_plans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`principal_id`) REFERENCES `service_principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grant_id`) REFERENCES `agent_grants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_agent_action_executions_status" CHECK("agent_action_executions"."status" in ('executing', 'succeeded', 'failed_retryable', 'failed_terminal')),
	CONSTRAINT "ck_agent_action_executions_plan_digest" CHECK(length("agent_action_executions"."plan_sha256") = 64),
	CONSTRAINT "ck_agent_action_executions_request_digest" CHECK(length("agent_action_executions"."request_sha256") = 64),
	CONSTRAINT "ck_agent_action_executions_key_digest" CHECK(length("agent_action_executions"."idempotency_key_sha256") = 64),
	CONSTRAINT "ck_agent_action_executions_events_json" CHECK(json_valid("agent_action_executions"."agreement_event_ids") = 1 and length("agent_action_executions"."agreement_event_ids") between 2 and 65536),
	CONSTRAINT "ck_agent_action_executions_provenance_json" CHECK(json_valid("agent_action_executions"."provenance") = 1 and length("agent_action_executions"."provenance") between 2 and 65536)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_action_executions_workspace_principal_key` ON `agent_action_executions` (`workspace_id`,`principal_id`,`idempotency_key_sha256`);--> statement-breakpoint
CREATE INDEX `idx_agent_action_executions_workspace_plan` ON `agent_action_executions` (`workspace_id`,`plan_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_action_executions_workspace_started` ON `agent_action_executions` (`workspace_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `agent_action_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`run_id` text,
	`action_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`agreement_id` integer,
	`canonical_input` text NOT NULL,
	`input_sha256` text NOT NULL,
	`plan_sha256` text NOT NULL,
	`expected_version` integer,
	`basis_hash` text,
	`document_version` integer,
	`document_sha256` text,
	`policy_version` text NOT NULL,
	`risk_tier` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`before_snapshot` text,
	`proposed_diff` text NOT NULL,
	`blockers` text NOT NULL,
	`provenance` text NOT NULL,
	`created_by_user_id` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`principal_id`) REFERENCES `service_principals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`) REFERENCES `agent_grants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_agent_action_plans_status" CHECK("agent_action_plans"."status" in ('draft', 'pending_approval', 'approved', 'executing', 'succeeded', 'failed_retryable', 'failed_terminal', 'superseded', 'expired', 'rejected', 'cancelled')),
	CONSTRAINT "ck_agent_action_plans_risk" CHECK("agent_action_plans"."risk_tier" in ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "ck_agent_action_plans_input_digest" CHECK(length("agent_action_plans"."input_sha256") = 64),
	CONSTRAINT "ck_agent_action_plans_plan_digest" CHECK(length("agent_action_plans"."plan_sha256") = 64),
	CONSTRAINT "ck_agent_action_plans_basis" CHECK("agent_action_plans"."basis_hash" is null or length("agent_action_plans"."basis_hash") = 64),
	CONSTRAINT "ck_agent_action_plans_document_digest" CHECK("agent_action_plans"."document_sha256" is null or length("agent_action_plans"."document_sha256") = 64),
	CONSTRAINT "ck_agent_action_plans_input_json" CHECK(json_valid("agent_action_plans"."canonical_input") = 1 and length("agent_action_plans"."canonical_input") between 2 and 262144),
	CONSTRAINT "ck_agent_action_plans_diff_json" CHECK(json_valid("agent_action_plans"."proposed_diff") = 1 and length("agent_action_plans"."proposed_diff") between 2 and 262144),
	CONSTRAINT "ck_agent_action_plans_blockers_json" CHECK(json_valid("agent_action_plans"."blockers") = 1 and length("agent_action_plans"."blockers") between 2 and 65536),
	CONSTRAINT "ck_agent_action_plans_provenance_json" CHECK(json_valid("agent_action_plans"."provenance") = 1 and length("agent_action_plans"."provenance") between 2 and 65536)
);
--> statement-breakpoint
CREATE INDEX `idx_agent_action_plans_workspace_principal_status` ON `agent_action_plans` (`workspace_id`,`principal_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_action_plans_workspace_agreement` ON `agent_action_plans` (`workspace_id`,`agreement_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_action_plans_workspace_expires` ON `agent_action_plans` (`workspace_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `agent_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`delegator_user_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`action_ids` text NOT NULL,
	`resource_constraints` text NOT NULL,
	`policy_version` text NOT NULL,
	`starts_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`revoked_by_user_id` text,
	`revocation_reason` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`principal_id`) REFERENCES `service_principals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`delegator_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_agent_grants_status" CHECK("agent_grants"."status" in ('active', 'revoked')),
	CONSTRAINT "ck_agent_grants_window" CHECK("agent_grants"."expires_at" > "agent_grants"."starts_at"),
	CONSTRAINT "ck_agent_grants_version" CHECK("agent_grants"."version" > 0),
	CONSTRAINT "ck_agent_grants_actions" CHECK(json_valid("agent_grants"."action_ids") = 1 and length("agent_grants"."action_ids") between 2 and 16384),
	CONSTRAINT "ck_agent_grants_resources" CHECK(json_valid("agent_grants"."resource_constraints") = 1 and length("agent_grants"."resource_constraints") between 2 and 65536)
);
--> statement-breakpoint
CREATE INDEX `idx_agent_grants_workspace_principal_status` ON `agent_grants` (`workspace_id`,`principal_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_grants_workspace_delegator` ON `agent_grants` (`workspace_id`,`delegator_user_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_grants_workspace_expiry` ON `agent_grants` (`workspace_id`,`expires_at`);--> statement-breakpoint
CREATE TRIGGER `enforce_agent_grant_cap_insert_v15`
BEFORE INSERT ON `agent_grants`
WHEN NEW.`status` = 'active'
  AND (
    SELECT count(*)
    FROM `agent_grants`
    WHERE `workspace_id` = NEW.`workspace_id`
      AND `principal_id` = NEW.`principal_id`
      AND `status` = 'active'
      AND `expires_at` > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ) >= 50
BEGIN
	SELECT RAISE(ABORT, 'agent_grant_limit_reached');
END;--> statement-breakpoint
CREATE TRIGGER `enforce_agent_grant_cap_update_v15`
BEFORE UPDATE OF `workspace_id`, `principal_id`, `status`, `expires_at` ON `agent_grants`
WHEN NEW.`status` = 'active'
  AND (
    SELECT count(*)
    FROM `agent_grants`
    WHERE `workspace_id` = NEW.`workspace_id`
      AND `principal_id` = NEW.`principal_id`
      AND `status` = 'active'
      AND `expires_at` > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND `id` <> OLD.`id`
  ) >= 50
BEGIN
	SELECT RAISE(ABORT, 'agent_grant_limit_reached');
END;--> statement-breakpoint
CREATE TABLE `agent_plan_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`plan_sha256` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`decided_by_user_id` text NOT NULL,
	`decided_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `agent_action_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_agent_plan_decisions_digest" CHECK(length("agent_plan_decisions"."plan_sha256") = 64),
	CONSTRAINT "ck_agent_plan_decisions_decision" CHECK("agent_plan_decisions"."decision" in ('approved', 'rejected')),
	CONSTRAINT "ck_agent_plan_decisions_reason" CHECK(length(trim("agent_plan_decisions"."reason")) between 3 and 4000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_plan_decisions_workspace_plan` ON `agent_plan_decisions` (`workspace_id`,`plan_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_plan_decisions_workspace_decided` ON `agent_plan_decisions` (`workspace_id`,`decided_at`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`sponsor_user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`model_provider` text,
	`model_id` text,
	`tool_version` text NOT NULL,
	`prompt_sha256` text,
	`context_sha256` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`principal_id`) REFERENCES `service_principals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`) REFERENCES `agent_grants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sponsor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_agent_runs_status" CHECK("agent_runs"."status" in ('running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "ck_agent_runs_prompt_digest" CHECK("agent_runs"."prompt_sha256" is null or length("agent_runs"."prompt_sha256") = 64),
	CONSTRAINT "ck_agent_runs_context_digest" CHECK("agent_runs"."context_sha256" is null or length("agent_runs"."context_sha256") = 64)
);
--> statement-breakpoint
CREATE INDEX `idx_agent_runs_workspace_principal_started` ON `agent_runs` (`workspace_id`,`principal_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_runs_workspace_status` ON `agent_runs` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `service_principals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_seen_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_service_principals_status" CHECK("service_principals"."status" in ('active', 'disabled')),
	CONSTRAINT "ck_service_principals_version" CHECK("service_principals"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_service_principals_workspace_identity` ON `service_principals` (`workspace_id`,`issuer`,`subject`);--> statement-breakpoint
CREATE INDEX `idx_service_principals_workspace_status` ON `service_principals` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TRIGGER `validate_agent_action_plan_agreement_insert_v15`
BEFORE INSERT ON `agent_action_plans`
WHEN (NEW.`resource_type` = 'agreement' AND (
	NEW.`agreement_id` IS NULL
	OR NEW.`resource_id` <> CAST(NEW.`agreement_id` AS text)
	OR NOT EXISTS (
		SELECT 1 FROM `agreements`
		WHERE `workspace_id` = NEW.`workspace_id`
			AND `id` = NEW.`agreement_id`
	)
)) OR (NEW.`resource_type` <> 'agreement' AND NEW.`agreement_id` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'agent_plan_agreement_missing_or_mismatched');
END;--> statement-breakpoint
CREATE TRIGGER `validate_agent_action_plan_agreement_update_v15`
BEFORE UPDATE OF `workspace_id`, `resource_type`, `resource_id`, `agreement_id` ON `agent_action_plans`
WHEN (NEW.`resource_type` = 'agreement' AND (
	NEW.`agreement_id` IS NULL
	OR NEW.`resource_id` <> CAST(NEW.`agreement_id` AS text)
	OR NOT EXISTS (
		SELECT 1 FROM `agreements`
		WHERE `workspace_id` = NEW.`workspace_id`
			AND `id` = NEW.`agreement_id`
	)
)) OR (NEW.`resource_type` <> 'agreement' AND NEW.`agreement_id` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'agent_plan_agreement_missing_or_mismatched');
END;--> statement-breakpoint
CREATE TRIGGER `purge_agent_action_evidence_before_agreement_delete_v15`
BEFORE DELETE ON `agreements`
BEGIN
	DELETE FROM `agent_action_executions`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `plan_id` IN (
			SELECT `id` FROM `agent_action_plans`
			WHERE `workspace_id` = OLD.`workspace_id`
				AND `agreement_id` = OLD.`id`
		);
	DELETE FROM `agent_plan_decisions`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `plan_id` IN (
			SELECT `id` FROM `agent_action_plans`
			WHERE `workspace_id` = OLD.`workspace_id`
				AND `agreement_id` = OLD.`id`
		);
	DELETE FROM `agent_action_plans`
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `agreement_id` = OLD.`id`;
END;--> statement-breakpoint
ALTER TABLE `agreements` ADD `risk_disposition` text;--> statement-breakpoint
ALTER TABLE `agreements` ADD `risk_basis_hash` text;--> statement-breakpoint
ALTER TABLE `agreements` ADD `risk_document_version` integer;--> statement-breakpoint
ALTER TABLE `agreements` ADD `risk_document_sha256` text;--> statement-breakpoint
ALTER TABLE `agreements` ADD `risk_decision_reason` text;--> statement-breakpoint
ALTER TABLE `agreements` ADD `risk_decided_by_user_id` text;--> statement-breakpoint
ALTER TABLE `agreements` ADD `risk_decided_at` text;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `basis_confirmed_at` text;--> statement-breakpoint
UPDATE `agreements`
SET
	`risk` = 'Unassessed',
	`risk_disposition` = NULL,
	`risk_basis_hash` = NULL,
	`risk_document_version` = NULL,
	`risk_document_sha256` = NULL,
	`risk_decision_reason` = NULL,
	`risk_decided_by_user_id` = NULL,
	`risk_decided_at` = NULL,
	`approval_status` = 'Required'
WHERE `stage` <> 'Active' AND `signature_status` <> 'Completed';--> statement-breakpoint
UPDATE `approval_requests`
SET `status` = 'Superseded', `version` = `version` + 1
WHERE `status` IN ('Pending', 'Approved', 'Changes requested')
	AND EXISTS (
		SELECT 1
		FROM `agreements`
		WHERE `agreements`.`workspace_id` = `approval_requests`.`workspace_id`
			AND `agreements`.`id` = `approval_requests`.`agreement_id`
			AND `agreements`.`stage` <> 'Active'
			AND `agreements`.`signature_status` <> 'Completed'
	);--> statement-breakpoint
UPDATE `signature_packets`
SET `status` = 'superseded', `active_key` = NULL, `updated_at` = CURRENT_TIMESTAMP, `version` = `version` + 1
WHERE `active_key` IS NOT NULL
	AND `status` IN ('creating', 'pending', 'partially_signed', 'reconciling', 'archived');--> statement-breakpoint
UPDATE `agreements`
SET `signature_status` = 'Not sent', `stage` = 'Review', `next_action` = 'Assess risk before approval and signature', `version` = `version` + 1, `updated_at` = CURRENT_TIMESTAMP
WHERE `stage` = 'Signature' AND `signature_status` <> 'Completed';--> statement-breakpoint
CREATE TRIGGER `normalize_unassessed_risk_insert`
AFTER INSERT ON `agreements`
WHEN NEW.`risk_disposition` IS NULL AND NEW.`risk` <> 'Unassessed'
BEGIN
	UPDATE `agreements` SET `risk` = 'Unassessed' WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `validate_agreement_risk_insert`
BEFORE INSERT ON `agreements`
WHEN NEW.`risk` NOT IN ('Unassessed', 'Low', 'Medium', 'High')
	OR (NEW.`risk_disposition` NOT IN ('assessed', 'waived') AND NEW.`risk_disposition` IS NOT NULL)
	OR (NEW.`risk_disposition` IS NULL AND (NEW.`risk_basis_hash` IS NOT NULL OR NEW.`risk_document_version` IS NOT NULL OR NEW.`risk_document_sha256` IS NOT NULL))
	OR (NEW.`risk_disposition` IS NOT NULL AND (NEW.`risk_basis_hash` IS NULL OR length(NEW.`risk_basis_hash`) <> 64 OR NEW.`risk_document_version` IS NULL OR NEW.`risk_document_version` <= 0 OR NEW.`risk_document_sha256` IS NULL OR length(NEW.`risk_document_sha256`) <> 64))
BEGIN
	SELECT RAISE(ABORT, 'invalid_agreement_risk');
END;--> statement-breakpoint
CREATE TRIGGER `validate_agreement_risk_update`
BEFORE UPDATE OF `risk`, `risk_disposition`, `risk_basis_hash`, `risk_document_version`, `risk_document_sha256` ON `agreements`
WHEN NEW.`risk` NOT IN ('Unassessed', 'Low', 'Medium', 'High')
	OR (NEW.`risk_disposition` NOT IN ('assessed', 'waived') AND NEW.`risk_disposition` IS NOT NULL)
	OR (NEW.`risk_disposition` IS NULL AND (NEW.`risk_basis_hash` IS NOT NULL OR NEW.`risk_document_version` IS NOT NULL OR NEW.`risk_document_sha256` IS NOT NULL))
	OR (NEW.`risk_disposition` IS NOT NULL AND (NEW.`risk_basis_hash` IS NULL OR length(NEW.`risk_basis_hash`) <> 64 OR NEW.`risk_document_version` IS NULL OR NEW.`risk_document_version` <= 0 OR NEW.`risk_document_sha256` IS NULL OR length(NEW.`risk_document_sha256`) <> 64))
BEGIN
	SELECT RAISE(ABORT, 'invalid_agreement_risk');
END;--> statement-breakpoint
CREATE TRIGGER `validate_agreement_risk_evidence_insert_v15`
BEFORE INSERT ON `agreements`
WHEN (NEW.`risk_disposition` = 'assessed' AND NEW.`risk` NOT IN ('Low', 'Medium', 'High'))
	OR (NEW.`risk_disposition` = 'waived' AND NEW.`risk` <> 'Unassessed')
	OR (NEW.`risk_disposition` IS NULL AND (NEW.`risk_decision_reason` IS NOT NULL OR NEW.`risk_decided_by_user_id` IS NOT NULL OR NEW.`risk_decided_at` IS NOT NULL))
	OR (NEW.`risk_disposition` IS NOT NULL AND (length(trim(coalesce(NEW.`risk_decision_reason`, ''))) = 0 OR length(trim(coalesce(NEW.`risk_decided_by_user_id`, ''))) = 0 OR NEW.`risk_decided_at` IS NULL))
BEGIN
	SELECT RAISE(ABORT, 'invalid_agreement_risk_evidence');
END;--> statement-breakpoint
CREATE TRIGGER `validate_agreement_risk_evidence_update_v15`
BEFORE UPDATE OF `risk`, `risk_disposition`, `risk_basis_hash`, `risk_document_version`, `risk_document_sha256`, `risk_decision_reason`, `risk_decided_by_user_id`, `risk_decided_at` ON `agreements`
WHEN (NEW.`risk_disposition` IS NULL AND NEW.`risk` <> 'Unassessed')
	OR (NEW.`risk_disposition` = 'assessed' AND NEW.`risk` NOT IN ('Low', 'Medium', 'High'))
	OR (NEW.`risk_disposition` = 'waived' AND NEW.`risk` <> 'Unassessed')
	OR (NEW.`risk_disposition` IS NULL AND (NEW.`risk_decision_reason` IS NOT NULL OR NEW.`risk_decided_by_user_id` IS NOT NULL OR NEW.`risk_decided_at` IS NOT NULL))
	OR (NEW.`risk_disposition` IS NOT NULL AND (length(trim(coalesce(NEW.`risk_decision_reason`, ''))) = 0 OR length(trim(coalesce(NEW.`risk_decided_by_user_id`, ''))) = 0 OR NEW.`risk_decided_at` IS NULL))
BEGIN
	SELECT RAISE(ABORT, 'invalid_agreement_risk_evidence');
END;--> statement-breakpoint
CREATE TRIGGER `validate_approval_decision_evidence_insert_v15`
BEFORE INSERT ON `approval_requests`
WHEN NEW.`status` NOT IN ('Pending', 'Approved', 'Changes requested', 'Superseded')
	OR (NEW.`status` = 'Pending' AND (NEW.`decided_by_user_id` IS NOT NULL OR NEW.`decided_at` IS NOT NULL OR NEW.`basis_confirmed_at` IS NOT NULL))
	OR (NEW.`status` IN ('Approved', 'Changes requested') AND (length(trim(NEW.`requested_by_user_id`)) = 0 OR NEW.`decided_by_user_id` IS NULL OR NEW.`decided_at` IS NULL OR NEW.`basis_confirmed_at` IS NULL OR length(NEW.`basis_hash`) <> 64 OR NEW.`document_version` <= 0 OR length(NEW.`document_sha256`) <> 64))
	OR (NEW.`status` = 'Changes requested' AND length(trim(coalesce(NEW.`comment`, ''))) = 0)
BEGIN
	SELECT RAISE(ABORT, 'invalid_approval_decision_evidence');
END;--> statement-breakpoint
CREATE TRIGGER `validate_approval_decision_evidence_update_v15`
BEFORE UPDATE OF `status`, `decided_by_user_id`, `decided_at`, `basis_confirmed_at`, `comment`, `basis_hash`, `document_version`, `document_sha256` ON `approval_requests`
WHEN NEW.`status` NOT IN ('Pending', 'Approved', 'Changes requested', 'Superseded')
	OR (NEW.`status` = 'Pending' AND (NEW.`decided_by_user_id` IS NOT NULL OR NEW.`decided_at` IS NOT NULL OR NEW.`basis_confirmed_at` IS NOT NULL))
	OR (NEW.`status` IN ('Approved', 'Changes requested') AND (length(trim(NEW.`requested_by_user_id`)) = 0 OR NEW.`decided_by_user_id` IS NULL OR NEW.`decided_at` IS NULL OR NEW.`basis_confirmed_at` IS NULL OR length(NEW.`basis_hash`) <> 64 OR NEW.`document_version` <= 0 OR length(NEW.`document_sha256`) <> 64))
	OR (NEW.`status` = 'Changes requested' AND length(trim(coalesce(NEW.`comment`, ''))) = 0)
BEGIN
	SELECT RAISE(ABORT, 'invalid_approval_decision_evidence');
END;--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 15, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary' AND `version` = 14;
