CREATE TABLE `agreements` (
	`id` integer PRIMARY KEY NOT NULL,
	`party` text NOT NULL,
	`initials` text NOT NULL,
	`side` text NOT NULL,
	`type` text NOT NULL,
	`value` integer DEFAULT 0 NOT NULL,
	`stage` text NOT NULL,
	`owner` text NOT NULL,
	`next_action` text NOT NULL,
	`due` text NOT NULL,
	`crm` text NOT NULL,
	`crm_record` text NOT NULL,
	`tags` text NOT NULL,
	`updated` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`agreement_id` integer,
	`file_name` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`tags` text NOT NULL,
	`extracted` text NOT NULL,
	`created_at` text NOT NULL
);
