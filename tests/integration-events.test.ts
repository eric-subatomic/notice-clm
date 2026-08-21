import assert from "node:assert/strict";
import test from "node:test";
import {
  CRM_INTEGRATION_TOPICS,
  INTEGRATION_TOPIC_VERSION,
  MAX_INTEGRATION_EVENT_PAYLOAD_BYTES,
  crmAgreementExternalKey,
  crmAgreementProjection,
  integrationEventPayloadSchemas,
  isCrmIntegrationTopic,
  parseIntegrationEvent,
  prepareAgreementDeletedIntegrationEvent,
  prepareAgreementLifecycleUpdatedIntegrationEvent,
  prepareAgreementUpdatedIntegrationEvent,
  prepareIntegrationOutboxEvent,
  type IntegrationTopic,
} from "../app/lib/integration-events";

const now = "2026-08-02T12:00:00.000Z";
const documentSha256 = "a".repeat(64);
const basisHash = "b".repeat(64);

const agreement = {
  id: 4102,
  workspaceId: "orchid-firm",
  version: 7,
  party: "Orchid Family Office LLC",
  type: "Investment Management Agreement",
  value: 2_500_000,
  valueMinor: 250_000_025,
  currencyCode: "EUR",
  stage: "Signature",
  owner: "Relationship Manager",
  department: "Wealth Management",
  risk: "High",
  approvalStatus: "Approved",
  signatureStatus: "Sent",
  effectiveDate: "2026-08-15",
  expirationDate: "2027-08-14",
  crm: "Salesforce",
  crmRecord: "006R000000AbCdE",
  updatedAt: now,
} as const;

const crmAgreement = crmAgreementProjection(agreement);

type EventSample = Readonly<{
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}>;

