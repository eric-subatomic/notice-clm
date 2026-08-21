import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCrmResyncCursor,
  encodeCrmResyncCursor,
  evaluateCrmResyncEligibility,
  crmLegacyEventPayloadSha256,
  legacyAttestationResolvesCrmDelivery,
  summarizeCrmProfileDeliveryEvidence,
  summarizeCrmProfileReceiptState,
} from "../app/lib/crm-resync-policy";

const emptyReceipts = {
  potentialProjectionVersion: null,
  acceptedTombstoneVersion: null,
  newestUnresolvedAcceptedOtherProfileVersion: null,
  newestUnreconciledProfileMutationVersion: null,
};

test("CRM resync eligibility separates live projection from deletion cleanup", () => {
  assert.deepEqual(evaluateCrmResyncEligibility({
    agreementProvider: "hubspot",
    deletedAt: null,
    profileProvider: "hubspot",
    receipts: { ...emptyReceipts, potentialProjectionVersion: 8 },
  }), { actions: ["projection"], historicalCleanup: false, blockedByUnreconciledMutation: false, blockedByHistoricalReactivation: false });
  assert.deepEqual(evaluateCrmResyncEligibility({
    agreementProvider: "hubspot",
    deletedAt: "2026-08-02T12:00:00.000Z",
    profileProvider: "hubspot",
    receipts: emptyReceipts,
  }), { actions: ["tombstone"], historicalCleanup: false, blockedByUnreconciledMutation: false, blockedByHistoricalReactivation: false });
  assert.deepEqual(evaluateCrmResyncEligibility({
    agreementProvider: "salesforce",
    deletedAt: null,
    profileProvider: "hubspot",
    receipts: emptyReceipts,
  }), { actions: [], historicalCleanup: false, blockedByUnreconciledMutation: false, blockedByHistoricalReactivation: false });
});

test("historical cleanup requires an unresolved profile-bound projection on the exact current profile", () => {
  assert.deepEqual(evaluateCrmResyncEligibility({
    agreementProvider: null,
    deletedAt: null,
    profileProvider: "custom",
    receipts: { ...emptyReceipts, potentialProjectionVersion: 12, acceptedTombstoneVersion: 11 },
  }), { actions: ["tombstone"], historicalCleanup: true, blockedByUnreconciledMutation: false, blockedByHistoricalReactivation: false });
  assert.deepEqual(evaluateCrmResyncEligibility({
    agreementProvider: "salesforce",
    deletedAt: "2026-08-02T12:00:00.000Z",
    profileProvider: "custom",
    receipts: { ...emptyReceipts, potentialProjectionVersion: 12, acceptedTombstoneVersion: 12 },
  }), { actions: [], historicalCleanup: false, blockedByUnreconciledMutation: false, blockedByHistoricalReactivation: false });
  assert.deepEqual(evaluateCrmResyncEligibility({
    agreementProvider: null,
    deletedAt: null,
    profileProvider: "custom",
    receipts: { ...emptyReceipts, potentialProjectionVersion: 12, acceptedTombstoneVersion: 13 },
  }), { actions: [], historicalCleanup: false, blockedByUnreconciledMutation: false, blockedByHistoricalReactivation: false });
});

test("pending, dead, and lost-response projections remain cleanup eligible until a tombstone is accepted", () => {
  for (const status of ["pending", "dead", "accepted"] as const) {
    const evidence = summarizeCrmProfileDeliveryEvidence([
      { operation: "projection", version: 12, status },
      { operation: "tombstone", version: 12, status: "pending" },
    ]);
    assert.deepEqual(evidence, {
      potentialProjectionVersion: 12,
      acceptedTombstoneVersion: null,
    });
    assert.deepEqual(evaluateCrmResyncEligibility({
      agreementProvider: null,
      deletedAt: null,
      profileProvider: "hubspot",
      receipts: { ...emptyReceipts, ...evidence },
    }), { actions: ["tombstone"], historicalCleanup: true, blockedByUnreconciledMutation: false, blockedByHistoricalReactivation: false });
  }

  assert.deepEqual(summarizeCrmProfileDeliveryEvidence([
    { operation: "projection", version: 12, status: "dead" },
    { operation: "tombstone", version: 12, status: "accepted" },
    { operation: "tombstone", version: 13, status: "dead" },
  ]), { potentialProjectionVersion: 12, acceptedTombstoneVersion: 12 });
});

test("same-provider mapping cutover exposes only cleanup for the superseded exact profile", () => {
  assert.deepEqual(evaluateCrmResyncEligibility({
    agreementProvider: "hubspot",
    deletedAt: null,
    profileProvider: "hubspot",
    receipts: {
      potentialProjectionVersion: 7,
      acceptedTombstoneVersion: null,
      newestUnresolvedAcceptedOtherProfileVersion: 8,
      newestUnreconciledProfileMutationVersion: null,
    },
  }), {
    actions: ["tombstone"],
    historicalCleanup: true,
    blockedByUnreconciledMutation: false,
    blockedByHistoricalReactivation: false,
  });

  assert.deepEqual(evaluateCrmResyncEligibility({
    agreementProvider: "hubspot",
    deletedAt: null,
    profileProvider: "hubspot",
    receipts: {
      potentialProjectionVersion: null,
      acceptedTombstoneVersion: null,
      newestUnresolvedAcceptedOtherProfileVersion: 7,
      newestUnreconciledProfileMutationVersion: null,
    },
  }), {
    actions: ["projection"],
    historicalCleanup: false,
    blockedByUnreconciledMutation: false,
    blockedByHistoricalReactivation: false,
  }, "a never-used new profile remains eligible for its first projection");
});

