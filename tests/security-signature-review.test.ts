import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("provider completion retains one exact artifact and stops at human review", async () => {
  const reconciliation = await source("../app/lib/docuseal-reconciliation.ts");
  const completion = reconciliation.slice(reconciliation.indexOf("export async function completeSubmission"));
  const cardinalityGate = completion.indexOf("artifactList.documents.length !== 1");
  const firstDownload = completion.indexOf("downloadDocuSealArtifact");
  const firstPersistence = completion.indexOf("bucket.put");

  assert.ok(cardinalityGate >= 0 && cardinalityGate < firstDownload && firstDownload < firstPersistence);
  assert.match(completion, /status: basisStillCurrent \? "completed_review_required" : "completed_superseded"/);
  assert.match(completion, /activeKey: basisStillCurrent \? claimedPacket\.activeKey : null/);
  assert.match(completion, /signatureStatus: "completed_review_required"[\s\S]*nextAction: "Review completed signature evidence"/);
  assert.doesNotMatch(completion, /stage: "Active"/);
  assert.doesNotMatch(completion, /signatureStatus: "Completed"/);
  assert.match(completion, /topic: "signature\.completed"[\s\S]*status: "completed_superseded"[\s\S]*activated: false/);
  assert.doesNotMatch(completion, /activated: basisStillCurrent/);
});

test("only an exact legal/admin human review can activate completed evidence", async () => {
  const route = await source("../app/api/signatures/route.ts");
  const patch = route.slice(route.indexOf("export async function PATCH"));
  const review = patch.slice(
    patch.indexOf('if (input.action === "review_completed")'),
    patch.indexOf("const configuration = getDocuSealConfiguration()"),
  );

  assert.match(route, /authorizeApiRequest\(request, "agreement:update"/);
  assert.match(route, /action: z\.literal\("review_completed"\)/);
  assert.match(route, /agreementVersion:[\s\S]*basisHash:[\s\S]*documentVersion:[\s\S]*documentSha256:[\s\S]*evidenceDocumentId:[\s\S]*finalArtifactSha256:/);
  assert.match(route, /confirmed: z\.literal\(true\)/);
  assert.match(route, /confirmation: z\.literal\(FINAL_SIGNATURE_REVIEW_CONFIRMATION\)/);
  assert.match(route, /packet\.status === "completed_review_required"[\s\S]*reviewArtifacts = evidenceDocumentIds\.length/);
  assert.match(route, /eq\(documents\.workspaceId, auth\.context\.workspace\.id\)[\s\S]*eq\(documents\.role, "signed_artifact"\)[\s\S]*eq\(documents\.scanStatus, "clean"\)/);
  assert.match(route, /finalArtifactSha256: reviewArtifactSha256ById\.get\(packet\.evidenceDocumentId\)/);
  assert.match(review, /new Set\(\["legal", "admin"\]\)\.has\(auth\.context\.role\)[\s\S]*permissions\.has\("document:manage"\)/);
  assert.match(review, /agreement\.version !== input\.agreementVersion[\s\S]*version_conflict/);
  assert.match(review, /computeAgreementBasisHash\(agreement, currentDocumentVersion\)/);
  assert.match(review, /approvalsSatisfyPolicy/);
  assert.match(review, /completedSignatureReviewBindingMatches/);
  assert.match(review, /actualArtifactSha256 = await sha256Hex\(evidenceBytes\)/);
  assert.ok(review.indexOf("actualArtifactSha256") < review.indexOf("await db.batch(["));

  assert.match(review, /status: "completed"[\s\S]*activeKey: null/);
  assert.match(review, /stage: "Active"[\s\S]*signatureStatus: "Completed"[\s\S]*nextAction: "Manage obligations"/);
  assert.match(review, /eq\(signaturePackets\.status, "completed_review_required"\)[\s\S]*eq\(signaturePackets\.basisHash, input\.basisHash\)[\s\S]*eq\(signaturePackets\.evidenceDocumentId, input\.evidenceDocumentId\)/);
  assert.match(review, /eq\(agreements\.version, input\.agreementVersion\)[\s\S]*eq\(agreements\.stage, "Signature"\)[\s\S]*eq\(agreements\.signatureStatus, "completed_review_required"\)/);
  assert.match(review, /notExists\(db\.select\(\{ id: agreementDocumentVersions\.id \}\)[\s\S]*gt\(agreementDocumentVersions\.version, input\.documentVersion\)/);
  assert.match(review, /exists\(db\.select\(\{ id: documents\.id \}\)[\s\S]*eq\(documents\.sha256, input\.finalArtifactSha256\)/);
  assert.match(review, /topic: "signature\.completed"[\s\S]*activated: true/);
  assert.match(review, /reviewed: true,[\s\S]*activated: true,[\s\S]*reconciled: true/);
});

test("provider and human completion states remain mutually exclusive", async () => {
  const [reconciliation, route] = await Promise.all([
    source("../app/lib/docuseal-reconciliation.ts"),
    source("../app/api/signatures/route.ts"),
  ]);
  const providerCompletion = reconciliation.slice(reconciliation.indexOf("export async function completeSubmission"));
  const humanReviewStart = route.indexOf('if (input.action === "review_completed")');
  const humanReviewEnd = route.indexOf("const configuration = getDocuSealConfiguration()", humanReviewStart);
  const outsideHumanReview = `${route.slice(0, humanReviewStart)}${route.slice(humanReviewEnd)}`;

  assert.doesNotMatch(providerCompletion, /stage: "Active"|signatureStatus: "Completed"|activated: true/);
  assert.doesNotMatch(outsideHumanReview, /stage: "Active"|signatureStatus: "Completed"|activated: true/);
});
