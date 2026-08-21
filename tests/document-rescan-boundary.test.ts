import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("first working-paper extraction rejects a replaced or corrupted source object", async () => {
  const route = await source("../app/api/documents/import/route.ts");
  const link = route.slice(route.indexOf("export async function PATCH"), route.indexOf("class DocumentLinkConflict"));
  const objectRead = link.indexOf("DOCUMENTS.get(document.objectKey)");
  const integrityGate = link.indexOf("verifyStoredDocumentSource(source");
  const extraction = link.indexOf("readDocumentText(", integrityGate);

  assert.ok(objectRead >= 0 && objectRead < integrityGate && integrityGate < extraction);
  assert.match(link, /fileName: document\.fileName,[\s\S]*size: document\.size,[\s\S]*contentType: document\.contentType,[\s\S]*sha256: document\.sha256/);
  assert.match(link, /if \(!verifiedSource\.ok\)[\s\S]*"document_integrity_failure"/);
});

test("rescan binds each verdict to exact stored bytes and immutable lineage evidence", async () => {
  const route = await source("../app/api/documents/import/route.ts");
  const rescan = route.slice(route.indexOf("export async function PUT"));

  assert.match(rescan, /const bytes = new Uint8Array\(await object\.arrayBuffer\(\)\)/);
  assert.match(rescan, /const actualSha256 = await sha256Hex\(bytes\)/);
  assert.match(rescan, /bytes\.byteLength !== document\.size \|\| actualSha256 !== document\.sha256/);
  assert.ok(rescan.indexOf("actualSha256 !== document.sha256") < rescan.indexOf("await scanDocument(bytes"));
  assert.match(rescan, /inspected\.contentType !== document\.contentType/);
  assert.ok(rescan.indexOf("await claimDocumentForRescan(db") < rescan.indexOf("await scanDocument(bytes"));
  assert.match(route, /const RESCAN_CLAIM_PROVIDER = "scan-gateway-rescan-pending"/);
  assert.match(route, /schema: "notice\.document_security\.rescan_claim\.v1"/);
  assert.match(route, /eq\(documents\.version, input\.document\.version\)[\s\S]*eq\(documents\.objectKey, input\.document\.objectKey\)[\s\S]*eq\(documents\.sha256, input\.document\.sha256\)/);
  assert.match(rescan, /hasActiveDocumentClaim\(document, RESCAN_CLAIM_PROVIDER, ACTIVE_RESCAN_CLAIM_MAX_AGE_MS\)/);
  assert.ok((rescan.match(/eq\(documents\.scanProvider, RESCAN_CLAIM_PROVIDER\)/g) ?? []).length >= 3);

  assert.match(route, /schema: "notice\.document_security\.rescan\.v1"/);
  assert.match(rescan, /const recordedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(rescan, /const latestScanAt = scan\.scannedAt \?\? recordedAt/);
  assert.doesNotMatch(rescan, /const recordedAt = scan\.scannedAt/);
  for (const exactField of [
    "documentId: input.documentId",
    "submissionId: input.submissionId",
    "negotiationRoundId: input.roundId",
    "sha256: input.sha256",
    "verdict: input.verdict",
    "provider: input.provider",
    "scannerReportedAt: input.scannerReportedAt",
    "recordedAt: input.recordedAt",
    "actorUserId: input.actor.id",
  ]) assert.ok(route.includes(exactField), `missing evidence field ${exactField}`);
  assert.equal((rescan.match(/prepareRescanEvidence\(db,/g) ?? []).length, 3);
  assert.match(rescan, /db\.insert\(workspaceEvents\)\.values\(workspaceEvent\)/);
  assert.match(rescan, /db\.insert\(agreementEvents\)\.values\(agreementEvent\)/);

  const unavailableStart = rescan.indexOf('if (scan.status === "unavailable")');
  const maliciousStart = rescan.indexOf('if (scan.status === "malicious")', unavailableStart);
  const unavailable = rescan.slice(unavailableStart, maliciousStart);
  assert.match(unavailable, /operation: "document\.rescan_unavailable"/);
  assert.ok(unavailable.indexOf("await db.batch(statements)") < unavailable.indexOf('return apiError("scanner_unavailable"'));
  assert.match(unavailable, /effect: "Document remains quarantined/);
});

test("malicious rescan rejects every linked negotiation record and reconciles only the current active queue", async () => {
  const route = await source("../app/api/documents/import/route.ts");
  const rescan = route.slice(route.indexOf("export async function PUT"));
  const unavailableStart = rescan.indexOf('if (scan.status === "unavailable")');
  const malicious = rescan.slice(
    rescan.indexOf('if (scan.status === "malicious")', unavailableStart),
    rescan.indexOf("const readable = await readDocumentText"),
  );

  assert.match(rescan, /eq\(negotiationSubmissions\.documentSha256, actualSha256\)/);
  assert.match(rescan, /eq\(documentComparisons\.submissionId, linkedSubmission\.id\)/);
  assert.match(rescan, /linkedComparison\.status !== "manual_required"/);
  assert.match(malicious, /deriveNegotiationRoundAction/);
  assert.match(malicious, /latestRoundId === linkedRound\.id/);
  assert.match(malicious, /notExists\(db\.select\(\{ id: negotiationRounds\.id \}\)/);
  assert.match(malicious, /db\.update\(negotiationSubmissions\)\.set\(\{[\s\S]*status: "rejected"/);
  assert.match(malicious, /db\.update\(documentComparisons\)\.set\(\{[\s\S]*status: "rejected"/);
  assert.match(malicious, /operation: "negotiation\.rescan_reject\.round"/);
  assert.match(malicious, /operation: "negotiation\.rescan_reject\.comparison"/);
  assert.match(malicious, /effectiveLegalHold/);
  assert.match(malicious, /db\.insert\(purgeJobs\)\.values/);
  assert.doesNotMatch(malicious, /DOCUMENTS\.delete/);
  assert.ok(malicious.indexOf('operation: "document.reject_malicious"') < malicious.indexOf("db.insert(workspaceEvents).values(workspaceEvent)"));
  assert.match(route, /reconcileCorrelatedMaliciousRescan/);
  assert.match(route, /scanStatus: "rejected"[\s\S]*ne\(documents\.scanStatus, "rejected"\)[\s\S]*ne\(documents\.scanStatus, "malicious"\)/);
  assert.ok(route.indexOf('scanStatus: "rejected"', route.indexOf("async function reconcileCorrelatedMaliciousRescan")) < route.indexOf("prepareRescanEvidence(db", route.indexOf("async function reconcileCorrelatedMaliciousRescan")));
  assert.match(route, /operation: "document\.reconcile_malicious_rescan"/);
  assert.ok(rescan.indexOf("if (!stillOwnsExactClaim)") < rescan.indexOf('if (scan.status === "unavailable")'));
  assert.match(rescan, /if \(await reconcileCorrelatedMaliciousRescan\(db, correlatedMaliciousRescan\)\)/);
});

test("clean rescan preserves object and ingress lineage but leaves negotiation review gated", async () => {
  const route = await source("../app/api/documents/import/route.ts");
  const clean = route.slice(route.indexOf("const readable = await readDocumentText", route.indexOf("export async function PUT")));

  assert.match(clean, /Object\.entries\(document\.extracted\)\.filter\(\(\[key\]\) => key\.startsWith\("ingress\."\)\)/);
  assert.match(clean, /"ingress\.security\.initialStatus"/);
  assert.match(clean, /promotedExtracted = \{ \.\.\.analysis\.extracted, \.\.\.initialScanEvidence, \.\.\.ingressEvidence \}/);
  assert.doesNotMatch(clean, /DOCUMENTS\.put\(document\.objectKey/);
  assert.match(clean, /Never rewrite those bytes/);
  assert.match(clean, /scanProvider: scan\.provider/);
  assert.match(clean, /scannedAt: latestScanAt/);
  assert.match(clean, /exact negotiation submission remains quarantined and direct download stays blocked/);
  assert.match(clean, /operation: "document\.promote_clean\.submission"/);
  assert.doesNotMatch(clean, /status: "ready"/);
  assert.match(clean, /db\.insert\(workspaceEvents\)\.values\(workspaceEvent\)/);
  assert.match(clean, /db\.insert\(agreementEvents\)\.values\(agreementEvent\)/);
});

test("counterparty-return download requires an eligible exact submission before R2 access", async () => {
  const route = await source("../app/api/documents/[id]/route.ts");
  const lineageGate = route.indexOf('if (document.role === "counterparty_return")');
  const objectRead = route.indexOf("DOCUMENTS.get(document.objectKey)");

  assert.ok(lineageGate >= 0 && objectRead > lineageGate);
  assert.match(route, /document\.agreementId === null \|\| document\.negotiationRoundId === null \|\| document\.direction !== "inbound"/);
  assert.match(route, /eq\(negotiationSubmissions\.agreementId, document\.agreementId\)/);
  assert.match(route, /eq\(negotiationSubmissions\.roundId, document\.negotiationRoundId\)/);
  assert.match(route, /eq\(negotiationSubmissions\.documentId, document\.id\)/);
  assert.match(route, /eq\(negotiationSubmissions\.documentSha256, document\.sha256\)/);
  assert.match(route, /inArray\(negotiationSubmissions\.status, \["sender_review", "ready", "promoted", "late"\]\)/);
  assert.doesNotMatch(route, /inArray\(negotiationSubmissions\.status, \[[^\]]*"quarantined"/);
  assert.match(route, /bytes\.byteLength !== document\.size \|\| actualSha256 !== document\.sha256/);
});
