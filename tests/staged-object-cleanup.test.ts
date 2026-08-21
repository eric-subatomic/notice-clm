import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { cleanupIfDefinitelyUncommitted } from "../app/lib/staged-object-cleanup";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("staged R2 cleanup deletes bytes only after D1 positively proves absence", async () => {
  let deletes = 0;
  assert.equal(await cleanupIfDefinitelyUncommitted({
    isAuthoritative: async () => false,
    deleteObject: async () => { deletes += 1; },
  }), "deleted-uncommitted");
  assert.equal(deletes, 1);

  assert.equal(await cleanupIfDefinitelyUncommitted({
    isAuthoritative: async () => true,
    deleteObject: async () => { deletes += 1; },
  }), "retained-authoritative");
  assert.equal(deletes, 1);
});

test("staged R2 cleanup retains bytes on an unknown D1 outcome or failed deletion", async () => {
  let deletes = 0;
  assert.equal(await cleanupIfDefinitelyUncommitted({
    isAuthoritative: async () => { throw new Error("D1 unavailable"); },
    deleteObject: async () => { deletes += 1; },
  }), "retained-unknown");
  assert.equal(deletes, 0);

  assert.equal(await cleanupIfDefinitelyUncommitted({
    isAuthoritative: async () => false,
    deleteObject: async () => { deletes += 1; throw new Error("R2 unavailable"); },
  }), "retained-unknown");
  assert.equal(deletes, 1);
});

test("authoritative lookups bind the exact workspace, row id, object key, and SHA-256", async () => {
  const helper = await source("../app/lib/staged-object-cleanup.ts");
  for (const column of ["workspaceId", "id", "objectKey", "sha256"]) {
    assert.ok((helper.match(new RegExp(`eq\\([^,]+\\.${column}, candidate\\.${column}\\)`, "g")) ?? []).length >= 2);
  }
  assert.ok(helper.indexOf("authoritative = await input.isAuthoritative()") < helper.indexOf("await input.deleteObject()"));
  assert.match(helper, /catch \{\s*return "retained-unknown";\s*\}/);
  assert.match(helper, /recordDeleteFailure: \(\) => recordDurableStagedCleanup/);
  assert.match(helper, /db\.insert\(purgeJobs\)\.values/);
  assert.match(helper, /resourceId: `staged:\$\{candidate\.id\}:\$\{id\}`/);
  assert.match(helper, /cleanupStagedReviewTextObject/);
});

test("agreement and import upload catches use ambiguity-safe cleanup and never delete D1 authority", async () => {
  const [agreements, versions, imports] = await Promise.all([
    source("../app/api/agreements/route.ts"),
    source("../app/api/agreements/[id]/versions/route.ts"),
    source("../app/api/documents/import/route.ts"),
  ]);

  assert.match(agreements, /stagedGeneratedVersion = \{ workspaceId:[\s\S]*objectKey: generatedObjectKey, sha256 \}/);
  assert.match(agreements, /cleanupStagedWorkingVersionObject\(getDb\(\),[\s\S]*stagedGeneratedVersion\)/);

  const versionCatch = versions.slice(versions.indexOf("} catch (error) {", versions.indexOf("export async function POST")));
  assert.match(versionCatch, /cleanupStagedWorkingVersionObject\(getDb\(\),[\s\S]*stagedVersion\)/);
  assert.doesNotMatch(versionCatch, /delete\(agreementDocumentVersions\)/);
  assert.doesNotMatch(versionCatch, /DOCUMENTS\.delete/);

  assert.ok((imports.match(/cleanupStagedDocumentObject\(getDb\(\)/g) ?? []).length >= 1);
  assert.match(imports, /cleanupStagedWorkingVersionObject\(getDb\(\),[\s\S]*stagedWorkingVersion\)/);
  assert.doesNotMatch(imports, /bindings\.DOCUMENTS\.put\(document\.objectKey/);
  assert.match(imports, /Never rewrite those bytes/);
  assert.doesNotMatch(imports, /DOCUMENTS\.delete\(storedObjectKey\)/);
  assert.doesNotMatch(imports, /DOCUMENTS\.delete\(workingVersionObjectKey\)/);
  assert.doesNotMatch(imports, /DOCUMENTS\.delete\(safeKey\)/);
});

test("document linking is preflight- and commit-fenced against active negotiation", async () => {
  const imports = await source("../app/api/documents/import/route.ts");
  const patch = imports.slice(imports.indexOf("export async function PATCH"), imports.indexOf("export async function PUT"));
  assert.match(patch, /eq\(negotiationRounds\.agreementId, agreement\.id\),\s*isNotNull\(negotiationRounds\.activeKey\)/);
  assert.match(patch, /negotiation_round_unresolved/);
  assert.ok((patch.match(/notExists\(db\.select\(\{ id: negotiationRounds\.id \}\)/g) ?? []).length >= 2);
  assert.ok((patch.match(/operation: "agreement\.link_document"/g) ?? []).length >= 2);
  assert.ok((patch.match(/isNull\(agreements\.deletedAt\)/g) ?? []).length >= 2);
});

test("negotiation R2 compensation uses durable authority-aware cleanup for every object kind", async () => {
  const [service, retention] = await Promise.all([
    source("../app/lib/negotiation-service.ts"),
    source("../app/api/jobs/retention/route.ts"),
  ]);
  assert.match(service, /cleanupStagedDocumentObject\(db, bindings\(\)\.DOCUMENTS, identity\)/);
  assert.match(service, /cleanupStagedWorkingVersionObject\(db, bindings\(\)\.DOCUMENTS, identity\)/);
  assert.match(service, /cleanupStagedReviewTextObject\(db, bindings\(\)\.DOCUMENTS, identity\)/);
  assert.doesNotMatch(service, /DOCUMENTS\.delete\(candidate\.objectKey\)/);
  assert.match(retention, /negotiationSubmissions\.reviewTextObjectKey/);
  assert.match(retention, /staged object became authoritative before cleanup/);
});
