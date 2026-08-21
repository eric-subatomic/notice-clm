ALTER TABLE `outbox_deliveries` ADD `crm_provider` text;--> statement-breakpoint
ALTER TABLE `outbox_deliveries` ADD `crm_mapping_version` text;--> statement-breakpoint
ALTER TABLE `outbox_deliveries` ADD `crm_destination_fingerprint` text;--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 12, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary';
