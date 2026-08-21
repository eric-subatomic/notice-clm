import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NOTICE_SCHEMA_VERSION } from "../db/schema-guard";

const migrationNames = [
  "0000_wonderful_satana.sql",
  "0001_panoramic_imperial_guard.sql",
  "0002_ordinary_the_call.sql",
  "0003_bumpy_viper.sql",
  "0004_neat_madelyne_pryor.sql",
  "0005_lonely_randall_flagg.sql",
  "0006_harsh_screwball.sql",
  "0007_lovely_earthquake.sql",
  "0008_steep_lila_cheney.sql",
  "0009_chief_deadpool.sql",
  "0010_melodic_wither.sql",
  "0011_sad_roughhouse.sql",
  "0012_narrow_chronomancer.sql",
  "0013_wild_sunfire.sql",
  "0014_wide_sleeper.sql",
  "0015_overjoyed_randall.sql",
  "0016_blue_aaron_stack.sql",
  "0017_recurring_obligations.sql",
  "0018_enterprise_foundations.sql",
  "0019_romantic_kabuki.sql",
  "0020_sweet_stark_industries.sql",
  "0021_silent_talos.sql",
] as const;

function applyMigration(database: DatabaseSync, name: string) {
  const sql = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) database.exec(statement);
  }
}

test("the latest migration journal entry has a chained schema snapshot", () => {
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const latest = journal.entries.at(-1) as { idx: number; tag: string };
  const previous = journal.entries.at(-2) as { idx: number; tag: string };
  assert.equal(`${latest.tag}.sql`, migrationNames.at(-1));

  const latestPrefix = latest.tag.slice(0, 4);
  const previousPrefix = previous.tag.slice(0, 4);
  const snapshot = JSON.parse(readFileSync(new URL(`../drizzle/meta/${latestPrefix}_snapshot.json`, import.meta.url), "utf8"));
  const previousSnapshot = JSON.parse(readFileSync(new URL(`../drizzle/meta/${previousPrefix}_snapshot.json`, import.meta.url), "utf8"));
  assert.equal(snapshot.prevId, previousSnapshot.id);
  assert.ok(snapshot.tables.obligation_schedules);
  assert.ok(snapshot.tables.obligation_evidence);
  assert.ok(snapshot.tables.obligation_creation_receipts);
  assert.ok(snapshot.tables.counterparties);
  assert.ok(snapshot.tables.legal_entities);
  assert.ok(snapshot.tables.governed_templates);
  assert.ok(snapshot.tables.governed_template_creation_receipts);
  assert.ok(snapshot.tables.clause_playbook_creation_receipts);
  for (const column of [
    "portal_upload_attempts",
    "portal_upload_accepted",
    "portal_upload_rejected",
    "portal_upload_bytes",
    "portal_upload_reservation_id",
    "portal_upload_reservation_expires_at",
    "portal_upload_reservation_bytes",
    "portal_download_attempts",
    "portal_download_bytes",
  ]) assert.ok(snapshot.tables.negotiation_rounds.columns[column]);
  for (const constraint of [
    "ck_negotiation_rounds_portal_upload_attempts",
    "ck_negotiation_rounds_portal_upload_accepted",
    "ck_negotiation_rounds_portal_upload_rejected",
    "ck_negotiation_rounds_portal_upload_bytes",
    "ck_negotiation_rounds_portal_upload_reservation",
    "ck_negotiation_rounds_portal_download_attempts",
    "ck_negotiation_rounds_portal_download_bytes",
  ]) assert.ok(snapshot.tables.negotiation_rounds.checkConstraints[constraint]);
  assert.ok(snapshot.tables.workflow_definitions);
  assert.ok(snapshot.tables.approval_lane_authorities.indexes.uq_approval_lane_authorities_active_identity);
  assert.match(
    snapshot.tables.approval_lane_authorities.indexes.uq_approval_lane_authorities_active_identity.where,
    /status.*active/i,
  );
  assert.equal(snapshot.tables.approval_lane_authorities.indexes.uq_approval_lane_authorities_workspace_lane_subject_currency, undefined);
  assert.ok(snapshot.tables.agreement_parties.indexes.uq_agreement_parties_legal_entity_identity);
  assert.ok(snapshot.tables.agreement_parties.indexes.uq_agreement_parties_counterparty_identity);
});

test("portal transfer budgets migrate additively, preserve rounds, enforce reservation state, and advance marker 20 to 21 last", () => {
  const migrationName = "0021_silent_talos.sql";
  const migration = readFileSync(new URL(`../drizzle/${migrationName}`, import.meta.url), "utf8");
  assert.doesNotMatch(migration, /DROP TABLE|__new_|PRAGMA foreign_keys/i);
  assert.equal((migration.match(/ALTER TABLE/g) ?? []).length, 9);
  assert.match(migration, /portal_upload_attempts[\s\S]*BETWEEN 0 AND 10/);
  assert.match(migration, /portal_upload_accepted[\s\S]*BETWEEN 0 AND 4/);
  assert.match(migration, /portal_upload_rejected[\s\S]*BETWEEN 0 AND 6/);
  assert.match(migration, /portal_upload_reservation_id[\s\S]*portal_upload_attempts[\s\S]*portal_upload_accepted[\s\S]*portal_upload_rejected/);
  assert.match(migration, /portal_download_attempts[\s\S]*BETWEEN 0 AND 20/);
  assert.match(
    migration.trim(),
    /UPDATE `notice_schema_state`\s+SET `version` = 21, `updated_at` = CURRENT_TIMESTAMP\s+WHERE `id` = 'primary' AND `version` = 20;$/,
  );

  const database = new DatabaseSync(":memory:");
  try {
    for (const name of migrationNames.slice(0, migrationNames.indexOf(migrationName))) applyMigration(database, name);
    database.exec(`INSERT INTO negotiation_rounds (
      id, workspace_id, agreement_id, round_number, status, active_key, alias_code,
      base_document_version, base_sha256, outbound_document_id, outbound_sha256,
      portal_token_hash, portal_expires_at, created_by_user_id, created_at, updated_at
    ) VALUES (
      'legacy-portal-round', 'workspace-portal', 21, 1, 'outbound', 'agreement:21', 'portal-alias',
      1, '${"a".repeat(64)}', 'outbound-21', '${"b".repeat(64)}', '${"c".repeat(64)}',
      '2026-09-01T00:00:00.000Z', 'user-portal', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
    )`);

    applyMigration(database, migrationName);
    const migrated = database.prepare(`SELECT portal_upload_attempts AS attempts,
      portal_upload_accepted AS accepted, portal_upload_rejected AS rejected,
      portal_upload_bytes AS uploadBytes, portal_upload_reservation_id AS reservationId,
      portal_download_attempts AS downloadAttempts, portal_download_bytes AS downloadBytes
      FROM negotiation_rounds WHERE id = 'legacy-portal-round'`).get();
    assert.deepEqual({ ...migrated }, {
      attempts: 0,
      accepted: 0,
      rejected: 0,
      uploadBytes: 0,
      reservationId: null,
      downloadAttempts: 0,
      downloadBytes: 0,
    });
    assert.throws(
      () => database.exec("UPDATE negotiation_rounds SET portal_upload_attempts = 11 WHERE id = 'legacy-portal-round'"),
      /ck_negotiation_rounds_portal_upload_attempts/,
    );
    database.exec(`UPDATE negotiation_rounds SET
      portal_upload_attempts = 1,
      portal_upload_bytes = 22020096,
      portal_upload_reservation_id = 'reservation-21',
      portal_upload_reservation_expires_at = '2026-08-20T00:05:00.000Z',
      portal_upload_reservation_bytes = 22020096
      WHERE id = 'legacy-portal-round'`);
    assert.throws(
      () => database.exec(`UPDATE negotiation_rounds SET
        portal_upload_reservation_id = NULL,
        portal_upload_reservation_expires_at = NULL,
        portal_upload_reservation_bytes = NULL
        WHERE id = 'legacy-portal-round'`),
      /ck_negotiation_rounds_portal_upload_reservation/,
    );
    database.exec(`UPDATE negotiation_rounds SET
      portal_upload_accepted = 1,
      portal_upload_bytes = 1024,
      portal_upload_reservation_id = NULL,
      portal_upload_reservation_expires_at = NULL,
      portal_upload_reservation_bytes = NULL
      WHERE id = 'legacy-portal-round'`);
    assert.throws(
      () => database.exec("UPDATE negotiation_rounds SET portal_download_attempts = 21 WHERE id = 'legacy-portal-round'"),
      /ck_negotiation_rounds_portal_download_attempts/,
    );
    assert.equal(database.prepare("SELECT version FROM notice_schema_state WHERE id = 'primary'").get()?.version, 21);
  } finally {
    database.close();
  }
});

