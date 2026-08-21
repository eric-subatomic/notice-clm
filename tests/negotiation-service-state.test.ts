import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = () => readFile(new URL("../app/lib/negotiation-service.ts", import.meta.url), "utf8");

function functionBody(contents: string, start: string, end: string): string {
  const from = contents.indexOf(start);
  const to = contents.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
  return contents.slice(from, to);
}

test("rejecting a current-round submission atomically recomputes the round and agreement queue", async () => {
  const contents = await source();
  const reject = functionBody(
    contents,
    "export async function rejectNegotiationSubmission",
    "export async function markNegotiationSubmissionReady",
  );

  assert.match(reject, /const \[round, latestRound, roundSubmissions\] = await Promise\.all/);
  assert.match(reject, /latestRound\?\.id === round\.id/);
  assert.match(reject, /const roundAction = activeRound[\s\S]*deriveNegotiationRoundAction/);
  assert.match(reject, /submissionStatuses: roundSubmissions\.map\(\(row\) => row\.id === submission\.id \? "rejected" : row\.status\)/);
  assert.match(reject, /db\.update\(agreements\)\.set\(agreementPatch \?\? \{ updatedAt: sql`\$\{agreements\.updatedAt\}` \}\)/);
  assert.match(reject, /operation: "negotiation\.reject_submission\.agreement"/);
  assert.match(reject, /db\.update\(negotiationRounds\)\.set\(\{[\s\S]*status: roundAction\.roundStatus/);
  assert.match(reject, /eq\(negotiationRounds\.updatedAt, activeRound\.updatedAt\)/);
  assert.match(reject, /eq\(negotiationRounds\.activeKey, activeRound\.activeKey!\)/);
  assert.match(reject, /notExists\([\s\S]*gt\(negotiationRounds\.roundNumber, activeRound\.roundNumber\)/);
  assert.match(reject, /operation: "negotiation\.reject_submission\.round"/);
  assert.match(reject, /operation: "negotiation\.reject_submission"/);
  assert.match(reject, /return \{ agreement: savedAgreement, submissionId:/);

  const queuePatch = reject.indexOf("const agreementPatch = roundAction");
  const guardedRoundSpread = reject.indexOf("...(activeRound && roundAction && nextRoundUpdatedAt && roundGuardId ? [");
  const submissionMutation = reject.indexOf("db.update(negotiationSubmissions).set");
  const auditMutation = reject.indexOf("db.insert(agreementEvents).values(event)");
  assert.ok(queuePatch >= 0 && guardedRoundSpread > queuePatch && submissionMutation > guardedRoundSpread && auditMutation > submissionMutation);
});

test("rejecting a historical submission leaves the active queue and round untouched", async () => {
  const contents = await source();
  const reject = functionBody(
    contents,
    "export async function rejectNegotiationSubmission",
    "export async function markNegotiationSubmissionReady",
  );

  assert.match(reject, /const activeRound = round[\s\S]*latestRound\?\.id === round\.id[\s\S]*\? round\s*: null/);
  assert.match(reject, /const agreementPatch = roundAction[\s\S]*: null/);
  assert.match(reject, /set\(agreementPatch \?\? \{ updatedAt: sql`\$\{agreements\.updatedAt\}` \}\)/);
  assert.match(reject, /\.\.\.\(activeRound && roundAction && nextRoundUpdatedAt && roundGuardId \? \[/);
});

test("promotion retains the original review-text reviewer provenance", async () => {
  const contents = await source();
  const promote = functionBody(
    contents,
    "export async function promoteNegotiationSubmission",
    "export type NegotiationAttachment",
  );
  const submissionUpdate = promote.slice(promote.indexOf("db.update(negotiationSubmissions).set"));

  assert.match(submissionUpdate, /\.\.\.\(!submission\.reviewTextObjectKey \? \{[\s\S]*reviewTextObjectKey: objectKey,[\s\S]*reviewedByUserId: input\.actor\.id,[\s\S]*reviewedAt: now,[\s\S]*\} : \{\}\),\s*decisionNote: note/);
  assert.equal((submissionUpdate.match(/reviewedByUserId: input\.actor\.id/g) ?? []).length, 1);
  assert.equal((submissionUpdate.match(/reviewedAt: now/g) ?? []).length, 1);
});

test("email ingress defers receipts before storage while aggregate priority includes prior submissions", async () => {
  const contents = await source();
  const ingressStart = contents.indexOf("export async function ingestNegotiationSubmissions");
  assert.ok(ingressStart >= 0);
  const ingest = contents.slice(ingressStart);
  const pendingCheck = ingest.indexOf("if (pendingEmailDelivery)");
  const retryableError = ingest.indexOf('"delivery_finalization_pending"', pendingCheck);
  const receiptFinalization = ingest.indexOf("const receiptFinalizationStatements", pendingCheck);
  const firstStorageWrite = ingest.indexOf("bindings().DOCUMENTS.put", pendingCheck);
  assert.ok(pendingCheck >= 0 && retryableError > pendingCheck && receiptFinalization > retryableError && firstStorageWrite > receiptFinalization);
  assert.match(ingest.slice(pendingCheck, receiptFinalization), /503/);
  assert.match(ingest, /const existingSubmissionStatuses = existingSubmissionRows\.map\(\(row\) => row\.status\)/);
  assert.match(ingest, /submissionStatuses: \[\.\.\.existingSubmissionStatuses, status\]/);
  assert.match(ingest, /submissionStatuses: \[[\s\S]*\.\.\.existingSubmissionStatuses,[\s\S]*\.\.\.prepared\.map/);
  assert.ok((ingest.match(/deriveNegotiationRoundAction\(/g) ?? []).length >= 2);
});

test("every active manual ingress advances the round CAS even when status is unchanged", async () => {
  const contents = await source();
  const ingressStart = contents.indexOf("export async function ingestNegotiationSubmissions");
  assert.ok(ingressStart >= 0);
  const ingest = contents.slice(ingressStart);

  assert.equal((ingest.match(/const requiresRoundGuard = Boolean\(roundAction\)/g) ?? []).length, 2);
  assert.doesNotMatch(ingest, /const requiresRoundGuard = input\.source !== "manual"/);
  assert.ok((ingest.match(/eq\(negotiationRounds\.updatedAt, round\.updatedAt\)/g) ?? []).length >= 2);
  assert.ok((ingest.match(/eq\(negotiationRounds\.activeKey, round\.activeKey!\)/g) ?? []).length >= 2);
  assert.ok((ingest.match(/operation: "negotiation\.ingest\.round"/g) ?? []).length >= 2);
  assert.match(ingest, /isMutationGuardConflict\(error\) && input\.source === "manual"[\s\S]*"version_conflict"/);
});

test("unknown persisted delivery states normalize fail-closed instead of widening the public type", async () => {
  const contents = await source();
  assert.match(contents, /type NegotiationOutboxStatus = "pending" \| "processing" \| "processed" \| "dead"/);
  assert.match(contents, /function negotiationOutboxStatus\(value: string \| null \| undefined\): NegotiationOutboxStatus \| null/);
  assert.match(contents, /default:\s*return null/);
  assert.match(contents, /outboxStatus: negotiationOutboxStatus\(deliveryByRound\.get\(round\.id\)\?\.status\)/);
});

test("outbound negotiation delivery is gated by outbound readiness while inbound capture stays optional", async () => {
  const service = await source();
  const send = service.slice(
    service.indexOf("export async function sendNegotiationRound"),
    service.indexOf("export async function attestManualNegotiationSend"),
  );
  const readiness = send.indexOf("getNegotiationDeliveryConfiguration()");
  const firstDatabaseRead = send.indexOf("findActiveAgreement(");

  assert.ok(readiness >= 0 && readiness < firstDatabaseRead);
  assert.match(send, /if \(!configuration\.portalEnabled\)/);
  assert.doesNotMatch(send, /!configuration\.inboundEmail/);
  assert.match(send, /configuration\.inboundEmail[\s\S]*\? \{ replyTo: buildNegotiationAliasAddress/);
  assert.match(service, /deliveryConfigured: isDeliveryGatewayConfigured\(\)/);
  assert.match(service, /negotiationMailAccepted: isNegotiationMailAccepted\(\)/);
  assert.match(service, /inboundEmailConfigured: Boolean\(configuration\.inboundEmail\)/);
});