test("a fenced historical profile cannot be reactivated while another accepted profile is live", () => {
  assert.deepEqual(evaluateCrmResyncEligibility({
    agreementProvider: "hubspot",
    deletedAt: null,
    profileProvider: "hubspot",
    receipts: {
      potentialProjectionVersion: 7,
      acceptedTombstoneVersion: 9,
      newestUnresolvedAcceptedOtherProfileVersion: 8,
      newestUnreconciledProfileMutationVersion: null,
    },
  }), {
    actions: [],
    historicalCleanup: false,
    blockedByUnreconciledMutation: false,
    blockedByHistoricalReactivation: true,
  });
});

test("unreconciled newer CRM work blocks mapping-history inference", () => {
  assert.deepEqual(evaluateCrmResyncEligibility({
    agreementProvider: "hubspot",
    deletedAt: null,
    profileProvider: "hubspot",
    receipts: {
      potentialProjectionVersion: 7,
      acceptedTombstoneVersion: null,
      newestUnresolvedAcceptedOtherProfileVersion: 8,
      newestUnreconciledProfileMutationVersion: 9,
    },
  }), {
    actions: [],
    historicalCleanup: false,
    blockedByUnreconciledMutation: true,
    blockedByHistoricalReactivation: false,
  });

  assert.deepEqual(evaluateCrmResyncEligibility({
    agreementProvider: "hubspot",
    deletedAt: null,
    profileProvider: "hubspot",
    receipts: {
      potentialProjectionVersion: 9,
      acceptedTombstoneVersion: null,
      newestUnresolvedAcceptedOtherProfileVersion: 8,
      newestUnreconciledProfileMutationVersion: 9,
    },
  }), {
    actions: ["projection"],
    historicalCleanup: false,
    blockedByUnreconciledMutation: false,
    blockedByHistoricalReactivation: false,
  }, "pending work already bound to the exact profile does not look like an unknown newer target");
});

test("profile aggregation fences old failures and preserves later ambiguous mutations", () => {
  const current = { provider: "hubspot", mappingVersion: "v2", destinationFingerprint: "b".repeat(64) };
  const cleanedOldProfile = {
    provider: "hubspot",
    mappingVersion: "v1",
    destinationFingerprint: "a".repeat(64),
    potentialProjectionVersion: 8,
    acceptedProjectionVersion: null,
    acceptedTombstoneVersion: 10,
    nonAcceptedMutationVersion: 8,
  };
  assert.deepEqual(summarizeCrmProfileReceiptState([cleanedOldProfile], current, null), emptyReceipts,
    "an accepted v10 tombstone fences the old profile's dead v8 projection");

  assert.deepEqual(summarizeCrmProfileReceiptState([{
    ...cleanedOldProfile,
    nonAcceptedMutationVersion: 11,
  }], current, null), {
    ...emptyReceipts,
    newestUnreconciledProfileMutationVersion: 11,
  }, "a later pending/dead tombstone or projection remains ambiguous");

  assert.deepEqual(summarizeCrmProfileReceiptState([{
    ...cleanedOldProfile,
    acceptedProjectionVersion: 8,
    acceptedTombstoneVersion: null,
    nonAcceptedMutationVersion: null,
  }], current, null), {
    ...emptyReceipts,
    newestUnresolvedAcceptedOtherProfileVersion: 8,
  });
});

test("CRM resync cursors round-trip exactly and reject malformed or expanded input", () => {
  const cursor = { updatedAt: "2026-08-02T12:00:00.000Z", id: 4102 };
  assert.deepEqual(decodeCrmResyncCursor(encodeCrmResyncCursor(cursor)), cursor);
  assert.equal(decodeCrmResyncCursor(null), null);
  for (const candidate of ["", "not%base64", "e30", "eyJ1cGRhdGVkQXQiOiIyMDI2LTA4LTAyVDEyOjAwOjAwLjAwMFoiLCJpZCI6MCwiZXh0cmEiOnRydWV9"]) {
    assert.throws(() => decodeCrmResyncCursor(candidate), /cursor is invalid/);
  }
});

test("legacy cleanup attestations bind to stable canonical payload JSON", async () => {
  const left = await crmLegacyEventPayloadSha256({
    crmAgreement: { version: 7, crm: "HubSpot" },
    agreementId: 4102,
  });
  const reordered = await crmLegacyEventPayloadSha256({
    agreementId: 4102,
    crmAgreement: { crm: "HubSpot", version: 7 },
  });
  const changed = await crmLegacyEventPayloadSha256({
    agreementId: 4102,
    crmAgreement: { crm: "HubSpot", version: 8 },
  });
  assert.equal(left, reordered);
  assert.notEqual(left, changed);
  assert.match(left, /^[0-9a-f]{64}$/);
});

test("legacy cleanup resolves only absent or incomplete CRM delivery profiles", () => {
  const complete = {
    crmProvider: "custom",
    crmMappingVersion: "v1",
    crmDestinationFingerprint: "a".repeat(64),
  };
  assert.equal(legacyAttestationResolvesCrmDelivery(false, null), false);
  assert.equal(legacyAttestationResolvesCrmDelivery(true, null), true);
  assert.equal(legacyAttestationResolvesCrmDelivery(true, { ...complete, crmProvider: null }), true);
  assert.equal(legacyAttestationResolvesCrmDelivery(true, { ...complete, crmMappingVersion: null }), true);
  assert.equal(legacyAttestationResolvesCrmDelivery(true, { ...complete, crmDestinationFingerprint: null }), true);
  assert.equal(legacyAttestationResolvesCrmDelivery(true, complete), false);
});
