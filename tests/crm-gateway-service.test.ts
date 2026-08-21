import assert from "node:assert/strict";
import test from "node:test";
import { deliverySignatureInput } from "../app/lib/delivery";
import {
  normalizeCrmIntegrationEvent,
  type CanonicalCrmEvent,
} from "../integrations/crm-gateway/src/canonical-event";
import type {
  CanonicalCrmEvent as ProviderCanonicalCrmEvent,
  CrmAdapter,
  CrmUpsertResult,
} from "../integrations/crm-gateway/src/providers/types";
import { CrmProviderError } from "../integrations/crm-gateway/src/providers/types";
import { CrmGatewayOperations, validateOperationsSecret } from "../integrations/crm-gateway/src/operations";
import { assertSuccessfulCrmGatewayScheduledRun } from "../integrations/crm-gateway/src/index";
import type {
  NewReceipt,
  OperationalReceipt,
  ReceiptAcceptance,
  ReceiptClaim,
  ReceiptProfile,
  ReceiptRecord,
  ReceiptStatus,
  ReceiptStore,
} from "../integrations/crm-gateway/src/receipt-store";
import {
  CRM_GATEWAY_MAX_RETRY_MS,
  CrmGatewayService,
  type WaitUntilContext,
} from "../integrations/crm-gateway/src/service";

const ingressSecret = "crm-gateway-ingress-secret-at-least-32-characters";
const initialNow = "2026-08-02T12:00:00.000Z";
type CrmSelection = "Salesforce" | "HubSpot" | "Custom CRM" | "None";

test("scheduled gateway runs reject partial or malformed completion signals", () => {
  const complete = Object.freeze({ examined: 3, processingErrors: 0 });
  assert.equal(assertSuccessfulCrmGatewayScheduledRun(complete), complete);
  assert.throws(
    () => assertSuccessfulCrmGatewayScheduledRun({ examined: 3, processingErrors: 1 }),
    /left processing errors/,
  );
  for (const malformed of [
    { examined: -1, processingErrors: 0 },
    { examined: 1, processingErrors: 2 },
    { examined: 1.5, processingErrors: 0 },
  ]) {
    assert.throws(() => assertSuccessfulCrmGatewayScheduledRun(malformed), /result is invalid/);
  }
});

const agreement = Object.freeze({
  externalKey: "notice:orchid-firm:agreement:4102",
  workspaceId: "orchid-firm",
  agreementId: 4102,
  version: 7,
  party: "Orchid Family Office LLC",
  type: "Investment Management Agreement",
  value: 2_500_000,
  stage: "Signature",
  owner: "Relationship Manager",
  department: "Wealth Management",
  risk: "High",
  approvalStatus: "Approved",
  signatureStatus: "Sent",
  effectiveDate: "2026-08-15",
  expirationDate: "2027-08-14",
  crm: "HubSpot" as CrmSelection,
  crmRecord: "006R000000AbCdE",
  updatedAt: initialNow,
});

const canonicalAgreement = Object.freeze({
  ...agreement,
  valueMinor: agreement.value * 100,
  currencyCode: "USD",
});

function sourceUpsert(overrides: {
  id?: string;
  version?: number;
  topic?: "agreement.created" | "agreement.updated" | "agreement.stage_changed" | "signature.completed";
  party?: string;
  crm?: CrmSelection;
} = {}): Record<string, unknown> {
  const version = overrides.version ?? agreement.version;
  const topic = overrides.topic ?? "agreement.updated";
  const projection = {
    ...agreement,
    version,
    party: overrides.party ?? agreement.party,
    crm: overrides.crm ?? agreement.crm,
  };
  const payloadByTopic = {
    "agreement.created": { agreementId: 4102, version, documentVersion: 1, aggregateVersion: version, crmAgreement: projection },
    "agreement.updated": { agreementId: 4102, version, changedFields: ["owner"], aggregateVersion: version, crmAgreement: projection },
    "agreement.stage_changed": { agreementId: 4102, from: "Negotiation", to: "Signature", version, aggregateVersion: version, crmAgreement: projection },
    "signature.completed": {
      packetId: "packet-1",
      agreementId: 4102,
      provider: "docuseal",
      submissionId: "submission-1",
      status: "completed",
      activated: true,
      documentVersion: 3,
      documentSha256: "a".repeat(64),
      evidenceDocumentId: "document-1",
      aggregateVersion: 4,
      crmAgreement: projection,
    },
  } as const;
  return {
    id: overrides.id ?? "event-upsert-1",
    workspaceId: "orchid-firm",
    topic,
    aggregateType: topic === "signature.completed" ? "signature" : "agreement",
    aggregateId: topic === "signature.completed" ? "packet-1" : "4102",
    payload: payloadByTopic[topic],
    createdAt: initialNow,
  };
}

function sourceDelete(id = "event-delete-1", version = 8, crm: CrmSelection = agreement.crm): Record<string, unknown> {
  return {
    id,
    workspaceId: "orchid-firm",
    topic: "agreement.deleted",
    aggregateType: "agreement",
    aggregateId: "4102",
    payload: {
      agreementId: 4102,
      version,
      aggregateVersion: version,
      externalKey: agreement.externalKey,
      tombstone: true,
      deletedAt: initialNow,
      crm,
      crmRecord: agreement.crmRecord,
    },
    createdAt: initialNow,
  };
}

function sourceConnectionTest(): Record<string, unknown> {
  return {
    id: "connection-event-1",
    workspaceId: "__connection_test__",
    topic: "integration.crm.connection_test",
    aggregateType: "system",
    aggregateId: "connection-event-1",
    payload: { dryRun: true, channel: "crm" },
    createdAt: initialNow,
  };
}

test("canonical CRM events carry the complete authoritative projection and deletion tombstone", () => {
  for (const topic of ["agreement.created", "agreement.updated", "agreement.stage_changed", "signature.completed"] as const) {
    const normalized = normalizeCrmIntegrationEvent(sourceUpsert({ topic }));
    assert.equal(normalized.kind, "mutation");
    if (normalized.kind !== "mutation") continue;
    assert.equal(normalized.event.operation, "upsert");
    if (normalized.event.operation !== "upsert") continue;
    assert.deepEqual(normalized.event.agreement, canonicalAgreement);
    assert.equal(normalized.event.aggregateVersion, agreement.version);
  }

  const deleted = normalizeCrmIntegrationEvent(sourceDelete());
  assert.equal(deleted.kind, "mutation");
  if (deleted.kind !== "mutation" || deleted.event.operation !== "delete") return;
  assert.deepEqual(deleted.event.tombstone, {
    externalKey: agreement.externalKey,
    workspaceId: agreement.workspaceId,
    agreementId: agreement.agreementId,
    version: 8,
    deletedAt: initialNow,
    crm: agreement.crm,
    crmRecord: agreement.crmRecord,
  });

  const nonCrm = { ...sourceUpsert(), topic: "approval.decided", aggregateType: "approval", aggregateId: "approval-1" };
  assert.throws(() => normalizeCrmIntegrationEvent(nonCrm));
  const mismatched = sourceUpsert();
  const payload = mismatched.payload as Record<string, unknown>;
  assert.throws(() => normalizeCrmIntegrationEvent({
    ...mismatched,
    payload: { ...payload, crmAgreement: { ...(payload.crmAgreement as object), workspaceId: "other" } },
  }));
});

