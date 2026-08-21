import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canonicalDocumentUploadIdempotencyKey,
  documentUploadExpiresAt,
  documentUploadKeyDigest,
  documentUploadLinkReceiptState,
  documentUploadRequestDigest,
} from "../app/lib/document-upload-idempotency";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("upload retry keys are canonical UUIDs and durable digests are scope-bound", async () => {
  const key = "a0000000-0000-4000-8000-000000000001";
  assert.equal(canonicalDocumentUploadIdempotencyKey(key), key);
  for (const malformed of [null, "", key.toUpperCase(), `{${key}}`, "00000000-0000-0000-0000-000000000000", `${key} `]) {
    assert.equal(canonicalDocumentUploadIdempotencyKey(malformed), null);
  }

  const base = await documentUploadKeyDigest({ workspaceId: "workspace-a", userId: "user-a", idempotencyKey: key });
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(base, await documentUploadKeyDigest({ workspaceId: "workspace-a", userId: "user-a", idempotencyKey: key }));
  assert.notEqual(base, await documentUploadKeyDigest({ workspaceId: "workspace-b", userId: "user-a", idempotencyKey: key }));
  assert.notEqual(base, await documentUploadKeyDigest({ workspaceId: "workspace-a", userId: "user-b", idempotencyKey: key }));
});

test("upload request identity uses normalized filename, exact size, and file SHA-256", async () => {
  const sha256 = "a".repeat(64);
  const normalized = await documentUploadRequestDigest({ fileName: "Client Contract.txt", size: 42, sha256 });
  assert.equal(normalized, await documentUploadRequestDigest({ fileName: "Client---Contract.txt", size: 42, sha256 }));
  assert.notEqual(normalized, await documentUploadRequestDigest({ fileName: "Client Contract.txt", size: 43, sha256 }));
  assert.notEqual(normalized, await documentUploadRequestDigest({ fileName: "Client Contract.txt", size: 42, sha256: "b".repeat(64) }));
  assert.equal(documentUploadExpiresAt(new Date("2026-08-01T00:00:00.000Z")), "2026-08-08T00:00:00.000Z");
});

test("receiptless v13 imports take the executable legacy PATCH gate without reservation dereference", () => {
  const now = "2026-08-08T00:00:00.000Z";
  assert.equal(documentUploadLinkReceiptState(null, now), "legacy-receiptless");
  assert.equal(documentUploadLinkReceiptState({ expiresAt: "2026-08-09T00:00:00.000Z", linkedAt: null }, now), "staging");
  assert.equal(documentUploadLinkReceiptState({ expiresAt: now, linkedAt: null }, now), "expired");
  assert.equal(documentUploadLinkReceiptState({ expiresAt: "2026-08-01T00:00:00.000Z", linkedAt: "2026-08-02T00:00:00.000Z" }, now), "reserved");
});

