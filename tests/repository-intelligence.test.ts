import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  decodeRepositorySearchCursor,
  encodeRepositorySearchCursor,
  fragmentPostSchema,
  ingestionPostSchema,
  playbookRulesSchema,
  repositorySearchBinding,
  repositorySearchTerms,
  RepositoryIntelligenceError,
} from "../app/lib/repository-intelligence";
import { NOTICE_SCHEMA_VERSION } from "../db/schema-guard";

const migrationNames = readdirSync(new URL("../drizzle/", import.meta.url))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

function applyMigrations(database: DatabaseSync) {
  for (const name of migrationNames) {
    const sql = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }
}

test("repository contracts bound inputs, exact Unicode offsets, and search cursors", async () => {
  const rule = {
    key: "limitation.liability",
    title: "Liability cap",
    category: "Risk",
    position: "preferred" as const,
    preferredText: "Liability is capped.",
    alternatives: [],
    reviewGuidance: "Escalate uncapped liability.",
    risk: "high" as const,
  };
  assert.equal(playbookRulesSchema.safeParse({ clauses: [rule, rule] }).success, false);

  const exact = fragmentPostSchema.safeParse({
    documentVersionId: "00000000-0000-4000-8000-000000000001",
    documentVersion: 1,
    documentSha256: "a".repeat(64),
    sourceTextSha256: "b".repeat(64),
    extractor: "fixture",
    extractorVersion: "1",
    fragments: [{ ordinal: 0, startOffset: 10, endOffset: 12, content: "A😀" }],
  });
  assert.equal(exact.success, true, "offsets use Unicode code points, not UTF-16 units");
  assert.equal(fragmentPostSchema.safeParse({
    ...exact.data,
    fragments: [
      { ordinal: 0, startOffset: 0, endOffset: 3, content: "abc" },
      { ordinal: 1, startOffset: 2, endOffset: 5, content: "cde" },
    ],
  }).success, false, "overlapping evidence fragments are rejected");
  assert.equal(ingestionPostSchema.safeParse({ items: Array.from({ length: 51 }, (_, index) => ({
    fileName: `${index}.pdf`, contentType: "application/pdf", size: 1, sha256: index.toString(16).padStart(64, "0"),
  })) }).success, false);

  const terms = repositorySearchTerms("  Force-Majeure force  ");
  assert.deepEqual(terms, ["force", "majeure"]);
  const binding = await repositorySearchBinding({
    workspaceId: "workspace-a", terms, agreementId: null, documentVersionId: null, limit: 20,
  });
  const cursor = await encodeRepositorySearchCursor({
    v: 1, b: binding, s: "2026-08-20T12:00:00.000Z", t: "2026-08-20T11:00:00.000Z", i: "fragment-a",
  });
  assert.deepEqual(await decodeRepositorySearchCursor(cursor, binding), {
    v: 1, b: binding, s: "2026-08-20T12:00:00.000Z", t: "2026-08-20T11:00:00.000Z", i: "fragment-a",
  });
  await assert.rejects(
    decodeRepositorySearchCursor(`${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`, binding),
    (error) => error instanceof RepositoryIntelligenceError && error.code === "invalid_cursor",
  );
  await assert.rejects(
    decodeRepositorySearchCursor(cursor, "f".repeat(64)),
    (error) => error instanceof RepositoryIntelligenceError && error.code === "invalid_cursor",
  );
});