test("authenticated connection tests exercise the provider without persisting or mutating", async () => {
  const store = new MemoryReceiptStore();
  const adapter = new FakeAdapter();
  const clock = new MutableClock(initialNow);
  const { service, background } = harness(store, adapter, clock);
  const response = await service.handleEvent(
    await signedRequest(sourceConnectionTest(), clock.date(), true),
    background.context,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    dryRun: true,
    provider: "hubspot",
    mappingVersion: "mapping-v1",
  });
  assert.equal(adapter.connectionTests, 1);
  assert.equal(adapter.calls.length, 0);
  assert.equal(store.acceptCalls, 0);
  assert.equal(background.promises.length, 0);
});

test("signed provider and mapping identity must match the deployed gateway profile", async () => {
  const store = new MemoryReceiptStore();
  const adapter = new FakeAdapter();
  const clock = new MutableClock(initialNow);
  const { service, background } = harness(store, adapter, clock);
  for (const profile of [
    { provider: "salesforce", mappingVersion: "mapping-v1" },
    { provider: "hubspot", mappingVersion: "mapping-v2" },
  ] as const) {
    const response = await service.handleEvent(
      await signedRequest(sourceConnectionTest(), clock.date(), true, profile),
      background.context,
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: { code: "crm_profile_mismatch" } });
  }
  assert.equal(adapter.connectionTests, 0);
  assert.equal(store.acceptCalls, 0);
});

test("signed CRM mutations must target the deployed provider before receipt or provider side effects", async () => {
  const store = new MemoryReceiptStore();
  const adapter = new FakeAdapter();
  const clock = new MutableClock(initialNow);
  const { service, background } = harness(store, adapter, clock);
  const missingUpsert = sourceUpsert({ id: "missing-upsert-target" });
  const missingUpsertPayload = missingUpsert.payload as Record<string, unknown>;
  const missingProjection = { ...(missingUpsertPayload.crmAgreement as Record<string, unknown>) };
  delete missingProjection.crm;
  missingUpsert.payload = { ...missingUpsertPayload, crmAgreement: missingProjection };
  const missingDelete = sourceDelete("missing-delete-target");
  delete (missingDelete.payload as Record<string, unknown>).crm;

  const cases = [
    { event: sourceUpsert({ id: "none-upsert-target", crm: "None" }), code: "crm_target_not_configured" },
    { event: sourceUpsert({ id: "wrong-upsert-target", crm: "Salesforce" }), code: "crm_target_mismatch" },
    { event: sourceDelete("none-delete-target", 8, "None"), code: "crm_target_not_configured" },
    { event: sourceDelete("wrong-delete-target", 8, "Custom CRM"), code: "crm_target_mismatch" },
    { event: missingUpsert, code: "invalid_event" },
    { event: missingDelete, code: "invalid_event" },
  ];

  for (const { event, code } of cases) {
    const response = await service.handleEvent(await signedRequest(event, clock.date()), background.context);
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: { code } });
  }
  assert.equal(store.acceptCalls, 0);
  assert.equal(adapter.calls.length, 0);
  assert.equal(background.promises.length, 0);
});

test("a receipt is durable before 202 and identical delivery is idempotent", async () => {
  const store = new MemoryReceiptStore();
  const adapter = new FakeAdapter();
  const clock = new MutableClock(initialNow);
  const { service, background } = harness(store, adapter, clock);
  const event = sourceUpsert();
  const request = await signedRequest(event, clock.date());

  const accepted = await service.handleEvent(request, background.context);
  assert.equal(accepted.status, 202);
  assert.equal(store.acceptCalls, 1);
  assert.ok(store.getSync("orchid-firm", "event-upsert-1"));
  await background.drain();
  assert.equal(store.getSync("orchid-firm", "event-upsert-1")?.status, "succeeded");
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(adapter.calls[0]?.projection, canonicalAgreement);

  const duplicate = await service.handleEvent(await signedRequest(event, clock.date()), background.context);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { status: "duplicate" });
  await background.drain();
  assert.equal(adapter.calls.length, 1);
});

test("an event ID with a different digest is quarantined and returns a redacted conflict", async () => {
  const store = new MemoryReceiptStore();
  const adapter = new FakeAdapter();
  const clock = new MutableClock(initialNow);
  const { service, background } = harness(store, adapter, clock);
  await service.handleEvent(await signedRequest(sourceUpsert(), clock.date()), background.context);

  const collision = await service.handleEvent(
    await signedRequest(sourceUpsert({ party: "Sensitive changed party" }), clock.date()),
    background.context,
  );
  assert.equal(collision.status, 409);
  const responseBody = JSON.stringify(await collision.json());
  assert.equal(responseBody.includes("Sensitive changed party"), false);
  assert.equal(responseBody.includes(ingressSecret), false);
  assert.equal(store.getSync("orchid-firm", "event-upsert-1")?.status, "quarantined");
});

test("an existing event ID under a changed provider profile returns a profile conflict without mutating prior success", async () => {
  const store = new MemoryReceiptStore();
  const clock = new MutableClock(initialNow);
  const first = harness(store, new FakeAdapter(), clock);
  await first.service.handleEvent(await signedRequest(sourceUpsert(), clock.date()), first.background.context);
  await first.background.drain();
  assert.equal(store.getSync("orchid-firm", "event-upsert-1")?.status, "succeeded");

  const background = new BackgroundWork();
  const changedProfile = new CrmGatewayService({
    ingressSecrets: [ingressSecret],
    mappingVersion: "mapping-v2",
    store,
    adapter: new FakeAdapter(),
    now: clock.date,
  });
  const response = await changedProfile.handleEvent(
    await signedRequest(sourceUpsert(), clock.date(), false, {
      provider: "hubspot",
      mappingVersion: "mapping-v2",
    }),
    background.context,
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: { code: "event_profile_conflict" } });
  assert.equal(store.getSync("orchid-firm", "event-upsert-1")?.status, "succeeded");
  assert.equal(background.promises.length, 0);
});

