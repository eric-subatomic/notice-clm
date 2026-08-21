CREATE TABLE `notice_schema_state` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `notice_schema_state` (`id`, `version`, `updated_at`)
VALUES ('primary', 5, CURRENT_TIMESTAMP);
