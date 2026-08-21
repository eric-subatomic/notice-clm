import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("signed email ingress binds exact raw bytes and atomically claims event and message identities", async () => {
  const [route, schema] = await Promise.all([
    source("../app/api/webhooks/email/route.ts"),
    source("../db/schema.ts"),
  ]);
  assert.match(route, /const contentSha256 = await sha256Hex\(rawBytes\)/);
  assert.match(route, /payloadDigest = contentSha256/);
  assert.match(route, /verifyNegotiationInboundPayload\([\s\S]*rawBodySha256: contentSha256/);
  assert.ok(route.indexOf("normalizeNegotiationEmail(manifest.from.email)") < route.indexOf("receipt = await claimWebhookReceipt"));
  assert.ok(route.indexOf("await sha256Hex(bytes) !== expected.sha256") < route.indexOf("receipt = await claimWebhookReceipt"));
  assert.match(route, /MESSAGE_PROVIDER = "inbound-email-message"/);
  assert.match(route, /messageBindingDigest = await sha256Hex\(`\$\{round\.id\}\.\$\{contentSha256\}`\)/);
  assert.match(route, /value === value\.trim\(\) && !\/\[\\u0000-\\u001f\\u007f\]/);
  assert.match(route, /!round\.activeKey \|\| round\.status === "resolved" \|\| round\.status === "closed"/);
  assert.match(route, /onConflictDoNothing\(\)/);
  assert.match(schema, /uniqueIndex\("uq_webhook_receipts_workspace_provider_event"\)/);
  assert.match(schema, /idx_webhook_receipts_workspace_aggregate/);
  assert.match(route, /RECEIPT_AGGREGATE_TYPE = "negotiation_round"/);
  assert.match(route, /existing\.aggregateType !== aggregateType/);
  assert.match(route, /existing\.aggregateId !== aggregateId/);
  assert.match(route, /insert\(webhookReceipts\)\.select\(db\.select/);
  assert.match(route, /from\(negotiationRounds\)\.where\(and\(/);
  assert.match(route, /disposition: "aggregate_missing"/);
  assert.doesNotMatch(route, /from\(negotiationSubmissions\)[\s\S]*providerMessageId/);
});

test("processed email replay wins after close while a new closed-round event is durably rejected before ingestion", async () => {
  const route = await source("../app/api/webhooks/email/route.ts");
  const processed = route.indexOf('receipt.disposition === "processed"');
  const inactive = route.indexOf('!round.activeKey || round.status === "resolved" || round.status === "closed"');
  const messageClaim = route.indexOf("messageReceipt = await claimWebhookReceipt");
  const ingest = route.indexOf("await ingestNegotiationSubmissions");
  assert.ok(processed >= 0 && messageClaim > processed && inactive > messageClaim && ingest > inactive);
  assert.match(route, /"exchange_closed"[\s\S]*410/);
  assert.match(route, /status: "rejected"/);
});

test("every external ingestion batch is CAS-bound to the live round and fresh portal expiry", async () => {
  const service = await source("../app/lib/negotiation-service.ts");
  assert.match(service, /const commitCheckedAt = new Date\(\)\.toISOString\(\)/);
  assert.equal((service.match(/const requiresRoundGuard = Boolean\(roundAction\)/g) ?? []).length, 2);
  assert.ok((service.match(/eq\(negotiationRounds\.updatedAt, round\.updatedAt\)/g) ?? []).length >= 2);
  assert.ok((service.match(/eq\(negotiationRounds\.activeKey, round\.activeKey!\)/g) ?? []).length >= 2);
  assert.ok((service.match(/gt\(negotiationRounds\.portalExpiresAt, commitCheckedAt\)/g) ?? []).length >= 2);
  assert.match(service, /isMutationGuardConflict\(error\) && input\.source === "portal"/);
  assert.match(service, /"exchange_changed"/);
  assert.match(service, /isMutationGuardConflict\(error\) && input\.source === "email"/);
  assert.ok((service.match(/operation: "negotiation\.ingest\.agreement"/g) ?? []).length >= 2);
  assert.ok((service.match(/isNull\(agreements\.deletedAt\)/g) ?? []).length >= 2);
  assert.ok((service.match(/eq\(agreements\.version, agreement\.version\)/g) ?? []).length >= 2);
  assert.match(service, /isMutationGuardConflict\(error\) && input\.source === "manual"/);
});

test("review text cannot be downloaded after its agreement is soft-deleted", async () => {
  const service = await source("../app/lib/negotiation-service.ts");
  const reviewText = service.slice(
    service.indexOf("export async function getNegotiationReviewText"),
    service.indexOf("type PreparedAttachment"),
  );
  assert.ok(reviewText.indexOf("findActiveAgreement") < reviewText.indexOf("from(negotiationSubmissions)"));
  assert.match(reviewText, /agreement_not_found/);
});

test("terminal webhook rejection remains rejected on exact replay while transient failures stay retryable", async () => {
  const [route, service] = await Promise.all([
    source("../app/api/webhooks/email/route.ts"),
    source("../app/lib/negotiation-service.ts"),
  ]);
  assert.match(route, /status: "rejected"/);
  assert.match(route, /persistedRejection\(existing\.error\)/);
  assert.match(route, /disposition === "rejected"[\s\S]*previously rejected/);
  assert.match(route, /error: `\$\{error\.status\}:\$\{error\.code\}`/);
  assert.match(route, /status: "failed", error: "Processing failed"/);
  assert.match(route, /receiptClaims: \[receipt, messageReceipt\]/);
  assert.match(service, /operation: "negotiation\.ingest\.receipt"/);
  assert.match(service, /eq\(webhookReceipts\.receivedAt, claim\.claimedAt\)/);
  assert.match(service, /eq\(webhookReceipts\.aggregateType, claim\.aggregateType\)/);
  assert.match(service, /eq\(webhookReceipts\.aggregateId, claim\.aggregateId\)/);
  assert.match(service, /EMAIL_RECEIPT_PROVIDERS/);
});

test("R2 cleanup retains bytes whenever D1 may already have committed", async () => {
  const [service, cleanup] = await Promise.all([
    source("../app/lib/negotiation-service.ts"),
    source("../app/lib/staged-object-cleanup.ts"),
  ]);
  assert.match(service, /async function cleanupUncommittedObject/);
  assert.match(service, /cleanupStagedDocumentObject/);
  assert.match(service, /cleanupStagedWorkingVersionObject/);
  assert.match(service, /cleanupStagedReviewTextObject/);
  assert.match(cleanup, /authoritative = await input\.isAuthoritative\(\)/);
  assert.match(cleanup, /recordDeleteFailure: \(\) => recordDurableStagedCleanup/);
  assert.equal((service.match(/await cleanupUncommittedObject\(/g) ?? []).length >= 3, true);
});

test("portal responses protect bearer URLs on success and every failure path", async () => {
  const [route, service] = await Promise.all([
    source("../app/api/exchange/[token]/route.ts"),
    source("../app/lib/negotiation-service.ts"),
  ]);
  for (const header of ["Referrer-Policy", "Content-Security-Policy", "X-Frame-Options", "Permissions-Policy", "Cross-Origin-Resource-Policy", "X-Robots-Tag"]) {
    assert.match(route, new RegExp(header));
  }
  assert.match(route, /withResponseHeaders\([\s\S]*handleRouteError/);
  assert.match(route, /withResponseHeaders\(guard\.response, securityHeaders\(\)\)/);
  assert.doesNotMatch(route, /checkBestEffortRateLimit|rateLimitExceeded/);
  assert.ok(route.indexOf("await reserveNegotiationPortalUpload(token)") < route.indexOf("await readBoundedBody("));
  assert.match(route, /portalReservation: reservation/);
  assert.match(route, /portalConsumedBytes: consumedUploadBytes/);
  assert.match(route, /await recordNegotiationPortalUploadFailure\(reservation, consumedUploadBytes\)/);
  assert.match(route, /Retry-After", "5"/);
  assert.match(route, /Replacing this round's link does not reset its transfer limits/);
  assert.match(route, /filename\*=UTF-8''\$\{encodedName\}/);
  assert.match(route, /status: rejected \? 422 : 201/);
  assert.match(route, /const receipts = result\.submissions\.map\(\(submission\) => \(\{ receiptId: submission\.id \}\)\)/);
  assert.match(route, /accepted: !rejected, recorded: true, receipts, requestId/);
  assert.doesNotMatch(route, /accepted: !rejected, recorded: true, submissions/);
  assert.match(route, /Do not resubmit it unless the contract sender asks you to/);
  assert.match(route, /Return to the secure exchange/);
  assert.match(route, /prefersHtml\(request\)/);
  assert.match(service, /if \(!exchangeConfiguration\.portalEnabled\)/);
  assert.match(service, /eq\(negotiationRounds\.workspaceId, noticeConfiguration\.workspace\.id\)/);
  assert.match(service, /requestingOrganization: noticeConfiguration\.workspace\.name/);
  assert.match(service, /transferPolicy: NEGOTIATION_PORTAL_TRANSFER_POLICY/);
  assert.match(service, /start a new exchange round and send its secure link/);
  const download = service.slice(
    service.indexOf("export async function getNegotiationPortalDocument"),
    service.indexOf("export async function getNegotiationReviewText"),
  );
  assert.ok(download.indexOf("await claimNegotiationPortalDownload") < download.indexOf("await readVerifiedObject"));
  const resolver = service.slice(
    service.indexOf("export async function resolveNegotiationPortal"),
    service.indexOf("export async function reserveNegotiationPortalUpload"),
  );
  assert.doesNotMatch(resolver, /readVerifiedObject|verifiedOutboundDocument/);
  assert.match(service, /negotiationPortalUploadReservationPredicate\(input\.portalReservation!, commitCheckedAt\)/);
});

test("negotiation state exposes an alias only to managers for the exact active round", async () => {
  const [service, route] = await Promise.all([
    source("../app/lib/negotiation-service.ts"),
    source("../app/api/agreements/[id]/negotiation/route.ts"),
  ]);
  assert.match(service, /const activeEmailDomain = canManage \?/);
  assert.match(service, /round\.id === active\?\.id \? activeEmailDomain : null/);
  assert.match(service, /outbound\.sha256 === round\.outboundSha256/);
  assert.match(service, /document\.sha256 === submission\.documentSha256/);
  assert.doesNotMatch(service.slice(service.indexOf("export async function getNegotiationState"), service.indexOf("type BaseDocument")), /objectKey:/);
  assert.match(route, /permissions\.has\("document:manage"\)/);
  assert.match(route, /view"\) === "review-text"/);
});

test("promotion preserves a pre-existing review artifact and rescan preserves namespaced ingress evidence", async () => {
  const [service, imports] = await Promise.all([
    source("../app/lib/negotiation-service.ts"),
    source("../app/api/documents/import/route.ts"),
  ]);
  assert.match(service, /!submission\.reviewTextObjectKey \? \{/);
  assert.match(service, /"ingress\.email\.internetMessageId"/);
  assert.match(imports, /startsWith\("ingress\."\)/);
  assert.match(imports, /promotedExtracted/);
});

test("decision actions and link rotation use mutation fences without logging bearer material", async () => {
  const service = await source("../app/lib/negotiation-service.ts");
  for (const operation of [
    "negotiation.reject_submission.agreement",
    "negotiation.reject_submission",
    "negotiation.mark_ready",
    "negotiation.mark_ready.round",
    "negotiation.promote.submission",
    "negotiation.rotate_portal",
  ]) assert.match(service, new RegExp(operation.replaceAll(".", "\\.")));
  assert.match(service, /delivery_in_progress/);
  assert.ok((service.match(/noPendingRoundDeliveryPredicate\(db, input\.workspaceId, round\.id\)/g) ?? []).length >= 2);
  assert.ok((service.match(/ensureNoPendingRoundDelivery\(db, input\.workspaceId, round\.id\)/g) ?? []).length >= 2);
  assert.doesNotMatch(service, /detail: `[^`]*\$\{token\}/);
});

test("returned negotiation evidence updates the business queue without changing the aggregate version", async () => {
  const [service, roundState] = await Promise.all([
    source("../app/lib/negotiation-service.ts"),
    source("../app/lib/negotiation-round-state.ts"),
  ]);
  assert.match(roundState, /Review returned counterparty file for negotiation round/);
  assert.match(roundState, /Verify the sender of a returned file for negotiation round/);
  assert.match(roundState, /Rescan a quarantined return for negotiation round/);
  assert.match(roundState, /Request a safe replacement for negotiation round/);
  assert.match(roundState, /Follow up: negotiation round \$\{input\.roundNumber\} received no attachment/);
  assert.ok((service.match(/deriveNegotiationRoundAction\(/g) ?? []).length >= 3);
  assert.match(service, /agreement: savedAgreement/);
});

test("authenticated mail header inputs reject control characters", async () => {
  const [route, service] = await Promise.all([
    source("../app/api/agreements/[id]/negotiation/route.ts"),
    source("../app/lib/negotiation-service.ts"),
  ]);
  assert.match(route, /!\/\[\\u0000-\\u001f\\u007f\]\/\.test\(value\)/);
  assert.match(service, /function providerHeaderText/);
  assert.match(service, /\[\\u0000-\\u001f\\u007f\]/);
});