test("retryable provider failures honor bounded Retry-After and later complete", async () => {
  const store = new MemoryReceiptStore();
  const adapter = new FakeAdapter([
    new CrmProviderError("CRM_PROVIDER_RATE_LIMITED", true, 24 * 60 * 60_000),
  ]);
  const clock = new MutableClock(initialNow);
  const { service, background } = harness(store, adapter, clock);
  await service.handleEvent(await signedRequest(sourceUpsert(), clock.date()), background.context);
  await background.drain();

  const failed = store.getSync("orchid-firm", "event-upsert-1");
  assert.equal(failed?.status, "retry");
  assert.equal(failed?.lastErrorCode, "crm_provider_rate_limited");
  assert.equal(
    Date.parse(failed?.availableAt ?? "") - clock.date().getTime(),
    CRM_GATEWAY_MAX_RETRY_MS,
  );

  clock.advance(CRM_GATEWAY_MAX_RETRY_MS);
  const scheduled = await service.runScheduled();
  assert.deepEqual(scheduled, { examined: 1, processingErrors: 0 });
  assert.equal(store.getSync("orchid-firm", "event-upsert-1")?.status, "succeeded");
  assert.equal(adapter.calls.length, 2);
});

test("permanent failures and exhausted retries become dead receipts", async () => {
  const permanentStore = new MemoryReceiptStore();
  const permanentAdapter = new FakeAdapter([
    new CrmProviderError("CRM_PROVIDER_REJECTED", false),
  ]);
  const permanentClock = new MutableClock(initialNow);
  const permanent = harness(permanentStore, permanentAdapter, permanentClock);
  await permanent.service.handleEvent(await signedRequest(sourceUpsert(), permanentClock.date()), permanent.background.context);
  await permanent.background.drain();
  assert.equal(permanentStore.getSync("orchid-firm", "event-upsert-1")?.status, "dead");

  const retryStore = new MemoryReceiptStore();
  const retryAdapter = new FakeAdapter([
    new CrmProviderError("CRM_PROVIDER_UNAVAILABLE", true),
    new CrmProviderError("CRM_PROVIDER_UNAVAILABLE", true),
  ]);
  const retryClock = new MutableClock(initialNow);
  const retry = harness(retryStore, retryAdapter, retryClock, { maxAttempts: 2, baseRetryMs: 1_000, maxRetryMs: 1_000 });
  await retry.service.handleEvent(await signedRequest(sourceUpsert(), retryClock.date()), retry.background.context);
  await retry.background.drain();
  retryClock.advance(1_000);
  await retry.service.runScheduled();
  assert.equal(retryStore.getSync("orchid-firm", "event-upsert-1")?.status, "dead");
  assert.equal(retryAdapter.calls.length, 2);
});

test("aggregate version claims fence stale events before provider mutation", async () => {
  const store = new MemoryReceiptStore();
  const adapter = new FakeAdapter();
  const clock = new MutableClock(initialNow);
  const { service, background } = harness(store, adapter, clock);

  await service.handleEvent(
    await signedRequest(sourceUpsert({ id: "event-v8", version: 8 }), clock.date()),
    background.context,
  );
  await background.drain();
  await service.handleEvent(
    await signedRequest(sourceUpsert({ id: "event-v7", version: 7 }), clock.date()),
    background.context,
  );
  await background.drain();

  assert.equal(store.getSync("orchid-firm", "event-v8")?.status, "succeeded");
  assert.equal(store.getSync("orchid-firm", "event-v7")?.status, "superseded");
  assert.deepEqual(adapter.calls.map(({ aggregateVersion }) => aggregateVersion), [8]);
});

test("an accepted higher version waits for the lower in-flight provider call in the same profile", async () => {
  const store = new MemoryReceiptStore();
  const adapter = new BlockingFirstAdapter();
  const clock = new MutableClock(initialNow);
  const service = new CrmGatewayService({
    ingressSecrets: [ingressSecret],
    mappingVersion: "mapping-v1",
    store,
    adapter,
    now: clock.date,
  });
  const lowerBackground = new BackgroundWork();
  const higherBackground = new BackgroundWork();

  assert.equal((await service.handleEvent(
    await signedRequest(sourceUpsert({ id: "in-flight-v7", version: 7 }), clock.date()),
    lowerBackground.context,
  )).status, 202);
  await adapter.firstCallStarted;

  assert.equal((await service.handleEvent(
    await signedRequest(sourceUpsert({ id: "accepted-while-v7-runs-v8", version: 8 }), clock.date()),
    higherBackground.context,
  )).status, 202);
  await higherBackground.drain();
  assert.deepEqual(adapter.calls.map(({ aggregateVersion }) => aggregateVersion), [7]);
  assert.equal(store.getSync("orchid-firm", "accepted-while-v7-runs-v8")?.status, "received");

  adapter.releaseFirstCall();
  await lowerBackground.drain();
  assert.equal(store.getSync("orchid-firm", "in-flight-v7")?.status, "succeeded");
  assert.deepEqual(await service.runScheduled(), { examined: 1, processingErrors: 0 });
  assert.equal(store.getSync("orchid-firm", "accepted-while-v7-runs-v8")?.status, "succeeded");
  assert.deepEqual(adapter.calls.map(({ aggregateVersion }) => aggregateVersion), [7, 8]);
});

test("a mapping cutover preserves same-version mutations and stale fencing within each exact profile", async () => {
  const store = new MemoryReceiptStore();
  const clock = new MutableClock(initialNow);
  const oldAdapter = new FakeAdapter();
  const newAdapter = new FakeAdapter();
  const oldBackground = new BackgroundWork();
  const newBackground = new BackgroundWork();
  const oldDeployment = new CrmGatewayService({
    ingressSecrets: [ingressSecret],
    mappingVersion: "mapping-v1",
    store,
    adapter: oldAdapter,
    now: clock.date,
  });
  const newDeployment = new CrmGatewayService({
    ingressSecrets: [ingressSecret],
    mappingVersion: "mapping-v2",
    store,
    adapter: newAdapter,
    now: clock.date,
  });

  const newProjection = sourceUpsert({ id: "new-profile-projection-v20", version: 20 });
  assert.equal((await newDeployment.handleEvent(
    await signedRequest(newProjection, clock.date(), false, {
      provider: "hubspot",
      mappingVersion: "mapping-v2",
    }),
    newBackground.context,
  )).status, 202);
  await newBackground.drain();

  const oldTombstone = sourceDelete("old-profile-tombstone-v20", 20);
  assert.equal((await oldDeployment.handleEvent(
    await signedRequest(oldTombstone, clock.date()),
    oldBackground.context,
  )).status, 202);
  await oldBackground.drain();

  assert.equal(store.getSync("orchid-firm", "new-profile-projection-v20")?.status, "succeeded");
  assert.equal(store.getSync("orchid-firm", "old-profile-tombstone-v20")?.status, "succeeded");
  assert.deepEqual(newAdapter.calls.map(({ aggregateVersion, deleted, mappingVersion }) => ({
    aggregateVersion,
    deleted,
    mappingVersion,
  })), [{ aggregateVersion: 20, deleted: false, mappingVersion: "mapping-v2" }]);
  assert.deepEqual(oldAdapter.calls.map(({ aggregateVersion, deleted, mappingVersion }) => ({
    aggregateVersion,
    deleted,
    mappingVersion,
  })), [{ aggregateVersion: 20, deleted: true, mappingVersion: "mapping-v1" }]);

  assert.equal((await oldDeployment.handleEvent(
    await signedRequest(sourceDelete("old-profile-stale-v19", 19), clock.date()),
    oldBackground.context,
  )).status, 202);
  assert.equal((await newDeployment.handleEvent(
    await signedRequest(
      sourceUpsert({ id: "new-profile-stale-v19", version: 19 }),
      clock.date(),
      false,
      { provider: "hubspot", mappingVersion: "mapping-v2" },
    ),
    newBackground.context,
  )).status, 202);
  await Promise.all([oldBackground.drain(), newBackground.drain()]);

  assert.equal(store.getSync("orchid-firm", "old-profile-stale-v19")?.status, "superseded");
  assert.equal(store.getSync("orchid-firm", "new-profile-stale-v19")?.status, "superseded");
  assert.equal(oldAdapter.calls.length, 1);
  assert.equal(newAdapter.calls.length, 1);
});