test("agent mutation attribution migration is additive, preserves v15 rows, and advances marker 15 to 16 last", () => {
  const migrationName = "0016_blue_aaron_stack.sql";
  const migration = readFileSync(new URL(`../drizzle/${migrationName}`, import.meta.url), "utf8");
  assert.doesNotMatch(migration, /DROP TABLE|__new_|PRAGMA foreign_keys/i);
  for (const column of ["source_agent_plan_id", "source_agent_plan_reviewer_user_id"]) {
    assert.ok(migration.includes("ALTER TABLE `approval_requests` ADD `" + column + "` text"));
  }
  assert.match(migration, /ALTER TABLE `agreement_events` ADD `source_agent_plan_id` text/);
  assert.equal((migration.match(/ALTER TABLE/g) ?? []).length, 3);
  assert.match(migration, /DROP TRIGGER IF EXISTS `purge_agent_action_evidence_before_agreement_delete_v15`/);
  assert.match(migration, /CREATE TRIGGER `purge_agent_action_evidence_before_agreement_delete_v16`/);
  assert.match(migration, /UPDATE `agent_runs`[\s\S]*`purpose` = 'Retention-purged agreement run'[\s\S]*`context_sha256` = NULL/);
  assert.match(migration, /length\(replace\(`source_agent_plan_id`, '-', ''\)\) = 32/);
  assert.match(
    migration.trim(),
    /UPDATE `notice_schema_state`\s+SET `version` = 16, `updated_at` = CURRENT_TIMESTAMP\s+WHERE `id` = 'primary' AND `version` = 15;$/,
  );

  const snapshot = JSON.parse(readFileSync(new URL("../drizzle/meta/0016_snapshot.json", import.meta.url), "utf8"));
  assert.ok(snapshot.tables.approval_requests.columns.source_agent_plan_id);
  assert.ok(snapshot.tables.approval_requests.columns.source_agent_plan_reviewer_user_id);
  assert.ok(snapshot.tables.approval_requests.indexes.idx_approval_requests_workspace_source_agent_plan);
  assert.ok(snapshot.tables.approval_requests.indexes.idx_approval_requests_workspace_agent_plan_reviewer);
  assert.match(snapshot.tables.approval_requests.checkConstraints.ck_approval_requests_source_agent_plan_id.value, /length\(replace[\s\S]*= 32/);
  assert.ok(snapshot.tables.agreement_events.columns.source_agent_plan_id);
  assert.ok(snapshot.tables.agreement_events.indexes.idx_agreement_events_workspace_source_agent_plan);

  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  assert.ok(journal.entries.some((entry: { tag?: string }) => entry.tag === "0016_blue_aaron_stack"));

  const bootstrap = readFileSync(new URL("../db/ensure.ts", import.meta.url), "utf8");
  for (const column of ["source_agent_plan_id", "source_agent_plan_reviewer_user_id"]) {
    assert.ok(bootstrap.includes(column + ": `text CONSTRAINT"));
  }
  for (const index of [
    "idx_approval_requests_workspace_source_agent_plan",
    "idx_approval_requests_workspace_agent_plan_reviewer",
    "idx_agreement_events_workspace_source_agent_plan",
  ]) assert.match(bootstrap, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}`));
  assert.match(bootstrap, /purge_agent_action_evidence_before_agreement_delete_v16/);
  assert.match(bootstrap, /UPDATE agent_runs[\s\S]*purpose = 'Retention-purged agreement run'[\s\S]*context_sha256 = NULL/);

  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of migrationNames.slice(0, migrationNames.indexOf(migrationName))) applyMigration(database, name);
    database.exec(`
      INSERT INTO approval_requests (
        id, workspace_id, version, agreement_id, role, requested_by_user_id,
        approver, status, due, created_at
      ) VALUES (
        'legacy-approval', 'workspace-attribution', 1, 901, 'Legal', 'legacy-requester',
        'Legal queue', 'Pending', '2026-08-31', '2026-08-19T12:00:00.000Z'
      );
      INSERT INTO agreement_events (
        id, workspace_id, agreement_id, type, actor, detail, sequence, created_at
      ) VALUES (
        'legacy-event', 'workspace-attribution', 901, 'Approval requested',
        'Legacy actor', 'Legacy event', 1, '2026-08-19T12:00:00.000Z'
      );
    `);

    applyMigration(database, migrationName);

    const legacyApproval = database.prepare(`SELECT
      requested_by_user_id AS requestedByUserId,
      source_agent_plan_id AS sourceAgentPlanId,
      source_agent_plan_reviewer_user_id AS sourceAgentPlanReviewerUserId
      FROM approval_requests WHERE id = 'legacy-approval'`).get() as {
        requestedByUserId: string;
        sourceAgentPlanId: string | null;
        sourceAgentPlanReviewerUserId: string | null;
      };
    assert.deepEqual({ ...legacyApproval }, {
      requestedByUserId: "legacy-requester",
      sourceAgentPlanId: null,
      sourceAgentPlanReviewerUserId: null,
    });
    assert.equal(
      database.prepare("SELECT source_agent_plan_id AS sourceAgentPlanId FROM agreement_events WHERE id = 'legacy-event'").get()?.sourceAgentPlanId,
      null,
    );

    const validPlanId = "123e4567-e89b-42d3-a456-426614174000";
    const validReviewerId = "223e4567-e89b-42d3-a456-426614174000";
    database.prepare(`UPDATE approval_requests
      SET source_agent_plan_id = ?, source_agent_plan_reviewer_user_id = ?
      WHERE id = 'legacy-approval'`).run(validPlanId, validReviewerId);
    database.prepare("UPDATE agreement_events SET source_agent_plan_id = ? WHERE id = 'legacy-event'").run(validPlanId);

    for (const invalid of [
      "not-a-uuid",
      "123e4567-e89b-42d3-a456-42661417400g",
      "00000000-0000-0000-0000-00000-000000",
    ]) {
      assert.throws(
        () => database.prepare("UPDATE approval_requests SET source_agent_plan_id = ? WHERE id = 'legacy-approval'").run(invalid),
        /CHECK constraint failed: ck_approval_requests_source_agent_plan_id/,
      );
      assert.throws(
        () => database.prepare("UPDATE approval_requests SET source_agent_plan_reviewer_user_id = ? WHERE id = 'legacy-approval'").run(invalid),
        /CHECK constraint failed: ck_approval_requests_source_agent_plan_reviewer/,
      );
      assert.throws(
        () => database.prepare("UPDATE agreement_events SET source_agent_plan_id = ? WHERE id = 'legacy-event'").run(invalid),
        /CHECK constraint failed: ck_agreement_events_source_agent_plan_id/,
      );
    }

    const indexes = new Set((database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>).map((row) => row.name));
    for (const name of [
      "idx_approval_requests_workspace_source_agent_plan",
      "idx_approval_requests_workspace_agent_plan_reviewer",
      "idx_agreement_events_workspace_source_agent_plan",
    ]) assert.equal(indexes.has(name), true, `missing attribution index ${name}`);
    assert.equal(
      database.prepare("SELECT version FROM notice_schema_state WHERE id = 'primary'").get()?.version,
      16,
    );
  } finally {
    database.close();
  }
});

test("a failed attribution migration rolls back without claiming schema 16", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const name of migrationNames.slice(0, migrationNames.indexOf("0016_blue_aaron_stack.sql"))) applyMigration(database, name);
    database.exec("CREATE INDEX idx_approval_requests_workspace_source_agent_plan ON approval_requests(workspace_id)");
    database.exec("BEGIN");
    assert.throws(
      () => applyMigration(database, "0016_blue_aaron_stack.sql"),
      /index idx_approval_requests_workspace_source_agent_plan already exists/,
    );
    database.exec("ROLLBACK");

    const columns = new Set((database.prepare("PRAGMA table_info(approval_requests)").all() as Array<{ name: string }>).map((row) => row.name));
    assert.equal(columns.has("source_agent_plan_id"), false);
    assert.equal(columns.has("source_agent_plan_reviewer_user_id"), false);
    assert.equal(
      database.prepare("SELECT version FROM notice_schema_state WHERE id = 'primary'").get()?.version,
      15,
    );
  } finally {
    database.close();
  }
});

test("recurring obligations migration preserves legacy rows and enforces immutable occurrence evidence", () => {
  const migrationName = "0017_recurring_obligations.sql";
  const migration = readFileSync(new URL(`../drizzle/${migrationName}`, import.meta.url), "utf8");
  assert.doesNotMatch(migration, /DROP TABLE|__new_|PRAGMA foreign_keys/i);
  assert.match(migration, /date\(`due_date`\) = `due_date`/);
  assert.match(migration, /json_valid\(NEW\.`reminder_lead_days`\)[\s\S]*json_type\(NEW\.`reminder_lead_days`\)[\s\S]*json_array_length/);
  assert.match(migration, /immutable_completed_obligation_v17/);
  assert.match(
    migration.trim(),
    /UPDATE `notice_schema_state`\s+SET `version` = 17, `updated_at` = CURRENT_TIMESTAMP\s+WHERE `id` = 'primary' AND `version` = 16;$/,
  );
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  assert.ok(journal.entries.some((entry: { tag?: string }) => entry.tag === migrationName.replace(/\.sql$/, "")));

  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of migrationNames.slice(0, migrationNames.indexOf(migrationName))) applyMigration(database, name);
    database.exec(`
      INSERT INTO workspaces (id, slug, name, status, created_at, updated_at)
      VALUES ('workspace-obligation', 'workspace-obligation', 'Obligation workspace', 'active', '2026-01-01', '2026-01-01');
      INSERT INTO agreements (
        id, workspace_id, version, party, initials, side, type, stage, owner,
        next_action, due, crm, crm_record, tags, updated
      ) VALUES (
        1701, 'workspace-obligation', 1, 'Orchid', 'OR', 'Sell-side', 'MSA', 'Active', 'Owner',
        'Manage obligations', '2026-12-31', 'None', '', '[]', '2026-01-01'
      );
      INSERT INTO obligations (
        id, workspace_id, version, agreement_id, title, due_date, owner, owner_user_id,
        status, completed_by_user_id, completed_at, completion_evidence, cadence, source
      ) VALUES
        ('legacy-valid', 'workspace-obligation', 2, 1701, 'Valid legacy', '2026-12-31', 'Owner', 'owner-a',
          'Open', NULL, NULL, NULL, 'Quarterly', 'Legacy clause'),
        ('legacy-invalid-date', 'workspace-obligation', 1, 1701, 'Invalid date', '2026-99-99', 'Owner', 'owner-a',
          'Open', NULL, NULL, NULL, 'Monthly', 'Legacy import'),
        ('legacy-complete', 'workspace-obligation', 4, 1701, 'Completed legacy', '2026-08-01', 'Owner', 'owner-a',
          'Complete', 'owner-a', '2026-08-02T12:00:00.000Z', 'Filed receipt 42', 'Annual', 'Legacy evidence');
    `);

    applyMigration(database, migrationName);
    assert.equal(database.prepare("SELECT version FROM notice_schema_state WHERE id = 'primary'").get()?.version, 17);

    const schedules = database.prepare(`SELECT id, recurrence_unit AS unit, recurrence_interval AS interval,
      status, next_occurrence_number AS nextNumber FROM obligation_schedules ORDER BY id`).all() as Array<{
        id: string; unit: string; interval: number; status: string; nextNumber: number | null;
      }>;
    assert.equal(schedules.length, 3);
    assert.deepEqual(schedules.map(({ unit, interval, status, nextNumber }) => ({ unit, interval, status, nextNumber })), [
      { unit: "once", interval: 1, status: "ended", nextNumber: null },
      { unit: "once", interval: 1, status: "ended", nextNumber: null },
      { unit: "once", interval: 1, status: "ended", nextNumber: null },
    ]);
    assert.equal(database.prepare("SELECT next_reminder_date AS value FROM obligations WHERE id = 'legacy-valid'").get()?.value, "2026-12-31");
    assert.equal(database.prepare("SELECT next_reminder_date AS value FROM obligations WHERE id = 'legacy-invalid-date'").get()?.value, null);
    assert.equal(database.prepare("SELECT cadence FROM obligations WHERE id = 'legacy-valid'").get()?.cadence, "Quarterly");
    const evidence = database.prepare(`SELECT evidence_text AS text, evidence_sha256 AS digest, provenance
      FROM obligation_evidence WHERE obligation_id = 'legacy-complete'`).get() as { text: string; digest: string | null; provenance: string };
    assert.deepEqual({ ...evidence }, { text: "Filed receipt 42", digest: null, provenance: "legacy_v16" });

    database.exec(`INSERT INTO obligation_schedules (
      id, workspace_id, agreement_id, version, title, source, owner_user_id, owner,
      timezone, recurrence_unit, recurrence_interval, anchor_date, end_date,
      reminder_lead_days, status, next_occurrence_number, next_occurrence_date,
      next_materialization_date, supersedes_schedule_id, created_by_user_id,
      created_at, updated_by_user_id, updated_at
    ) VALUES (
      'schedule-new', 'workspace-obligation', 1701, 1, 'New schedule', 'Clause 9', 'owner-a', 'Owner',
      'Etc/UTC', 'month', 1, '2027-01-31', NULL, '[30,0]', 'active', 2, '2027-02-28',
      '2027-01-29', NULL, 'creator-a', '2026-08-19T12:00:00.000Z', 'creator-a', '2026-08-19T12:00:00.000Z'
    )`);
    const occurrenceInsert = database.prepare(`INSERT INTO obligations (
      id, workspace_id, version, agreement_id, schedule_id, occurrence_number,
      title, due_date, owner, owner_user_id, status, completed_by_user_id,
      completed_at, completion_evidence, cadence, source, timezone,
      reminder_lead_days, next_reminder_date, created_by_user_id, created_at
    ) VALUES (?, 'workspace-obligation', 1, 1701, 'schedule-new', ?,
      'New occurrence', '2027-01-31', 'Owner', 'owner-a', 'Open', NULL,
      NULL, NULL, 'Monthly', 'Clause 9', 'Etc/UTC', ?, '2027-01-01', 'creator-a', '2026-08-19T12:00:00.000Z')`);
    for (const [id, occurrenceNumber, reminderJson] of [
      ["invalid-empty", 2, "[]"],
      ["invalid-scalar", 3, "1"],
      ["invalid-range", 4, "[366]"],
      ["invalid-fraction", 5, "[1.5]"],
      ["invalid-json", 6, "not-json"],
    ] as const) {
      assert.throws(() => occurrenceInsert.run(id, occurrenceNumber, reminderJson), /invalid_obligation_occurrence|CHECK constraint failed/);
    }
    occurrenceInsert.run("valid-new", 7, "[30,0]");

    database.exec(`UPDATE obligations SET status = 'Complete', completed_by_user_id = 'owner-a',
      completed_at = '2027-02-01T00:00:00.000Z', completion_evidence = 'Native evidence'
      WHERE id = 'valid-new'`);
    assert.throws(
      () => database.exec(`INSERT INTO obligation_evidence (
        id, workspace_id, agreement_id, obligation_id, evidence_text, evidence_sha256,
        submitted_by_user_id, override_reason, provenance, created_at
      ) VALUES (
        'bad-native-evidence', 'workspace-obligation', 1701, 'valid-new', 'Mismatched evidence', '${"a".repeat(64)}',
        'owner-a', NULL, 'native', '2027-02-01T00:00:00.000Z'
      )`),
      /invalid_obligation_evidence/,
    );
    assert.throws(
      () => database.exec(`INSERT INTO obligation_evidence (
        id, workspace_id, agreement_id, obligation_id, evidence_text, evidence_sha256,
        submitted_by_user_id, override_reason, provenance, created_at
      ) VALUES (
        'bad-native-digest', 'workspace-obligation', 1701, 'valid-new', 'Native evidence', '${"z".repeat(64)}',
        'owner-a', NULL, 'native', '2027-02-01T00:00:00.000Z'
      )`),
      /CHECK constraint failed: ck_obligation_evidence_digest/,
    );
    database.exec(`INSERT INTO obligation_evidence (
      id, workspace_id, agreement_id, obligation_id, evidence_text, evidence_sha256,
      submitted_by_user_id, override_reason, provenance, created_at
    ) VALUES (
      'valid-native-evidence', 'workspace-obligation', 1701, 'valid-new', 'Native evidence', '${"a".repeat(64)}',
      'owner-a', NULL, 'native', '2027-02-01T00:00:00.000Z'
    )`);
    assert.throws(
      () => database.exec("UPDATE obligations SET status = 'Open' WHERE id = 'valid-new'"),
      /immutable_completed_obligation/,
    );
    assert.throws(
      () => database.exec("UPDATE obligations SET completion_evidence = 'Changed' WHERE id = 'legacy-complete'"),
      /immutable_completed_obligation/,
    );
    assert.throws(
      () => database.exec("UPDATE obligation_evidence SET evidence_text = 'Changed' WHERE obligation_id = 'legacy-complete'"),
      /immutable_obligation_evidence/,
    );
    assert.throws(
      () => database.exec("DELETE FROM obligation_evidence WHERE obligation_id = 'legacy-complete'"),
      /active_obligation_evidence_immutable/,
    );

    const indexes = new Set((database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>).map((row) => row.name));
    for (const name of [
      "uq_obligations_workspace_schedule_occurrence",
      "uq_obligation_evidence_workspace_obligation",
      "idx_obligation_creation_receipts_workspace_agreement",
      "idx_agreements_workspace_live_updated",
      "idx_agreements_workspace_live_value",
      "idx_agreements_workspace_live_risk",
    ]) assert.equal(indexes.has(name), true, `missing recurring-obligation index ${name}`);
  } finally {
    database.close();
  }
});

test("enterprise foundations migrate additively and enforce tenant-bound governed configuration", () => {
  const migrationName = "0018_enterprise_foundations.sql";
  const migration = readFileSync(new URL(`../drizzle/${migrationName}`, import.meta.url), "utf8");
  assert.doesNotMatch(migration, /DROP TABLE|__new_|PRAGMA foreign_keys/i);
  for (const table of [
    "workspace_groups",
    "legal_entities",
    "counterparties",
    "custom_field_definitions",
    "governed_templates",
    "workflow_definitions",
    "approval_lane_authorities",
    "intake_forms",
    "saved_views",
    "agreement_parties",
    "agreement_relationships",
  ]) assert.match(migration, new RegExp(`CREATE TABLE [^\\n]+${table}`));
  for (const column of ["value_minor", "currency_code", "owner_user_id", "primary_counterparty_id", "legal_entity_id", "governed_template_version_id", "workflow_definition_id"]) {
    assert.match(migration, new RegExp(`ALTER TABLE [^\\n]+agreements[^\\n]+ ADD [^\\n]+${column}`));
  }
  assert.match(
    migration.trim(),
    /UPDATE `notice_schema_state`\s+SET `version` = 18, `updated_at` = CURRENT_TIMESTAMP\s+WHERE `id` = 'primary' AND `version` = 17;$/,
  );

  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of migrationNames.slice(0, migrationNames.indexOf(migrationName))) applyMigration(database, name);
    database.exec(`
      INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES
        ('enterprise-a', 'enterprise-a', 'Enterprise A', 'active', '2026-08-20', '2026-08-20'),
        ('enterprise-b', 'enterprise-b', 'Enterprise B', 'active', '2026-08-20', '2026-08-20');
      INSERT INTO users (id, identity_provider, identity_subject, email, display_name, status, created_at, updated_at, last_seen_at)
      VALUES ('enterprise-user', 'test', 'enterprise-user', 'enterprise@example.com', 'Enterprise Owner', 'active', '2026-08-20', '2026-08-20', '2026-08-20');
      INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at, updated_at)
      VALUES ('enterprise-a', 'enterprise-user', 'admin', 'active', '2026-08-20', '2026-08-20');
      INSERT INTO agreements (id, workspace_id, version, party, initials, side, type, value, stage, owner, next_action, due, crm, crm_record, tags, updated)
      VALUES
        (1801, 'enterprise-a', 1, 'Legacy Money', 'LM', 'Sell-side', 'MSA', 125000, 'Review', 'Enterprise Owner', 'Review', '2026-12-01', 'None', '', '[]', '2026-08-20'),
        (1802, 'enterprise-a', 1, 'Related Party', 'RP', 'Sell-side', 'Order', 1, 'Review', 'Enterprise Owner', 'Review', '2026-12-01', 'None', '', '[]', '2026-08-20');
    `);

    applyMigration(database, migrationName);
    assert.equal(database.prepare("SELECT version FROM notice_schema_state WHERE id = 'primary'").get()?.version, 18);
    assert.deepEqual({ ...database.prepare("SELECT value_minor AS valueMinor, currency_code AS currencyCode FROM agreements WHERE id = 1801").get()! }, {
      valueMinor: 12_500_000,
      currencyCode: "USD",
    });

    database.exec(`
      INSERT INTO legal_entities (id, workspace_id, version, legal_name, display_name, entity_type, jurisdiction, registration_number, default_currency_code, status, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES ('entity-a', 'enterprise-a', 1, 'Notice Holdings LLC', 'Notice Holdings', 'company', 'Delaware', '', 'USD', 'active', 'enterprise-user', '2026-08-20', 'enterprise-user', '2026-08-20');
      INSERT INTO counterparties (id, workspace_id, version, legal_name, display_name, domain, jurisdiction, registration_number, external_id, dedupe_key, status, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES
        ('party-a', 'enterprise-a', 1, 'Acme Incorporated', 'Acme', 'acme.example', 'New York', '', '', 'acme incorporated|acme.example', 'active', 'enterprise-user', '2026-08-20', 'enterprise-user', '2026-08-20'),
        ('party-b', 'enterprise-b', 1, 'Cross Tenant Inc', 'Cross Tenant', '', '', '', '', 'cross tenant inc|', 'active', 'enterprise-user', '2026-08-20', 'enterprise-user', '2026-08-20'),
        ('party-inactive', 'enterprise-a', 1, 'Dormant Inc', 'Dormant', '', '', '', '', 'dormant inc|', 'inactive', 'enterprise-user', '2026-08-20', 'enterprise-user', '2026-08-20');
      UPDATE agreements SET owner_user_id = 'enterprise-user', legal_entity_id = 'entity-a', primary_counterparty_id = 'party-a' WHERE id = 1801;
      INSERT INTO agreement_parties (id, workspace_id, agreement_id, role, legal_entity_id, counterparty_id, "primary", created_by_user_id, created_at)
      VALUES
        ('agreement-party-ours', 'enterprise-a', 1801, 'our_entity', 'entity-a', NULL, 1, 'enterprise-user', '2026-08-20'),
        ('agreement-party-them', 'enterprise-a', 1801, 'counterparty', NULL, 'party-a', 1, 'enterprise-user', '2026-08-20');
      INSERT INTO agreement_relationships (id, workspace_id, source_agreement_id, target_agreement_id, relationship_type, created_by_user_id, created_at)
      VALUES ('relationship-a', 'enterprise-a', 1802, 1801, 'order_under', 'enterprise-user', '2026-08-20');
      INSERT INTO custom_field_definitions (id, workspace_id, version, resource_type, key, label, description, data_type, options, required, status, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES ('field-a', 'enterprise-a', 1, 'agreement', 'business-unit', 'Business unit', '', 'single_select', '["Wealth","Corporate"]', 1, 'active', 'enterprise-user', '2026-08-20', 'enterprise-user', '2026-08-20');
      INSERT INTO custom_field_values (id, workspace_id, definition_id, resource_type, resource_id, value_json, updated_by_user_id, updated_at)
      VALUES ('value-a', 'enterprise-a', 'field-a', 'agreement', '1801', '"Wealth"', 'enterprise-user', '2026-08-20');
    `);

    assert.throws(() => database.exec("UPDATE agreements SET currency_code = 'usd' WHERE id = 1801"), /invalid_agreement_enterprise_fields/);
    assert.throws(() => database.exec("UPDATE agreements SET primary_counterparty_id = 'party-b' WHERE id = 1801"), /invalid_agreement_enterprise_fields/);
    assert.throws(() => database.exec(`INSERT INTO agreement_relationships (id, workspace_id, source_agreement_id, target_agreement_id, relationship_type, created_by_user_id, created_at) VALUES ('self-link', 'enterprise-a', 1801, 1801, 'related', 'enterprise-user', '2026-08-20')`), /ck_agreement_relationships_distinct/);
    assert.throws(() => database.exec(`INSERT INTO custom_field_values (id, workspace_id, definition_id, resource_type, resource_id, value_json, updated_by_user_id, updated_at) VALUES ('cross-field', 'enterprise-b', 'field-a', 'agreement', '1801', '"bad"', 'enterprise-user', '2026-08-20')`), /invalid_custom_field_value_scope/);
    database.exec(`INSERT INTO custom_field_definitions (id, workspace_id, version, resource_type, key, label, description, data_type, options, required, status, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES ('field-counterparty', 'enterprise-a', 1, 'counterparty', 'tier', 'Tier', '', 'text', '[]', 0, 'active', 'enterprise-user', '2026-08-20', 'enterprise-user', '2026-08-20')`);
    assert.throws(
      () => database.exec(`INSERT INTO custom_field_values (id, workspace_id, definition_id, resource_type, resource_id, value_json, updated_by_user_id, updated_at)
        VALUES ('inactive-party-value', 'enterprise-a', 'field-counterparty', 'counterparty', 'party-inactive', '"Dormant"', 'enterprise-user', '2026-08-20')`),
      /invalid_custom_field_value_scope/,
    );
    database.exec(`INSERT INTO custom_field_values (id, workspace_id, definition_id, resource_type, resource_id, value_json, updated_by_user_id, updated_at)
      VALUES ('active-party-value', 'enterprise-a', 'field-counterparty', 'counterparty', 'party-a', '"Strategic"', 'enterprise-user', '2026-08-20')`);
    database.exec("UPDATE counterparties SET status = 'inactive' WHERE id = 'party-a'");
    assert.throws(
      () => database.exec(`UPDATE custom_field_values SET value_json = '"Changed"' WHERE id = 'active-party-value'`),
      /invalid_custom_field_value_scope/,
      "a counterparty status change between precheck and commit must invalidate the value write",
    );

    database.exec(`
      INSERT INTO governed_templates (id, workspace_id, version, name, description, agreement_type, side, status, current_published_version, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES ('template-a', 'enterprise-a', 1, 'Enterprise MSA', '', 'MSA', 'Sell-side', 'draft', NULL, 'enterprise-user', '2026-08-20', 'enterprise-user', '2026-08-20');
      INSERT INTO governed_template_versions (id, workspace_id, template_id, version, status, body, variable_schema, language_block_ids, content_sha256, change_summary, created_by_user_id, created_at)
      VALUES ('template-version-a', 'enterprise-a', 'template-a', 1, 'draft', 'Agreement body', '{}', '[]', '${"a".repeat(64)}', 'Initial version', 'enterprise-user', '2026-08-20');
      UPDATE governed_template_versions SET status = 'published', reviewed_by_user_id = 'enterprise-user', reviewed_at = '2026-08-20' WHERE id = 'template-version-a';
      INSERT INTO workflow_definitions (id, workspace_id, version, name, description, status, definition, definition_sha256, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES ('workflow-a', 'enterprise-a', 1, 'Standard review', '', 'draft', '{"lanes":["Legal"]}', '${"b".repeat(64)}', 'enterprise-user', '2026-08-20', 'enterprise-user', '2026-08-20');
      UPDATE workflow_definitions SET status = 'published', published_by_user_id = 'enterprise-user', published_at = '2026-08-20' WHERE id = 'workflow-a';
    `);
    assert.throws(() => database.exec("UPDATE governed_template_versions SET body = 'tampered' WHERE id = 'template-version-a'"), /immutable_published_template_version/);
    assert.throws(() => database.exec("UPDATE workflow_definitions SET definition = '{}' WHERE id = 'workflow-a'"), /immutable_published_workflow_definition/);
  } finally {
    database.close();
  }
});

test("agent governance migration is additive, resets unsafe workflow evidence, and advances marker 14 to 15 last", () => {
  const migration = readFileSync(new URL("../drizzle/0015_overjoyed_randall.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /DROP TABLE|__new_agreements/i);
  for (const table of ["service_principals", "agent_grants", "agent_runs", "agent_action_plans", "agent_plan_decisions", "agent_action_executions"]) {
    assert.match(migration, new RegExp(`CREATE TABLE [^\\n]+${table}`));
  }
  for (const column of ["risk_disposition", "risk_basis_hash", "risk_document_version", "risk_document_sha256", "risk_decision_reason", "risk_decided_by_user_id", "risk_decided_at"]) {
    assert.match(migration, new RegExp(`ALTER TABLE [^\\n]+agreements[^\\n]+ ADD [^\\n]+${column}`));
  }
  assert.match(migration, /ALTER TABLE `approval_requests` ADD `basis_confirmed_at`/);
  assert.match(migration, /UPDATE `agreements`[\s\S]*`risk` = 'Unassessed'/);
  assert.match(migration, /UPDATE `approval_requests`[\s\S]*`status` = 'Superseded'[\s\S]*FROM `agreements`/);
  assert.match(migration, /CREATE TRIGGER `validate_agreement_risk_insert`/);
  assert.match(migration, /CREATE TRIGGER `validate_agreement_risk_update`/);
  assert.match(migration, /CREATE TRIGGER `validate_agreement_risk_evidence_update_v15`/);
  assert.match(migration, /CREATE TRIGGER `validate_approval_decision_evidence_update_v15`/);
  assert.match(migration, /CREATE TRIGGER `enforce_agent_grant_cap_insert_v15`/);
  assert.match(migration, /CREATE TRIGGER `enforce_agent_grant_cap_update_v15`/);
  assert.match(migration, /CREATE TRIGGER `validate_agent_action_plan_agreement_insert_v15`/);
  assert.match(migration, /CREATE TRIGGER `validate_agent_action_plan_agreement_update_v15`/);
  assert.match(migration, /CREATE TRIGGER `purge_agent_action_evidence_before_agreement_delete_v15`/);
  assert.match(
    migration.trim(),
    /UPDATE `notice_schema_state`\s+SET `version` = 15, `updated_at` = CURRENT_TIMESTAMP\s+WHERE `id` = 'primary' AND `version` = 14;$/,
  );

  const bootstrap = readFileSync(new URL("../db/ensure.ts", import.meta.url), "utf8");
  for (const table of ["service_principals", "agent_grants", "agent_runs", "agent_action_plans", "agent_plan_decisions", "agent_action_executions"]) {
    assert.match(bootstrap, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(bootstrap, /normalize_unassessed_risk_insert/);
  assert.match(bootstrap, /validate_agreement_risk_update/);
  assert.match(bootstrap, /validate_agreement_risk_evidence_update_v15/);
  assert.match(bootstrap, /validate_approval_decision_evidence_update_v15/);
  assert.match(bootstrap, /enforce_agent_grant_cap_insert_v15/);
  assert.match(bootstrap, /enforce_agent_grant_cap_update_v15/);
  assert.match(bootstrap, /validate_agent_action_plan_agreement_insert_v15/);
  assert.match(bootstrap, /validate_agent_action_plan_agreement_update_v15/);
  assert.match(bootstrap, /purge_agent_action_evidence_before_agreement_delete_v16/);
  assert.match(bootstrap, /priorSchemaMarker\.version < 15[\s\S]*UPDATE approval_requests[\s\S]*status = 'Superseded'/);

  const snapshot = JSON.parse(readFileSync(new URL("../drizzle/meta/0015_snapshot.json", import.meta.url), "utf8"));
  assert.ok(snapshot.tables.service_principals);
  assert.ok(snapshot.tables.agent_grants.checkConstraints.ck_agent_grants_actions);
  assert.ok(snapshot.tables.agent_action_plans.checkConstraints.ck_agent_action_plans_plan_digest);
  assert.ok(snapshot.tables.agent_action_executions.indexes.uq_agent_action_executions_workspace_principal_key);
  assert.ok(snapshot.tables.agreements.columns.risk_disposition);
  assert.ok(snapshot.tables.approval_requests.columns.basis_confirmed_at);
});

test("schema 16 atomically purges agreement-bound agent evidence, redacts retained run provenance, and prevents orphan plans", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of migrationNames) applyMigration(database, name);
    assert.equal(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);

    database.exec(`
      INSERT INTO workspaces (id, slug, name, status, created_at, updated_at)
      VALUES ('workspace-agent-purge', 'workspace-agent-purge', 'Agent purge test', 'active', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z');
      INSERT INTO users (id, identity_provider, identity_subject, email, display_name, status, created_at, updated_at, last_seen_at)
      VALUES ('user-agent-purge', 'test', 'user-agent-purge', 'agent-purge@example.test', 'Agent purge admin', 'active', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z');
      INSERT INTO agreements (
        id, workspace_id, version, party, initials, side, type, value, stage, owner,
        next_action, due, crm, crm_record, tags, updated, created_at, updated_at,
        department, risk, approval_status, signature_status, effective_date, expiration_date
      ) VALUES
        (301, 'workspace-agent-purge', 1, 'Secret Counterparty', 'SC', 'Buy-side', 'MSA', 1000, 'Active', 'Owner',
          'None', '2026-08-20', 'None', '', '[]', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z',
          'Legal', 'Unassessed', 'Required', 'Completed', '2026-08-19', '2027-08-19'),
        (302, 'workspace-agent-purge', 1, 'Control Counterparty', 'CC', 'Buy-side', 'MSA', 2000, 'Active', 'Owner',
          'None', '2026-08-20', 'None', '', '[]', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z',
          'Legal', 'Unassessed', 'Required', 'Completed', '2026-08-19', '2027-08-19');
      INSERT INTO service_principals (
        id, workspace_id, name, issuer, subject, status, version, created_by_user_id, created_at, updated_at
      ) VALUES (
        'principal-agent-purge', 'workspace-agent-purge', 'Purge agent', 'https://issuer.example.test', 'purge-agent',
        'active', 1, 'user-agent-purge', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z'
      );
      INSERT INTO agent_grants (
        id, workspace_id, principal_id, delegator_user_id, status, action_ids, resource_constraints,
        policy_version, starts_at, expires_at, version, created_at, updated_at
      ) VALUES (
        'grant-agent-purge', 'workspace-agent-purge', 'principal-agent-purge', 'user-agent-purge', 'active',
        '["agreement.read"]', '{"resources":[{"type":"agreement","ids":["301","302"]}]}', 'v1',
        '2026-08-19T00:00:00.000Z', '2099-08-19T00:00:00.000Z', 1,
        '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z'
      );
      INSERT INTO agent_runs (
        id, workspace_id, principal_id, grant_id, sponsor_user_id, purpose, status,
        model_provider, model_id, tool_version, prompt_sha256, context_sha256, started_at, completed_at
      ) VALUES
        ('run-agent-purge', 'workspace-agent-purge', 'principal-agent-purge', 'grant-agent-purge', 'user-agent-purge',
          'Read Secret Counterparty agreement', 'succeeded', 'Sensitive Provider', 'secret-counterparty-model', 'secret-counterparty-tool',
          '${"a".repeat(64)}', '${"b".repeat(64)}', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:01.000Z'),
        ('run-agent-control', 'workspace-agent-purge', 'principal-agent-purge', 'grant-agent-purge', 'user-agent-purge',
          'Read control target', 'succeeded', 'Control Provider', 'control-model', 'control-tool',
          '${"c".repeat(64)}', '${"d".repeat(64)}', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:01.000Z');
    `);

    const insertPlan = database.prepare(`INSERT INTO agent_action_plans (
      id, workspace_id, principal_id, grant_id, run_id, action_id, resource_type, resource_id, agreement_id,
      canonical_input, input_sha256, plan_sha256, expected_version, policy_version, risk_tier, status,
      before_snapshot, proposed_diff, blockers, provenance, expires_at, created_at, updated_at
    ) VALUES (
      ?, 'workspace-agent-purge', 'principal-agent-purge', 'grant-agent-purge', ?, 'agreement.read', 'agreement', ?, ?,
      ?, ?, ?, 1, 'v1', 'low', 'succeeded', ?, '{}', '[]', '{}',
      '2099-08-19T00:00:00.000Z', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:01.000Z'
    )`);
    insertPlan.run(
      "plan-agent-purge",
      "run-agent-purge",
      "301",
      301,
      '{"resource":{"type":"agreement","id":"301"}}',
      "a".repeat(64),
      "b".repeat(64),
      '{"agreement":{"party":"Secret Counterparty"}}',
    );
    insertPlan.run(
      "plan-agent-control",
      "run-agent-control",
      "302",
      302,
      '{"resource":{"type":"agreement","id":"302"}}',
      "c".repeat(64),
      "d".repeat(64),
      '{"agreement":{"party":"Control Counterparty"}}',
    );
    database.exec(`
      INSERT INTO agent_plan_decisions (
        id, workspace_id, plan_id, plan_sha256, decision, reason, decided_by_user_id, decided_at
      ) VALUES
        ('decision-agent-purge', 'workspace-agent-purge', 'plan-agent-purge', '${"b".repeat(64)}', 'approved', 'Reviewed exact digest', 'user-agent-purge', '2026-08-19T12:00:00.000Z'),
        ('decision-agent-control', 'workspace-agent-purge', 'plan-agent-control', '${"d".repeat(64)}', 'approved', 'Reviewed exact digest', 'user-agent-purge', '2026-08-19T12:00:00.000Z');
      INSERT INTO agent_action_executions (
        id, workspace_id, plan_id, principal_id, grant_id, action_id, plan_sha256, request_sha256,
        idempotency_key_sha256, status, result, agreement_event_ids, provenance, started_at, completed_at
      ) VALUES
        ('execution-agent-purge', 'workspace-agent-purge', 'plan-agent-purge', 'principal-agent-purge', 'grant-agent-purge',
          'agreement.read', '${"b".repeat(64)}', '${"e".repeat(64)}', '${"f".repeat(64)}', 'succeeded',
          '{"agreement":{"party":"Secret Counterparty"}}', '[]', '{}', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:01.000Z'),
        ('execution-agent-control', 'workspace-agent-purge', 'plan-agent-control', 'principal-agent-purge', 'grant-agent-purge',
          'agreement.read', '${"d".repeat(64)}', '${"1".repeat(64)}', '${"2".repeat(64)}', 'succeeded',
          '{"agreement":{"party":"Control Counterparty"}}', '[]', '{}', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:01.000Z');
    `);

    database.exec("BEGIN IMMEDIATE; DELETE FROM agreements WHERE workspace_id = 'workspace-agent-purge' AND id = 301");
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreements WHERE id = 301").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agent_action_plans WHERE id = 'plan-agent-purge'").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agent_plan_decisions WHERE id = 'decision-agent-purge'").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agent_action_executions WHERE id = 'execution-agent-purge'").get()?.count, 0);
    database.exec("ROLLBACK");
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreements WHERE id = 301").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agent_action_plans WHERE id = 'plan-agent-purge'").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agent_plan_decisions WHERE id = 'decision-agent-purge'").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agent_action_executions WHERE id = 'execution-agent-purge'").get()?.count, 1);
    assert.equal(
      database.prepare("SELECT purpose FROM agent_runs WHERE id = 'run-agent-purge'").get()?.purpose,
      "Read Secret Counterparty agreement",
    );

    database.exec("DELETE FROM agreements WHERE workspace_id = 'workspace-agent-purge' AND id = 301");

    for (const table of ["agent_action_executions", "agent_plan_decisions", "agent_action_plans"]) {
      assert.equal(
        database.prepare(`SELECT count(*) AS count FROM ${table} WHERE id LIKE '%agent-purge'`).get()?.count,
        0,
        `${table} must not retain purged agreement evidence`,
      );
      assert.equal(
        database.prepare(`SELECT count(*) AS count FROM ${table} WHERE id LIKE '%agent-control'`).get()?.count,
        1,
        `${table} must retain unrelated agreement evidence`,
      );
    }
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreements WHERE id = 301").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreements WHERE id = 302").get()?.count, 1);
    assert.deepEqual({ ...database.prepare(`SELECT
      purpose,
      model_provider AS modelProvider,
      model_id AS modelId,
      tool_version AS toolVersion,
      prompt_sha256 AS promptSha256,
      context_sha256 AS contextSha256
      FROM agent_runs WHERE id = 'run-agent-purge'`).get()! }, {
      purpose: "Retention-purged agreement run",
      modelProvider: null,
      modelId: null,
      toolVersion: "retention-redacted",
      promptSha256: null,
      contextSha256: null,
    });
    assert.deepEqual({ ...database.prepare(`SELECT
      purpose,
      model_provider AS modelProvider,
      model_id AS modelId,
      tool_version AS toolVersion,
      prompt_sha256 AS promptSha256,
      context_sha256 AS contextSha256
      FROM agent_runs WHERE id = 'run-agent-control'`).get()! }, {
      purpose: "Read control target",
      modelProvider: "Control Provider",
      modelId: "control-model",
      toolVersion: "control-tool",
      promptSha256: "c".repeat(64),
      contextSha256: "d".repeat(64),
    });

    assert.throws(
      () => insertPlan.run(
        "plan-agent-orphan",
        "run-agent-purge",
        "301",
        301,
        '{"resource":{"type":"agreement","id":"301"}}',
        "3".repeat(64),
        "4".repeat(64),
        '{"agreement":{"party":"Secret Counterparty"}}',
      ),
      /agent_plan_agreement_missing_or_mismatched/,
    );
    assert.throws(
      () => insertPlan.run(
        "plan-agent-mismatched-resource",
        "run-agent-control",
        "999",
        302,
        '{"resource":{"type":"agreement","id":"999"}}',
        "5".repeat(64),
        "6".repeat(64),
        '{"agreement":{"party":"Control Counterparty"}}',
      ),
      /agent_plan_agreement_missing_or_mismatched/,
    );
    assert.throws(
      () => database.exec("UPDATE agent_action_plans SET resource_id = '301', agreement_id = 301 WHERE id = 'plan-agent-control'"),
      /agent_plan_agreement_missing_or_mismatched/,
    );

    insertPlan.run(
      "plan-agent-live-control",
      "run-agent-control",
      "302",
      302,
      '{"resource":{"type":"agreement","id":"302"}}',
      "7".repeat(64),
      "8".repeat(64),
      '{"agreement":{"party":"Control Counterparty"}}',
    );
    assert.equal(database.prepare("SELECT count(*) AS count FROM agent_action_plans WHERE agreement_id = 302").get()?.count, 2);
  } finally {
    database.close();
  }
});

test("schema 15 durably caps active unexpired or scheduled grants per principal", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const name of migrationNames) applyMigration(database, name);
    database.exec(`
      INSERT INTO workspaces (id, slug, name, status, created_at, updated_at)
      VALUES ('workspace-grant-cap', 'workspace-grant-cap', 'Grant cap test', 'active', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z');
      INSERT INTO users (id, identity_provider, identity_subject, email, display_name, status, created_at, updated_at, last_seen_at)
      VALUES ('user-grant-cap', 'test', 'user-grant-cap', 'grant-cap@example.test', 'Grant cap admin', 'active', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z');
      INSERT INTO service_principals (id, workspace_id, name, issuer, subject, status, version, created_by_user_id, created_at, updated_at)
      VALUES ('principal-grant-cap', 'workspace-grant-cap', 'Grant cap agent', 'https://issuer.example.test', 'agent.example.test', 'active', 1, 'user-grant-cap', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z');
    `);
    const insert = database.prepare(`INSERT INTO agent_grants (
      id, workspace_id, principal_id, delegator_user_id, status, action_ids, resource_constraints,
      policy_version, starts_at, expires_at, version, created_at, updated_at
    ) VALUES (?, 'workspace-grant-cap', 'principal-grant-cap', 'user-grant-cap', ?, '["agreement.read"]',
      '{"resources":[{"type":"agreement","ids":["1"]}]}', 'v1', '2098-01-01T00:00:00.000Z',
      '2099-01-01T00:00:00.000Z', 1, '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z')`);
    for (let index = 0; index < 50; index += 1) insert.run(`grant-cap-${index}`, "active");
    assert.throws(() => insert.run("grant-cap-50", "active"), /agent_grant_limit_reached/);

    insert.run("grant-cap-revoked", "revoked");
    assert.throws(
      () => database.exec("UPDATE agent_grants SET status = 'active' WHERE id = 'grant-cap-revoked'"),
      /agent_grant_limit_reached/,
    );
    database.exec("UPDATE agent_grants SET status = 'revoked' WHERE id = 'grant-cap-0'");
    database.exec("UPDATE agent_grants SET status = 'active' WHERE id = 'grant-cap-revoked'");
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM agent_grants WHERE status = 'active'").get()?.count,
      50,
    );
  } finally {
    database.close();
  }
});

test("schema 15 rejects risk labels and approval decisions without their exact governance evidence", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const name of migrationNames) applyMigration(database, name);
    database.exec(`
      INSERT INTO workspaces (id, slug, name, status, created_at, updated_at)
      VALUES ('workspace-governance', 'workspace-governance', 'Governance test', 'active', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z');
      INSERT INTO users (id, identity_provider, identity_subject, email, display_name, status, created_at, updated_at, last_seen_at)
      VALUES ('user-governance', 'test', 'user-governance', 'governance@example.test', 'Governance reviewer', 'active', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z');
      INSERT INTO agreements (
        id, workspace_id, version, party, initials, side, type, value, stage, owner,
        next_action, due, crm, crm_record, tags, updated, created_at, updated_at,
        department, risk, approval_status, signature_status, effective_date, expiration_date
      ) VALUES (
        91, 'workspace-governance', 1, 'Counterparty', 'C', 'Buy-side', 'MSA', 1000, 'Review', 'Owner',
        'Assess risk', '2026-08-20', 'None', '', '[]', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z',
        'Legal', 'Unassessed', 'Required', 'Not sent', '2026-08-19', '2027-08-19'
      );
    `);

    assert.throws(
      () => database.exec("UPDATE agreements SET risk = 'Low' WHERE id = 91"),
      /invalid_agreement_risk_evidence/,
    );
    assert.throws(
      () => database.exec(`UPDATE agreements SET
        risk = 'Low', risk_disposition = 'assessed', risk_basis_hash = '${"a".repeat(64)}',
        risk_document_version = 1, risk_document_sha256 = '${"b".repeat(64)}',
        risk_decided_by_user_id = 'user-governance', risk_decided_at = '2026-08-19T12:00:00.000Z'
        WHERE id = 91`),
      /invalid_agreement_risk_evidence/,
    );
    database.exec(`UPDATE agreements SET
      risk = 'Low', risk_disposition = 'assessed', risk_basis_hash = '${"a".repeat(64)}',
      risk_document_version = 1, risk_document_sha256 = '${"b".repeat(64)}',
      risk_decision_reason = 'Reviewed the exact current paper', risk_decided_by_user_id = 'user-governance',
      risk_decided_at = '2026-08-19T12:00:00.000Z'
      WHERE id = 91`);

    database.exec(`INSERT INTO approval_requests (
      id, workspace_id, version, agreement_id, basis_hash, document_version, document_sha256,
      role, requested_by_user_id, approver, status, due, created_at
    ) VALUES (
      'approval-governance', 'workspace-governance', 1, 91, '${"c".repeat(64)}', 1, '${"d".repeat(64)}',
      'Legal', 'user-governance', 'Reviewer', 'Pending', '2026-08-20', '2026-08-19T12:00:00.000Z'
    )`);
    assert.throws(
      () => database.exec("UPDATE approval_requests SET status = 'Approved', decided_by_user_id = 'user-governance', decided_at = '2026-08-19T12:00:00.000Z' WHERE id = 'approval-governance'"),
      /invalid_approval_decision_evidence/,
    );
    assert.throws(
      () => database.exec("UPDATE approval_requests SET status = 'Changes requested', decided_by_user_id = 'user-governance', decided_at = '2026-08-19T12:00:00.000Z', basis_confirmed_at = '2026-08-19T12:00:00.000Z', comment = '' WHERE id = 'approval-governance'"),
      /invalid_approval_decision_evidence/,
    );
    database.exec("UPDATE approval_requests SET status = 'Approved', decided_by_user_id = 'user-governance', decided_at = '2026-08-19T12:00:00.000Z', basis_confirmed_at = '2026-08-19T12:00:00.000Z', comment = 'Approved exact paper' WHERE id = 'approval-governance'");
  } finally {
    database.close();
  }
});

test("negotiation migration is additive, baseline-safe, and advances marker 13 to 14 last", () => {
  const migration = readFileSync(new URL("../drizzle/0014_wide_sleeper.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /__new_documents|DROP TABLE [`"]?documents/i);
  for (const column of ["role", "direction", "negotiation_round_id", "provider_message_id", "parent_sha256", "original_sender_email"]) {
    assert.match(migration, new RegExp(`ALTER TABLE [^\\n]+documents[^\\n]+ ADD [^\\n]+${column}`));
  }
  for (const column of ["aggregate_type", "aggregate_id"]) {
    assert.match(migration, new RegExp(`ALTER TABLE [^\\n]+webhook_receipts[^\\n]+ ADD [^\\n]+${column}`));
  }
  assert.match(migration, /CREATE INDEX `idx_webhook_receipts_workspace_aggregate`/);
  assert.match(migration, /CREATE TABLE `agreement_creation_receipts`/);
  assert.match(migration, /CREATE TABLE `document_upload_receipts`/);
  assert.match(migration, /PRIMARY KEY\(`workspace_id`, `user_id`, `key_digest`\)/);
  assert.match(migration, /CONSTRAINT "ck_document_upload_receipts_response_json" CHECK\(json_valid/);
  assert.match(migration, /FOREIGN KEY \(`document_id`\) REFERENCES `documents`\(`id`\)[^\n]+ON DELETE cascade/);
  assert.match(migration, /PRIMARY KEY\(`workspace_id`, `user_id`, `idempotency_key`\)/);
  assert.match(migration, /CONSTRAINT "ck_agreement_creation_receipts_mode" CHECK/);
  assert.match(migration, /CONSTRAINT "ck_negotiation_rounds_baseline" CHECK/);
  assert.match(migration, /UPDATE `documents`[\s\S]*THEN 'signed_artifact'[\s\S]*ELSE 'initial_source'[\s\S]*`direction` = 'inbound'/);
  assert.ok(migration.indexOf("UPDATE `documents`") < migration.indexOf("UPDATE `notice_schema_state`"));
  assert.match(
    migration.trim(),
    /UPDATE `notice_schema_state`\s+SET `version` = 14, `updated_at` = CURRENT_TIMESTAMP\s+WHERE `id` = 'primary' AND `version` = 13;$/,
  );

  const bootstrap = readFileSync(new URL("../db/ensure.ts", import.meta.url), "utf8");
  for (const table of ["agreement_creation_receipts", "document_upload_receipts", "negotiation_rounds", "negotiation_submissions", "document_comparisons"]) {
    assert.match(bootstrap, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  for (const indexName of [
    "idx_documents_workspace_role",
    "idx_documents_workspace_negotiation_round",
    "uq_negotiation_rounds_workspace_agreement_round",
    "uq_negotiation_submissions_workspace_round_document",
    "uq_document_comparisons_workspace_round_submission",
    "uq_agreement_creation_receipts_workspace_agreement",
    "idx_agreement_creation_receipts_workspace_created_at",
    "uq_document_upload_receipts_workspace_document",
    "idx_document_upload_receipts_workspace_expiry",
  ]) assert.match(bootstrap, new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${indexName}`));
  assert.match(bootstrap, /UPDATE webhook_receipts[\s\S]*aggregate_type = 'signature_packet'[\s\S]*legacy_signature_packet\.submission_id = substr/);
  assert.match(bootstrap, /priorSchemaMarker[\s\S]*UPDATE documents[\s\S]*THEN 'signed_artifact'[\s\S]*ELSE 'initial_source'/);

  const snapshot = JSON.parse(readFileSync(new URL("../drizzle/meta/0014_snapshot.json", import.meta.url), "utf8"));
  assert.ok(snapshot.tables.agreement_creation_receipts, "0014 snapshot must include creation receipts");
  assert.ok(snapshot.tables.agreement_creation_receipts.columns.creation_mode);
  assert.ok(snapshot.tables.agreement_creation_receipts.checkConstraints.ck_agreement_creation_receipts_mode);
  assert.ok(snapshot.tables.document_upload_receipts, "0014 snapshot must include upload receipts");
  assert.ok(snapshot.tables.document_upload_receipts.columns.key_digest);
  assert.equal(snapshot.tables.document_upload_receipts.columns.idempotency_key, undefined);
  assert.ok(snapshot.tables.document_upload_receipts.checkConstraints.ck_document_upload_receipts_response_json);
});

test("version 13 document provenance is backfilled before negotiation roles become authoritative", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const name of migrationNames.slice(0, migrationNames.indexOf("0014_wide_sleeper.sql"))) applyMigration(database, name);

    const insertDocument = database.prepare(`INSERT INTO documents (
      id, workspace_id, version, agreement_id, file_name, object_key,
      content_type, size, tags, extracted, extraction_mode, sha256,
      scan_status, created_by_user_id, legal_hold, created_at
    ) VALUES (?, 'workspace-a', 1, ?, ?, ?, 'application/pdf', 128, ?, '{}', ?, ?, 'clean', ?, 0, '2026-08-01')`);
    insertDocument.run(
      "import-unlinked", null, "source.pdf", "workspaces/workspace-a/documents/import-unlinked/source.pdf",
      "[]", "PDF text extraction", "a".repeat(64), "user-a",
    );
    insertDocument.run(
      "import-linked", 7, "linked-source.pdf", "workspaces/workspace-a/documents/import-linked/linked-source.pdf",
      "[]", "PDF text extraction", "b".repeat(64), "user-a",
    );
    insertDocument.run(
      "signed-lookalike", 7, "signed-contract.pdf", "workspaces/workspace-a/documents/signed-lookalike/signed-contract.pdf",
      '["Signed artifact"]', "PDF text extraction", "c".repeat(64), "user-a",
    );
    insertDocument.run(
      "signed-packet-evidence", 7, "opaque-evidence.pdf", "legacy/archive/opaque-evidence.pdf",
      "[]", "Opaque provider evidence", "d".repeat(64), "legacy-system",
    );
    insertDocument.run(
      "signed-path-sibling", 7, "annex.pdf", "workspaces/workspace-a/signed/7/packet-legacy/signed-path-sibling/annex.pdf",
      "[]", "Opaque provider evidence", "e".repeat(64), "legacy-system",
    );
    insertDocument.run(
      "signed-system-actor", 7, "receipt.pdf", "legacy/archive/receipt.pdf",
      "[]", "Opaque provider evidence", "f".repeat(64), "system:docuseal",
    );
    insertDocument.run(
      "signed-ambiguous-evidence", 7, "ambiguous.pdf", "legacy/archive/ambiguous.pdf",
      "[]", "Opaque provider evidence", "9".repeat(64), "legacy-system",
    );

    database.exec(`INSERT INTO signature_packets (
      id, workspace_id, agreement_id, basis_hash, document_version, document_sha256,
      active_key, provider, external_id, submission_id, status, signers,
      evidence_document_id, version, created_at, updated_at, completed_at
    ) VALUES (
      'packet-legacy', 'workspace-a', 7, '${"1".repeat(64)}', 1, '${"2".repeat(64)}',
      NULL, 'docuseal', 'external-legacy', '73001', 'completed', '[]',
      'signed-packet-evidence', 2, '2026-08-01', '2026-08-01', '2026-08-01'
    ), (
      'packet-conflict', 'workspace-a', 7, '${"1".repeat(64)}', 1, '${"3".repeat(64)}',
      NULL, 'docuseal', 'external-conflict', '74001', 'completed', '[]',
      'signed-path-sibling', 2, '2026-08-01', '2026-08-01', '2026-08-01'
    ), (
      'packet-ambiguous-a', 'workspace-a', 7, '${"1".repeat(64)}', 1, '${"4".repeat(64)}',
      NULL, 'docuseal', 'external-ambiguous-a', '75001', 'completed', '[]',
      'signed-ambiguous-evidence', 2, '2026-08-01', '2026-08-01', '2026-08-01'
    ), (
      'packet-ambiguous-b', 'workspace-a', 7, '${"1".repeat(64)}', 1, '${"5".repeat(64)}',
      NULL, 'docuseal', 'external-ambiguous-b', '76001', 'completed', '[]',
      'signed-ambiguous-evidence', 2, '2026-08-01', '2026-08-01', '2026-08-01'
    )`);

    applyMigration(database, "0014_wide_sleeper.sql");
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_creation_receipts").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM document_upload_receipts").get()?.count, 0);

    const rows = (database.prepare(
      "SELECT id, role, direction, provider_message_id, parent_sha256 FROM documents ORDER BY id",
    ).all() as Array<{ id: string; role: string; direction: string; provider_message_id: string | null; parent_sha256: string | null }>).map((row) => ({
      id: row.id,
      role: row.role,
      direction: row.direction,
      providerMessageId: row.provider_message_id,
      parentSha256: row.parent_sha256,
    }));
    assert.deepEqual(rows, [
      { id: "import-linked", role: "initial_source", direction: "inbound", providerMessageId: null, parentSha256: null },
      { id: "import-unlinked", role: "initial_source", direction: "inbound", providerMessageId: null, parentSha256: null },
      { id: "signed-ambiguous-evidence", role: "signed_artifact", direction: "inbound", providerMessageId: null, parentSha256: null },
      { id: "signed-lookalike", role: "initial_source", direction: "inbound", providerMessageId: null, parentSha256: null },
      { id: "signed-packet-evidence", role: "signed_artifact", direction: "inbound", providerMessageId: "73001", parentSha256: "2".repeat(64) },
      { id: "signed-path-sibling", role: "signed_artifact", direction: "inbound", providerMessageId: "73001", parentSha256: "2".repeat(64) },
      { id: "signed-system-actor", role: "signed_artifact", direction: "inbound", providerMessageId: null, parentSha256: null },
    ]);
    const eligibleSource = database.prepare(`SELECT id FROM documents
      WHERE id = 'import-linked'
        AND role IN ('initial_source', 'counterparty_return')
        AND direction = 'inbound'
        AND negotiation_round_id IS NULL`).get();
    assert.equal((eligibleSource as { id?: string } | undefined)?.id, "import-linked");
    const legacyUnlinkedSource = database.prepare(`SELECT id FROM documents
      WHERE id = 'import-unlinked'
        AND agreement_id IS NULL
        AND role = 'initial_source'
        AND direction = 'inbound'
        AND negotiation_round_id IS NULL
        AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM document_upload_receipts
          WHERE workspace_id = documents.workspace_id AND document_id = documents.id
        )`).get();
    assert.equal((legacyUnlinkedSource as { id?: string } | undefined)?.id, "import-unlinked", "v13 receiptless intake must remain eligible for the bounded legacy link path");
    const reusableSignedArtifacts = database.prepare(`SELECT id FROM documents
      WHERE role = 'signed_artifact'
        AND direction = 'inbound'
        AND provider_message_id = '73001'
        AND parent_sha256 = '${"2".repeat(64)}'
        AND scan_status = 'clean'
        AND deleted_at IS NULL
      ORDER BY id`).all() as Array<{ id: string }>;
    assert.deepEqual(reusableSignedArtifacts.map((row) => row.id), ["signed-packet-evidence", "signed-path-sibling"]);
    assert.equal(database.prepare(
      "SELECT count(*) AS count FROM documents WHERE role = 'supporting' OR direction = 'internal'",
    ).get()?.count, 0);
  } finally {
    database.close();
  }
});

test("agreement creation receipts enforce tenant/user scope, request shape, and one receipt per agreement", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of migrationNames) applyMigration(database, name);
    database.exec(`
      INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES
        ('receipt-workspace-a', 'receipt-workspace-a', 'Receipt A', 'active', '2026-08-01', '2026-08-01'),
        ('receipt-workspace-b', 'receipt-workspace-b', 'Receipt B', 'active', '2026-08-01', '2026-08-01');
      INSERT INTO users (id, identity_provider, identity_subject, email, display_name, status, created_at, updated_at, last_seen_at) VALUES
        ('receipt-user-a', 'test', 'receipt-user-a', 'receipt-a@test.invalid', 'Receipt A', 'active', '2026-08-01', '2026-08-01', '2026-08-01'),
        ('receipt-user-b', 'test', 'receipt-user-b', 'receipt-b@test.invalid', 'Receipt B', 'active', '2026-08-01', '2026-08-01', '2026-08-01');
      INSERT INTO agreements (id, workspace_id, version, party, initials, side, type, stage, owner, next_action, due, crm, crm_record, tags, updated) VALUES
        (101, 'receipt-workspace-a', 1, 'One', 'ONE', 'Buy-side', 'NDA', 'Intake', 'Owner', 'Review', 'Today', 'None', '', '[]', '2026-08-01'),
        (102, 'receipt-workspace-a', 1, 'Two', 'TWO', 'Buy-side', 'NDA', 'Draft', 'Owner', 'Review', 'Today', 'None', '', '[]', '2026-08-01'),
        (103, 'receipt-workspace-b', 1, 'Three', 'THR', 'Buy-side', 'NDA', 'Review', 'Owner', 'Review', 'Today', 'None', '', '[]', '2026-08-01');
    `);
    const insert = database.prepare(`INSERT INTO agreement_creation_receipts (
      workspace_id, user_id, idempotency_key, request_sha256, creation_mode, agreement_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, '2026-08-01')`);
    const sharedKey = "00000000-0000-4000-8000-000000000001";
    insert.run("receipt-workspace-a", "receipt-user-a", sharedKey, "a".repeat(64), "manual", 101);
    assert.throws(
      () => insert.run("receipt-workspace-a", "receipt-user-a", sharedKey, "b".repeat(64), "generated", 102),
      /UNIQUE constraint failed/,
    );
    insert.run("receipt-workspace-a", "receipt-user-b", sharedKey, "b".repeat(64), "generated", 102);
    insert.run("receipt-workspace-b", "receipt-user-a", sharedKey, "c".repeat(64), "imported", 103);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_creation_receipts").get()?.count, 3);
    assert.throws(
      () => insert.run("receipt-workspace-a", "receipt-user-b", "00000000-0000-4000-8000-000000000002", "d".repeat(64), "manual", 101),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => insert.run("receipt-workspace-a", "receipt-user-a", "00000000-0000-4000-8000-000000000003", "e".repeat(64), "unknown", 101),
      /CHECK constraint failed: ck_agreement_creation_receipts_mode/,
    );
    database.exec("DELETE FROM agreements WHERE id = 101");
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_creation_receipts WHERE agreement_id = 101").get()?.count, 0);
  } finally {
    database.close();
  }
});

test("document upload receipts are digest-only, tenant/user scoped, bounded, and document-owned", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of migrationNames) applyMigration(database, name);
    database.exec(`
      INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES
        ('upload-workspace-a', 'upload-workspace-a', 'Upload A', 'active', '2026-08-01', '2026-08-01'),
        ('upload-workspace-b', 'upload-workspace-b', 'Upload B', 'active', '2026-08-01', '2026-08-01');
      INSERT INTO users (id, identity_provider, identity_subject, email, display_name, status, created_at, updated_at, last_seen_at) VALUES
        ('upload-user-a', 'test', 'upload-user-a', 'upload-a@test.invalid', 'Upload A', 'active', '2026-08-01', '2026-08-01', '2026-08-01'),
        ('upload-user-b', 'test', 'upload-user-b', 'upload-b@test.invalid', 'Upload B', 'active', '2026-08-01', '2026-08-01', '2026-08-01');
      INSERT INTO documents (
        id, workspace_id, version, agreement_id, role, direction, file_name, object_key,
        content_type, size, tags, extracted, extraction_mode, sha256, scan_status,
        created_by_user_id, legal_hold, retention_until, created_at
      ) VALUES
        ('00000000-0000-4000-8000-000000000101', 'upload-workspace-a', 1, NULL, 'initial_source', 'inbound', 'a.txt', 'workspaces/upload-workspace-a/documents/a/a.txt', 'text/plain', 1, '[]', '{}', 'Plain-text extraction', '${"a".repeat(64)}', 'clean', 'upload-user-a', 0, '2026-08-08', '2026-08-01'),
        ('00000000-0000-4000-8000-000000000102', 'upload-workspace-a', 1, NULL, 'initial_source', 'inbound', 'b.txt', 'workspaces/upload-workspace-a/documents/b/b.txt', 'text/plain', 1, '[]', '{}', 'Plain-text extraction', '${"b".repeat(64)}', 'clean', 'upload-user-b', 0, '2026-08-08', '2026-08-01'),
        ('00000000-0000-4000-8000-000000000103', 'upload-workspace-b', 1, NULL, 'initial_source', 'inbound', 'c.txt', 'workspaces/upload-workspace-b/documents/c/c.txt', 'text/plain', 1, '[]', '{}', 'Plain-text extraction', '${"c".repeat(64)}', 'clean', 'upload-user-a', 0, '2026-08-08', '2026-08-01');
    `);
    const insert = database.prepare(`INSERT INTO document_upload_receipts (
      workspace_id, user_id, key_digest, request_digest, document_id,
      response_json, response_status, created_at, expires_at, linked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-08-01', '2026-08-08', NULL)`);
    const sharedDigest = "d".repeat(64);
    insert.run("upload-workspace-a", "upload-user-a", sharedDigest, "1".repeat(64), "00000000-0000-4000-8000-000000000101", '{"document":{"id":"a"}}', 201);
    insert.run("upload-workspace-a", "upload-user-b", sharedDigest, "2".repeat(64), "00000000-0000-4000-8000-000000000102", '{"document":{"id":"b"}}', 202);
    insert.run("upload-workspace-b", "upload-user-a", sharedDigest, "3".repeat(64), "00000000-0000-4000-8000-000000000103", '{"document":{"id":"c"}}', 201);
    assert.equal(database.prepare("SELECT count(*) AS count FROM document_upload_receipts").get()?.count, 3);
    assert.equal(database.prepare("PRAGMA table_info(document_upload_receipts)").all().some((column) => (column as { name: string }).name === "idempotency_key"), false);
    assert.throws(
      () => insert.run("upload-workspace-a", "upload-user-a", sharedDigest, "4".repeat(64), "00000000-0000-4000-8000-000000000102", '{"document":{"id":"collision"}}', 201),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => insert.run("upload-workspace-a", "upload-user-a", "short", "4".repeat(64), "00000000-0000-4000-8000-000000000102", '{}', 201),
      /CHECK constraint failed: ck_document_upload_receipts_key_digest/,
    );
    assert.throws(
      () => insert.run("upload-workspace-a", "upload-user-a", "e".repeat(64), "4".repeat(64), "00000000-0000-4000-8000-000000000102", 'not-json', 201),
      /CHECK constraint failed: ck_document_upload_receipts_response_json/,
    );
    assert.throws(
      () => insert.run("upload-workspace-a", "upload-user-a", "f".repeat(64), "4".repeat(64), "00000000-0000-4000-8000-000000000102", '{}', 200),
      /CHECK constraint failed: ck_document_upload_receipts_response_status/,
    );
    database.exec("DELETE FROM documents WHERE id = '00000000-0000-4000-8000-000000000101'");
    assert.equal(database.prepare("SELECT count(*) AS count FROM document_upload_receipts WHERE document_id = '00000000-0000-4000-8000-000000000101'").get()?.count, 0);
  } finally {
    database.close();
  }
});

test("round-bound receipt claims cannot be resurrected after the round is purged", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const name of migrationNames) applyMigration(database, name);
    database.exec(`INSERT INTO negotiation_rounds (
      id, workspace_id, agreement_id, round_number, status, active_key, alias_code,
      base_document_version, base_sha256, outbound_document_id, outbound_sha256,
      created_by_user_id, created_at, updated_at
    ) VALUES ('round-claim', 'workspace-a', 7, 1, 'outbound', 'active-7', 'alias-claim',
      1, '${"a".repeat(64)}', 'outbound-a', '${"b".repeat(64)}', 'user-a', '2026-01-01', '2026-01-01')`);
    const claim = database.prepare(`INSERT INTO webhook_receipts (
      id, workspace_id, provider, provider_event_id, payload_digest,
      aggregate_type, aggregate_id, status, received_at, processed_at, error
    ) SELECT ?, workspace_id, ?, ?, ?, 'negotiation_round', id, 'processing', ?, NULL, NULL
      FROM negotiation_rounds WHERE workspace_id = ? AND id = ?
      ON CONFLICT DO NOTHING`);

    const beforePurge = claim.run(
      "receipt-before", "inbound-email-gateway", "event-before", "a".repeat(64),
      "2026-01-02", "workspace-a", "round-claim",
    );
    assert.equal(beforePurge.changes, 1);

    database.exec("BEGIN");
    database.exec("DELETE FROM webhook_receipts WHERE workspace_id = 'workspace-a' AND aggregate_type = 'negotiation_round' AND aggregate_id = 'round-claim'");
    database.exec("DELETE FROM negotiation_rounds WHERE workspace_id = 'workspace-a' AND id = 'round-claim'");
    database.exec("COMMIT");

    const afterPurge = claim.run(
      "receipt-after", "inbound-email-gateway", "event-after", "b".repeat(64),
      "2026-01-03", "workspace-a", "round-claim",
    );
    assert.equal(afterPurge.changes, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM webhook_receipts WHERE aggregate_id = 'round-claim'").get()?.count, 0);
  } finally {
    database.close();
  }
});

test("legacy DocuSeal receipts are packet-bound and packet-bound claims cannot survive purge", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const name of migrationNames.slice(0, migrationNames.indexOf("0014_wide_sleeper.sql"))) applyMigration(database, name);
    database.exec(`INSERT INTO signature_packets (
      id, workspace_id, agreement_id, basis_hash, document_version, document_sha256,
      active_key, provider, external_id, submission_id, status, signers, version,
      created_at, updated_at, completed_at
    ) VALUES (
      'packet-legacy', 'workspace-a', 7, '${"a".repeat(64)}', 3, '${"b".repeat(64)}',
      NULL, 'docuseal', 'external-legacy', '73001', 'completed', '[]', 4,
      '2026-08-01T10:00:00.000Z', '2026-08-01T11:00:00.000Z', '2026-08-01T11:00:00.000Z'
    )`);
    database.exec(`INSERT INTO webhook_receipts (
      id, workspace_id, provider, provider_event_id, payload_digest,
      status, received_at, processed_at, error
    ) VALUES (
      'receipt-legacy', 'workspace-a', 'docuseal',
      'submission.completed:73001:2026-08-01T11:00:00.000Z', '${"c".repeat(64)}',
      'processed', '2026-08-01T11:00:01.000Z', '2026-08-01T11:00:02.000Z', NULL
    )`);

    applyMigration(database, "0014_wide_sleeper.sql");
    const backfilled = database.prepare(
      "SELECT aggregate_type AS aggregateType, aggregate_id AS aggregateId FROM webhook_receipts WHERE id = 'receipt-legacy'",
    ).get() as { aggregateType: string; aggregateId: string };
    assert.equal(backfilled.aggregateType, "signature_packet");
    assert.equal(backfilled.aggregateId, "packet-legacy");

    const claim = database.prepare(`INSERT INTO webhook_receipts (
      id, workspace_id, provider, provider_event_id, payload_digest,
      aggregate_type, aggregate_id, status, received_at, processed_at, error
    ) SELECT ?, workspace_id, 'docuseal', ?, ?, 'signature_packet', id, 'processing', ?, NULL, NULL
      FROM signature_packets
      WHERE workspace_id = ? AND id = ? AND provider = 'docuseal' AND submission_id = ?
      ON CONFLICT DO NOTHING`);

    database.exec("BEGIN");
    database.exec("DELETE FROM webhook_receipts WHERE workspace_id = 'workspace-a' AND aggregate_type = 'signature_packet' AND aggregate_id = 'packet-legacy'");
    database.exec("DELETE FROM signature_packets WHERE workspace_id = 'workspace-a' AND id = 'packet-legacy'");
    database.exec("COMMIT");

    const afterPurge = claim.run(
      "receipt-after", "submission.completed:73001:2026-08-02T11:00:00.000Z", "d".repeat(64),
      "2026-08-02T11:00:01.000Z", "workspace-a", "packet-legacy", "73001",
    );
    assert.equal(afterPurge.changes, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM webhook_receipts WHERE aggregate_id = 'packet-legacy'").get()?.count, 0);
  } finally {
    database.close();
  }
});

test("all committed migrations upgrade a legacy database without forking audit sequences", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of migrationNames.slice(0, 3)) applyMigration(database, name);

    const insertLegacyEvent = database.prepare(
      "INSERT INTO agreement_events (id, agreement_id, type, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertLegacyEvent.run("legacy-1", 7, "Created", "Legacy user", "Created", "2026-01-01T00:00:00.000Z");
    insertLegacyEvent.run("legacy-2", 7, "Updated", "Legacy user", "Updated", "2026-01-02T00:00:00.000Z");

    for (const name of migrationNames.slice(3)) applyMigration(database, name);

    const sequences = database.prepare(
      "SELECT sequence FROM agreement_events WHERE agreement_id = 7 ORDER BY sequence",
    ).all() as Array<{ sequence: number }>;
    assert.deepEqual(sequences.map((row) => row.sequence), [1, 2]);

    const tables = new Set((database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all() as Array<{ name: string }>).map((row) => row.name));
    for (const table of [
      "workspaces",
      "users",
      "workspace_memberships",
      "workspace_events",
      "agreements",
      "agreement_creation_receipts",
      "obligation_schedules",
      "obligation_evidence",
      "obligation_creation_receipts",
      "documents",
      "agreement_versions",
      "agreement_document_versions",
      "signature_packets",
      "webhook_receipts",
      "outbox_events",
      "outbox_deliveries",
      "integration_diagnostics",
      "crm_legacy_cleanup_attestations",
      "negotiation_rounds",
      "negotiation_submissions",
      "document_comparisons",
      "notice_schema_state",
      "mutation_guards",
      "purge_jobs",
    ]) assert.equal(tables.has(table), true, `missing migrated table ${table}`);

    const schemaMarker = database.prepare(
      "SELECT id, version FROM notice_schema_state WHERE id = 'primary'",
    ).get() as { id: string; version: number } | undefined;
    assert.equal(schemaMarker?.id, "primary");
    assert.equal(schemaMarker?.version, NOTICE_SCHEMA_VERSION);
    const deliveryColumns = new Set((database.prepare("PRAGMA table_info(outbox_deliveries)").all() as Array<{ name: string }>).map((row) => row.name));
    for (const column of ["crm_provider", "crm_mapping_version", "crm_destination_fingerprint"]) {
      assert.equal(deliveryColumns.has(column), true, `missing outbox delivery profile column ${column}`);
    }
    const approvalColumns = new Set((database.prepare("PRAGMA table_info(approval_requests)").all() as Array<{ name: string }>).map((row) => row.name));
    assert.equal(approvalColumns.has("requested_by_user_id"), true);
    const documentColumns = new Map((database.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string; dflt_value: string | null; notnull: number }>).map((row) => [row.name, row]));
    for (const column of ["role", "direction", "negotiation_round_id", "provider_message_id", "parent_sha256", "original_sender_email"]) {
      assert.equal(documentColumns.has(column), true, `missing negotiation document column ${column}`);
    }
    assert.equal(documentColumns.get("role")?.dflt_value, "'supporting'");
    assert.equal(documentColumns.get("role")?.notnull, 1);
    assert.equal(documentColumns.get("direction")?.dflt_value, "'internal'");
    assert.equal(documentColumns.get("direction")?.notnull, 1);
    const receiptColumns = new Set((database.prepare("PRAGMA table_info(webhook_receipts)").all() as Array<{ name: string }>).map((row) => row.name));
    for (const column of ["aggregate_type", "aggregate_id"]) {
      assert.equal(receiptColumns.has(column), true, `missing webhook receipt aggregate column ${column}`);
    }
    const creationReceiptColumns = new Set((database.prepare("PRAGMA table_info(agreement_creation_receipts)").all() as Array<{ name: string }>).map((row) => row.name));
    for (const column of ["workspace_id", "user_id", "idempotency_key", "request_sha256", "creation_mode", "agreement_id", "created_at"]) {
      assert.equal(creationReceiptColumns.has(column), true, `missing agreement creation receipt column ${column}`);
    }
    const obligationReceiptColumns = new Set((database.prepare("PRAGMA table_info(obligation_creation_receipts)").all() as Array<{ name: string }>).map((row) => row.name));
    for (const column of ["workspace_id", "user_id", "idempotency_key", "request_sha256", "agreement_id", "schedule_id", "obligation_id", "agreement_event_id", "created_at"]) {
      assert.equal(obligationReceiptColumns.has(column), true, `missing obligation creation receipt column ${column}`);
    }

    const negotiationIndexes = new Set((database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>).map((row) => row.name));
    for (const indexName of [
      "idx_documents_workspace_role",
      "idx_documents_workspace_negotiation_round",
      "uq_negotiation_rounds_workspace_agreement_round",
      "uq_negotiation_rounds_workspace_active_key",
      "uq_negotiation_rounds_workspace_alias_code",
      "uq_negotiation_rounds_workspace_portal_token_hash",
      "uq_negotiation_submissions_workspace_round_document",
      "uq_document_comparisons_workspace_round_submission",
      "idx_webhook_receipts_workspace_aggregate",
      "uq_agreement_creation_receipts_workspace_agreement",
      "idx_agreement_creation_receipts_workspace_created_at",
    ]) assert.equal(negotiationIndexes.has(indexName), true, `missing negotiation index ${indexName}`);

    const insertRound = database.prepare(`INSERT INTO negotiation_rounds (
      id, workspace_id, agreement_id, round_number, status, active_key, alias_code,
      base_document_version, base_document_id, base_sha256, outbound_document_id,
      outbound_sha256, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertRound.run(
      "round-a", "workspace-a", 7, 1, "prepared", "active-7", "alias-a", 1, null,
      "a".repeat(64), "outbound-a", "b".repeat(64), "user-a", "2026-01-01", "2026-01-01",
    );
    assert.throws(
      () => insertRound.run(
        "round-duplicate", "workspace-a", 7, 1, "prepared", null, "alias-b", 2, null,
        "c".repeat(64), "outbound-b", "d".repeat(64), "user-a", "2026-01-01", "2026-01-01",
      ),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => insertRound.run(
        "round-no-baseline", "workspace-a", 8, 1, "prepared", null, "alias-c", null, null,
        "c".repeat(64), "outbound-c", "d".repeat(64), "user-a", "2026-01-01", "2026-01-01",
      ),
      /CHECK constraint failed: ck_negotiation_rounds_baseline/,
    );
    assert.throws(
      () => insertRound.run(
        "round-two-baselines", "workspace-a", 8, 1, "prepared", null, "alias-d", 1, "source-a",
        "c".repeat(64), "outbound-d", "d".repeat(64), "user-a", "2026-01-01", "2026-01-01",
      ),
      /CHECK constraint failed: ck_negotiation_rounds_baseline/,
    );
    assert.throws(
      () => insertRound.run(
        "round-bad-status", "workspace-a", 8, 1, "invalid", null, "alias-e", null, "source-b",
        "c".repeat(64), "outbound-e", "d".repeat(64), "user-a", "2026-01-01", "2026-01-01",
      ),
      /CHECK constraint failed: ck_negotiation_rounds_status/,
    );

    const insertSubmission = database.prepare(`INSERT INTO negotiation_submissions (
      id, workspace_id, agreement_id, round_id, source, status, document_id, document_sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertSubmission.run("submission-a", "workspace-a", 7, "round-a", "email", "ready", "returned-a", "e".repeat(64), "2026-01-02");
    assert.throws(
      () => insertSubmission.run("submission-duplicate", "workspace-a", 7, "round-a", "manual", "ready", "returned-a", "e".repeat(64), "2026-01-02"),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => insertSubmission.run("submission-bad-status", "workspace-a", 7, "round-a", "portal", "unknown", null, null, "2026-01-02"),
      /CHECK constraint failed: ck_negotiation_submissions_status/,
    );

    const insertComparison = database.prepare(`INSERT INTO document_comparisons (
      id, workspace_id, agreement_id, round_id, submission_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insertComparison.run("comparison-a", "workspace-a", 7, "round-a", "submission-a", "ready", "2026-01-02", "2026-01-02");
    assert.throws(
      () => insertComparison.run("comparison-duplicate", "workspace-a", 7, "round-a", "submission-a", "ready", "2026-01-02", "2026-01-02"),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => insertComparison.run("comparison-bad-status", "workspace-a", 7, "round-a", "submission-b", "unknown", "2026-01-02", "2026-01-02"),
      /CHECK constraint failed: ck_document_comparisons_status/,
    );

    database.exec("INSERT INTO outbox_events (id, workspace_id, topic, aggregate_type, aggregate_id, payload, status, attempts, available_at, created_at) VALUES ('outbox-1', 'workspace-a', 'agreement.created', 'agreement', '7', '{}', 'pending', 0, '2026-01-01', '2026-01-01')");
    database.exec("INSERT INTO outbox_deliveries (event_id, sink, workspace_id, status, attempts, available_at, created_at, updated_at) VALUES ('outbox-1', 'delivery', 'workspace-a', 'accepted', 1, '2026-01-01', '2026-01-01', '2026-01-01'), ('outbox-1', 'crm', 'workspace-a', 'pending', 0, '2026-01-01', '2026-01-01', '2026-01-01')");
    assert.throws(
      () => database.exec("INSERT INTO outbox_deliveries (event_id, sink, workspace_id, status, attempts, available_at, created_at, updated_at) VALUES ('outbox-1', 'unknown', 'workspace-a', 'pending', 0, '2026-01-01', '2026-01-01', '2026-01-01')"),
      /CHECK constraint failed: ck_outbox_deliveries_sink/,
    );
    database.exec("DELETE FROM outbox_events WHERE id = 'outbox-1'");
    assert.equal(database.prepare("SELECT count(*) AS count FROM outbox_deliveries WHERE event_id = 'outbox-1'").get()?.count, 0);

    database.exec("INSERT OR IGNORE INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES ('workspace-a', 'workspace-a', 'Workspace A', 'active', '2026-01-01', '2026-01-01')");
    database.exec(`INSERT INTO crm_legacy_cleanup_attestations (workspace_id, agreement_id, event_id, event_payload_sha256, provider_selection, reason, attested_by_user_id, created_at) VALUES ('workspace-a', 7, 'legacy-event', '${"a".repeat(64)}', 'Salesforce', 'Verified downstream cleanup', 'admin-a', '2026-01-01')`);
    assert.throws(
      () => database.exec(`INSERT INTO crm_legacy_cleanup_attestations (workspace_id, agreement_id, event_id, event_payload_sha256, provider_selection, reason, attested_by_user_id, created_at) VALUES ('workspace-a', 7, 'bad-provider', '${"b".repeat(64)}', 'None', 'Invalid', 'admin-a', '2026-01-01')`),
      /CHECK constraint failed: ck_crm_legacy_cleanup_provider/,
    );
    assert.throws(
      () => database.exec("INSERT INTO crm_legacy_cleanup_attestations (workspace_id, agreement_id, event_id, event_payload_sha256, provider_selection, reason, attested_by_user_id, created_at) VALUES ('workspace-a', 7, 'bad-digest', 'short', 'HubSpot', 'Invalid', 'admin-a', '2026-01-01')"),
      /CHECK constraint failed: ck_crm_legacy_cleanup_digest/,
    );

    assert.throws(
      () => database.exec("INSERT INTO mutation_guards (id, workspace_id, operation, guard_changes, created_at) VALUES ('unguarded-mutation', 'workspace-a', 'test', 0, '2026-01-01')"),
      /CHECK constraint failed: ck_mutation_guards_changes/,
    );

    assert.throws(
      () => database.exec("INSERT INTO purge_jobs (id, workspace_id, resource_type, resource_id, object_keys, status, guard_changes, attempts, created_at, updated_at) VALUES ('unguarded', 'workspace-a', 'document', 'doc-a', '[]', 'storage_pending', 0, 0, '2026-01-01', '2026-01-01')"),
      /CHECK constraint failed: ck_purge_jobs_guard_changes/,
    );

    database.exec("INSERT INTO workspace_events (id, workspace_id, sequence, type, actor_user_id, actor_email, actor, detail, event_hash, created_at) VALUES ('event-1', 'workspace-a', 1, 'Membership', 'user-a', 'a@test.invalid', 'A', 'Granted access', 'hash-1', '2026-01-01T00:00:00.000Z')");
    assert.throws(
      () => database.exec("INSERT INTO workspace_events (id, workspace_id, sequence, type, actor_user_id, actor_email, actor, detail, event_hash, created_at) VALUES ('event-2', 'workspace-a', 1, 'Membership', 'user-b', 'b@test.invalid', 'B', 'Granted access', 'hash-2', '2026-01-02T00:00:00.000Z')"),
      /UNIQUE constraint failed/,
    );

    database.exec("INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES ('protected-workspace', 'protected-workspace', 'Protected workspace', 'active', '2026-01-01', '2026-01-01')");
    database.exec("INSERT INTO users (id, identity_provider, identity_subject, email, display_name, status, created_at, updated_at, last_seen_at) VALUES ('admin-a', 'test', 'admin-a', 'admin-a@test.invalid', 'Admin A', 'active', '2026-01-01', '2026-01-01', '2026-01-01'), ('admin-b', 'test', 'admin-b', 'admin-b@test.invalid', 'Admin B', 'active', '2026-01-01', '2026-01-01', '2026-01-01')");
    database.exec("INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at, updated_at) VALUES ('protected-workspace', 'admin-a', 'admin', 'active', '2026-01-01', '2026-01-01'), ('protected-workspace', 'admin-b', 'admin', 'active', '2026-01-01', '2026-01-01')");
    database.exec("INSERT INTO integration_diagnostics (workspace_id, integration_id, configuration_fingerprint, status, tested_at, detail, tested_by_user_id, updated_at) VALUES ('protected-workspace', 'crm', 'fingerprint', 'passed', '2026-01-01', 'Passed', 'admin-a', '2026-01-01')");
    assert.throws(
      () => database.exec("INSERT INTO integration_diagnostics (workspace_id, integration_id, configuration_fingerprint, status, tested_at, detail, tested_by_user_id, updated_at) VALUES ('protected-workspace', 'unknown', 'fingerprint', 'passed', '2026-01-01', 'Passed', 'admin-a', '2026-01-01')"),
      /CHECK constraint failed: ck_integration_diagnostics_id/,
    );
    database.exec("UPDATE workspace_memberships SET status = 'disabled' WHERE workspace_id = 'protected-workspace' AND user_id = 'admin-a'");
    assert.throws(
      () => database.exec("UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = 'protected-workspace' AND user_id = 'admin-b'"),
      /last_active_admin/,
    );
    assert.throws(
      () => database.exec("DELETE FROM workspace_memberships WHERE workspace_id = 'protected-workspace' AND user_id = 'admin-b'"),
      /last_active_admin/,
    );
  } finally {
    database.close();
  }
});

test("purge job changes guard atomically rejects a lost parent precondition", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const name of migrationNames) applyMigration(database, name);
    database.exec("CREATE TABLE purge_protocol_parent (id text PRIMARY KEY, eligible integer NOT NULL)");
    database.exec("INSERT INTO purge_protocol_parent (id, eligible) VALUES ('lost', 0), ('eligible', 1)");

    database.exec("BEGIN");
    let lostError: unknown;
    try {
      database.exec("DELETE FROM purge_protocol_parent WHERE id = 'lost' AND eligible = 1");
      database.exec("INSERT INTO purge_jobs (id, workspace_id, resource_type, resource_id, object_keys, status, guard_changes, attempts, created_at, updated_at) VALUES ('purge-lost', 'workspace-a', 'document', 'lost', '[]', 'storage_pending', changes(), 0, '2026-08-01', '2026-08-01')");
      database.exec("COMMIT");
    } catch (error) {
      lostError = error;
      database.exec("ROLLBACK");
    }
    assert.match(String(lostError), /CHECK constraint failed: ck_purge_jobs_guard_changes/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM purge_protocol_parent WHERE id = 'lost'").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM purge_jobs WHERE id = 'purge-lost'").get()?.count, 0);

    database.exec("BEGIN");
    database.exec("DELETE FROM purge_protocol_parent WHERE id = 'eligible' AND eligible = 1");
    database.exec("INSERT INTO purge_jobs (id, workspace_id, resource_type, resource_id, object_keys, status, guard_changes, attempts, created_at, updated_at) VALUES ('purge-eligible', 'workspace-a', 'document', 'eligible', '[\"workspaces/workspace-a/documents/eligible.pdf\"]', 'storage_pending', changes(), 0, '2026-08-01', '2026-08-01')");
    database.exec("COMMIT");

    assert.equal(database.prepare("SELECT count(*) AS count FROM purge_protocol_parent WHERE id = 'eligible'").get()?.count, 0);
    const manifest = database.prepare("SELECT status, guard_changes FROM purge_jobs WHERE id = 'purge-eligible'").get() as { status: string; guard_changes: number };
    assert.equal(manifest.status, "storage_pending");
    assert.equal(manifest.guard_changes, 1);
  } finally {
    database.close();
  }
});

test("a lost optimistic update aborts audit, snapshot, and outbox side effects", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of migrationNames) applyMigration(database, name);
    database.exec("INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES ('workspace-a', 'workspace-a', 'Workspace A', 'active', '2026-01-01', '2026-01-01')");
    database.exec("INSERT INTO agreements (id, workspace_id, version, party, initials, side, type, stage, owner, next_action, due, crm, crm_record, tags, updated) VALUES (7, 'workspace-a', 1, 'Orchid', 'OR', 'Sell-side', 'MSA', 'Draft', 'Owner', 'Review', '2026-09-01', 'None', '', '[]', '2026-01-01')");

    database.exec("BEGIN");
    let guardError: unknown;
    try {
      database.exec("UPDATE agreements SET version = 2 WHERE workspace_id = 'workspace-a' AND id = 7 AND version = 99");
      database.exec("INSERT INTO mutation_guards (id, workspace_id, operation, guard_changes, created_at) VALUES ('lost-update', 'workspace-a', 'agreement.update', changes(), '2026-01-02')");
      database.exec("INSERT INTO agreement_events (id, workspace_id, agreement_id, type, actor, detail, sequence, event_hash, created_at) VALUES ('false-event', 'workspace-a', 7, 'Updated', 'Actor', 'False event', 1, 'hash', '2026-01-02')");
      database.exec("INSERT INTO agreement_versions (id, workspace_id, agreement_id, version, snapshot, checksum_sha256, created_by_user_id, created_at) VALUES ('false-snapshot', 'workspace-a', 7, 2, '{}', 'hash', 'actor', '2026-01-02')");
      database.exec("INSERT INTO outbox_events (id, workspace_id, topic, aggregate_type, aggregate_id, payload, status, attempts, available_at, created_at) VALUES ('false-outbox', 'workspace-a', 'agreement.updated', 'agreement', '7', '{}', 'pending', 0, '2026-01-02', '2026-01-02')");
      database.exec("COMMIT");
    } catch (error) {
      guardError = error;
      database.exec("ROLLBACK");
    }

    assert.match(String(guardError), /CHECK constraint failed: ck_mutation_guards_changes/);
    assert.equal(database.prepare("SELECT version FROM agreements WHERE id = 7").get()?.version, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_events WHERE id = 'false-event'").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_versions WHERE id = 'false-snapshot'").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM outbox_events WHERE id = 'false-outbox'").get()?.count, 0);
  } finally {
    database.close();
  }
});

test("a same-version derived queue update aborts a stale detail snapshot", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of migrationNames) applyMigration(database, name);
    database.exec("INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES ('workspace-a', 'workspace-a', 'Workspace A', 'active', '2026-01-01', '2026-01-01')");
    database.exec("INSERT INTO agreements (id, workspace_id, version, party, initials, side, type, stage, owner, next_action, due, crm, crm_record, tags, updated) VALUES (8, 'workspace-a', 1, 'Orchid', 'OR', 'Sell-side', 'MSA', 'Negotiation', 'Owner', 'Send negotiation round 1 to the counterparty', '2026-09-01', 'None', '', '[]', '2026-01-01')");

    const staleNextAction = "Send negotiation round 1 to the counterparty";
    database.exec("UPDATE agreements SET next_action = 'Review returned counterparty file for negotiation round 1' WHERE workspace_id = 'workspace-a' AND id = 8 AND version = 1");

    database.exec("BEGIN");
    let guardError: unknown;
    try {
      database.prepare("UPDATE agreements SET owner = 'Stale owner', version = 2 WHERE workspace_id = 'workspace-a' AND id = 8 AND version = 1 AND next_action = ?").run(staleNextAction);
      database.exec("INSERT INTO mutation_guards (id, workspace_id, operation, guard_changes, created_at) VALUES ('queue-race', 'workspace-a', 'agreement.update', changes(), '2026-01-02')");
      database.exec("INSERT INTO agreement_versions (id, workspace_id, agreement_id, version, snapshot, checksum_sha256, created_by_user_id, created_at) VALUES ('stale-queue-snapshot', 'workspace-a', 8, 2, '{}', 'hash', 'actor', '2026-01-02')");
      database.exec("COMMIT");
    } catch (error) {
      guardError = error;
      database.exec("ROLLBACK");
    }

    assert.match(String(guardError), /CHECK constraint failed: ck_mutation_guards_changes/);
    const current = database.prepare("SELECT version, owner, next_action FROM agreements WHERE id = 8").get() as { version: number; owner: string; next_action: string };
    assert.deepEqual({ ...current }, {
      version: 1,
      owner: "Owner",
      next_action: "Review returned counterparty file for negotiation round 1",
    });
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_versions WHERE id = 'stale-queue-snapshot'").get()?.count, 0);
  } finally {
    database.close();
  }
});

test("document and retention mutation guards reject zero-row updates before audit side effects", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of migrationNames) applyMigration(database, name);
    database.exec("INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES ('workspace-a', 'workspace-a', 'Workspace A', 'active', '2026-01-01', '2026-01-01')");
    database.exec("INSERT INTO agreements (id, workspace_id, version, party, initials, side, type, stage, owner, next_action, due, crm, crm_record, tags, updated) VALUES (7, 'workspace-a', 1, 'Orchid', 'OR', 'Sell-side', 'MSA', 'Draft', 'Owner', 'Review', '2026-09-01', 'None', '', '[]', '2026-01-01')");
    database.exec("INSERT INTO documents (id, workspace_id, version, agreement_id, file_name, object_key, content_type, size, tags, extracted, created_at) VALUES ('document-a', 'workspace-a', 1, 7, 'contract.txt', 'workspaces/workspace-a/quarantine/document-a', 'text/plain', 8, '[]', '{}', '2026-01-01')");

    database.exec("BEGIN");
    let documentError: unknown;
    try {
      database.exec("UPDATE documents SET agreement_id = 7, version = 2 WHERE workspace_id = 'workspace-a' AND id = 'document-a' AND version = 99");
      database.exec("INSERT INTO mutation_guards (id, workspace_id, operation, guard_changes, created_at) VALUES ('document-lost-update', 'workspace-a', 'document.link', changes(), '2026-01-02')");
      database.exec("INSERT INTO workspace_events (id, workspace_id, sequence, type, actor_user_id, actor_email, actor, detail, event_hash, created_at) VALUES ('false-document-event', 'workspace-a', 1, 'Document', 'actor', 'actor@test.invalid', 'Actor', 'False document event', 'hash-document', '2026-01-02')");
      database.exec("COMMIT");
    } catch (error) {
      documentError = error;
      database.exec("ROLLBACK");
    }
    assert.match(String(documentError), /CHECK constraint failed: ck_mutation_guards_changes/);
    assert.equal(database.prepare("SELECT version FROM documents WHERE id = 'document-a'").get()?.version, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM workspace_events WHERE id = 'false-document-event'").get()?.count, 0);

    database.exec("BEGIN");
    let retentionError: unknown;
    try {
      database.exec("UPDATE agreements SET legal_hold = 1, version = 2 WHERE workspace_id = 'workspace-a' AND id = 7 AND version = 99");
      database.exec("INSERT INTO mutation_guards (id, workspace_id, operation, guard_changes, created_at) VALUES ('retention-lost-update', 'workspace-a', 'retention.policy.agreement', changes(), '2026-01-02')");
      database.exec("INSERT INTO agreement_events (id, workspace_id, agreement_id, type, actor, detail, sequence, event_hash, created_at) VALUES ('false-retention-event', 'workspace-a', 7, 'Records policy', 'Actor', 'False policy event', 1, 'hash-retention', '2026-01-02')");
      database.exec("INSERT INTO agreement_versions (id, workspace_id, agreement_id, version, snapshot, checksum_sha256, created_by_user_id, created_at) VALUES ('false-retention-snapshot', 'workspace-a', 7, 2, '{}', 'hash', 'actor', '2026-01-02')");
      database.exec("COMMIT");
    } catch (error) {
      retentionError = error;
      database.exec("ROLLBACK");
    }
    assert.match(String(retentionError), /CHECK constraint failed: ck_mutation_guards_changes/);
    assert.equal(database.prepare("SELECT legal_hold, version FROM agreements WHERE id = 7").get()?.legal_hold, 0);
    assert.equal(database.prepare("SELECT version FROM agreements WHERE id = 7").get()?.version, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_events WHERE id = 'false-retention-event'").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_versions WHERE id = 'false-retention-snapshot'").get()?.count, 0);
  } finally {
    database.close();
  }
});

test("the delivery-ledger upgrade leaves historical CRM projections visibly unprofiled", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of migrationNames.slice(0, 10)) applyMigration(database, name);
    const insert = database.prepare(
      "INSERT INTO outbox_events (id, workspace_id, topic, aggregate_type, aggregate_id, payload, status, attempts, available_at, processed_at, created_at) VALUES (?, 'workspace-a', 'agreement.updated', 'agreement', '7', ?, 'processed', 1, '2026-01-01', '2026-01-01', '2026-01-01')",
    );
    insert.run("legacy-crm", JSON.stringify({
      agreementId: 7,
      crmAgreement: { version: 3, crm: "Salesforce" },
    }));
    insert.run("legacy-opt-out", JSON.stringify({
      agreementId: 7,
      crmAgreement: { version: 4, crm: "None" },
    }));
    for (const name of migrationNames.slice(10)) applyMigration(database, name);

    const unprofiled = database.prepare(`
      select id from outbox_events as candidate
      where candidate.workspace_id = 'workspace-a'
        and candidate.topic in ('agreement.created', 'agreement.updated', 'agreement.stage_changed', 'signature.completed')
        and json_valid(candidate.payload) = 1
        and json_type(candidate.payload, '$.crmAgreement.crm') = 'text'
        and json_extract(candidate.payload, '$.crmAgreement.crm') <> 'None'
        and not exists (
          select 1 from outbox_deliveries as delivery
          where delivery.workspace_id = candidate.workspace_id
            and delivery.event_id = candidate.id
            and delivery.sink = 'crm'
        )
      order by id
    `).all() as Array<{ id: string }>;
    assert.deepEqual(unprofiled.map((row) => row.id), ["legacy-crm"]);
  } finally {
    database.close();
  }
});
