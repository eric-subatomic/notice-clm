ALTER TABLE `negotiation_rounds` ADD `portal_upload_attempts` integer DEFAULT 0 NOT NULL
	CONSTRAINT "ck_negotiation_rounds_portal_upload_attempts" CHECK(`portal_upload_attempts` BETWEEN 0 AND 10);--> statement-breakpoint
ALTER TABLE `negotiation_rounds` ADD `portal_upload_accepted` integer DEFAULT 0 NOT NULL
	CONSTRAINT "ck_negotiation_rounds_portal_upload_accepted" CHECK(`portal_upload_accepted` BETWEEN 0 AND 4);--> statement-breakpoint
ALTER TABLE `negotiation_rounds` ADD `portal_upload_rejected` integer DEFAULT 0 NOT NULL
	CONSTRAINT "ck_negotiation_rounds_portal_upload_rejected" CHECK(`portal_upload_rejected` BETWEEN 0 AND 6);--> statement-breakpoint
ALTER TABLE `negotiation_rounds` ADD `portal_upload_bytes` integer DEFAULT 0 NOT NULL
	CONSTRAINT "ck_negotiation_rounds_portal_upload_bytes" CHECK(`portal_upload_bytes` BETWEEN 0 AND 100663296);--> statement-breakpoint
ALTER TABLE `negotiation_rounds` ADD `portal_upload_reservation_id` text;--> statement-breakpoint
ALTER TABLE `negotiation_rounds` ADD `portal_upload_reservation_expires_at` text;--> statement-breakpoint
ALTER TABLE `negotiation_rounds` ADD `portal_upload_reservation_bytes` integer
	CONSTRAINT "ck_negotiation_rounds_portal_upload_reservation" CHECK(
		(
			`portal_upload_reservation_id` IS NULL
			AND `portal_upload_reservation_expires_at` IS NULL
			AND `portal_upload_reservation_bytes` IS NULL
			AND `portal_upload_attempts` = `portal_upload_accepted` + `portal_upload_rejected`
		)
		OR (
			`portal_upload_reservation_id` IS NOT NULL
			AND `portal_upload_reservation_expires_at` IS NOT NULL
			AND `portal_upload_reservation_bytes` BETWEEN 1 AND 22020096
			AND `portal_upload_attempts` = `portal_upload_accepted` + `portal_upload_rejected` + 1
		)
	);--> statement-breakpoint
ALTER TABLE `negotiation_rounds` ADD `portal_download_attempts` integer DEFAULT 0 NOT NULL
	CONSTRAINT "ck_negotiation_rounds_portal_download_attempts" CHECK(`portal_download_attempts` BETWEEN 0 AND 20);--> statement-breakpoint
ALTER TABLE `negotiation_rounds` ADD `portal_download_bytes` integer DEFAULT 0 NOT NULL
	CONSTRAINT "ck_negotiation_rounds_portal_download_bytes" CHECK(`portal_download_bytes` BETWEEN 0 AND 268435456);--> statement-breakpoint
UPDATE `notice_schema_state`
SET `version` = 21, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'primary' AND `version` = 20;