test("scheduled delivery and operations views cannot cross the configured mapping profile", async () => {
  const store = new MemoryReceiptStore();
  const clock = new MutableClock(initialNow);
  const oldAdapter = new FakeAdapter();
  const newAdapter = new FakeAdapter();
  const oldDeployment = new CrmGatewayService({
    ingressSecrets: [ingressSecret],
    mappingVersion: "mapping-v1",
    store,
    adapter: oldAdapter,
    now: clock.date,
  });
  const newDeployment = new CrmGatewayService({
    ingressSecrets: [ingressSecret],
    mappingVersion: "mapping-v2",
    store,
    adapter: newAdapter,
    now: clock.date,
  });
  const oldCanonical = normalizeCrmIntegrationEvent(sourceUpsert({ id: "scheduled-old-profile-v22", version: 22 }));
  const newCanonical = normalizeCrmIntegrationEvent(sourceUpsert({ id: "scheduled-new-profile-v22", version: 22 }));
  assert.equal(oldCanonical.kind, "mutation");
  assert.equal(newCanonical.kind, "mutation");
  if (oldCanonical.kind !== "mutation" || newCanonical.kind !== "mutation") return;
  store.seed(receiptFromCanonical(oldCanonical.event, { status: "retry", mappingVersion: "mapping-v1" }));
  store.seed(receiptFromCanonical(newCanonical.event, { status: "retry", mappingVersion: "mapping-v2" }));

  assert.deepEqual(await newDeployment.runScheduled(), { examined: 1, processingErrors: 0 });
  assert.equal(store.getSync("orchid-firm", "scheduled-new-profile-v22")?.status, "succeeded");
  assert.equal(store.getSync("orchid-firm", "scheduled-old-profile-v22")?.status, "retry");
  assert.deepEqual(newAdapter.calls.map(({ mappingVersion }) => mappingVersion), ["mapping-v2"]);
  assert.equal(oldAdapter.calls.length, 0);

  const operationsSecret = "crm-operations-secret-at-least-32-characters";
  const newOperations = new CrmGatewayOperations({
    secret: operationsSecret,
    provider: "hubspot",
    mappingVersion: "mapping-v2",
    store,
  });
  const oldOperations = new CrmGatewayOperations({
    secret: operationsSecret,
    provider: "hubspot",
    mappingVersion: "mapping-v1",
    store,
  });
  const listRetry = (operations: CrmGatewayOperations) => operations.handle(new Request(
    "https://gateway.invalid/v1/operations/receipts?status=retry",
    { headers: { authorization: `Bearer ${operationsSecret}` } },
  ));
  assert.deepEqual(await (await listRetry(newOperations)).json(), { receipts: [] });
  const oldListing = await (await listRetry(oldOperations)).json() as { receipts: OperationalReceipt[] };
  assert.deepEqual(oldListing.receipts.map(({ eventId }) => eventId), ["scheduled-old-profile-v22"]);

  assert.deepEqual(await oldDeployment.runScheduled(), { examined: 1, processingErrors: 0 });
  assert.equal(store.getSync("orchid-firm", "scheduled-old-profile-v22")?.status, "succeeded");
  assert.deepEqual(oldAdapter.calls.map(({ mappingVersion }) => mappingVersion), ["mapping-v1"]);
});

test("a newer ambiguous provider success with a lost response fences older events while its exact retry remains eligible", async () => {
  const store = new MemoryReceiptStore();
  // FakeAdapter records the provider mutation before throwing, modeling the
  // ambiguous boundary where the provider may have committed but its response
  // was lost in transit.
  const adapter = new FakeAdapter([new CrmProviderError("CRM_PROVIDER_UNAVAILABLE", true)]);
  const clock = new MutableClock(initialNow);
  const { service, background } = harness(store, adapter, clock, {
    baseRetryMs: 1_000,
    maxRetryMs: 1_000,
  });

  await service.handleEvent(
    await signedRequest(sourceUpsert({ id: "ambiguous-v9", version: 9 }), clock.date()),
    background.context,
  );
  await background.drain();
  assert.equal(store.getSync("orchid-firm", "ambiguous-v9")?.status, "retry");

  await service.handleEvent(
    await signedRequest(sourceUpsert({ id: "stale-v8", version: 8 }), clock.date()),
    background.context,
  );
  await background.drain();
  assert.equal(store.getSync("orchid-firm", "stale-v8")?.status, "superseded");
  assert.deepEqual(adapter.calls.map(({ aggregateVersion }) => aggregateVersion), [9]);

  clock.advance(1_000);
  assert.deepEqual(await service.runScheduled(), { examined: 1, processingErrors: 0 });
  assert.equal(store.getSync("orchid-firm", "ambiguous-v9")?.status, "succeeded");
  assert.deepEqual(adapter.calls.map(({ aggregateVersion }) => aggregateVersion), [9, 9]);
});

