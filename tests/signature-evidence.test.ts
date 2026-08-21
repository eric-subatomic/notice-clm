import assert from "node:assert/strict";
import test from "node:test";
import { completedSignatureReviewBindingMatches, FINAL_SIGNATURE_REVIEW_CONFIRMATION, isTerminalSignaturePacketStatus, reconcileCompletedSignerEvidence, reconcilePendingSignerEvidence, reconcileSignerEventEvidence, sanitizeSignaturePacket } from "../app/lib/signature-evidence";

test("signature evidence removes provider capabilities and unknown signer fields", () => {
  const packet = sanitizeSignaturePacket({
    id: "packet-1",
    signers: [{
      role: "Client",
      email: "signer@client.test",
      name: "Client Signer",
      submitterId: 42,
      status: "pending",
      embedSrc: "https://sign.example/capability-token",
      providerSecret: "must-not-leak",
    }],
  });

  assert.deepEqual(packet, {
    id: "packet-1",
    signers: [{
      role: "Client",
      email: "signer@client.test",
      name: "Client Signer",
      submitterId: 42,
      status: "pending",
    }],
  });
  assert.equal(JSON.stringify(packet).includes("capability-token"), false);
  assert.equal(JSON.stringify(packet).includes("providerSecret"), false);
});

test("malformed signer evidence is reduced to an empty safe record", () => {
  assert.deepEqual(sanitizeSignaturePacket({ id: "packet-2", signers: [null, "bad"] }).signers, [{}, {}]);
});

test("completed provider reconciliation refreshes status without retaining capabilities", () => {
  const reconciled = reconcileCompletedSignerEvidence(
    [{ role: "Counterparty", email: "signer@test.invalid", name: "Signer", submitterId: 91, status: "pending" }],
    [{ id: 91, email: "signer@test.invalid", status: "completed", embed_src: "https://provider.invalid/capability", secret: "never" }],
  );
  assert.deepEqual(reconciled, [{ role: "Counterparty", email: "signer@test.invalid", name: "Signer", submitterId: 91, status: "completed" }]);
  assert.equal(JSON.stringify(reconciled).includes("capability"), false);
  assert.equal(JSON.stringify(reconciled).includes("secret"), false);
});

test("completed reconciliation fails closed on missing, mismatched, or incomplete signer evidence", () => {
  const stored = [
    { role: "Client", email: "first@example.com", submitterId: 41, status: "pending" },
    { role: "Provider", email: "second@example.com", submitterId: 42, status: "pending" },
  ];
  assert.throws(() => reconcileCompletedSignerEvidence(stored, []), /expected signer count/);
  assert.throws(() => reconcileCompletedSignerEvidence(stored, [
    { id: 41, email: "first@example.com", status: "completed" },
    { id: 99, email: "unknown@example.com", status: "completed" },
  ]), /did not match expected signer 2/);
  assert.throws(() => reconcileCompletedSignerEvidence(stored, [
    { id: 41, email: "first@example.com", status: "completed" },
    { id: 42, email: "second@example.com", status: "pending" },
  ]), /signer 2 is not completed/);
  assert.throws(() => reconcileCompletedSignerEvidence(stored, [
    { id: 41, email: "changed-recipient@example.com", status: "completed" },
    { id: 42, email: "second@example.com", status: "completed" },
  ]), /did not match expected signer 1/);
  assert.throws(() => reconcileCompletedSignerEvidence(stored, [
    { id: 41, status: "completed" },
    { id: 42, email: "second@example.com", status: "completed" },
  ]), /did not match expected signer 1/);
});

test("provider creation reconciliation defaults missing status to pending", () => {
  const [signer] = reconcilePendingSignerEvidence(
    [{ role: "Client", email: "client@example.com", name: "Client" }],
    [{ id: 77, email: "client@example.com", embed_src: "https://provider.invalid/capability" }],
  );
  assert.equal(signer.submitterId, 77);
  assert.equal(signer.status, "pending");
  assert.equal("embed_src" in signer, false);
});

test("nonterminal refresh requires matching email before accepting terminal signer evidence", () => {
  const stored = [{ role: "Client", email: "client@example.com", submitterId: 77, status: "pending" }];
  assert.throws(() => reconcilePendingSignerEvidence(stored, [
    { id: 77, status: "completed" },
  ]), /did not match expected signer 1/);
  assert.throws(() => reconcilePendingSignerEvidence(stored, [
    { id: 77, status: "declined" },
  ]), /did not match expected signer 1/);
  assert.equal(reconcilePendingSignerEvidence(stored, [
    { id: 77, status: "pending" },
  ])[0].status, "pending");
});

