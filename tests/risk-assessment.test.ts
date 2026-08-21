import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateRiskAssessment,
  riskAssessmentBasisMatches,
  riskAssessmentRequiresReset,
  riskAssessmentResetPatch,
  type RiskAssessmentBasis,
  type RiskAssessmentEvidence,
} from "../app/lib/risk-assessment";

const basis: RiskAssessmentBasis = {
  basisHash: "a".repeat(64),
  documentVersion: 4,
  documentSha256: "b".repeat(64),
};

function assessed(level: "Low" | "Medium" | "High", overrides: Partial<RiskAssessmentEvidence> = {}): RiskAssessmentEvidence {
  return {
    disposition: "assessed",
    level,
    basis,
    decidedByPrincipalId: "user-risk-1",
    decidedAt: "2026-08-19T15:00:00.000Z",
    rationale: "Reviewed the exact current working paper and intake metadata.",
    ...overrides,
  } as RiskAssessmentEvidence;
}

test("unassessed work and bare labels fail closed with stable blocker codes", () => {
  assert.deepEqual(evaluateRiskAssessment({ level: "Unassessed", evidence: null }, basis).blockers.map((blocker) => blocker.code), [
    "RISK_ASSESSMENT_REQUIRED",
  ]);
  assert.deepEqual(evaluateRiskAssessment({ level: "High", evidence: null }, basis).blockers.map((blocker) => blocker.code), [
    "RISK_ASSESSMENT_EVIDENCE_REQUIRED",
  ]);
});

test("all assessed risk tiers require complete evidence for the exact paper", () => {
  for (const level of ["Low", "Medium", "High"] as const) {
    const evaluation = evaluateRiskAssessment({ level, evidence: assessed(level) }, basis);
    assert.equal(evaluation.cleared, true);
    assert.equal(evaluation.level, level);
    assert.equal(evaluation.disposition, "assessed");
    assert.deepEqual(evaluation.blockers, []);
  }
});

test("an explicit human waiver is evidence, not a hidden Low-risk default", () => {
  const evidence: RiskAssessmentEvidence = {
    disposition: "waived",
    level: "Unassessed",
    basis,
    decidedByPrincipalId: "legal-admin-1",
    decidedAt: "2026-08-19T16:00:00.000Z",
    rationale: "Authorized emergency waiver; review is due before renewal.",
  };
  const evaluation = evaluateRiskAssessment({ level: "Unassessed", evidence }, basis);
  assert.equal(evaluation.cleared, true);
  assert.equal(evaluation.disposition, "waived");
});

test("basis matching binds hash, document version, and document digest exactly", () => {
  assert.equal(riskAssessmentBasisMatches(basis, { ...basis }), true);
  for (const current of [
    { ...basis, basisHash: "c".repeat(64) },
    { ...basis, documentVersion: 5 },
    { ...basis, documentSha256: "d".repeat(64) },
  ]) {
    const state = { level: "Medium" as const, evidence: assessed("Medium") };
    const evaluation = evaluateRiskAssessment(state, current);
    assert.equal(evaluation.cleared, false);
    assert.equal(evaluation.blockers.some((blocker) => blocker.code === "RISK_ASSESSMENT_BASIS_STALE"), true);
    assert.equal(riskAssessmentRequiresReset(state, current), true);
  }
});

test("malformed evidence and disposition-label mismatches are rejected", () => {
  for (const evidence of [
    assessed("Low", { decidedByPrincipalId: " " }),
    assessed("Low", { rationale: "" }),
    assessed("Low", { decidedAt: "yesterday" }),
    assessed("Low", { basis: { ...basis, basisHash: "short" } }),
  ]) {
    const evaluation = evaluateRiskAssessment({ level: "Low", evidence }, basis);
    assert.equal(evaluation.cleared, false);
    assert.equal(evaluation.blockers.some((blocker) => blocker.code === "RISK_ASSESSMENT_EVIDENCE_INVALID"), true);
  }
  const mismatch = evaluateRiskAssessment({ level: "High", evidence: assessed("Low") }, basis);
  assert.equal(mismatch.blockers.some((blocker) => blocker.code === "RISK_ASSESSMENT_EVIDENCE_INVALID"), true);
});

test("the reset patch is stable and removes evidence after basis-changing edits", () => {
  assert.deepEqual(riskAssessmentResetPatch(), { level: "Unassessed", evidence: null });
  assert.equal(riskAssessmentRequiresReset(riskAssessmentResetPatch(), basis), false);
});
