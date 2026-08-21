import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("the outbox runner fails closed on tenant config and scopes every lifecycle mutation", async () => {
  const route = await source("../app/api/jobs/outbox/route.ts");

  assert.match(route, /const noticeConfig = getNoticeConfig\(\);[\s\S]*const workspaceId = noticeConfig\.workspace\.id/);
  assert.ok((route.match(/eq\(outboxEvents\.workspaceId, workspaceId\)/g) ?? []).length >= 5);
  assert.doesNotMatch(route, /\.where\(eq\(outboxEvents\.id, row\.id\)\)/);
  assert.ok(route.indexOf("constantTimeSecretEqual(expected, supplied)") < route.indexOf("const rate = checkBestEffortRateLimit"));
  assert.match(route, /if \(!deliveries\.some\(\(delivery\) => delivery\.sink === "delivery"\)\)/);
  assert.match(route, /crmTarget !== null && !deliveries\.some\(\(delivery\) => delivery\.sink === "crm"\)/);
  assert.doesNotMatch(route, /if \(deliveries\.length === 0\)/);
  assert.match(route, /db\.insert\(outboxDeliveries\)\.select[\s\S]*legacyAttestationAbsent\(db, workspaceId, outboxEvents\.id\)/);
  assert.match(route, /isNull\(outboxDeliveries\.crmDestinationFingerprint\),[\s\S]*legacyAttestationAbsent\(db, workspaceId, row\.id\)/);
  assert.match(route, /legacyAttestationResolvesCrmDelivery/);
  assert.match(route, /destination\.sink === "crm"[\s\S]*isLegacyCrmDeliveryProfileIncomplete\(destination\)[\s\S]*legacyAttestationExists/);
  assert.match(route, /destination\.status === "accepted"[\s\S]*destination\.sink === "crm" && legacyCrmResolved/);
  assert.ok(route.indexOf("legacyAttestationAbsent(db, workspaceId, row.id)") < route.indexOf("await deliverOutboxEvent(configuration, row)"));
});

test("job rate limits count only authenticated scheduler requests", async () => {
  const retention = await source("../app/api/jobs/retention/route.ts");

  assert.ok(retention.indexOf("constantTimeSecretEqual(expected, supplied)") < retention.indexOf("const rate = checkBestEffortRateLimit"));
});