const samples: Record<IntegrationTopic, EventSample> = {
  "notification.workspace_access": {
    aggregateType: "workspace_membership",
    aggregateId: "user-1",
    payload: {
      workspaceId: agreement.workspaceId,
      role: "requester",
      recipient: { userId: "user-1", email: "requester@example.invalid", displayName: "Request Owner" },
      causationId: "request-1",
    },
  },
  "notification.approval_reminder": {
    aggregateType: "approval",
    aggregateId: "approval-1",
    payload: {
      approvalId: "approval-1",
      agreementId: agreement.id,
      role: "Legal",
      due: "2026-08-05",
      recipient: { userId: "user-2", email: "approver@example.invalid", displayName: "Legal Approver" },
      aggregateVersion: 2,
      causationId: "request-2",
    },
  },
  "notification.obligation_reminder": {
    aggregateType: "obligation",
    aggregateId: "obligation-1",
    payload: {
      obligationId: "obligation-1",
      agreementId: agreement.id,
      title: "Annual suitability review",
      dueDate: "2027-08-01",
      recipient: { userId: "user-3", email: "owner@example.invalid", displayName: "Obligation Owner" },
      aggregateVersion: 1,
      causationId: "request-3",
    },
  },
  "negotiation.round_requested": {
    aggregateType: "negotiation_round",
    aggregateId: "round-1",
    payload: {
      roundId: "round-1",
      agreementId: agreement.id,
      roundNumber: 2,
      party: agreement.party,
      agreementType: agreement.type,
      subject: `Review requested: ${agreement.party}`,
      message: "Please review the exact contract in the secure exchange.",
      recipient: { email: "counsel@example.invalid", displayName: "Counterparty counsel" },
      replyTo: "redlines-a1b2c3@example.invalid",
      portalUrl: "https://notice.example.invalid/api/exchange/synthetic-token",
      outboundDocument: { id: "document-round-1", fileName: "agreement-round-2.docx", sha256: documentSha256 },
      sentBy: { userId: "user-1", email: "owner@example.invalid", displayName: "Agreement Owner" },
      aggregateVersion: 2,
      causationId: "request-round-1",
    },
  },
  "agreement.created": {
    aggregateType: "agreement",
    aggregateId: String(agreement.id),
    payload: { agreementId: agreement.id, version: 1, documentVersion: 1, aggregateVersion: 1, causationId: "request-4", crmAgreement: { ...crmAgreement, version: 1 } },
  },
  "agreement.updated": {
    aggregateType: "agreement",
    aggregateId: String(agreement.id),
    payload: { agreementId: agreement.id, version: agreement.version, changedFields: ["owner", "value"], aggregateVersion: agreement.version, causationId: "request-5", crmAgreement },
  },
  "agreement.stage_changed": {
    aggregateType: "agreement",
    aggregateId: String(agreement.id),
    payload: { agreementId: agreement.id, from: "Negotiation", to: "Signature", version: agreement.version, aggregateVersion: agreement.version, causationId: "request-6", crmAgreement },
  },
  "agreement.deleted": {
    aggregateType: "agreement",
    aggregateId: String(agreement.id),
    payload: {
      agreementId: agreement.id,
      version: agreement.version + 1,
      aggregateVersion: agreement.version + 1,
      causationId: "request-7",
      externalKey: crmAgreement.externalKey,
      tombstone: true,
      deletedAt: now,
      crm: agreement.crm,
      crmRecord: agreement.crmRecord,
    },
  },
  "approval.requested": {
    aggregateType: "approval",
    aggregateId: "approval-2",
    payload: { approvalId: "approval-2", agreementId: agreement.id, requestedByUserId: "user-1", approverUserId: null, documentVersion: 3, documentSha256, basisHash, aggregateVersion: 1, causationId: "request-8" },
  },
  "approval.assigned": {
    aggregateType: "approval",
    aggregateId: "approval-2",
    payload: { approvalId: "approval-2", agreementId: agreement.id, approverUserId: "user-2", aggregateVersion: 2, causationId: "request-9" },
  },
  "approval.decided": {
    aggregateType: "approval",
    aggregateId: "approval-2",
    payload: { approvalId: "approval-2", agreementId: agreement.id, status: "Approved", decidedByUserId: "user-2", aggregateVersion: 3, causationId: "request-10" },
  },
  "obligation.created": {
    aggregateType: "obligation",
    aggregateId: "obligation-2",
    payload: { obligationId: "obligation-2", agreementId: agreement.id, ownerUserId: "user-3", dueDate: "2027-08-01", aggregateVersion: 1, causationId: "request-11" },
  },
  "obligation.completed": {
    aggregateType: "obligation",
    aggregateId: "obligation-2",
    payload: { obligationId: "obligation-2", agreementId: agreement.id, aggregateVersion: 2, causationId: "request-12" },
  },
  "language.created": {
    aggregateType: "language_block",
    aggregateId: "8001",
    payload: { languageBlockId: 8001, version: 1, aggregateVersion: 1, causationId: "request-13" },
  },
  "language.updated": {
    aggregateType: "language_block",
    aggregateId: "8001",
    payload: { languageBlockId: 8001, version: 2, aggregateVersion: 2, causationId: "request-14" },
  },
  "signature.packet_created": {
    aggregateType: "signature_packet",
    aggregateId: "packet-1",
    payload: { packetId: "packet-1", agreementId: agreement.id, provider: "docuseal", submissionId: "73001", documentVersion: 3, documentSha256, basisHash, aggregateVersion: 2, causationId: "request-15" },
  },
  "signature.packet_abandoned": {
    aggregateType: "signature_packet",
    aggregateId: "packet-1",
    payload: { packetId: "packet-1", agreementId: agreement.id, provider: "docuseal", reason: "provider_mapping_absent", verifiedAt: now, aggregateVersion: 2, causationId: "request-16" },
  },
  "signature.packet_archived": {
    aggregateType: "signature_packet",
    aggregateId: "packet-1",
    payload: { packetId: "packet-1", agreementId: agreement.id, provider: "docuseal", submissionId: "73001", documentVersion: 3, documentSha256, basisHash, status: "archived", actionable: false, recovered: true, aggregateVersion: 3, causationId: "request-17" },
  },
  "signature.packet_superseded": {
    aggregateType: "signature_packet",
    aggregateId: "packet-1",
    payload: { packetId: "packet-1", agreementId: agreement.id, provider: "docuseal", submissionId: "73001", documentVersion: 3, documentSha256, basisHash, status: "superseded", actionable: false, recovered: true, aggregateVersion: 3, causationId: "request-18" },
  },
  "signature.completed": {
    aggregateType: "signature",
    aggregateId: "packet-1",
    payload: { packetId: "packet-1", agreementId: agreement.id, provider: "docuseal", submissionId: "73001", status: "completed", activated: true, documentVersion: 3, documentSha256, evidenceDocumentId: "document-1", aggregateVersion: 4, crmAgreement: { ...crmAgreement, version: 8, stage: "Active", signatureStatus: "Completed" } },
  },
  "retention.d1_purged": {
    aggregateType: "records-policy",
    aggregateId: `agreement:${agreement.id}`,
    payload: { resourceType: "agreement", resourceId: String(agreement.id), d1PurgedAt: now, storageStatus: "storage_pending", purgeJobId: "purge-job-1", causationId: "request-19" },
  },
  "integration.delivery.connection_test": {
    aggregateType: "system",
    aggregateId: "connection-1",
    payload: { dryRun: true, channel: "delivery" },
  },
  "integration.crm.connection_test": {
    aggregateType: "system",
    aggregateId: "connection-2",
    payload: { dryRun: true, channel: "crm" },
  },
};

