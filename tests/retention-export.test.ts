import assert from "node:assert/strict";
import test from "node:test";
import {
  constantTimeSecretEqual,
  DEFAULT_PURGE_GRACE_DAYS,
  isHardPurgeEligible,
  isTerminalAgreementStage,
  isWorkspaceObjectKey,
  normalizeRetentionUntil,
  resolvePurgeGraceDays,
  retentionHasExpired,
} from "../app/lib/records-governance";

test("retention dates are normalized without deleting at the start of a selected day", () => {
  assert.equal(normalizeRetentionUntil("2026-08-31"), "2026-08-31T23:59:59.999Z");
  assert.equal(normalizeRetentionUntil("2026-08-31T18:30:00+02:00"), "2026-08-31T16:30:00.000Z");
  assert.equal(normalizeRetentionUntil(null), null);
  assert.throws(() => normalizeRetentionUntil("2026-02-30"), /valid YYYY-MM-DD/i);
  assert.throws(() => normalizeRetentionUntil("2026-08-31T18:30:00"), /timezone-aware/i);
});

test("hard purge requires expiry, elapsed grace, and no legal hold", () => {
  const now = new Date("2026-08-31T12:00:00.000Z");
  const cutoff = new Date("2026-08-01T12:00:00.000Z");
  const eligible = {
    legalHold: false,
    retentionUntil: "2026-07-31T23:59:59.999Z",
    deletedAt: "2026-07-30T12:00:00.000Z",
  };
  assert.equal(isHardPurgeEligible(eligible, now, cutoff), true);
  assert.equal(isHardPurgeEligible({ ...eligible, legalHold: true }, now, cutoff), false);
  assert.equal(isHardPurgeEligible({ ...eligible, retentionUntil: null }, now, cutoff), false);
  assert.equal(isHardPurgeEligible({ ...eligible, deletedAt: "2026-08-02T12:00:00.000Z" }, now, cutoff), false);
  assert.equal(retentionHasExpired("2026-08-31T11:59:59.000Z", now), true);
  assert.equal(retentionHasExpired("2026-08-31T12:00:01.000Z", now), false);
});

test("retention safeguards reject unsafe storage keys and unsafe grace settings", () => {
  assert.equal(isWorkspaceObjectKey("orchid", "workspaces/orchid/documents/id/file.pdf"), true);
  assert.equal(isWorkspaceObjectKey("orchid", "workspaces/acme/documents/id/file.pdf"), false);
  assert.equal(isWorkspaceObjectKey("orchid", "workspaces/orchid/../acme/file.pdf"), false);
  assert.equal(resolvePurgeGraceDays(undefined), DEFAULT_PURGE_GRACE_DAYS);
  assert.equal(resolvePurgeGraceDays("45"), 45);
  assert.throws(() => resolvePurgeGraceDays("0"), /between 7 and 365/i);
  assert.throws(() => resolvePurgeGraceDays("thirty"), /whole number/i);
  assert.equal(isTerminalAgreementStage("Active"), true);
  assert.equal(isTerminalAgreementStage("Signature"), false);
});

test("job bearer comparison fails closed", () => {
  assert.equal(constantTimeSecretEqual("synthetic-secret", "synthetic-secret"), true);
  assert.equal(constantTimeSecretEqual("synthetic-secret", "synthetic-secreu"), false);
  assert.equal(constantTimeSecretEqual("synthetic-secret", "short"), false);
  assert.equal(constantTimeSecretEqual("", ""), false);
});