test("agreement lifecycle projections and tombstones stay inside guarded mutation batches", async () => {
  const [retention, operations, approvalRouting, signatures, reconciliation, agreements, versions, transitions, language] = await Promise.all([
    source("../app/api/jobs/retention/route.ts"),
    source("../app/api/operations/route.ts"),
    source("../app/lib/approval-routing-service.ts"),
    source("../app/api/signatures/route.ts"),
    source("../app/lib/docuseal-reconciliation.ts"),
    source("../app/api/agreements/route.ts"),
    source("../app/api/agreements/[id]/versions/route.ts"),
    source("../app/api/agreements/transition/route.ts"),
    source("../app/api/language-blocks/route.ts"),
  ]);

  assert.match(retention, /prepareAgreementDeletedIntegrationEvent/);
  assert.match(retention, /operation: "retention\.soft_delete\.agreement", guardChanges: sql<number>`changes\(\)`/);
  assert.ok((retention.match(/operation: "retention\.soft_delete\.document", guardChanges: sql<number>`changes\(\)`/g) ?? []).length >= 2);
  assert.match(retention, /evaluateDeletionDeliveryGate/);
  assert.match(retention, /purge_tombstone\.status = 'processed'/);
  assert.match(retention, /purge_delivery_sink\.status = 'accepted'/);
  assert.match(retention, /purge_projection_delivery\.sink = 'crm'/);
  assert.match(retention, /purge_cleanup_delivery\.status = 'accepted'/);
  assert.match(retention, /purge_cleanup_delivery\.crm_destination_fingerprint = purge_projection_delivery\.crm_destination_fingerprint/);
  assert.match(retention, /unresolvedCrmDeliveryProfiles\(crmLedger\.filter/);
  assert.match(retention, /purge_unprofiled_projection\.topic in/);
  assert.match(retention, /json_valid\(purge_unprofiled_projection\.payload\) = 1/);
  assert.doesNotMatch(retention, /purge_unprofiled_projection\.status in/);
  assert.doesNotMatch(retention, /crmTombstoneRequired|crmDeliveryEnabled/);
  assert.match(retention, /purge_incomplete_sink\.status <> 'accepted'/);
  assert.doesNotMatch(retention, /ne\(outboxEvents\.topic, "agreement\.deleted"\)/);

  assert.ok((operations.match(/prepareAgreementLifecycleUpdatedIntegrationEvent/g) ?? []).length >= 3);
  assert.match(approvalRouting, /prepareAgreementLifecycleUpdatedIntegrationEvent/);
  assert.ok((operations.match(/guardChanges: sql<number>`changes\(\)`/g) ?? []).length >= 6);
  assert.ok((signatures.match(/prepareAgreementLifecycleUpdatedIntegrationEvent/g) ?? []).length >= 3);
  assert.ok((reconciliation.match(/prepareAgreementLifecycleUpdatedIntegrationEvent/g) ?? []).length >= 4);
  assert.match(reconciliation, /topic: "signature\.completed"[\s\S]*crmAgreement: crmAgreementProjection\(projectedAgreement\)/);
  assert.match(agreements, /operation: "agreement\.update", guardChanges: sql<number>`changes\(\)`/);
  assert.match(agreements, /operation: "agreement\.delete", guardChanges: sql<number>`changes\(\)`/);
  assert.match(versions, /prepareAgreementLifecycleUpdatedIntegrationEvent/);
  assert.match(versions, /operation: "agreement\.document_version", guardChanges: sql<number>`changes\(\)`/);
  assert.match(transitions, /topic: "agreement\.stage_changed"[\s\S]*crmAgreement: crmAgreementProjection\(saved\)/);
  assert.match(transitions, /operation: "agreement\.transition", guardChanges: sql<number>`changes\(\)`/);
  assert.doesNotMatch(transitions, /prepareAgreementLifecycleUpdatedIntegrationEvent/);
  assert.match(language, /operation: "language\.update", guardChanges: sql<number>`changes\(\)`/);
});

test("obligation creation atomically rechecks the executed agreement before child side effects", async () => {
  const operations = await source("../app/api/operations/route.ts");
  const branchStart = operations.indexOf('if (input.entity === "obligation" && input.action === "create")');
  const branchEnd = operations.indexOf('if (input.entity === "obligation" && input.action === "complete")', branchStart);
  assert.ok(branchStart >= 0 && branchEnd > branchStart);
  const branch = operations.slice(branchStart, branchEnd);

  assert.match(branch, /agreement\.stage !== "Active" && agreement\.signatureStatus !== "Completed"/);
  assert.match(branch, /db\.insert\(obligationSchedules\)\.select/);
  assert.match(branch, /db\.insert\(obligations\)\.values\(obligation\)/);
  assert.match(branch, /eq\(agreements\.workspaceId, workspaceId\)/);
  assert.match(branch, /eq\(agreements\.id, agreement\.id\)/);
  assert.match(branch, /eq\(agreements\.version, agreement\.version\)/);
  assert.match(branch, /isNull\(agreements\.deletedAt\)/);
  assert.match(branch, /or\(eq\(agreements\.stage, "Active"\), eq\(agreements\.signatureStatus, "Completed"\)\)/);
  assert.match(branch, /operation: "obligation\.create\.agreement"/);
  assert.match(branch, /guardChanges: sql<number>`changes\(\)`/);
  assert.ok(branch.indexOf("db.insert(obligationSchedules).select") < branch.indexOf('operation: "obligation.create.agreement"'));
  assert.ok(branch.indexOf('operation: "obligation.create.agreement"') < branch.indexOf("db.insert(agreementEvents).values(event)"));
  assert.ok(branch.indexOf('operation: "obligation.create.agreement"') < branch.indexOf("db.insert(outboxEvents).values(outbox)"));
});

test("administrator CRM repair is bounded, versioned, guarded, and tombstone-safe", async () => {
  const [route, page] = await Promise.all([
    source("../app/api/admin/integrations/resync/route.ts"),
    source("../app/page.tsx"),
  ]);

  assert.match(route, /authorizeApiRequest\(request, "integration:manage"/);
  assert.match(route, /z\.discriminatedUnion\("action"/);
  assert.match(route, /action: z\.literal\("projection"\)/);
  assert.match(route, /action: z\.literal\("tombstone"\)/);
  assert.match(route, /action: z\.literal\("legacy_cleanup_attestation"\)/);
  assert.match(route, /legacyCleanupConfirmed: z\.literal\(true\)/);
  assert.match(route, /legacyCleanupConfirmation: z\.literal\(CRM_LEGACY_CLEANUP_CONFIRMATION\)/);
  assert.match(route, /historicalCleanupConfirmed: z\.literal\(true\)\.optional\(\)/);
  assert.match(route, /historicalCleanupConfirmation: z\.literal\(CRM_HISTORICAL_CLEANUP_CONFIRMATION\)\.optional\(\)/);
  assert.match(route, /crm_historical_cleanup_confirmation_required/);
  assert.match(route, /crm_profile_reactivation_not_supported/);
  assert.match(route, /if \(!summary\.configured\)/);
  assert.match(route, /diagnostics\.crm\?\.status !== "passed"/);
  assert.match(route, /decodeCrmResyncCursor/);
  assert.match(route, /encodeCrmResyncCursor/);
  assert.match(route, /limit\(PAGE_SIZE \+ 1\)/);
  assert.match(route, /nextCursor:/);
  assert.match(route, /const PAGE_SIZE = 50/);
  assert.match(route, /const D1_MAX_BINDS_PER_STATEMENT = 100/);
  assert.match(route, /const CRM_PROFILE_PAGE_FIXED_BINDS = 7/);
  assert.match(route, /const CRM_LEGACY_PAGE_FIXED_BINDS = 6/);
  assert.match(route, /PAGE_SIZE \+ Math\.max\(CRM_PROFILE_PAGE_FIXED_BINDS, CRM_LEGACY_PAGE_FIXED_BINDS\) > D1_MAX_BINDS_PER_STATEMENT/);
  assert.match(route, /when \$\{outboxEvents\.aggregateType\} = 'agreement' then \$\{outboxEvents\.aggregateId\}/);
  assert.match(route, /inArray\(crmAgreementKey, ids\)/);
  assert.match(route, /inArray\(crmAgreementKey, agreementIds\.map\(String\)\)/);
  assert.doesNotMatch(route, /inArray\(outboxEvents\.aggregateId, ids\)/);
  assert.doesNotMatch(route, /inArray\(outboxEvents\.aggregateId, agreementIds\.map\(String\)\)/);
  assert.match(route, /and \$\{outboxDeliveries\.status\} = 'accepted'/);
  assert.doesNotMatch(route, /eq\(outboxDeliveries\.status, "accepted"\)/);
  assert.match(route, /eq\(outboxDeliveries\.crmProvider, configuration\.provider\)/);
  assert.match(route, /eq\(outboxDeliveries\.crmMappingVersion, configuration\.mappingVersion\)/);
  assert.match(route, /eq\(outboxDeliveries\.crmDestinationFingerprint, fingerprint\)/);
  assert.match(route, /eq\(outboxEvents\.topic, "signature\.completed"\)/);
  assert.match(route, /json_extract\(\$\{outboxEvents\.payload\}, '\$\.agreementId'\)/);
  assert.match(route, /evaluateCrmResyncEligibility/);
  assert.match(route, /version: current\.version \+ 1/);
  assert.match(route, /prepareAgreementDeletedIntegrationEvent/);
  assert.match(route, /prepareAgreementUpdatedIntegrationEvent/);
  assert.match(route, /crm: agreementSelectionForCrmProvider\(configuration\.provider\)/);
  assert.match(route, /deletedAt: current\.deletedAt \?\? now/);
  assert.match(route, /operation: isTombstone \? "integration\.crm_tombstone_resync" : "integration\.crm_projection_resync"/);
  assert.match(route, /guardChanges: sql<number>`changes\(\)`/);
  assert.ok(route.indexOf("guardChanges: sql<number>`changes()`") < route.indexOf("db.insert(outboxEvents).values(outbox)"));

  const legacyBranchStart = route.indexOf('if (input.action === "legacy_cleanup_attestation")');
  const profileGateStart = route.indexOf("const runtimeSource = env as unknown as IntegrationStatusSource", legacyBranchStart);
  const legacyBranch = route.slice(
    legacyBranchStart,
    profileGateStart,
  );
  assert.match(route, /const LEGACY_ATTESTATION_MAX_EVENTS = 20/);
  assert.match(route, /const LEGACY_ATTESTATION_CLEANUP_FIXED_BINDS = 2/);
  assert.match(route, /LEGACY_ATTESTATION_MAX_STATEMENT_BINDS = LEGACY_ATTESTATION_CLEANUP_FIXED_BINDS[\s\S]*\+ LEGACY_ATTESTATION_MAX_EVENTS/);
  assert.match(route, /LEGACY_ATTESTATION_MAX_STATEMENT_BINDS > D1_MAX_BINDS_PER_STATEMENT/);
  assert.match(route, /limit\(LEGACY_ATTESTATION_MAX_EVENTS \+ 1\)/);
  assert.match(legacyBranch, /db\.insert\(crmLegacyCleanupAttestations\)\.select/);
  assert.match(legacyBranch, /eq\(outboxEvents\.payload, row\.payload\)/);
  assert.match(legacyBranch, /legacyProfileIncomplete\(\)/);
  assert.match(legacyBranch, /isNull\(crmLegacyCleanupAttestations\.eventId\)/);
  assert.match(legacyBranch, /operation: "integration\.crm_legacy_cleanup_evidence"/);
  assert.match(legacyBranch, /current\.deletedAt === null \? null : prepareOutboxEvent/);
  assert.ok(legacyBranchStart >= 0 && legacyBranchStart < profileGateStart);

  assert.match(page, /type CrmResyncAction = "projection" \| "tombstone" \| "legacy_cleanup_attestation"/);
  assert.match(page, /<option value="legacy_cleanup_attestation">Attest legacy cleanup<\/option>/);
  assert.match(page, /legacyCleanupConfirmed: true/);
  assert.match(page, /legacyCleanupConfirmation: crmLegacyCleanupConfirmation/);
  assert.match(page, /crmResyncAction === "legacy_cleanup_attestation"[\s\S]*crmLegacyCleanupConfirmed && crmLegacyCleanupConfirmation === CRM_LEGACY_CLEANUP_CONFIRMATION/);
  assert.match(page, /This action does not infer a destination, bind a delivery receipt, or contact a CRM/);
  assert.match(page, /historicalCleanupConfirmed: true/);
  assert.match(page, /historicalCleanupConfirmation: crmHistoricalCleanupConfirmation/);
  assert.match(page, /crmResyncAction === "tombstone"[\s\S]*candidate\.historicalCleanup[\s\S]*crmHistoricalCleanupConfirmed/);
  assert.match(page, /CRM_HISTORICAL_CLEANUP_CONFIRMATION/);
  assert.match(page, /intended live profile[\s\S]*reproject it before resuming service/i);
});

test("document linking, rescanning, and retention policy audits follow immediate mutation guards", async () => {
  const [documentsRoute, retentionRoute] = await Promise.all([
    source("../app/api/documents/import/route.ts"),
    source("../app/api/admin/retention/route.ts"),
  ]);

  assert.match(documentsRoute, /operation: "document\.link",[\s\S]*guardChanges: sql<number>`changes\(\)`/);
  assert.match(documentsRoute, /operation: "agreement\.link_document",[\s\S]*guardChanges: sql<number>`changes\(\)`/);
  assert.match(documentsRoute, /operation: "document\.reject_malicious",[\s\S]*guardChanges: sql<number>`changes\(\)`/);
  assert.match(documentsRoute, /operation: "document\.promote_clean",[\s\S]*guardChanges: sql<number>`changes\(\)`/);
  assert.ok((documentsRoute.match(/operation: "document\.link"/g) ?? []).length >= 2);

  const rescan = documentsRoute.slice(documentsRoute.indexOf("export async function PUT"));
  const unavailableStart = rescan.indexOf('if (scan.status === "unavailable")');
  const malicious = rescan.slice(rescan.indexOf('if (scan.status === "malicious")', unavailableStart), rescan.indexOf("const readable = await readDocumentText"));
  assert.ok(malicious.indexOf('operation: "document.reject_malicious"') < malicious.indexOf("db.insert(workspaceEvents).values(workspaceEvent)"));
  assert.match(malicious, /effectiveLegalHold/);
  assert.match(malicious, /db\.insert\(purgeJobs\)\.values/);
  assert.match(malicious, /resourceId: `rejected:\$\{document\.id\}:\$\{cleanupJobId\}`/);
  assert.doesNotMatch(malicious, /DOCUMENTS\.delete/);

  assert.match(retentionRoute, /operation: "retention\.policy\.agreement",[\s\S]*guardChanges: sql<number>`changes\(\)`/);
  assert.match(retentionRoute, /prepareAgreementDeletedIntegrationEvent/);
  assert.match(retentionRoute, /\.\.\.tombstoneWrite/);
  assert.match(retentionRoute, /operation: "retention\.policy\.document",[\s\S]*guardChanges: sql<number>`changes\(\)`/);
  assert.ok(retentionRoute.indexOf("agreementGuard,") < retentionRoute.indexOf("db.insert(agreementEvents).values(event)"));
  assert.ok(retentionRoute.indexOf("documentGuard, db.insert(agreementEvents).values(event)") >= 0);
  assert.ok(retentionRoute.indexOf("documentGuard, db.insert(workspaceEvents).values(event)") >= 0);
  assert.match(retentionRoute, /REJECTED_OBJECT_DELETE_CLAIM/);
  assert.ok((retentionRoute.match(/hold_cleanup_claim/g) ?? []).length >= 2);
});

test("webhook reclaim refreshes and fences the processing claim before reuse", async () => {
  const route = await source("../app/api/webhooks/docuseal/route.ts");
  const reconciliation = await source("../app/lib/docuseal-reconciliation.ts");

  assert.match(route, /eq\(webhookReceipts\.receivedAt, existing\.receivedAt\)/);
  assert.ok((route.match(/eq\(webhookReceipts\.receivedAt, claimToken\)/g) ?? []).length >= 2);
  assert.match(route, /eq\(webhookReceipts\.receivedAt, receiptClaimedAt\)/);
  assert.match(route, /if \(!finalizedReceipt\.meta\.changes\) throw new Error/);
  assert.doesNotMatch(route, /status: 202/);
  assert.match(route, /retryableWebhookResponse\(requestId, "busy"\)/);
  assert.ok((route.match(/if \(!released\.meta\.changes\) throw new Error/g) ?? []).length >= 2);
  assert.match(route, /if \(receiptId && receiptWorkspaceId\) return retryableWebhookResponse\(requestId, "failed"\)/);
  assert.match(route, /headers: \{ "Retry-After": String\(acknowledgement\.retryAfterSeconds\) \}/);
  assert.match(reconciliation, /eq\(documents\.scanStatus, "clean"\)/);
  assert.match(reconciliation, /isNull\(documents\.deletedAt\)/);
  assert.match(reconciliation, /findReusableSignedArtifact/);
});

test("reminder recipients require both active tenant membership and an active user", async () => {
  const route = await source("../app/api/reminders/route.ts");

  assert.match(route, /from\(workspaceMemberships\)\.innerJoin\(users/);
  assert.match(route, /const workspaceId = auth\.context\.workspace\.id/);
  assert.match(route, /eq\(workspaceMemberships\.workspaceId, workspaceId\)/);
  assert.match(route, /eq\(workspaceMemberships\.userId, userId\)/);
  assert.match(route, /eq\(workspaceMemberships\.status, "active"\)/);
  assert.match(route, /eq\(users\.status, "active"\)/);
});

test("identity recovery cannot change a shared or concurrently re-enabled account", async () => {
  const route = await source("../app/api/admin/memberships/route.ts");
  const recovery = route.slice(route.indexOf('if ("action" in input)'));

  assert.match(recovery, /identity_replacement_shared_account/);
  assert.match(recovery, /eq\(users\.identityProvider, subject\.identityProvider\)/);
  assert.match(recovery, /eq\(users\.identitySubject, subject\.identitySubject\)/);
  assert.match(recovery, /identity_current\.status = 'disabled'/);
  assert.match(recovery, /not exists \([\s\S]*workspace_memberships as identity_other/);
  assert.match(recovery, /operation: "membership\.replace_identity"/);
  assert.match(recovery, /guardChanges: sql<number>`changes\(\)`/);
  assert.ok(recovery.indexOf("operation: \"membership.replace_identity\"") < recovery.indexOf("db.insert(workspaceEvents).values(event)"));
});

test("unexpected session failures log only a bounded diagnostic", async () => {
  const route = await source("../app/api/session/route.ts");

  assert.match(route, /errorKind: error instanceof Error \? "error" : typeof error/);
  assert.doesNotMatch(route, /console\.error\("Unable to resolve Notice session", error\)/);
});
