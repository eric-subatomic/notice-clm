import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDeletionDeliveryGate, unresolvedCrmDeliveryProfiles } from "../app/lib/retention-delivery-policy";

const payload = {
  tombstone: true,
  agreementId: 42,
  version: 7,
  aggregateVersion: 7,
  deletedAt: "2026-08-01T00:00:00.000Z",
};

function gate(overrides: Partial<Parameters<typeof evaluateDeletionDeliveryGate>[0]> = {}) {
  return evaluateDeletionDeliveryGate({
    agreementId: 42,
    version: 7,
    deletedAt: "2026-08-01T00:00:00.000Z",
    unresolvedCrmProfiles: [],
    event: { status: "processed", payload },
    deliveries: [
      { sink: "delivery", status: "accepted" },
      { sink: "crm", status: "accepted" },
    ],
    ...overrides,
  });
}

test("hard purge requires the exact current deletion epoch", () => {
  assert.equal(gate().ready, true);
  assert.equal(gate({ event: null }).code, "current_tombstone_missing");
  assert.equal(gate({ event: { status: "processed", payload: { ...payload, version: 6 } } }).code, "current_tombstone_missing");
  assert.equal(gate({ event: { status: "processed", payload: { ...payload, deletedAt: "2026-07-01T00:00:00.000Z" } } }).code, "current_tombstone_missing");
});

test("every immutable sink must have a durable accepted receipt", () => {
  assert.equal(gate({ deliveries: [{ sink: "crm", status: "accepted" }] }).code, "delivery_sink_missing");
  assert.equal(gate({
    deliveries: [{ sink: "delivery", status: "accepted" }],
    unresolvedCrmProfiles: ["salesforce:v1:destination"],
  }).code, "crm_cleanup_required");
  assert.equal(gate({ deliveries: [
    { sink: "delivery", status: "accepted" },
    { sink: "crm", status: "dead" },
  ] }).code, "sink_delivery_incomplete");
  assert.equal(gate({ unresolvedCrmProfiles: [], deliveries: [
    { sink: "delivery", status: "accepted" },
    { sink: "crm", status: "pending" },
  ] }).code, "sink_delivery_incomplete");
});

test("gateway receipts must also be finalized on the parent event", () => {
  assert.equal(gate({ event: { status: "processing", payload } }).code, "event_finalization_incomplete");
  assert.equal(gate({ unresolvedCrmProfiles: [], deliveries: [{ sink: "delivery", status: "accepted" }] }).ready, true);
});

test("each accepted CRM projection requires a same-profile version-fenced tombstone", () => {
  const fingerprint = "a".repeat(64);
  const projection = {
    eventId: "projection-1",
    topic: "agreement.updated",
    payload: { crmAgreement: { version: 7 } },
    status: "accepted" as const,
    crmProvider: "salesforce" as const,
    crmMappingVersion: "v1",
    crmDestinationFingerprint: fingerprint,
  };
  const staleTombstone = {
    eventId: "tombstone-1",
    topic: "agreement.deleted",
    payload: { aggregateVersion: 6 },
    status: "accepted" as const,
    crmProvider: "salesforce" as const,
    crmMappingVersion: "v1",
    crmDestinationFingerprint: fingerprint,
  };
  assert.equal(unresolvedCrmDeliveryProfiles([projection]).length, 1);
  assert.equal(unresolvedCrmDeliveryProfiles([projection, staleTombstone]).length, 1);
  assert.deepEqual(unresolvedCrmDeliveryProfiles([
    projection,
    { ...staleTombstone, eventId: "tombstone-2", payload: { aggregateVersion: 7 } },
  ]), []);
});

test("legacy profile rows and packet versions cannot falsely authorize purge", () => {
  const fingerprint = "b".repeat(64);
  const signatureProjection = {
    eventId: "signature-1",
    topic: "signature.completed",
    payload: { aggregateVersion: 99, crmAgreement: { version: 4 } },
    status: "pending" as const,
    crmProvider: "hubspot" as const,
    crmMappingVersion: "mapping-v2",
    crmDestinationFingerprint: fingerprint,
  };
  const tombstone = {
    eventId: "tombstone-1",
    topic: "agreement.deleted",
    payload: { aggregateVersion: 5 },
    status: "accepted" as const,
    crmProvider: "hubspot" as const,
    crmMappingVersion: "mapping-v2",
    crmDestinationFingerprint: fingerprint,
  };
  assert.deepEqual(unresolvedCrmDeliveryProfiles([signatureProjection, tombstone]), []);
  assert.equal(unresolvedCrmDeliveryProfiles([{ ...signatureProjection, crmDestinationFingerprint: null }]).length, 1);
});
