CREATE TABLE `outbox_deliveries` (
	`event_id` text NOT NULL,
	`sink` text NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` text NOT NULL,
	`accepted_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`event_id`, `sink`),
	FOREIGN KEY (`event_id`) REFERENCES `outbox_events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_outbox_deliveries_sink" CHECK("outbox_deliveries"."sink" in ('delivery', 'crm')),
	CONSTRAINT "ck_outbox_deliveries_status" CHECK("outbox_deliveries"."status" in ('pending', 'accepted', 'dead'))
);
--> statement-breakpoint
CREATE INDEX `idx_outbox_deliveries_workspace_status_available_at` ON `outbox_deliveries` (`workspace_id`,`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `idx_outbox_deliveries_workspace_event` ON `outbox_deliveries` (`workspace_id`,`event_id`);--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 10, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary';