test("a newer dead receipt fences older events and can itself be explicitly requeued", async () => {
  const store = new MemoryReceiptStore();
  const adapter = new FakeAdapter([new CrmProviderError("CRM_PROVIDER_REJECTED", false)]);
  const clock = new MutableClock(initialNow);
  const { service, background } = harness(store, adapter, clock);

  await service.handleEvent(
    await signedRequest(sourceUpsert({ id: "dead-v11", version: 11 }), clock.date()),
    background.context,
  );
  await background.drain();
  assert.equal(store.getSync("orchid-firm", "dead-v11")?.status, "dead");

  await service.handleEvent(
    await signedRequest(sourceUpsert({ id: "stale-v10", version: 10 }), clock.date()),
    background.context,
  );
  await background.drain();
  assert.equal(store.getSync("orchid-firm", "stale-v10")?.status, "superseded");
  assert.deepEqual(adapter.calls.map(({ aggregateVersion }) => aggregateVersion), [11]);

  assert.deepEqual(await store.requeueDead({
    workspaceId: "orchid-firm",
    eventId: "dead-v11",
    provider: "hubspot",
    mappingVersion: "mapping-v1",
    now: clock.date().toISOString(),
  }), { kind: "requeued" });
  assert.deepEqual(await service.runScheduled(), { examined: 1, processingErrors: 0 });
  assert.equal(store.getSync("orchid-firm", "dead-v11")?.status, "succeeded");
  assert.deepEqual(adapter.calls.map(({ aggregateVersion }) => aggregateVersion), [11, 11]);
});

test("pending receipts cannot silently cross provider mapping versions", async () => {
  const store = new MemoryReceiptStore();
  const adapter = new FakeAdapter();
  const clock = new MutableClock(initialNow);
  const { service } = harness(store, adapter, clock);
  const normalized = normalizeCrmIntegrationEvent(sourceUpsert({ id: "old-mapping-event" }));
  assert.equal(normalized.kind, "mutation");
  if (normalized.kind !== "mutation") return;
  const receipt = receiptFromCanonical(normalized.event, { mappingVersion: "mapping-v0" });
  store.seed(receipt);

  await service.processReceipt(receipt);
  assert.equal(store.getSync("orchid-firm", "old-mapping-event")?.status, "dead");
  assert.equal(store.getSync("orchid-firm", "old-mapping-event")?.lastErrorCode, "mapping_configuration_changed");
  assert.equal(adapter.calls.length, 0);
});

test("persisted receipts cannot cross their payload target before provider mutation", async () => {
  const store = new MemoryReceiptStore();
  const adapter = new FakeAdapter();
  const clock = new MutableClock(initialNow);
  const { service } = harness(store, adapter, clock);
  const normalized = normalizeCrmIntegrationEvent(sourceUpsert({
    id: "wrong-target-receipt",
    crm: "Salesforce",
  }));
  assert.equal(normalized.kind, "mutation");
  if (normalized.kind !== "mutation") return;
  const receipt = receiptFromCanonical(normalized.event);
  store.seed(receipt);

  await service.processReceipt(receipt);
  assert.equal(store.getSync("orchid-firm", "wrong-target-receipt")?.status, "dead");
  assert.equal(store.getSync("orchid-firm", "wrong-target-receipt")?.lastErrorCode, "receipt_target_mismatch");
  assert.equal(adapter.calls.length, 0);
});

test("scheduled work recovers stale leases, processes due receipts, redacts payloads, and prunes old metadata", async () => {
  const store = new MemoryReceiptStore();
  const adapter = new FakeAdapter();
  const clock = new MutableClock(initialNow);
  const { service } = harness(store, adapter, clock, {
    terminalPayloadRetentionMs: 24 * 60 * 60_000,
    terminalMetadataRetentionMs: 60 * 24 * 60 * 60_000,
  });
  const canonical = normalizeCrmIntegrationEvent(sourceUpsert({ id: "stale-event", version: 9 }));
  const oldCompleteCanonical = normalizeCrmIntegrationEvent(sourceUpsert({ id: "old-complete", version: 8 }));
  const oldRedactedCanonical = normalizeCrmIntegrationEvent(sourceUpsert({ id: "old-redacted", version: 7 }));
  assert.equal(canonical.kind, "mutation");
  assert.equal(oldCompleteCanonical.kind, "mutation");
  assert.equal(oldRedactedCanonical.kind, "mutation");
  if (
    canonical.kind !== "mutation"
    || oldCompleteCanonical.kind !== "mutation"
    || oldRedactedCanonical.kind !== "mutation"
  ) return;
  store.seed(receiptFromCanonical(canonical.event, {
    status: "processing",
    lockedAt: "2026-08-02T11:54:59.000Z",
    leaseToken: "old-lease",
  }));
  store.seed(receiptFromCanonical(oldCompleteCanonical.event, {
    status: "succeeded",
    completedAt: "2026-07-01T00:00:00.000Z",
  }));
  store.seed(receiptFromCanonical(oldRedactedCanonical.event, {
    status: "dead",
    eventJson: "",
    completedAt: "2026-05-01T00:00:00.000Z",
    payloadRedactedAt: "2026-07-01T00:00:00.000Z",
  }));

  const result = await service.runScheduled();
  assert.deepEqual(result, { examined: 1, processingErrors: 0 });
  assert.equal(store.recoverCalls, 1);
  assert.equal(store.getSync("orchid-firm", "stale-event")?.status, "succeeded");
  assert.equal(store.getSync("orchid-firm", "old-complete")?.eventJson, "");
  assert.equal(store.getSync("orchid-firm", "old-complete")?.payloadRedactedAt, initialNow);
  assert.equal(store.getSync("orchid-firm", "old-redacted"), null);
});

test("request and event validation errors never echo secrets or inbound bodies", async () => {
  const store = new MemoryReceiptStore();
  const adapter = new FakeAdapter();
  const clock = new MutableClock(initialNow);
  const { service, background } = harness(store, adapter, clock);
  const event = sourceUpsert({ party: "DO-NOT-ECHO-CUSTOMER-DATA" });
  const request = await signedRequest(event, clock.date());
  request.headers.set("x-notice-signature", `sha256=${"0".repeat(64)}`);
  const response = await service.handleEvent(request, background.context);
  const body = JSON.stringify(await response.json());
  assert.equal(response.status, 401);
  assert.equal(body.includes("DO-NOT-ECHO-CUSTOMER-DATA"), false);
  assert.equal(body.includes(ingressSecret), false);
  assert.deepEqual(JSON.parse(body), { error: { code: "signature" } });
});

test("chunked ingress is rejected as soon as it exceeds the bounded body limit", async () => {
  const store = new MemoryReceiptStore();
  const adapter = new FakeAdapter();
  const clock = new MutableClock(initialNow);
  const { service, background } = harness(store, adapter, clock);
  const chunk = new Uint8Array(65_537).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const request = new Request("https://crm-gateway.test.invalid/v1/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-notice-event-id": "oversized-event",
      "x-notice-timestamp": String(Math.floor(clock.date().getTime() / 1_000)),
      "x-notice-signature": `sha256=${"0".repeat(64)}`,
    },
    body: stream,
    duplex: "half",
  } as RequestInit);

  const response = await service.handleEvent(request, background.context);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: { code: "body_too_large" } });
  assert.equal(store.acceptCalls, 0);
  assert.equal(adapter.calls.length, 0);
});

