CREATE TABLE `obligation_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agreement_id` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`source` text NOT NULL,
	`owner_user_id` text,
	`owner` text NOT NULL,
	`timezone` text NOT NULL,
	`recurrence_unit` text NOT NULL,
	`recurrence_interval` integer NOT NULL,
	`anchor_date` text NOT NULL,
	`end_date` text,
	`reminder_lead_days` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`next_occurrence_number` integer,
	`next_occurrence_date` text,
	`next_materialization_date` text,
	`supersedes_schedule_id` text,
	`created_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_by_user_id` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `ck_obligation_schedules_status` CHECK (`status` in ('active', 'paused', 'ended')),
	CONSTRAINT `ck_obligation_schedules_unit` CHECK (`recurrence_unit` in ('once', 'week', 'month', 'year')),
	CONSTRAINT `ck_obligation_schedules_interval` CHECK (`recurrence_interval` between 1 and 12 and (`recurrence_unit` <> 'once' or `recurrence_interval` = 1)),
	CONSTRAINT `ck_obligation_schedules_reminders` CHECK (json_valid(`reminder_lead_days`) = 1 and json_type(`reminder_lead_days`) = 'array' and json_array_length(`reminder_lead_days`) between 1 and 8 and length(`reminder_lead_days`) between 3 and 128),
	CONSTRAINT `ck_obligation_schedules_end` CHECK (`end_date` is null or `end_date` >= `anchor_date`),
	CONSTRAINT `ck_obligation_schedules_next_cursor` CHECK ((
		`next_occurrence_number` is null and `next_occurrence_date` is null and `next_materialization_date` is null
	) or (
		`next_occurrence_number` > 0 and `next_occurrence_date` is not null and `next_materialization_date` is not null
	))
);--> statement-breakpoint
CREATE INDEX `idx_obligation_schedules_workspace_agreement` ON `obligation_schedules` (`workspace_id`,`agreement_id`);--> statement-breakpoint
CREATE INDEX `idx_obligation_schedules_workspace_status_materialization` ON `obligation_schedules` (`workspace_id`,`status`,`next_materialization_date`);--> statement-breakpoint
CREATE INDEX `idx_obligation_schedules_workspace_owner_status` ON `obligation_schedules` (`workspace_id`,`owner_user_id`,`status`);--> statement-breakpoint
ALTER TABLE `obligations` ADD `schedule_id` text;--> statement-breakpoint
ALTER TABLE `obligations` ADD `occurrence_number` integer;--> statement-breakpoint
ALTER TABLE `obligations` ADD `timezone` text;--> statement-breakpoint
ALTER TABLE `obligations` ADD `reminder_lead_days` text;--> statement-breakpoint
ALTER TABLE `obligations` ADD `next_reminder_date` text;--> statement-breakpoint
ALTER TABLE `obligations` ADD `created_by_user_id` text;--> statement-breakpoint
ALTER TABLE `obligations` ADD `created_at` text;--> statement-breakpoint
INSERT INTO `obligation_schedules` (
	`id`, `workspace_id`, `agreement_id`, `version`, `title`, `source`,
	`owner_user_id`, `owner`, `timezone`, `recurrence_unit`, `recurrence_interval`,
	`anchor_date`, `end_date`, `reminder_lead_days`, `status`,
	`next_occurrence_number`, `next_occurrence_date`, `next_materialization_date`,
	`supersedes_schedule_id`, `created_by_user_id`, `created_at`, `updated_by_user_id`, `updated_at`
)
SELECT
	`id`, `workspace_id`, `agreement_id`, 1, `title`, `source`,
	`owner_user_id`, `owner`, 'Etc/UTC', 'once', 1,
	`due_date`, NULL, '[0]', 'ended',
	NULL, NULL, NULL,
	NULL, NULL, COALESCE(`completed_at`, CURRENT_TIMESTAMP), NULL, COALESCE(`completed_at`, CURRENT_TIMESTAMP)
FROM `obligations`;--> statement-breakpoint
UPDATE `obligations`
SET
	`schedule_id` = `id`,
	`occurrence_number` = 1,
	`timezone` = 'Etc/UTC',
	`reminder_lead_days` = '[0]',
	`next_reminder_date` = CASE
		WHEN `status` = 'Open'
			AND length(`due_date`) = 10
			AND `due_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
			AND date(`due_date`) = `due_date`
		THEN `due_date`
		ELSE NULL
	END,
	`created_by_user_id` = NULL,
	`created_at` = COALESCE(`completed_at`, CURRENT_TIMESTAMP);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_obligations_workspace_schedule_occurrence` ON `obligations` (`workspace_id`,`schedule_id`,`occurrence_number`);--> statement-breakpoint