test("document import persists a safe digest receipt and reconciles concurrent losers only after R2 cleanup", async () => {
  const route = await source("../app/api/documents/import/route.ts");
  const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function PATCH"));
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  const catchStart = post.lastIndexOf("} catch (error) {");
  const cleanup = post.indexOf("cleanupStagedDocumentObject", catchStart);
  const reconcile = post.indexOf("replayDocumentUpload", cleanup);

  assert.match(get, /request\.headers\.get\("idempotency-key"\)/);
  assert.match(get, /document_upload_not_found/);
  assert.match(get, /replayDocumentUpload/);
  assert.match(post, /rawIdempotencyKey === null[\s\S]*idempotency_key_required/);
  assert.match(post, /canonicalDocumentUploadIdempotencyKey[\s\S]*invalid_idempotency_key/);
  assert.match(post, /documentUploadRequestDigest\(\{ fileName, size: bytes\.byteLength, sha256 \}\)/);
  assert.ok(post.indexOf("replayDocumentUpload({") < post.indexOf("DOCUMENTS.put"), "a committed receipt must replay before another object is staged");
  assert.match(post, /db\.insert\(documentUploadReceipts\)\.values\([\s\S]*keyDigest[\s\S]*requestDigest[\s\S]*responseJson/);
  assert.doesNotMatch(post, /idempotencyKey,\s*requestDigest/);
  assert.ok(cleanup > catchStart && reconcile > cleanup, "the losing staged object must be cleaned before receipt reconciliation");
  assert.match(route, /receipt\.requestDigest !== input\.requestDigest[\s\S]*idempotency_key_conflict/);
  assert.match(route, /status: 200,[\s\S]*Idempotency-Replayed/);
});

test("requester source linking requires the exact reserved import saga while privileged repair remains bounded", async () => {
  const route = await source("../app/api/documents/import/route.ts");
  const patch = route.slice(route.indexOf("export async function PATCH"), route.indexOf("export async function PUT"));
  assert.match(patch, /documentUploadReceipts\.userId[\s\S]*documentUploadReceipts\.documentId/);
  assert.match(patch, /canManageDocumentLinks = auth\.context\.permissions\.has\("agreement:update"\)[\s\S]*permissions\.has\("document:manage"\)/);
  assert.match(patch, /reservationProofRequired = !canManageDocumentLinks[\s\S]*intakeReceiptState === "reserved" && document\.agreementId === null[\s\S]*document_upload_receipt_required/);
  assert.match(patch, /documentUploadKeyDigest\([\s\S]*intakeReceipt\.userId !== auth\.context\.user\.id[\s\S]*intakeReceipt\.keyDigest !== intakeKeyDigest/);
  assert.match(patch, /document_upload_receipt_mismatch/);
  assert.match(patch, /intakeReceiptState === "staging"[\s\S]*document_upload_not_reserved/);
  assert.match(patch, /intakeReceiptState === "expired"[\s\S]*document_upload_expired/);
  assert.match(patch, /documentUploadLinkReceiptState\(intakeReceipt,[\s\S]*intakeReceipt && intakeReceiptState === "reserved"/);
  assert.doesNotMatch(patch, /intakeReceipt\?\.linkedAt !== null/);
  assert.match(patch, /creationReceipt\.createdAt === intakeReceipt\.linkedAt/);
  assert.match(patch, /legalHold: agreement\.legalHold,[\s\S]*retentionUntil: agreement\.retentionUntil/);
  assert.match(patch, /!intakeAgreementReservation \? eq\(documents\.retentionUntil, intakeReceipt\.expiresAt\)[\s\S]*!intakeAgreementReservation \? gt\(documents\.retentionUntil, linkedAt\)/);
  assert.match(patch, /exists\(db\.select\(\{ documentId: documentUploadReceipts\.documentId \}\)[\s\S]*eq\(documentUploadReceipts\.linkedAt, reservationCreatedAt\)/);
  assert.match(patch, /exists\(db\.select\(\{ agreementId: agreementCreationReceipts\.agreementId \}\)[\s\S]*eq\(agreementCreationReceipts\.creationMode, "imported"\)[\s\S]*eq\(agreementCreationReceipts\.createdAt, reservationCreatedAt\)/);
  assert.match(patch, /agreement\.stage === "Active" \|\| agreement\.signatureStatus === "Completed"[\s\S]*agreement_execution_started/);
  assert.match(patch, /isNotNull\(signaturePackets\.activeKey\)[\s\S]*signature_packet_active/);
  assert.equal((patch.match(/ne\(agreements\.stage, "Active"\)/g) ?? []).length, 2);
  assert.equal((patch.match(/notExists\(db\.select\(\{ id: signaturePackets\.id \}\)/g) ?? []).length, 2);
  assert.equal((patch.match(/receiptLinkWrite/g) ?? []).length, 3);
  assert.ok((patch.match(/agreement\.retentionUntil === null \? isNull\(agreements\.retentionUntil\)/g) ?? []).length >= 2);
});

test("browser import recovery keeps one tenant-bound UUID through upload, agreement, and link convergence", async () => {
  const page = await source("../app/page.tsx");
  const importCreation = page.slice(page.indexOf("async function addImportedAgreementAfterGuard"), page.indexOf("async function addClause"));
  for (const phase of ["uploading", "uploaded", "agreement-attempted", "linking"]) assert.match(page, new RegExp(`phase: "${phase}"`));
  assert.match(page, /recoverCommittedImportUpload[\s\S]*method: "GET"[\s\S]*"idempotency-key": idempotencyKey/);
  assert.match(page, /method: "POST",[\s\S]*"idempotency-key": idempotencyKey/);
  assert.match(page, /method: "PATCH",[\s\S]*"idempotency-key": creationKey/);
  assert.match(page, /recovery\.workspaceId !== session\.workspace\.id[\s\S]*recovery\.userId !== session\.user\.id/);
  assert.match(page, /importUploadInFlightRef\.current \|\| importCreateInFlightRef\.current/);
  assert.match(page, /if \(importUploadInFlightRef\.current\) return;[\s\S]*setImportUploadBusy\(true\)/);
  assert.match(page, /importCreationBodyRef\.current \|\| JSON\.stringify/);
  assert.match(page, /setImportCreationRecoveryLocked\(true\)[\s\S]*phase: "agreement-attempted"/);
  assert.match(page, /phase: "linking"[\s\S]*agreementId: saved\.id[\s\S]*method: "PATCH"/);
  assert.ok(importCreation.indexOf("sourceAlreadyLinked = linkPayload.alreadyLinked === true") < importCreation.indexOf("removeItem(IMPORTED_CREATION_RECOVERY_KEY)"), "recovery may clear only after link convergence");
  assert.match(page, /analysis\.documentId && !recoveryLocked \? "Discard staged upload"/);
  assert.match(page, /onDiscard=\{discardImportedIntake\}/);
  assert.match(page, /!documentDirty && !importUploadBusy && !importCreateBusy/);
});

test("imported agreement creation atomically reserves the same unexpired upload before returning", async () => {
  const route = await source("../app/api/agreements/route.ts");
  const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function PATCH"));
  assert.match(post, /input\.creationMode === "imported"[\s\S]*documentUploadKeyDigest/);
  assert.match(post, /document_upload_receipt_required/);
  assert.match(post, /documentUploadReceipts\.linkedAt[\s\S]*documentUploadReceipts\.expiresAt/);
  assert.match(post, /set\(\{ linkedAt: now \}\)[\s\S]*gt\(documentUploadReceipts\.expiresAt, now\)/);
  assert.match(post, /db\.update\(documents\)\.set\([\s\S]*retentionUntil: record\.retentionUntil/);
  assert.match(post, /operation: "agreement\.create\.import_receipt_reservation"[\s\S]*operation: "agreement\.create\.import_document_reservation"/);
  assert.ok((post.match(/\.\.\.importReservationWrites/g) ?? []).length === 2);
});
