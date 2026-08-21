import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("agreement creation requires a scoped UUID receipt and replays only its original creation artifact", async () => {
  const route = await source("../app/api/agreements/route.ts");
  const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function PATCH"));
  const replay = route.slice(route.indexOf("async function replayAgreementCreation"), route.indexOf("export async function GET"));

  assert.match(post, /rawIdempotencyKey === null[\s\S]*idempotency_key_required/);
  assert.match(route, /creationIdempotencyKeySchema = z\.string\(\)\.uuid\(\)/);
  assert.match(replay, /agreementCreationReceipts\.workspaceId[\s\S]*agreementCreationReceipts\.userId[\s\S]*agreementCreationReceipts\.idempotencyKey/);
  assert.match(replay, /receipt\.requestSha256 !== input\.requestSha256[\s\S]*idempotency_key_conflict/);
  assert.match(replay, /receipt\.creationMode === "generated" \? db\.select/);
  assert.match(replay, /documentVersion: documentVersions\[0\] \?\? null/);
  assert.match(replay, /Idempotency-Replayed", "true"/);
  assert.equal((post.match(/db\.insert\(agreementCreationReceipts\)\.values/g) ?? []).length, 2);
  assert.equal((post.match(/creationMode: input\.creationMode/g) ?? []).length, 2);
  assert.match(post, /Idempotency-Replayed", "false"/);

  const catchStart = post.lastIndexOf("} catch (error) {");
  const cleanup = post.indexOf("cleanupStagedWorkingVersionObject", catchStart);
  const reconciliation = post.indexOf("replayAgreementCreation", cleanup);
  assert.ok(cleanup > catchStart && reconciliation > cleanup, "losing staged bytes must be cleaned before replay reconciliation");
});

test("document-link retries converge before and after a concurrent winner, with or without readable working text", async () => {
  const route = await source("../app/api/documents/import/route.ts");
  const patch = route.slice(route.indexOf("export async function PATCH"), route.indexOf("export async function PUT"));
  const sameTarget = patch.indexOf("document.agreementId === agreement.id");
  const latestVersionRead = patch.indexOf("const [latestWorkingVersion]");
  assert.ok(sameTarget > 0 && sameTarget < latestVersionRead, "same-target replay must not depend on a working version");
  assert.match(patch.slice(sameTarget, latestVersionRead), /alreadyLinked: true[\s\S]*workingVersionCreated: false/);
  assert.match(patch, /linkedDocument\?\.agreementId === linkAgreementId[\s\S]*alreadyLinked: true/);
  assert.match(patch, /linkDocumentId = input\.documentId/);
});

test("browser creation retries freeze exact tenant-bound payloads and lock modal escape paths", async () => {
  const page = await source("../app/page.tsx");
  assert.match(page, /workspaceId: session\?\.workspace\.id[\s\S]*userId: session\?\.user\.id/);
  assert.match(page, /recovery\.workspaceId !== session\.workspace\.id[\s\S]*recovery\.userId !== session\.user\.id/);
  assert.match(page, /newCreationBodyRef\.current \|\| JSON\.stringify/);
  assert.match(page, /importCreationBodyRef\.current \|\| JSON\.stringify/);
  assert.match(page, /body: requestBody/);
  assert.match(page, /onClose=\{closeGenerator\}/);
  assert.match(page, /disabled=\{newCreateBusy \|\| newCreationRecoveryLocked\}/);
  assert.match(page, /disabled=\{busy \|\| recoveryLocked\}/);
  assert.match(page, /sourceAlreadyLinked = linkPayload\.alreadyLinked === true[\s\S]*if \(!sourceAlreadyLinked\)/);
  assert.match(page, /requestText\(`\/api\/agreements\/\$\{saved\.id\}\/versions\?version=\$\{payload\.documentVersion\.version\}`\)/);
});
