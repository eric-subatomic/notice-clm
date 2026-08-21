import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("negotiation evidence follows agreement retention and storage cleanup", async () => {
  const route = await source("../app/api/jobs/retention/route.ts");

  assert.match(route, /submission\.reviewTextObjectKey \? \[submission\.reviewTextObjectKey\] : \[\]/);
  assert.match(route, /isWorkspaceObjectKey\(workspaceId, objectKey\)/);
  assert.match(route, /from negotiation_rounds as purge_counted_round/);
  assert.match(route, /from negotiation_submissions as purge_counted_submission/);
  assert.match(route, /from document_comparisons as purge_counted_comparison/);
  assert.match(route, /from webhook_receipts as purge_counted_receipt/);
  assert.match(route, /db\.delete\(documentComparisons\)/);
  assert.match(route, /db\.delete\(negotiationSubmissions\)/);
  assert.match(route, /db\.delete\(webhookReceipts\)/);
  assert.match(route, /db\.delete\(negotiationRounds\)/);
  assert.ok(route.indexOf("db.insert(purgeJobs).values") < route.indexOf("db.delete(negotiationSubmissions)"));
});

test("DocuSeal receipt identity is packet-bound and counted before packet purge", async () => {
  const [webhook, retention] = await Promise.all([
    source("../app/api/webhooks/docuseal/route.ts"),
    source("../app/api/jobs/retention/route.ts"),
  ]);

  assert.match(webhook, /matchingPackets\.length !== 1/);
  assert.match(webhook, /db\.insert\(webhookReceipts\)\.select\(db\.select\(/);
  assert.match(webhook, /aggregateType: sql<string>`\$\{RECEIPT_AGGREGATE_TYPE\}`/);
  assert.match(webhook, /aggregateId: signaturePackets\.id/);
  assert.match(webhook, /eq\(signaturePackets\.id, packetId\)/);
  assert.match(webhook, /existing\.aggregateType !== RECEIPT_AGGREGATE_TYPE/);
  assert.match(webhook, /existing\.aggregateId !== packetId/);

  assert.match(retention, /from webhook_receipts as purge_counted_signature_receipt/);
  assert.match(retention, /purge_counted_signature_receipt\.aggregate_type = 'signature_packet'/);
  assert.match(retention, /\)\) = \$\{signatureReceiptRows\.length\}/);
  const signatureReceiptDelete = retention.indexOf('eq(webhookReceipts.aggregateType, "signature_packet")', retention.indexOf("db.insert(purgeJobs).values"));
  const packetDelete = retention.indexOf("db.delete(signaturePackets)", signatureReceiptDelete);
  assert.ok(signatureReceiptDelete >= 0 && packetDelete > signatureReceiptDelete);
});