test("intelligence routes keep search tenant/live scoped and review separate from mutation", () => {
  const search = readFileSync(new URL("../app/api/intelligence/search/route.ts", import.meta.url), "utf8");
  for (const evidence of [
    "eq(repositoryFragments.workspaceId, workspaceId)",
    "eq(agreementDocumentVersions.workspaceId, workspaceId)",
    "eq(agreements.workspaceId, workspaceId)",
    "isNull(agreements.deletedAt)",
    "eq(agreementDocumentVersions.sha256, repositoryFragments.documentSha256)",
    ".limit(limit + 1)",
  ]) assert.ok(search.includes(evidence), `search route is missing ${evidence}`);

  const proposals = readFileSync(new URL("../app/api/intelligence/proposals/route.ts", import.meta.url), "utf8");
  assert.match(proposals, /governed_executor_required/);
  assert.match(proposals, /mutationApplied:\s*false/);
  assert.doesNotMatch(proposals, /(?:insert|update)\(agreements\)|customFieldValues/);
  assert.ok(
    proposals.indexOf("const existingReplay = await loadReplay()") < proposals.indexOf("const [source] = await db.select"),
    "an exact proposal retry must replay before mutable source, target, or ingestion status checks",
  );
  assert.equal((proposals.match(/\["pending_extraction", "review_required"\]/g) ?? []).length, 2,
    "one ingestion item must support multiple independently reviewed field proposals");
  assert.match(readFileSync(new URL("../app/api/admin/configuration/playbooks/route.ts", import.meta.url), "utf8"),
    /if \(uniqueError\(error\)\)[\s\S]*version_conflict/,
    "concurrent playbook-version creation must return a stable conflict instead of a generic server error");
  assert.match(readFileSync(new URL("../app/api/admin/configuration/playbooks/route.ts", import.meta.url), "utf8"),
    /isMutationGuardConflict\(error\)[\s\S]*version_conflict/,
    "stale playbook update, publish, and retirement commits must return one stable conflict");

  const ingestion = readFileSync(new URL("../app/api/intelligence/ingestion/route.ts", import.meta.url), "utf8");
  assert.match(ingestion, /externalCallMade:\s*false/);
  assert.match(ingestion, /extraction_provider_not_configured/);
  assert.match(ingestion, /const allDuplicates = items\.every/);
  assert.match(ingestion, /allDuplicates \? "completed"/);
  assert.match(ingestion, /inArray\(documents\.id, linkedDocumentIds\)/,
    "explicit document links must be resolved by exact ID rather than an arbitrary digest result prefix");
  assert.match(ingestion, /groupBy\(documents\.sha256\)/,
    "duplicate hints must select one bounded candidate per source digest");
  const fragmentsRoute = readFileSync(new URL("../app/api/intelligence/fragments/route.ts", import.meta.url), "utf8");
  assert.match(fragmentsRoute, /const missing = fragments\.filter/);
  assert.match(fragmentsRoute, /existing\.length \+ missing\.length > REPOSITORY_FRAGMENT_MAX_TOTAL/);
});