test("every integration topic has a valid versioned outbox and full-event sample", () => {
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(integrationEventPayloadSchemas).sort());

  for (const [topic, sample] of Object.entries(samples)) {
    const outbox = prepareIntegrationOutboxEvent({
      workspaceId: agreement.workspaceId,
      topic,
      aggregateType: sample.aggregateType,
      aggregateId: sample.aggregateId,
      payload: sample.payload,
    });
    assert.equal(outbox.payload.topicVersion, INTEGRATION_TOPIC_VERSION, topic);

    const parsed = parseIntegrationEvent({
      id: `event-${topic}`,
      ...outbox,
      createdAt: now,
    });
    assert.equal(parsed.topic, topic);
    assert.equal(parsed.payload.topicVersion, INTEGRATION_TOPIC_VERSION);
  }
});

test("automated negotiation delivery supports a portal-only return path", () => {
  const sample = samples["negotiation.round_requested"];
  const portalOnlyPayload = Object.fromEntries(
    Object.entries(sample.payload).filter(([key]) => key !== "replyTo"),
  );
  const outbox = prepareIntegrationOutboxEvent({
    workspaceId: agreement.workspaceId,
    topic: "negotiation.round_requested",
    aggregateType: sample.aggregateType,
    aggregateId: sample.aggregateId,
    payload: portalOnlyPayload,
  });
  assert.equal("replyTo" in outbox.payload, false);
  assert.equal(outbox.payload.portalUrl, sample.payload.portalUrl);
});