test("workspace and agreement exports preserve lineage without bearer or storage credentials", async () => {
  const [workspaceExport, agreementAudit, outboxJob] = await Promise.all([
    source("../app/api/admin/export/route.ts"),
    source("../app/api/agreements/[id]/audit/route.ts"),
    source("../app/api/jobs/outbox/route.ts"),
  ]);

  assert.match(workspaceExport, /negotiationRounds: negotiationRoundRows\.map\(sanitizeNegotiationRound\)/);
  assert.match(workspaceExport, /negotiationSubmissions: negotiationSubmissionRows\.map\(withoutReviewTextStorageReference\)/);
  assert.match(workspaceExport, /outboxEvents: outboxRows\.map\(sanitizeOutboxEvent\)/);
  assert.match(workspaceExport, /portalUrl: "\[redacted scoped counterparty link\]"/);
  assert.match(workspaceExport, /"activeKey",[\s\S]*"aliasCode",[\s\S]*"portalTokenHash"/);
  assert.match(workspaceExport, /seenStorageReferences/);

  assert.match(agreementAudit, /negotiationRounds: roundRows/);
  assert.match(agreementAudit, /negotiationSubmissions: submissionRows/);
  assert.match(agreementAudit, /documentComparisons: comparisonRows/);
  assert.match(agreementAudit, /negotiationInboundReceipts: receiptRows/);
  assert.match(agreementAudit, /eq\(webhookReceipts\.aggregateType, "negotiation_round"\)/);
  assert.doesNotMatch(agreementAudit, /aliasCode: negotiationRounds\.aliasCode/);
  assert.doesNotMatch(agreementAudit, /portalTokenHash: negotiationRounds\.portalTokenHash/);
  assert.doesNotMatch(agreementAudit, /reviewTextObjectKey: negotiationSubmissions\.reviewTextObjectKey/);

  assert.match(outboxJob, /payloadAfterTerminalDelivery/);
  assert.match(outboxJob, /portalUrl: `\[redacted after \$\{outcome\} delivery state\]`/);
  assert.match(outboxJob, /portalUrlSha256: await sha256Hex\(portalUrl\)/);
  assert.match(outboxJob, /anyDead[\s\S]*payloadAfterTerminalDelivery\(row, "dead"\)/);
  assert.ok(outboxJob.indexOf("await deliverOutboxEvent(configuration, row)") < outboxJob.indexOf("const processedPayload = await payloadAfterTerminalDelivery(row, \"accepted\")"));
  assert.match(outboxJob, /negotiationDeliveryIsCurrent/);
  assert.match(outboxJob, /eq\(negotiationRounds\.portalTokenHash, tokenHash\)/);
  assert.match(outboxJob, /eq\(negotiationRounds\.status, "outbound"\)/);
  assert.match(outboxJob, /innerJoin\(agreements,[\s\S]*isNull\(agreements\.deletedAt\)/);
  assert.match(outboxJob, /negotiation_delivery_superseded/);
  assert.ok(outboxJob.indexOf("!await negotiationDeliveryIsCurrent") < outboxJob.indexOf("await deliverOutboxEvent(configuration, row)"));
  assert.match(outboxJob, /row\.topic === "negotiation\.round_requested"[\s\S]*getNegotiationDeliveryConfiguration\(\)[\s\S]*getDeliveryConfiguration\(\)/);
});

test("signature readiness and deletion are fenced by unresolved negotiation and document roles are explicit", async () => {
  const [transition, signatures, agreementsRoute, versionsRoute, imports, reconciliation, documentDownload] = await Promise.all([
    source("../app/api/agreements/transition/route.ts"),
    source("../app/api/signatures/route.ts"),
    source("../app/api/agreements/route.ts"),
    source("../app/api/agreements/[id]/versions/route.ts"),
    source("../app/api/documents/import/route.ts"),
    source("../app/lib/docuseal-reconciliation.ts"),
    source("../app/api/documents/[id]/route.ts"),
  ]);

  assert.match(transition, /negotiation_round_unresolved/);
  assert.match(transition, /isNotNull\(negotiationRounds\.activeKey\)/);
  assert.match(signatures, /negotiation_round_unresolved/);
  assert.match(signatures, /isNotNull\(negotiationRounds\.activeKey\)/);
  assert.match(signatures, /operation: "signature\.create\.reservation"/);
  assert.match(signatures, /notExists\(db\.select\(\{ id: negotiationRounds\.id \}\)[\s\S]*isNotNull\(negotiationRounds\.activeKey\)/);
  assert.match(agreementsRoute, /negotiation_round_unresolved/);
  assert.match(agreementsRoute, /notExists\(db\.select\(\{ id: negotiationRounds\.id \}\)[\s\S]*isNotNull\(negotiationRounds\.activeKey\)/);
  assert.match(versionsRoute, /negotiation_round_unresolved/);
  assert.match(versionsRoute, /notExists\(db\.select\(\{ id: negotiationRounds\.id \}\)[\s\S]*isNotNull\(negotiationRounds\.activeKey\)/);
  assert.match(versionsRoute, /inArray\(documents\.role, NEGOTIATION_BASE_SOURCE_ROLES\)/);
  assert.match(versionsRoute, /eq\(documents\.direction, "inbound"\)/);
  assert.match(versionsRoute, /isNull\(documents\.negotiationRoundId\)/);
  assert.match(imports, /role: "initial_source"/);
  assert.match(imports, /direction: "inbound"/);
  assert.match(imports, /key\.startsWith\("ingress\."\)/);
  assert.match(imports, /promotedExtracted = \{ \.\.\.analysis\.extracted, \.\.\.initialScanEvidence, \.\.\.ingressEvidence \}/);
  assert.match(reconciliation, /role: "signed_artifact"/);
  assert.match(reconciliation, /direction: "inbound"/);
  assert.match(documentDownload, /const bytes = new Uint8Array\(await object\.arrayBuffer\(\)\)/);
  assert.match(documentDownload, /bytes\.byteLength !== document\.size \|\| actualSha256 !== document\.sha256/);
  assert.match(documentDownload, /document_integrity_failure/);
  assert.match(documentDownload, /X-Document-SHA256/);
  assert.match(documentDownload, /exists\(db\.select\(\{ id: agreements\.id \}\)[\s\S]*isNull\(agreements\.deletedAt\)/);
});
