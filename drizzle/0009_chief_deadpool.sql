CREATE TABLE `mutation_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`operation` text NOT NULL,
	`guard_changes` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "ck_mutation_guards_changes" CHECK("mutation_guards"."guard_changes" = 1)
);--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 9, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary';