test("operations listing requires a strong bearer secret and never returns payloads or internal identifiers", async () => {
  const store = new MemoryReceiptStore();
  const canonical = normalizeCrmIntegrationEvent(sourceUpsert({ id: "dead-sensitive" }));
  assert.equal(canonical.kind, "mutation");
  if (canonical.kind !== "mutation") return;
  store.seed(receiptFromCanonical(canonical.event, {
    status: "dead",
    attempts: 8,
    lastErrorCode: "crm_provider_rejected",
    providerRecordId: "provider-sensitive-record-id",
    eventJson: JSON.stringify({ customer: "DO-NOT-RETURN-PAYLOAD" }),
    completedAt: initialNow,
  }));
  const secret = "crm-operations-secret-at-least-32-characters";
  const operations = new CrmGatewayOperations({
    secret,
    provider: "hubspot",
    mappingVersion: "mapping-v1",
    store,
  });

  assert.throws(() => validateOperationsSecret("too-short"));
  const unauthorized = await operations.handle(new Request("https://gateway.invalid/v1/operations/receipts"));
  assert.equal(unauthorized.status, 401);
  const response = await operations.handle(new Request("https://gateway.invalid/v1/operations/receipts?status=dead&limit=10", {
    headers: { authorization: `Bearer ${secret}` },
  }));
  assert.equal(response.status, 200);
  const serialized = JSON.stringify(await response.json());
  assert.equal(serialized.includes("DO-NOT-RETURN-PAYLOAD"), false);
  assert.equal(serialized.includes("provider-sensitive-record-id"), false);
  assert.equal(serialized.includes("a".repeat(64)), false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('"eventId":"dead-sensitive"'), true);
});

test("operations requeue is dead-only and refuses redacted, quarantined, and profile-mismatched receipts", async () => {
  const store = new MemoryReceiptStore();
  const canonical = normalizeCrmIntegrationEvent(sourceUpsert({ id: "requeue-base" }));
  assert.equal(canonical.kind, "mutation");
  if (canonical.kind !== "mutation") return;
  store.seed(receiptFromCanonical({ ...canonical.event, eventId: "dead-ready" }, { status: "dead", completedAt: initialNow }));
  store.seed(receiptFromCanonical({ ...canonical.event, eventId: "quarantined" }, { status: "quarantined", completedAt: initialNow }));
  store.seed(receiptFromCanonical({ ...canonical.event, eventId: "redacted" }, {
    status: "dead",
    eventJson: "",
    payloadRedactedAt: initialNow,
    completedAt: initialNow,
  }));
  store.seed(receiptFromCanonical({ ...canonical.event, eventId: "old-profile" }, {
    status: "dead",
    mappingVersion: "mapping-v0",
    completedAt: initialNow,
  }));
  const secret = "crm-operations-secret-at-least-32-characters";
  const operations = new CrmGatewayOperations({
    secret,
    provider: "hubspot",
    mappingVersion: "mapping-v1",
    store,
    now: () => new Date(initialNow),
  });
  const call = (eventId: string, body: Record<string, unknown> = { workspaceId: "orchid-firm", eventId }) => operations.handle(
    new Request("https://gateway.invalid/v1/operations/requeue", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  assert.equal((await call("dead-ready")).status, 202);
  assert.equal(store.getSync("orchid-firm", "dead-ready")?.status, "retry");
  assert.deepEqual(await (await call("quarantined")).json(), { error: { code: "receipt_not_dead" } });
  assert.deepEqual(await (await call("redacted")).json(), { error: { code: "receipt_payload_redacted" } });
  assert.deepEqual(await (await call("old-profile")).json(), { error: { code: "receipt_profile_mismatch" } });
  assert.equal((await call("missing")).status, 404);
  assert.equal((await call("dead-ready", { workspaceId: "orchid-firm", eventId: "dead-ready", payload: "forbidden" })).status, 400);
});

class FakeAdapter implements CrmAdapter {
  readonly provider = "hubspot" as const;
  readonly calls: ProviderCanonicalCrmEvent[] = [];
  connectionTests = 0;

  constructor(private readonly failures: unknown[] = []) {}

  async upsert(event: ProviderCanonicalCrmEvent): Promise<CrmUpsertResult> {
    this.calls.push(event);
    const failure = this.failures.shift();
    if (failure) throw failure;
    return { providerRecordId: `provider-${event.externalKey}` };
  }

  async testConnection(): Promise<void> {
    this.connectionTests += 1;
  }
}

class BlockingFirstAdapter implements CrmAdapter {
  readonly provider = "hubspot" as const;
  readonly calls: ProviderCanonicalCrmEvent[] = [];
  private resolveStarted: (() => void) | null = null;
  private resolveRelease: (() => void) | null = null;
  readonly firstCallStarted = new Promise<void>((resolve) => { this.resolveStarted = resolve; });
  private readonly firstCallRelease = new Promise<void>((resolve) => { this.resolveRelease = resolve; });

  async upsert(event: ProviderCanonicalCrmEvent): Promise<CrmUpsertResult> {
    this.calls.push(event);
    if (this.calls.length === 1) {
      this.resolveStarted?.();
      await this.firstCallRelease;
    }
    return { providerRecordId: `provider-${event.externalKey}` };
  }

  async testConnection(): Promise<void> {}

  releaseFirstCall(): void {
    this.resolveRelease?.();
  }
}

class MutableClock {
  private milliseconds: number;

  constructor(value: string) {
    this.milliseconds = Date.parse(value);
  }

  date = (): Date => new Date(this.milliseconds);

  advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }
}

class BackgroundWork {
  promises: Promise<unknown>[] = [];
  readonly context: WaitUntilContext = {
    waitUntil: (promise) => { this.promises.push(promise); },
  };

  async drain(): Promise<void> {
    const current = this.promises.splice(0);
    await Promise.all(current);
  }
}

function harness(
  store: MemoryReceiptStore,
  adapter: FakeAdapter,
  clock: MutableClock,
  overrides: Partial<{
    maxAttempts: number;
    baseRetryMs: number;
    maxRetryMs: number;
    terminalPayloadRetentionMs: number;
    terminalMetadataRetentionMs: number;
  }> = {},
): { service: CrmGatewayService; background: BackgroundWork } {
  const background = new BackgroundWork();
  return {
    service: new CrmGatewayService({
      ingressSecrets: [ingressSecret],
      mappingVersion: "mapping-v1",
      store,
      adapter,
      now: clock.date,
      ...overrides,
    }),
    background,
  };
}

async function signedRequest(
  event: Record<string, unknown>,
  now: Date,
  connectionTest = false,
  profile: Readonly<{ provider: "hubspot" | "salesforce" | "custom"; mappingVersion: string }> = {
    provider: "hubspot",
    mappingVersion: "mapping-v1",
  },
): Promise<Request> {
  const body = JSON.stringify({ schemaVersion: "1.0", event });
  const timestamp = Math.floor(now.getTime() / 1_000).toString();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(ingressSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(deliverySignatureInput(timestamp, body, profile)),
  );
  const signature = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://crm-gateway.test.invalid/v1/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-notice-event-id": String(event.id),
      "x-notice-crm-provider": profile.provider,
      "x-notice-crm-mapping-version": profile.mappingVersion,
      "x-notice-timestamp": timestamp,
      "x-notice-signature": `sha256=${signature}`,
      ...(connectionTest ? { "x-notice-test": "connection" } : {}),
    },
    body,
  });
}

