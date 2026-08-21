CREATE TABLE `language_blocks` (
	`id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`profile` text NOT NULL,
	`summary` text NOT NULL,
	`language` text NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL
);