test("schema 19 enforces governed intelligence evidence and enterprise pins", () => {
  const migration = readFileSync(new URL("../drizzle/0019_romantic_kabuki.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /DROP TABLE|__new_|PRAGMA foreign_keys/i);
  assert.match(migration.trim(), /SET `version` = 19[\s\S]*WHERE `id` = 'primary' AND `version` = 18;$/);

  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    const now = "2026-08-20T12:00:00.000Z";
    database.exec(`
      INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES
        ('workspace-a', 'repo-a', 'Repository A', 'active', '${now}', '${now}'),
        ('workspace-b', 'repo-b', 'Repository B', 'active', '${now}', '${now}');
      INSERT INTO users (id, identity_provider, identity_subject, email, display_name, status, created_at, updated_at, last_seen_at) VALUES
        ('creator', 'test', 'creator', 'creator@repo.invalid', 'Creator', 'active', '${now}', '${now}', '${now}'),
        ('publisher', 'test', 'publisher', 'publisher@repo.invalid', 'Publisher', 'active', '${now}', '${now}', '${now}');
      INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at, updated_at) VALUES
        ('workspace-a', 'creator', 'admin', 'active', '${now}', '${now}'),
        ('workspace-a', 'publisher', 'admin', 'active', '${now}', '${now}');
      INSERT INTO workflow_definitions (
        id, workspace_id, version, name, description, status, definition, definition_sha256,
        created_by_user_id, created_at, updated_by_user_id, updated_at, published_by_user_id, published_at
      ) VALUES
        ('workflow-a', 'workspace-a', 1, 'Workflow A', '', 'published', '{}', '${"a".repeat(64)}', 'creator', '${now}', 'publisher', '${now}', 'publisher', '${now}'),
        ('workflow-b', 'workspace-a', 1, 'Workflow B', '', 'retired', '{}', '${"b".repeat(64)}', 'creator', '${now}', 'publisher', '${now}', 'publisher', '${now}');
      INSERT INTO agreements (
        id, workspace_id, version, party, initials, side, type, stage, owner, next_action, due, crm, crm_record,
        tags, updated, workflow_definition_id, workflow_policy_sha256, workflow_approval_lanes
      ) VALUES
        (1901, 'workspace-a', 1, 'Acme', 'AC', 'Sell-side', 'MSA', 'Review', 'Owner', 'Review', '2026-09-01', 'None', '', '[]', '${now}',
          'workflow-a', '${"a".repeat(64)}', '["Legal","Finance"]'),
        (1902, 'workspace-b', 1, 'Other', 'OT', 'Buy-side', 'NDA', 'Draft', 'Owner', 'Review', '2026-09-01', 'None', '', '[]', '${now}', NULL, NULL, NULL);
      INSERT INTO agreement_document_versions (
        id, workspace_id, agreement_id, version, label, object_key, content_type, size, sha256, source_document_id,
        created_by_user_id, created_at
      ) VALUES
        ('00000000-0000-4000-8000-000000000101', 'workspace-a', 1901, 1, 'Working paper', 'workspaces/a/working/1', 'text/plain', 11, '${"c".repeat(64)}', NULL, 'creator', '${now}'),
        ('00000000-0000-4000-8000-000000000102', 'workspace-b', 1902, 1, 'Other paper', 'workspaces/b/working/1', 'text/plain', 5, '${"d".repeat(64)}', NULL, 'creator', '${now}');
    `);

    database.exec("UPDATE workflow_definitions SET status = 'retired' WHERE id = 'workflow-a'");
    database.exec("UPDATE agreements SET value_minor = 12500, currency_code = 'USD' WHERE id = 1901");
    assert.equal(database.prepare("SELECT value_minor FROM agreements WHERE id = 1901").get()?.value_minor, 12500,
      "an unchanged retired workflow pin must not brick unrelated agreement updates");
    database.exec(`UPDATE agreements SET workflow_approval_lanes = '["Legal","Finance","Security"]' WHERE id = 1901`);
    assert.throws(
      () => database.exec(`UPDATE agreements SET workflow_approval_lanes = '["Legal","legal"]' WHERE id = 1901`),
      /invalid_agreement_workflow_snapshot/,
    );
    assert.throws(
      () => database.exec(`UPDATE agreements SET workflow_definition_id = 'workflow-b', workflow_policy_sha256 = '${"b".repeat(64)}', workflow_approval_lanes = '["Legal"]' WHERE id = 1901`),
      /invalid_agreement_/,
    );
    assert.throws(
      () => database.exec(`INSERT INTO agreements (id, workspace_id, version, party, initials, side, type, stage, owner, next_action, due, crm, crm_record, tags, updated, workflow_definition_id, workflow_policy_sha256, workflow_approval_lanes)
        VALUES (1903, 'workspace-a', 1, 'Retired', 'RT', 'Sell-side', 'NDA', 'Draft', 'Owner', 'Review', '2026-09-01', 'None', '', '[]', '${now}', 'workflow-a', '${"a".repeat(64)}', '["Legal"]')`),
      /invalid_agreement_/,
    );

    database.exec(`
      INSERT INTO clause_playbooks (id, workspace_id, version, name, description, scope, status, current_published_version, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES ('playbook-a', 'workspace-a', 1, 'MSA standards', '', '{}', 'draft', NULL, 'creator', '${now}', 'creator', '${now}');
      INSERT INTO clause_playbook_versions (id, workspace_id, playbook_id, version, status, rules, content_sha256, change_summary, created_by_user_id, created_at, published_by_user_id, published_at)
      VALUES ('playbook-version-a', 'workspace-a', 'playbook-a', 1, 'draft', '{"clauses":[]}', '${"e".repeat(64)}', 'Initial governed version', 'creator', '${now}', NULL, NULL);
    `);
    assert.throws(
      () => database.exec(`UPDATE clause_playbook_versions SET status = 'published', published_by_user_id = 'creator', published_at = '${now}' WHERE id = 'playbook-version-a'`),
      /CHECK constraint failed: ck_clause_playbook_versions_publisher/,
    );
    database.exec(`UPDATE clause_playbook_versions SET status = 'published', published_by_user_id = 'publisher', published_at = '${now}' WHERE id = 'playbook-version-a'`);
    database.exec("UPDATE clause_playbooks SET status = 'published', current_published_version = 1 WHERE id = 'playbook-a'");
    assert.throws(
      () => database.exec("UPDATE clause_playbooks SET scope = '{\"agreementTypes\":[\"NDA\"],\"sides\":[],\"jurisdictions\":[]}' WHERE id = 'playbook-a'"),
      /immutable_clause_playbook_scope/,
    );
    database.exec(`
      INSERT INTO clause_playbook_versions (id, workspace_id, playbook_id, version, status, rules, content_sha256, change_summary, created_by_user_id, created_at, published_by_user_id, published_at) VALUES
        ('playbook-version-b', 'workspace-a', 'playbook-a', 2, 'draft', '{"clauses":[]}', '${"6".repeat(64)}', 'Second governed version', 'creator', '${now}', NULL, NULL),
        ('playbook-version-c', 'workspace-a', 'playbook-a', 3, 'draft', '{"clauses":[]}', '${"7".repeat(64)}', 'Third governed version', 'creator', '${now}', NULL, NULL);
      UPDATE clause_playbook_versions SET status = 'published', published_by_user_id = 'publisher', published_at = '${now}' WHERE id = 'playbook-version-c';
      UPDATE clause_playbooks SET current_published_version = 3 WHERE id = 'playbook-a';
      UPDATE clause_playbook_versions SET status = 'published', published_by_user_id = 'publisher', published_at = '${now}' WHERE id = 'playbook-version-b';
    `);
    assert.throws(
      () => database.exec("UPDATE clause_playbooks SET current_published_version = 2 WHERE id = 'playbook-a'"),
      /invalid_clause_playbook_lifecycle/,
      "publishing a leftover older draft cannot roll the governed parent backward",
    );

    database.exec(`INSERT INTO repository_fragments (
      id, workspace_id, document_version_id, agreement_id, document_version, document_sha256, source_text_sha256,
      ordinal, start_offset, end_offset, content, content_sha256, extractor, extractor_version, created_by_user_id, created_at
    ) VALUES ('fragment-a', 'workspace-a', '00000000-0000-4000-8000-000000000101', 1901, 1, '${"c".repeat(64)}', '${"f".repeat(64)}',
      0, 0, 11, 'hello world', '${"1".repeat(64)}', 'fixture', '1', 'creator', '${now}')`);
    assert.throws(
      () => database.exec(`INSERT INTO repository_fragments (id, workspace_id, document_version_id, agreement_id, document_version, document_sha256, source_text_sha256, ordinal, start_offset, end_offset, content, content_sha256, extractor, extractor_version, created_by_user_id, created_at)
        VALUES ('fragment-overlap', 'workspace-a', '00000000-0000-4000-8000-000000000101', 1901, 1, '${"c".repeat(64)}', '${"f".repeat(64)}', 1, 5, 12, 'overlap', '${"2".repeat(64)}', 'fixture', '1', 'creator', '${now}')`),
      /repository_fragment_overlap/,
    );
    database.exec(`WITH RECURSIVE fragment_number(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM fragment_number WHERE n < 499
    ) INSERT INTO repository_fragments (
      id, workspace_id, document_version_id, agreement_id, document_version, document_sha256, source_text_sha256,
      ordinal, start_offset, end_offset, content, content_sha256, extractor, extractor_version, created_by_user_id, created_at
    ) SELECT printf('bulk-fragment-%03d', n), 'workspace-a', '00000000-0000-4000-8000-000000000101', 1901, 1,
      '${"c".repeat(64)}', '${"f".repeat(64)}', n, 20 + n * 2, 21 + n * 2, 'x', '${"2".repeat(64)}', 'fixture', '1', 'creator', '${now}'
    FROM fragment_number`);
    assert.throws(
      () => database.exec(`INSERT INTO repository_fragments (id, workspace_id, document_version_id, agreement_id, document_version, document_sha256, source_text_sha256, ordinal, start_offset, end_offset, content, content_sha256, extractor, extractor_version, created_by_user_id, created_at)
        VALUES ('fragment-over-limit', 'workspace-a', '00000000-0000-4000-8000-000000000101', 1901, 1, '${"c".repeat(64)}', '${"f".repeat(64)}', 500, 2000, 2001, 'x', '${"2".repeat(64)}', 'fixture', '1', 'creator', '${now}')`),
      /repository_fragment_limit/,
    );
    assert.throws(
      () => database.exec(`INSERT INTO repository_fragments (id, workspace_id, document_version_id, agreement_id, document_version, document_sha256, source_text_sha256, ordinal, start_offset, end_offset, content, content_sha256, extractor, extractor_version, created_by_user_id, created_at)
        VALUES ('fragment-cross-tenant', 'workspace-b', '00000000-0000-4000-8000-000000000101', 1901, 1, '${"c".repeat(64)}', '${"f".repeat(64)}', 1, 0, 5, 'hello', '${"2".repeat(64)}', 'fixture', '1', 'creator', '${now}')`),
      /invalid_repository_fragment_source|FOREIGN KEY constraint failed/,
    );
    database.exec(`INSERT INTO extraction_proposals (
      id, workspace_id, document_version_id, agreement_id, ingestion_item_id, document_version, document_sha256,
      source_text_sha256, target_type, target_field, custom_field_definition_id, proposed_value, confidence_ppm,
      extractor, extractor_version, status, application_status, blocker_code, blocker_message,
      reviewed_by_user_id, reviewed_at, review_reason, created_by_user_id, created_at, updated_at
    ) VALUES ('proposal-a', 'workspace-a', '00000000-0000-4000-8000-000000000101', 1901, NULL, 1, '${"c".repeat(64)}',
      '${"f".repeat(64)}', 'agreement_field', 'party', NULL, '"Acme"', 900000, 'fixture', '1', 'pending_review',
      'not_reviewed', 'human_review_required', 'Human review is required.', NULL, NULL, NULL, 'creator', '${now}', '${now}');
      INSERT INTO extraction_proposal_citations (
        id, workspace_id, proposal_id, fragment_id, document_version_id, document_version, document_sha256,
        source_text_sha256, start_offset, end_offset, quote, quote_sha256
      ) VALUES ('citation-a', 'workspace-a', 'proposal-a', 'fragment-a', '00000000-0000-4000-8000-000000000101', 1,
        '${"c".repeat(64)}', '${"f".repeat(64)}', 0, 5, 'hello', '${"3".repeat(64)}');
    `);
    assert.throws(
      () => database.exec("UPDATE extraction_proposals SET status = 'accepted', application_status = 'blocked' WHERE id = 'proposal-a'"),
      /CHECK constraint failed: ck_extraction_proposals_review/,
    );
    database.exec(`UPDATE extraction_proposals SET status = 'accepted', application_status = 'blocked',
      blocker_code = 'governed_executor_required', blocker_message = 'No governed executor.',
      reviewed_by_user_id = 'publisher', reviewed_at = '${now}', review_reason = 'Exact source reviewed.' WHERE id = 'proposal-a'`);

    database.exec(`
      INSERT INTO ingestion_batches (id, workspace_id, created_by_user_id, idempotency_key_sha256, request_sha256, status, item_count, accepted_count, rejected_count, blocker_code, blocker_message, created_at, updated_at, completed_at)
      VALUES ('batch-a', 'workspace-a', 'creator', '${"4".repeat(64)}', '${"5".repeat(64)}', 'awaiting_upload', 1, 0, 0, 'upload_required', 'Upload required.', '${now}', '${now}', NULL);
      INSERT INTO ingestion_items (id, workspace_id, batch_id, ordinal, file_name, content_type, size, source_sha256, dedupe_sha256, document_id, duplicate_of_document_id, status, blocker_code, blocker_message, reviewed_by_user_id, reviewed_at, review_reason, created_at, updated_at)
      VALUES ('item-a', 'workspace-a', 'batch-a', 0, 'contract.pdf', 'application/pdf', 10, '${"6".repeat(64)}', '${"7".repeat(64)}', NULL, NULL, 'awaiting_upload', 'upload_required', 'Upload required.', NULL, NULL, NULL, '${now}', '${now}');
    `);
    assert.throws(
      () => database.exec(`INSERT INTO ingestion_items (id, workspace_id, batch_id, ordinal, file_name, content_type, size, source_sha256, dedupe_sha256, status, blocker_code, blocker_message, created_at, updated_at)
        VALUES ('item-overflow', 'workspace-a', 'batch-a', 1, 'overflow.pdf', 'application/pdf', 10, '${"8".repeat(64)}', '${"9".repeat(64)}', 'awaiting_upload', 'upload_required', 'Upload required.', '${now}', '${now}')`),
      /invalid_ingestion_item_scope/,
    );

    database.exec(`
      INSERT INTO governed_templates (id, workspace_id, version, name, description, agreement_type, side, status, current_published_version, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES ('template-a', 'workspace-a', 1, 'NDA', '', 'NDA', 'Sell-side', 'published', 1, 'creator', '${now}', 'publisher', '${now}');
      INSERT INTO governed_template_versions (id, workspace_id, template_id, version, status, body, variable_schema, language_block_ids, content_sha256, change_summary, created_by_user_id, created_at, reviewed_by_user_id, reviewed_at)
      VALUES ('template-version-a', 'workspace-a', 'template-a', 1, 'published', 'Body', '{}', '[]', '${"0".repeat(64)}', 'Initial', 'creator', '${now}', 'publisher', '${now}');
    `);
    assert.throws(
      () => database.exec("UPDATE governed_templates SET side = 'Buy-side' WHERE id = 'template-a'"),
      /immutable_governed_template_scope/,
      "a published version's type and side cannot be reinterpreted by mutating its parent",
    );
    assert.throws(
      () => database.exec(`INSERT INTO intake_forms (id, workspace_id, version, name, description, status, form_schema, template_id, template_version_id, workflow_definition_id, created_by_user_id, created_at, updated_by_user_id, updated_at)
        VALUES ('form-unpinned', 'workspace-a', 1, 'Unpinned', '', 'published', '{}', 'template-a', NULL, NULL, 'creator', '${now}', 'creator', '${now}')`),
      /invalid_intake_form_template_version|intake_template_version_not_current/,
    );
    database.exec(`INSERT INTO intake_forms (id, workspace_id, version, name, description, status, form_schema, template_id, template_version_id, workflow_definition_id, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES ('form-pinned', 'workspace-a', 1, 'Pinned', '', 'published', '{}', 'template-a', 'template-version-a', NULL, 'creator', '${now}', 'creator', '${now}')`);
    database.exec(`INSERT INTO intake_submissions (id, workspace_id, form_id, form_version, version, status, answers, submitted_by_user_id, agreement_id, created_at, updated_at, submitted_at, converted_at)
      VALUES ('submission-pinned-v1', 'workspace-a', 'form-pinned', 1, 1, 'submitted', '{}', 'creator', NULL, '${now}', '${now}', '${now}', NULL)`);

    database.exec("UPDATE agreements SET governed_template_version_id = 'template-version-a' WHERE id = 1901");
    database.exec(`INSERT INTO intake_forms (id, workspace_id, version, name, description, status, form_schema, template_id, template_version_id, workflow_definition_id, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES ('form-template-race', 'workspace-a', 1, 'Template race', '', 'draft', '{}', 'template-a', NULL, NULL, 'creator', '${now}', 'creator', '${now}')`);
    database.exec(`INSERT INTO governed_template_versions (id, workspace_id, template_id, version, status, body, variable_schema, language_block_ids, content_sha256, change_summary, created_by_user_id, created_at, reviewed_by_user_id, reviewed_at)
      VALUES ('template-version-b', 'workspace-a', 'template-a', 2, 'published', 'Body v2', '{}', '[]', '${"9".repeat(64)}', 'Second version', 'creator', '${now}', 'publisher', '${now}')`);
    database.exec("UPDATE governed_templates SET version = version + 1, current_published_version = 2 WHERE id = 'template-a'");
    assert.throws(
      () => database.exec("UPDATE intake_forms SET status = 'published', template_version_id = 'template-version-a' WHERE id = 'form-template-race'"),
      /intake_template_version_not_current/,
      "intake publication must reject a template version superseded after its pre-read",
    );
    assert.throws(
      () => database.exec(`INSERT INTO agreements (id, workspace_id, version, party, initials, side, type, stage, owner, next_action, due, crm, crm_record, tags, updated, governed_template_version_id)
        VALUES (1903, 'workspace-a', 1, 'Old pin', 'OP', 'Sell-side', 'NDA', 'Draft', 'Owner', 'Review', '2026-09-01', 'None', '', '[]', '${now}', 'template-version-a')`),
      /invalid_agreement_template_pin/,
      "a new agreement cannot bind a no-longer-current governed template version",
    );
    database.exec(`UPDATE intake_submissions SET status = 'converted', agreement_id = 1905, version = 2, converted_at = '${now}', updated_at = '${now}'
      WHERE id = 'submission-pinned-v1' AND status = 'submitted'`);
    database.exec(`INSERT INTO agreements (id, workspace_id, version, party, initials, side, type, stage, owner, next_action, due, crm, crm_record, tags, updated, governed_template_version_id)
      VALUES (1905, 'workspace-a', 1, 'Pinned intake', 'PI', 'Sell-side', 'NDA', 'Intake', 'Owner', 'Review', '2026-09-01', 'None', '', '[]', '${now}', 'template-version-a')`);
    assert.equal(database.prepare("SELECT governed_template_version_id FROM agreements WHERE id = 1905").get()?.governed_template_version_id, "template-version-a",
      "an exact immutable intake pin remains convertible after the template publishes a newer version");
    database.exec("UPDATE intake_forms SET status = 'retired' WHERE id = 'form-pinned'");
    database.exec("UPDATE agreements SET value_minor = value_minor + 1 WHERE id = 1901");
    database.exec("UPDATE agreements SET governed_template_version_id = 'template-version-b' WHERE id = 1901");
    database.exec("UPDATE governed_templates SET version = version + 1, status = 'retired' WHERE id = 'template-a'");
    database.exec("UPDATE agreements SET value_minor = value_minor + 1 WHERE id = 1901");
    assert.throws(
      () => database.exec(`INSERT INTO agreements (id, workspace_id, version, party, initials, side, type, stage, owner, next_action, due, crm, crm_record, tags, updated, governed_template_version_id)
        VALUES (1904, 'workspace-a', 1, 'Retired pin', 'RP', 'Sell-side', 'NDA', 'Draft', 'Owner', 'Review', '2026-09-01', 'None', '', '[]', '${now}', 'template-version-b')`),
      /invalid_agreement_template_pin/,
      "a retired template cannot be newly pinned while an existing exact pin remains updateable",
    );
    database.exec(`
      INSERT INTO intake_forms (id, workspace_id, version, name, description, status, form_schema, template_id, template_version_id, workflow_definition_id, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES ('form-submit-race', 'workspace-a', 1, 'Submit race', '', 'published', '{}', NULL, NULL, NULL, 'creator', '${now}', 'creator', '${now}');
      INSERT INTO intake_submissions (id, workspace_id, form_id, form_version, version, status, answers, submitted_by_user_id, agreement_id, created_at, updated_at, submitted_at, converted_at)
      VALUES ('submission-race', 'workspace-a', 'form-submit-race', 1, 1, 'draft', '{}', 'creator', NULL, '${now}', '${now}', NULL, NULL);
      UPDATE intake_forms SET status = 'retired' WHERE id = 'form-submit-race';
    `);
    assert.throws(
      () => database.exec(`UPDATE intake_submissions SET status = 'submitted', submitted_at = '${now}', version = 2 WHERE id = 'submission-race'`),
      /intake_form_not_published/,
      "a form retirement that wins the race must prevent a late draft submission",
    );

    database.exec(`
      INSERT INTO legal_entities (id, workspace_id, version, legal_name, display_name, entity_type, jurisdiction, registration_number, default_currency_code, status, created_by_user_id, created_at, updated_by_user_id, updated_at) VALUES
        ('entity-a', 'workspace-a', 1, 'Entity A LLC', 'Entity A', 'company', '', '', 'USD', 'active', 'creator', '${now}', 'creator', '${now}'),
        ('entity-b', 'workspace-a', 1, 'Entity B LLC', 'Entity B', 'company', '', '', 'USD', 'active', 'creator', '${now}', 'creator', '${now}');
      INSERT INTO agreement_parties (id, workspace_id, agreement_id, role, legal_entity_id, counterparty_id, \`primary\`, created_by_user_id, created_at)
      VALUES ('party-a', 'workspace-a', 1901, 'our_entity', 'entity-a', NULL, 1, 'creator', '${now}');
    `);
    assert.throws(
      () => database.exec(`INSERT INTO agreement_parties (id, workspace_id, agreement_id, role, legal_entity_id, counterparty_id, \`primary\`, created_by_user_id, created_at)
        VALUES ('party-duplicate', 'workspace-a', 1901, 'our_entity', 'entity-a', NULL, 0, 'creator', '${now}')`),
      /duplicate_agreement_party/,
      "null target columns must not let a concurrent duplicate party bypass uniqueness",
    );
    assert.throws(
      () => database.exec(`INSERT INTO agreement_parties (id, workspace_id, agreement_id, role, legal_entity_id, counterparty_id, \`primary\`, created_by_user_id, created_at)
        VALUES ('party-b', 'workspace-a', 1901, 'our_entity', 'entity-b', NULL, 1, 'creator', '${now}')`),
      /UNIQUE constraint failed/,
    );
    database.exec(`INSERT INTO approval_lane_authorities (id, workspace_id, version, lane, subject_type, subject_id, currency_code, amount_limit_minor, status, reason, created_by_user_id, created_at, updated_by_user_id, updated_at) VALUES
      ('authority-usd', 'workspace-a', 1, 'Legal', 'user', 'creator', 'USD', 10000, 'active', 'USD authority', 'publisher', '${now}', 'publisher', '${now}'),
      ('authority-eur', 'workspace-a', 1, 'Legal', 'user', 'creator', 'EUR', 10000, 'active', 'EUR authority', 'publisher', '${now}', 'publisher', '${now}')`);

    database.exec(`UPDATE agreements SET deleted_at = '${now}' WHERE id = 1901`);
    assert.throws(
      () => database.exec(`INSERT INTO repository_fragments (id, workspace_id, document_version_id, agreement_id, document_version, document_sha256, source_text_sha256, ordinal, start_offset, end_offset, content, content_sha256, extractor, extractor_version, created_by_user_id, created_at)
        VALUES ('fragment-after-delete', 'workspace-a', '00000000-0000-4000-8000-000000000101', 1901, 1, '${"c".repeat(64)}', '${"9".repeat(64)}', 1, 0, 5, 'hello', '${"2".repeat(64)}', 'fixture', '1', 'creator', '${now}')`),
      /invalid_repository_fragment_source/,
    );
    database.exec("DELETE FROM agreements WHERE id = 1901");
    assert.equal(database.prepare("SELECT count(*) AS count FROM repository_fragments WHERE agreement_id = 1901").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM extraction_proposals WHERE agreement_id = 1901").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM extraction_proposal_citations WHERE proposal_id = 'proposal-a'").get()?.count, 0);
    assert.equal(database.prepare("SELECT version FROM notice_schema_state WHERE id = 'primary'").get()?.version, NOTICE_SCHEMA_VERSION);
  } finally {
    database.close();
  }
});