function receiptFromCanonical(
  event: CanonicalCrmEvent,
  overrides: Partial<ReceiptRecord> = {},
): ReceiptRecord {
  return Object.freeze({
    workspaceId: event.workspaceId,
    eventId: event.eventId,
    bodyDigest: "a".repeat(64),
    eventJson: JSON.stringify(event),
    topic: event.topic,
    agreementId: String(event.agreementId),
    aggregateVersion: event.aggregateVersion,
    provider: "hubspot",
    mappingVersion: "mapping-v1",
    status: "received",
    attempts: 0,
    availableAt: initialNow,
    leaseToken: null,
    lockedAt: null,
    lastErrorCode: null,
    providerRecordId: null,
    receivedAt: initialNow,
    updatedAt: initialNow,
    completedAt: null,
    payloadRedactedAt: null,
    ...overrides,
  });
}

class MemoryReceiptStore implements ReceiptStore {
  private readonly receipts = new Map<string, ReceiptRecord>();
  private readonly aggregateWatermarks = new Map<string, {
    version: number;
    eventId: string;
    leaseToken: string | null;
    lockedAt: string | null;
  }>();
  private leaseSequence = 0;
  acceptCalls = 0;
  recoverCalls = 0;

  seed(receipt: ReceiptRecord): void {
    this.receipts.set(this.key(receipt.workspaceId, receipt.eventId), receipt);
  }

  getSync(workspaceId: string, eventId: string): ReceiptRecord | null {
    return this.receipts.get(this.key(workspaceId, eventId)) ?? null;
  }

  async accept(input: NewReceipt): Promise<ReceiptAcceptance> {
    this.acceptCalls += 1;
    const existing = this.getSync(input.workspaceId, input.eventId);
    if (!existing) {
      const receipt = Object.freeze({
        ...input,
        status: "received" as const,
        attempts: 0,
        availableAt: input.now,
        leaseToken: null,
        lockedAt: null,
        lastErrorCode: null,
        providerRecordId: null,
        receivedAt: input.now,
        updatedAt: input.now,
        completedAt: null,
        payloadRedactedAt: null,
      });
      this.seed(receipt);
      this.recordAccepted(receipt);
      return { kind: "new", receipt };
    }
    if (existing.provider !== input.provider || existing.mappingVersion !== input.mappingVersion) {
      return { kind: "profile_conflict", receipt: existing };
    }
    if (existing.bodyDigest === input.bodyDigest) {
      this.recordAccepted(existing);
      return { kind: "duplicate", receipt: existing };
    }
    const receipt = Object.freeze({
      ...existing,
      status: "quarantined" as const,
      lastErrorCode: "event_id_digest_collision",
      leaseToken: null,
      lockedAt: null,
      updatedAt: input.now,
      completedAt: existing.completedAt ?? input.now,
    });
    this.seed(receipt);
    return { kind: "collision", receipt };
  }

  async get(workspaceId: string, eventId: string): Promise<ReceiptRecord | null> {
    return this.getSync(workspaceId, eventId);
  }

  async claim(receipt: ReceiptRecord, now: string, staleBefore: string): Promise<ReceiptClaim> {
    void staleBefore;
    const current = this.getSync(receipt.workspaceId, receipt.eventId) ?? receipt;
    if (["succeeded", "superseded", "dead", "quarantined"].includes(current.status)) {
      return { kind: "terminal", receipt: current };
    }
    if (current.status === "processing" || current.availableAt > now) return { kind: "busy", receipt: current };
    const watermark = this.reconcileAggregateWatermark(current);
    if (
      watermark.version > current.aggregateVersion
      || (watermark.version === current.aggregateVersion && watermark.eventId !== current.eventId)
    ) {
      const superseded = Object.freeze({
        ...current,
        status: "superseded" as const,
        completedAt: now,
        updatedAt: now,
        leaseToken: null,
        lockedAt: null,
        lastErrorCode: null,
      });
      this.seed(superseded);
      return { kind: "superseded", receipt: superseded };
    }
    if (watermark.leaseToken !== null && (watermark.lockedAt ?? now) >= staleBefore) {
      return { kind: "busy", receipt: current };
    }
    const leaseToken = `lease-${++this.leaseSequence}`;
    this.aggregateWatermarks.set(this.aggregateKey(current), {
      ...watermark,
      leaseToken,
      lockedAt: now,
    });
    const claimed = Object.freeze({
      ...current,
      status: "processing" as const,
      attempts: current.attempts + 1,
      leaseToken,
      lockedAt: now,
      updatedAt: now,
      lastErrorCode: null,
    });
    this.seed(claimed);
    return { kind: "claimed", receipt: claimed };
  }

  async complete(receipt: ReceiptRecord, leaseToken: string, providerRecordId: string | null, now: string): Promise<void> {
    const current = this.getSync(receipt.workspaceId, receipt.eventId);
    if (!current || current.leaseToken !== leaseToken) return;
    this.recordAccepted(current);
    this.releaseAggregateLease(current, leaseToken);
    this.seed(Object.freeze({
      ...current,
      status: "succeeded" as const,
      providerRecordId,
      completedAt: now,
      updatedAt: now,
      leaseToken: null,
      lockedAt: null,
      lastErrorCode: null,
    }));
  }

  async fail(
    receipt: ReceiptRecord,
    leaseToken: string,
    input: { terminal: boolean; code: string; availableAt: string; now: string },
  ): Promise<void> {
    const current = this.getSync(receipt.workspaceId, receipt.eventId);
    if (!current || current.leaseToken !== leaseToken) return;
    this.releaseAggregateLease(current, leaseToken);
    this.seed(Object.freeze({
      ...current,
      status: input.terminal ? "dead" as const : "retry" as const,
      availableAt: input.availableAt,
      updatedAt: input.now,
      lastErrorCode: input.code,
      completedAt: input.terminal ? input.now : null,
      leaseToken: null,
      lockedAt: null,
    }));
  }