test("the CRM agreement projection is stable, bounded, and excludes non-contract fields", () => {
  assert.deepEqual(crmAgreement, {
    externalKey: "notice:orchid-firm:agreement:4102",
    workspaceId: "orchid-firm",
    agreementId: 4102,
    version: 7,
    party: "Orchid Family Office LLC",
    type: "Investment Management Agreement",
    value: 2_500_000,
    valueMinor: 250_000_025,
    currencyCode: "EUR",
    stage: "Signature",
    owner: "Relationship Manager",
    department: "Wealth Management",
    risk: "High",
    approvalStatus: "Approved",
    signatureStatus: "Sent",
    effectiveDate: "2026-08-15",
    expirationDate: "2027-08-14",
    crm: "Salesforce",
    crmRecord: "006R000000AbCdE",
    updatedAt: now,
  });
  assert.equal(crmAgreementExternalKey("orchid-firm", 4102), crmAgreement.externalKey);
  assert.throws(() => crmAgreementProjection({ ...agreement, party: "x".repeat(201) }));
  assert.throws(() => crmAgreementProjection({ ...agreement, crmRecord: "x".repeat(501) }));
  assert.throws(() => crmAgreementProjection({ ...agreement, valueMinor: undefined }));
  assert.throws(() => crmAgreementProjection({ ...agreement, currencyCode: undefined }));
  assert.deepEqual(
    crmAgreementProjection({
      ...agreement,
      value: 9_000_000_000_001,
      valueMinor: 9_000_000_000_001,
      currencyCode: "JPY",
    }),
    {
      ...crmAgreement,
      value: 9_000_000_000_001,
      valueMinor: 9_000_000_000_001,
      currencyCode: "JPY",
    },
  );
  assert.equal(crmAgreementProjection({
    ...agreement,
    value: 90_000_000_000_000,
    valueMinor: 9_000_000_000_000_000,
    currencyCode: "USD",
  }).valueMinor, 9_000_000_000_000_000);
  assert.throws(() => crmAgreementProjection({
    ...agreement,
    value: 90_000_000_000_001,
    valueMinor: 9_000_000_000_000_000,
    currencyCode: "USD",
  }), /Whole-unit compatibility value/);
});

test("agreement lifecycle helpers produce canonical version-aligned CRM events", () => {
  const updated = prepareAgreementUpdatedIntegrationEvent({
    agreement,
    changedFields: ["signatureStatus", "approvalStatus", "signatureStatus"],
    causationId: "request-lifecycle-update",
  });
  assert.equal(updated.topic, "agreement.updated");
  assert.equal(updated.aggregateType, "agreement");
  assert.equal(updated.aggregateId, String(agreement.id));
  assert.equal(updated.payload.version, agreement.version);
  assert.equal(updated.payload.aggregateVersion, agreement.version);
  assert.deepEqual(updated.payload.changedFields, ["approvalStatus", "signatureStatus"]);
  assert.deepEqual(updated.payload.crmAgreement, crmAgreement);

  assert.equal(prepareAgreementLifecycleUpdatedIntegrationEvent({
    before: agreement,
    agreement: { ...agreement, version: agreement.version + 1 },
    candidateFields: ["approvalStatus", "signatureStatus"],
  }), null);
  const lifecycleUpdate = prepareAgreementLifecycleUpdatedIntegrationEvent({
    before: agreement,
    agreement: { ...agreement, version: agreement.version + 1, signatureStatus: "Partially signed" },
    candidateFields: ["approvalStatus", "signatureStatus", "signatureStatus"],
  });
  assert.ok(lifecycleUpdate);
  assert.equal(lifecycleUpdate.payload.version, agreement.version + 1);
  assert.deepEqual(lifecycleUpdate.payload.changedFields, ["signatureStatus"]);
  assert.equal(lifecycleUpdate.payload.crmAgreement.signatureStatus, "Partially signed");

  const deletedAgreement = { ...agreement, version: agreement.version + 1 };
  const deleted = prepareAgreementDeletedIntegrationEvent({
    agreement: deletedAgreement,
    deletedAt: now,
    causationId: "request-lifecycle-delete",
  });
  assert.equal(deleted.topic, "agreement.deleted");
  assert.equal(deleted.aggregateType, "agreement");
  assert.equal(deleted.aggregateId, String(agreement.id));
  assert.deepEqual(deleted.payload, {
    agreementId: agreement.id,
    version: agreement.version + 1,
    aggregateVersion: agreement.version + 1,
    causationId: "request-lifecycle-delete",
    externalKey: crmAgreement.externalKey,
    tombstone: true,
    deletedAt: now,
    crm: agreement.crm,
    crmRecord: agreement.crmRecord,
    topicVersion: INTEGRATION_TOPIC_VERSION,
  });
});

