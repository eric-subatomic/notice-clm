ALTER TABLE `approval_requests` ADD `source_agent_plan_id` text
	CONSTRAINT `ck_approval_requests_source_agent_plan_id`
	CHECK (
		`source_agent_plan_id` IS NULL OR (
			length(`source_agent_plan_id`) = 36
			AND substr(`source_agent_plan_id`, 9, 1) = '-'
			AND substr(`source_agent_plan_id`, 14, 1) = '-'
			AND substr(`source_agent_plan_id`, 19, 1) = '-'
			AND substr(`source_agent_plan_id`, 24, 1) = '-'
			AND length(replace(`source_agent_plan_id`, '-', '')) = 32
			AND lower(replace(`source_agent_plan_id`, '-', '')) NOT GLOB '*[^0-9a-f]*'
		)
	);--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `source_agent_plan_reviewer_user_id` text
	CONSTRAINT `ck_approval_requests_source_agent_plan_reviewer`
	CHECK (
		`source_agent_plan_reviewer_user_id` IS NULL OR (
			length(`source_agent_plan_reviewer_user_id`) = 36
			AND substr(`source_agent_plan_reviewer_user_id`, 9, 1) = '-'
			AND substr(`source_agent_plan_reviewer_user_id`, 14, 1) = '-'
			AND substr(`source_agent_plan_reviewer_user_id`, 19, 1) = '-'
			AND substr(`source_agent_plan_reviewer_user_id`, 24, 1) = '-'
			AND length(replace(`source_agent_plan_reviewer_user_id`, '-', '')) = 32
			AND lower(replace(`source_agent_plan_reviewer_user_id`, '-', '')) NOT GLOB '*[^0-9a-f]*'
		)
	);--> statement-breakpoint
ALTER TABLE `agreement_events` ADD `source_agent_plan_id` text
	CONSTRAINT `ck_agreement_events_source_agent_plan_id`
	CHECK (
		`source_agent_plan_id` IS NULL OR (
			length(`source_agent_plan_id`) = 36
			AND substr(`source_agent_plan_id`, 9, 1) = '-'
			AND substr(`source_agent_plan_id`, 14, 1) = '-'
			AND substr(`source_agent_plan_id`, 19, 1) = '-'
			AND substr(`source_agent_plan_id`, 24, 1) = '-'
			AND length(replace(`source_agent_plan_id`, '-', '')) = 32
			AND lower(replace(`source_agent_plan_id`, '-', '')) NOT GLOB '*[^0-9a-f]*'
		)
	);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_workspace_source_agent_plan`
	ON `approval_requests` (`workspace_id`, `source_agent_plan_id`);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_workspace_agent_plan_reviewer`
	ON `approval_requests` (`workspace_id`, `source_agent_plan_reviewer_user_id`);--> statement-breakpoint
CREATE INDEX `idx_agreement_events_workspace_source_agent_plan`
	ON `agreement_events` (`workspace_id`, `source_agent_plan_id`);--> statement-breakpoint
DROP TRIGGER IF EXISTS `purge_agent_action_evidence_before_agreement_delete_v15`;--> statement-breakpoint
CREATE TRIGGER `purge_agent_action_evidence_before_agreement_delete_v16`
BEFORE DELETE ON `agreements`
BEGIN
	UPDATE `agent_runs`
	SET
		`purpose` = 'Retention-purged agreement run',
		`model_provider` = NULL,
		`model_id` = NULL,
		`tool_version` = 'retention-redacted',
		`prompt_sha256` = NULL,
		`context_sha256` = NULL
	WHERE `workspace_id` = OLD.`workspace_id`
		AND `id` IN (
			SELECT `run_id` FROM `agent_action_plans`
			WHERE `workspace_id` = OLD.`workspace_id`
				AND `agreement_id` = OLD.`id`
				AND `run_id` IS NOT NULL
		);
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
UPDATE `notice_schema_state`
SET `version` = 16, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary' AND `version` = 15;