  async listDue(now: string, limit: number, profile: ReceiptProfile): Promise<ReceiptRecord[]> {
    return [...this.receipts.values()]
      .filter((receipt) => receipt.provider === profile.provider
        && receipt.mappingVersion === profile.mappingVersion
        && ["received", "retry"].includes(receipt.status)
        && receipt.availableAt <= now)
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt))
      .slice(0, limit);
  }

  async recoverStale(staleBefore: string, now: string, profile: ReceiptProfile): Promise<void> {
    this.recoverCalls += 1;
    for (const receipt of this.receipts.values()) {
      if (
        receipt.provider === profile.provider
        && receipt.mappingVersion === profile.mappingVersion
        && receipt.status === "processing"
        && receipt.lockedAt
        && receipt.lockedAt < staleBefore
      ) {
        if (receipt.leaseToken !== null) this.releaseAggregateLease(receipt, receipt.leaseToken);
        this.seed(Object.freeze({
          ...receipt,
          status: "retry" as const,
          availableAt: now,
          leaseToken: null,
          lockedAt: null,
          lastErrorCode: "stale_processing_recovered",
          updatedAt: now,
        }));
      }
    }
  }

  async listOperationalReceipts(
    status: ReceiptStatus,
    limit: number,
    profile: ReceiptProfile,
  ): Promise<OperationalReceipt[]> {
    return [...this.receipts.values()]
      .filter((receipt) => receipt.status === status
        && receipt.provider === profile.provider
        && receipt.mappingVersion === profile.mappingVersion)
      .sort((left, right) => (right.completedAt ?? right.updatedAt).localeCompare(left.completedAt ?? left.updatedAt))
      .slice(0, limit)
      .map((receipt) => ({
        workspaceId: receipt.workspaceId,
        eventId: receipt.eventId,
        topic: receipt.topic,
        agreementId: receipt.agreementId,
        aggregateVersion: receipt.aggregateVersion,
        provider: receipt.provider,
        mappingVersion: receipt.mappingVersion,
        status: receipt.status,
        attempts: receipt.attempts,
        lastErrorCode: receipt.lastErrorCode,
        receivedAt: receipt.receivedAt,
        updatedAt: receipt.updatedAt,
        completedAt: receipt.completedAt,
        payloadState: receipt.payloadRedactedAt === null ? "retained" : "redacted",
      }));
  }

  async requeueDead(input: {
    workspaceId: string;
    eventId: string;
    provider: string;
    mappingVersion: string;
    now: string;
  }): Promise<{ kind: "requeued" | "not_found" | "not_dead" | "payload_redacted" | "profile_mismatch" }> {
    const receipt = this.getSync(input.workspaceId, input.eventId);
    if (!receipt) return { kind: "not_found" };
    if (receipt.status !== "dead") return { kind: "not_dead" };
    if (receipt.payloadRedactedAt !== null || receipt.eventJson.length === 0) return { kind: "payload_redacted" };
    if (receipt.provider !== input.provider || receipt.mappingVersion !== input.mappingVersion) {
      return { kind: "profile_mismatch" };
    }
    this.seed(Object.freeze({
      ...receipt,
      status: "retry" as const,
      attempts: 0,
      availableAt: input.now,
      leaseToken: null,
      lockedAt: null,
      lastErrorCode: null,
      providerRecordId: null,
      completedAt: null,
      updatedAt: input.now,
    }));
    return { kind: "requeued" };
  }

  async redactTerminalPayloads(
    terminalBefore: string,
    now: string,
    limit: number,
    profile: ReceiptProfile,
  ): Promise<void> {
    let remaining = limit;
    for (const receipt of this.receipts.values()) {
      if (
        remaining > 0
        && receipt.provider === profile.provider
        && receipt.mappingVersion === profile.mappingVersion
        && ["succeeded", "dead", "quarantined", "superseded"].includes(receipt.status)
        && receipt.payloadRedactedAt === null
        && (receipt.completedAt ?? receipt.updatedAt) < terminalBefore
      ) {
        this.seed(Object.freeze({ ...receipt, eventJson: "", payloadRedactedAt: now, updatedAt: now }));
        remaining -= 1;
      }
    }
  }

  async pruneTerminalMetadata(terminalBefore: string, limit: number, profile: ReceiptProfile): Promise<void> {
    let remaining = limit;
    for (const [key, receipt] of this.receipts) {
      if (
        remaining > 0
        && receipt.provider === profile.provider
        && receipt.mappingVersion === profile.mappingVersion
        && ["succeeded", "dead", "quarantined", "superseded"].includes(receipt.status)
        && receipt.payloadRedactedAt !== null
        && (receipt.completedAt ?? receipt.updatedAt) < terminalBefore
      ) {
        this.reconcileAggregateWatermark(receipt);
        this.receipts.delete(key);
        remaining -= 1;
      }
    }
  }

  async checkReady(): Promise<void> {}

  private key(workspaceId: string, eventId: string): string {
    return `${workspaceId}\u0000${eventId}`;
  }

  private aggregateKey(receipt: ReceiptRecord): string {
    return `${receipt.workspaceId}\u0000${receipt.agreementId}\u0000${receipt.provider}\u0000${receipt.mappingVersion}`;
  }

  private recordAccepted(receipt: ReceiptRecord): void {
    const key = this.aggregateKey(receipt);
    const watermark = this.aggregateWatermarks.get(key);
    if (!watermark || receipt.aggregateVersion > watermark.version) {
      this.aggregateWatermarks.set(key, {
        version: receipt.aggregateVersion,
        eventId: receipt.eventId,
        leaseToken: watermark?.leaseToken ?? null,
        lockedAt: watermark?.lockedAt ?? null,
      });
    }
  }

  private releaseAggregateLease(receipt: ReceiptRecord, leaseToken: string): void {
    const key = this.aggregateKey(receipt);
    const watermark = this.aggregateWatermarks.get(key);
    if (watermark?.leaseToken !== leaseToken) return;
    this.aggregateWatermarks.set(key, { ...watermark, leaseToken: null, lockedAt: null });
  }

  private reconcileAggregateWatermark(receipt: ReceiptRecord): {
    version: number;
    eventId: string;
    leaseToken: string | null;
    lockedAt: string | null;
  } {
    const key = this.aggregateKey(receipt);
    const highestPersisted = [...this.receipts.values()]
      .filter((candidate) => candidate.workspaceId === receipt.workspaceId && candidate.agreementId === receipt.agreementId)
      .filter((candidate) => candidate.provider === receipt.provider && candidate.mappingVersion === receipt.mappingVersion)
      .sort((left, right) => right.aggregateVersion - left.aggregateVersion
        || left.receivedAt.localeCompare(right.receivedAt)
        || left.eventId.localeCompare(right.eventId))[0];
    if (highestPersisted) this.recordAccepted(highestPersisted);
    return this.aggregateWatermarks.get(key) ?? {
      version: receipt.aggregateVersion,
      eventId: receipt.eventId,
      leaseToken: null,
      lockedAt: null,
    };
  }
}
