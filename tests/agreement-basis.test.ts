import assert from "node:assert/strict";
import test from "node:test";
import { computeAgreementBasisHash } from "../app/lib/agreement-basis";

const agreement = {
  workspaceId: "orchid-workspace",
  id: 42,
  party: "Orchid Client",
  side: "Sell-side",
  type: "Master Services Agreement",
  value: 250_000,
  department: "Legal Operations",
  risk: "Medium",
  effectiveDate: "2026-09-01",
  expirationDate: "2027-09-01",
};
const document = { version: 3, sha256: "a".repeat(64) };

test("execution basis is stable and changes with material paper or metadata", async () => {
  const baseline = await computeAgreementBasisHash(agreement, document);
  assert.equal(baseline, await computeAgreementBasisHash({ ...agreement }, { ...document }));
  assert.notEqual(baseline, await computeAgreementBasisHash({ ...agreement, value: agreement.value + 1 }, document));
  assert.notEqual(baseline, await computeAgreementBasisHash(agreement, { ...document, version: 4 }));
  assert.notEqual(baseline, await computeAgreementBasisHash(agreement, { ...document, sha256: "b".repeat(64) }));
  const governed = {
    ...agreement,
    workflowDefinitionId: "11111111-1111-4111-8111-111111111111",
    workflowPolicySha256: "c".repeat(64),
    workflowApprovalLanes: ["Legal", "Privacy"],
  };
  const governedBasis = await computeAgreementBasisHash(governed, document);
  assert.notEqual(baseline, governedBasis);
  assert.notEqual(governedBasis, await computeAgreementBasisHash({ ...governed, workflowApprovalLanes: ["Legal"] }, document));
});