test("provider signer rows are consumed one-to-one even when legacy emails repeat", () => {
  const result = reconcilePendingSignerEvidence(
    [
      { role: "First", email: "shared@example.com" },
      { role: "Second", email: "shared@example.com" },
    ],
    [
      { id: 71, email: "shared@example.com", status: "pending" },
      { id: 72, email: "shared@example.com", status: "sent" },
    ],
  );
  assert.equal(result[0].submitterId, 71);
  assert.equal(result[1].submitterId, 72);
});

test("both activated and superseded completions are terminal", () => {
  assert.equal(isTerminalSignaturePacketStatus("completed_review_required"), true);
  assert.equal(isTerminalSignaturePacketStatus("completed"), true);
  assert.equal(isTerminalSignaturePacketStatus("completed_superseded"), true);
  assert.equal(isTerminalSignaturePacketStatus("expired"), false);
  assert.equal(isTerminalSignaturePacketStatus("partially_signed"), false);
});

test("human completion review binds the exact agreement version, current basis, signers, and final artifact", () => {
  const basisHash = "a".repeat(64);
  const documentSha256 = "b".repeat(64);
  const finalArtifactSha256 = "c".repeat(64);
  const evidenceDocumentId = "10000000-0000-4000-8000-000000000001";
  const binding = {
    packet: {
      status: "completed_review_required",
      activeKey: "agreement:42",
      completedAt: "2026-08-19T12:00:00.000Z",
      basisHash,
      documentVersion: 7,
      documentSha256,
      evidenceDocumentId,
      signers: [{ role: "Counterparty", email: "signer@example.test", status: "completed" }],
    },
    agreement: {
      version: 11,
      stage: "Signature",
      signatureStatus: "completed_review_required",
      nextAction: "Review completed signature evidence",
    },
    currentBasis: { hash: basisHash, documentVersion: 7, documentSha256 },
    artifact: { id: evidenceDocumentId, sha256: finalArtifactSha256 },
    review: {
      agreementVersion: 11,
      basisHash,
      documentVersion: 7,
      documentSha256,
      evidenceDocumentId,
      finalArtifactSha256,
      confirmed: true as const,
      confirmation: FINAL_SIGNATURE_REVIEW_CONFIRMATION,
    },
  };

  assert.equal(completedSignatureReviewBindingMatches(binding), true, "an exact authorized review binding must remain executable");
  assert.equal(completedSignatureReviewBindingMatches({ ...binding, review: { ...binding.review, agreementVersion: 10 } }), false);
  assert.equal(completedSignatureReviewBindingMatches({ ...binding, currentBasis: { ...binding.currentBasis, hash: "d".repeat(64) } }), false);
  assert.equal(completedSignatureReviewBindingMatches({ ...binding, artifact: { ...binding.artifact, sha256: "e".repeat(64) } }), false);
  assert.equal(completedSignatureReviewBindingMatches({ ...binding, packet: { ...binding.packet, signers: [{ status: "pending" }] } }), false);
  assert.equal(completedSignatureReviewBindingMatches({ ...binding, packet: { ...binding.packet, activeKey: null } }), false);
  assert.equal(completedSignatureReviewBindingMatches({ ...binding, review: { ...binding.review, confirmation: `${FINAL_SIGNATURE_REVIEW_CONFIRMATION} ` } }), false);
});

test("authenticated form evidence updates only the matching signer and strips provider capabilities", () => {
  const result = reconcileSignerEventEvidence([
    { role: "Client", email: "first@example.com", name: "First", submitterId: 41, status: "pending" },
    { role: "Provider", email: "second@example.com", name: "Second", submitterId: 42, status: "pending" },
  ], {
    id: 42,
    email: "second@example.com",
    status: "completed",
    embed_src: "https://provider.invalid/bearer",
    slug: "secret-capability",
    ip: "192.0.2.1",
  }, "completed");
  assert.equal(result.matched, true);
  assert.equal(result.signers[0].status, "pending");
  assert.equal(result.signers[1].status, "completed");
  assert.equal("embed_src" in result.signers[1], false);
  assert.equal("slug" in result.signers[1], false);
  assert.equal("ip" in result.signers[1], false);

  const unmatched = reconcileSignerEventEvidence(result.signers, { id: 99, email: "unknown@example.com" }, "declined");
  assert.equal(unmatched.matched, false);
  assert.deepEqual(unmatched.signers, result.signers);

  const contradictory = reconcileSignerEventEvidence(result.signers, { id: 42, email: "first@example.com" }, "declined");
  assert.equal(contradictory.matched, false);
  assert.deepEqual(contradictory.signers, result.signers);

  const idOnly = reconcileSignerEventEvidence(result.signers, { id: 42 }, "completed");
  assert.equal(idOnly.matched, false);
  assert.deepEqual(idOnly.signers, result.signers);
});
