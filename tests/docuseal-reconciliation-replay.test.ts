import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = () => readFile(new URL("../app/lib/docuseal-reconciliation.ts", import.meta.url), "utf8");

function functionBody(moduleSource: string, start: string, end: string): string {
  const startIndex = moduleSource.indexOf(start);
  const endIndex = moduleSource.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Could not isolate ${start}`);
  return moduleSource.slice(startIndex, endIndex);
}

test("replayed form completion is a semantic no-op before audit mutation", async () => {
  const reconciliation = await source();
  const partial = functionBody(
    reconciliation,
    "export async function partiallyCompleteSubmission",
    "export async function archiveSubmission",
  );

  assert.match(partial, /packet\.status === targetPacketStatus/);
  assert.match(partial, /packet\.activeKey === targetActiveKey/);
  assert.match(partial, /JSON\.stringify\(packet\.signers\) === JSON\.stringify\(signerEvidence\.signers\)/);
  assert.match(partial, /agreementPatch === null[\s\S]*return;/);
  assert.ok(partial.indexOf("agreementPatch === null") < partial.indexOf("prepareAgreementEvent"));
  assert.match(partial, /operation: "signature\.partial\.agreement"/);
  assert.match(partial, /eq\(agreements\.version, agreement\.version\),[\s\S]*isNull\(agreements\.deletedAt\)/);
  assert.match(partial, /inArray\(mutationGuards\.id, \[packetGuardId, agreementGuardId\]\)/);
});

test("archival of an inactive packet cannot append an orphan or replay audit event", async () => {
  const reconciliation = await source();
  const archive = functionBody(
    reconciliation,
    "export async function archiveSubmission",
    "export async function refreshNonterminalSubmission",
  );

  assert.match(archive, /if \([\s\S]*!packet\.activeKey[\s\S]*\) \{[\s\S]*return;/);
  assert.ok(archive.indexOf("!packet.activeKey") < archive.indexOf("const db = getDb()"));
  assert.doesNotMatch(archive, /superseded DocuSeal submission was archived/);
  assert.doesNotMatch(archive, /if \(!packet\.activeKey\)[\s\S]*insert\(agreementEvents\)/);
  assert.match(archive, /operation: "signature\.archive\.packet"/);
  assert.match(archive, /operation: "signature\.archive\.agreement"/);
  assert.match(archive, /eq\(agreements\.version, agreement\.version\),[\s\S]*isNull\(agreements\.deletedAt\)/);
  assert.match(archive, /inArray\(mutationGuards\.id, \[packetGuardId, agreementGuardId\]\)/);
  assert.equal((archive.match(/db\.insert\(agreementEvents\)\.values\(event\)/g) ?? []).length, 1);
  assert.ok(archive.indexOf('operation: "signature.archive.agreement"') < archive.indexOf("db.insert(agreementEvents).values(event)"));
});