test("the parser accepts legacy schemaVersion 1.0 payloads and preserves additive fields", () => {
  const sample = samples["agreement.updated"];
  const legacyProjection = { ...crmAgreement } as Record<string, unknown>;
  delete legacyProjection.valueMinor;
  delete legacyProjection.currencyCode;
  const parsed = parseIntegrationEvent({
    id: "legacy-event-1",
    workspaceId: agreement.workspaceId,
    topic: "agreement.updated",
    aggregateType: sample.aggregateType,
    aggregateId: sample.aggregateId,
    payload: {
      ...sample.payload,
      topicVersion: undefined,
      crmAgreement: legacyProjection,
      customerExtension: { mapping: "v2" },
    },
    createdAt: now,
  });
  assert.equal(parsed.payload.topicVersion, INTEGRATION_TOPIC_VERSION);
  assert.deepEqual(parsed.payload.customerExtension, { mapping: "v2" });
  assert.equal(parsed.topic, "agreement.updated");
  if (parsed.topic !== "agreement.updated") return;
  assert.equal(parsed.payload.crmAgreement.valueMinor, agreement.value * 100);
  assert.equal(parsed.payload.crmAgreement.currencyCode, "USD");

  legacyProjection.value = 9_000_000_000_001;
  assert.throws(() => parseIntegrationEvent({
    id: "legacy-event-out-of-range",
    workspaceId: agreement.workspaceId,
    topic: "agreement.updated",
    aggregateType: sample.aggregateType,
    aggregateId: sample.aggregateId,
    payload: { ...sample.payload, crmAgreement: legacyProjection },
    createdAt: now,
  }), /Legacy whole-unit value exceeds/);
});

test("unknown, oversized, and invalid topic payloads fail closed", () => {
  assert.throws(() => prepareIntegrationOutboxEvent({
    workspaceId: agreement.workspaceId,
    topic: "agreement.unknown",
    aggregateType: "agreement",
    aggregateId: String(agreement.id),
    payload: { agreementId: agreement.id },
  }));

  assert.throws(() => prepareIntegrationOutboxEvent({
    workspaceId: agreement.workspaceId,
    topic: "agreement.created",
    aggregateType: "agreement",
    aggregateId: String(agreement.id),
    payload: { agreementId: agreement.id, version: 1 },
  }));

  assert.throws(() => prepareIntegrationOutboxEvent({
    workspaceId: agreement.workspaceId,
    topic: "agreement.created",
    aggregateType: "signature",
    aggregateId: String(agreement.id),
    payload: samples["agreement.created"].payload,
  }));

  assert.throws(() => prepareIntegrationOutboxEvent({
    workspaceId: agreement.workspaceId,
    topic: "agreement.created",
    aggregateType: "agreement",
    aggregateId: String(agreement.id),
    payload: { ...samples["agreement.created"].payload, oversized: "x".repeat(MAX_INTEGRATION_EVENT_PAYLOAD_BYTES) },
  }), RangeError);

  const valid = prepareIntegrationOutboxEvent({
    workspaceId: agreement.workspaceId,
    topic: "agreement.created",
    aggregateType: "agreement",
    aggregateId: String(agreement.id),
    payload: samples["agreement.created"].payload,
  });
  assert.throws(() => parseIntegrationEvent({
    id: "event-invalid-version",
    ...valid,
    payload: { ...valid.payload, topicVersion: "2.0" },
    createdAt: now,
  }));
});

test("CRM routing is an explicit allowlist", () => {
  for (const topic of CRM_INTEGRATION_TOPICS) assert.equal(isCrmIntegrationTopic(topic), true);
  assert.equal(isCrmIntegrationTopic("approval.decided"), false);
  assert.equal(isCrmIntegrationTopic("notification.approval_reminder"), false);
  assert.equal(isCrmIntegrationTopic("negotiation.round_requested"), false);
  assert.equal(isCrmIntegrationTopic("agreement.unknown"), false);
});