CREATE INDEX `idx_obligations_workspace_status_next_reminder` ON `obligations` (`workspace_id`,`status`,`next_reminder_date`);--> statement-breakpoint
CREATE INDEX `idx_obligations_workspace_owner_status` ON `obligations` (`workspace_id`,`owner_user_id`,`status`);--> statement-breakpoint
CREATE TABLE `obligation_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agreement_id` integer NOT NULL,
	`obligation_id` text NOT NULL,
	`evidence_text` text NOT NULL,
	`evidence_sha256` text,
	`submitted_by_user_id` text,
	`override_reason` text,
	`provenance` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `ck_obligation_evidence_provenance` CHECK (`provenance` in ('native', 'legacy_v16')),
	CONSTRAINT `ck_obligation_evidence_digest` CHECK ((
		`provenance` = 'native' and length(`evidence_sha256`) = 64
			and lower(`evidence_sha256`) not glob '*[^0-9a-f]*'
	) or (
		`provenance` = 'legacy_v16' and (`evidence_sha256` is null or (
			length(`evidence_sha256`) = 64 and lower(`evidence_sha256`) not glob '*[^0-9a-f]*'
		))
	))
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_obligation_evidence_workspace_obligation` ON `obligation_evidence` (`workspace_id`,`obligation_id`);--> statement-breakpoint
CREATE INDEX `idx_obligation_evidence_workspace_agreement` ON `obligation_evidence` (`workspace_id`,`agreement_id`);--> statement-breakpoint
CREATE TABLE `obligation_creation_receipts` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_sha256` text NOT NULL,
	`agreement_id` integer NOT NULL,
	`schedule_id` text NOT NULL,
	`obligation_id` text NOT NULL,
	`agreement_event_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`, `idempotency_key`),
	CONSTRAINT `ck_obligation_creation_receipts_key` CHECK (length(`idempotency_key`) = 36),
	CONSTRAINT `ck_obligation_creation_receipts_digest` CHECK (length(`request_sha256`) = 64)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_obligation_creation_receipts_workspace_schedule` ON `obligation_creation_receipts` (`workspace_id`,`schedule_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_obligation_creation_receipts_workspace_obligation` ON `obligation_creation_receipts` (`workspace_id`,`obligation_id`);--> statement-breakpoint
CREATE INDEX `idx_obligation_creation_receipts_workspace_agreement` ON `obligation_creation_receipts` (`workspace_id`,`agreement_id`);--> statement-breakpoint
CREATE INDEX `idx_obligation_creation_receipts_workspace_created_at` ON `obligation_creation_receipts` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agreements_workspace_live_updated` ON `agreements` (`workspace_id`,`deleted_at`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_agreements_workspace_live_value` ON `agreements` (`workspace_id`,`deleted_at`,`value`,`id`);--> statement-breakpoint
CREATE INDEX `idx_agreements_workspace_live_risk` ON `agreements` (`workspace_id`,`deleted_at`,`risk`,`id`);--> statement-breakpoint
INSERT INTO `obligation_evidence` (
	`id`, `workspace_id`, `agreement_id`, `obligation_id`, `evidence_text`,
	`evidence_sha256`, `submitted_by_user_id`, `override_reason`, `provenance`, `created_at`
)
SELECT
	`id`, `workspace_id`, `agreement_id`, `id`, `completion_evidence`,
	NULL, `completed_by_user_id`, NULL, 'legacy_v16', COALESCE(`completed_at`, CURRENT_TIMESTAMP)
FROM `obligations`
WHERE `completion_evidence` IS NOT NULL AND length(trim(`completion_evidence`)) > 0;--> statement-breakpoint
CREATE TRIGGER `validate_obligation_schedule_reminders_insert_v17`
BEFORE INSERT ON `obligation_schedules`
WHEN EXISTS (
	SELECT 1 FROM json_each(NEW.`reminder_lead_days`)
	WHERE type <> 'integer' OR value < 0 OR value > 365
)
BEGIN SELECT RAISE(ABORT, 'invalid_obligation_reminder_days'); END;--> statement-breakpoint
CREATE TRIGGER `validate_obligation_schedule_reminders_update_v17`
BEFORE UPDATE OF `reminder_lead_days` ON `obligation_schedules`
WHEN EXISTS (
	SELECT 1 FROM json_each(NEW.`reminder_lead_days`)
	WHERE type <> 'integer' OR value < 0 OR value > 365
)
BEGIN SELECT RAISE(ABORT, 'invalid_obligation_reminder_days'); END;--> statement-breakpoint
CREATE TRIGGER `immutable_obligation_schedule_rule_v17`
BEFORE UPDATE OF `agreement_id`, `title`, `source`, `timezone`, `recurrence_unit`, `recurrence_interval`, `anchor_date`, `end_date`, `reminder_lead_days`, `supersedes_schedule_id`, `created_by_user_id`, `created_at`
ON `obligation_schedules`
BEGIN SELECT RAISE(ABORT, 'immutable_obligation_schedule_rule'); END;--> statement-breakpoint
CREATE TRIGGER `validate_obligation_occurrence_insert_v17`
BEFORE INSERT ON `obligations`
WHEN NEW.`schedule_id` IS NULL
	OR NEW.`occurrence_number` IS NULL
	OR NEW.`occurrence_number` < 1
	OR NEW.`timezone` IS NULL
	OR NEW.`reminder_lead_days` IS NULL
	OR json_valid(NEW.`reminder_lead_days`) <> 1
	OR json_type(NEW.`reminder_lead_days`) <> 'array'
	OR json_array_length(NEW.`reminder_lead_days`) NOT BETWEEN 1 AND 8
	OR length(NEW.`reminder_lead_days`) NOT BETWEEN 3 AND 128
	OR NEW.`created_at` IS NULL
	OR NOT EXISTS (
		SELECT 1 FROM `obligation_schedules` AS `occurrence_schedule`
		WHERE `occurrence_schedule`.`id` = NEW.`schedule_id`
			AND `occurrence_schedule`.`workspace_id` = NEW.`workspace_id`
			AND `occurrence_schedule`.`agreement_id` = NEW.`agreement_id`
	)
	OR EXISTS (
		SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.`reminder_lead_days`) THEN NEW.`reminder_lead_days` ELSE '[]' END)
		WHERE type <> 'integer' OR value < 0 OR value > 365
	)
BEGIN SELECT RAISE(ABORT, 'invalid_obligation_occurrence'); END;--> statement-breakpoint
CREATE TRIGGER `immutable_obligation_occurrence_terms_v17`
BEFORE UPDATE OF `schedule_id`, `occurrence_number`, `agreement_id`, `title`, `due_date`, `cadence`, `source`, `timezone`, `reminder_lead_days`, `created_by_user_id`, `created_at`
ON `obligations`
BEGIN SELECT RAISE(ABORT, 'immutable_obligation_occurrence_terms'); END;--> statement-breakpoint
CREATE TRIGGER `immutable_completed_obligation_v17`
BEFORE UPDATE OF `status`, `completed_by_user_id`, `completed_at`, `completion_evidence`
ON `obligations`
WHEN OLD.`status` = 'Complete' AND (
	NEW.`status` IS NOT OLD.`status`
	OR NEW.`completed_by_user_id` IS NOT OLD.`completed_by_user_id`
	OR NEW.`completed_at` IS NOT OLD.`completed_at`
	OR NEW.`completion_evidence` IS NOT OLD.`completion_evidence`
)
BEGIN SELECT RAISE(ABORT, 'immutable_completed_obligation'); END;--> statement-breakpoint
CREATE TRIGGER `validate_obligation_evidence_insert_v17`
BEFORE INSERT ON `obligation_evidence`
WHEN length(trim(NEW.`evidence_text`)) = 0
	OR NEW.`created_at` IS NULL
	OR (NEW.`provenance` = 'native' AND NEW.`submitted_by_user_id` IS NULL)
	OR NOT EXISTS (
		SELECT 1 FROM `obligations` AS `evidence_occurrence`
		WHERE `evidence_occurrence`.`workspace_id` = NEW.`workspace_id`
			AND `evidence_occurrence`.`agreement_id` = NEW.`agreement_id`
			AND `evidence_occurrence`.`id` = NEW.`obligation_id`
			AND `evidence_occurrence`.`status` = 'Complete'
			AND `evidence_occurrence`.`completion_evidence` = NEW.`evidence_text`
			AND (NEW.`provenance` <> 'native' OR `evidence_occurrence`.`completed_by_user_id` = NEW.`submitted_by_user_id`)
	)
BEGIN SELECT RAISE(ABORT, 'invalid_obligation_evidence'); END;--> statement-breakpoint
CREATE TRIGGER `immutable_obligation_evidence_update_v17`
BEFORE UPDATE ON `obligation_evidence`
BEGIN SELECT RAISE(ABORT, 'immutable_obligation_evidence'); END;--> statement-breakpoint
CREATE TRIGGER `protect_active_obligation_evidence_delete_v17`
BEFORE DELETE ON `obligation_evidence`
WHEN EXISTS (
	SELECT 1 FROM `agreements` AS `evidence_parent`
	WHERE `evidence_parent`.`workspace_id` = OLD.`workspace_id`
		AND `evidence_parent`.`id` = OLD.`agreement_id`
		AND `evidence_parent`.`deleted_at` IS NULL
)
BEGIN SELECT RAISE(ABORT, 'active_obligation_evidence_immutable'); END;--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 17, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary' AND `version` = 16;
