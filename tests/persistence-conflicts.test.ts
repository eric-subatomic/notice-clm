import assert from "node:assert/strict";
import test from "node:test";
import {
  isAgreementEventSequenceConflict,
  isMutationGuardConflict,
  isOptimisticConcurrencyConflict,
  isWorkspaceEventSequenceConflict,
} from "../app/lib/persistence";

test("audit append retries only recognized chain-sequence conflicts", () => {
  assert.equal(isAgreementEventSequenceConflict(new Error(
    "UNIQUE constraint failed: agreement_events.workspace_id, agreement_events.agreement_id, agreement_events.sequence",
  )), true);
  assert.equal(isWorkspaceEventSequenceConflict(new Error(
    "UNIQUE constraint failed: workspace_events.workspace_id, workspace_events.sequence",
  )), true);
  assert.equal(isAgreementEventSequenceConflict(new Error("UNIQUE constraint failed: agreement_events.id")), false);
  assert.equal(isWorkspaceEventSequenceConflict(new Error("storage unavailable")), false);
});

test("optimistic conflict classification is limited to aggregate guard constraints", () => {
  for (const message of [
    "UNIQUE constraint failed: agreement_versions.workspace_id, agreement_versions.agreement_id, agreement_versions.version",
    "UNIQUE constraint failed: agreement_document_versions.workspace_id, agreement_document_versions.agreement_id, agreement_document_versions.version",
    "UNIQUE constraint failed: signature_packets.workspace_id, signature_packets.active_key",
    "CHECK constraint failed: ck_mutation_guards_changes",
  ]) assert.equal(isOptimisticConcurrencyConflict(new Error(message)), true);

  assert.equal(isMutationGuardConflict(new Error("CHECK constraint failed: mutation_guards.guard_changes")), true);

  assert.equal(isOptimisticConcurrencyConflict(new Error("UNIQUE constraint failed: users.email")), false);
  assert.equal(isOptimisticConcurrencyConflict(new Error("network unavailable")), false);
});
