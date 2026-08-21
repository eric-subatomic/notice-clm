export const riskLevels = ["Unassessed", "Low", "Medium", "High"] as const;
export type RiskLevel = (typeof riskLevels)[number];
export type AssessedRiskLevel = Exclude<RiskLevel, "Unassessed">;
export type RiskAssessmentDisposition = "assessed" | "waived";

export type RiskAssessmentBasis = Readonly<{
  basisHash: string;
  documentVersion: number;
  documentSha256: string;
}>;

type RiskAssessmentEvidenceBase = Readonly<{
  basis: RiskAssessmentBasis;
  decidedByPrincipalId: string;
  decidedAt: string;
  rationale: string;
}>;

export type RiskAssessmentEvidence =
  | (RiskAssessmentEvidenceBase & Readonly<{
    disposition: "assessed";
    level: AssessedRiskLevel;
  }>)
  | (RiskAssessmentEvidenceBase & Readonly<{
    disposition: "waived";
    level: "Unassessed";
  }>);

export type RiskAssessmentState = Readonly<{
  level: RiskLevel;
  evidence: RiskAssessmentEvidence | null;
}>;

export type RiskAssessmentBlockerCode =
  | "RISK_ASSESSMENT_REQUIRED"
  | "RISK_ASSESSMENT_EVIDENCE_REQUIRED"
  | "RISK_ASSESSMENT_EVIDENCE_INVALID"
  | "RISK_ASSESSMENT_BASIS_STALE";

export type RiskAssessmentBlocker = Readonly<{
  code: RiskAssessmentBlockerCode;
  message: string;
}>;

export type RiskAssessmentEvaluation = Readonly<{
  cleared: boolean;
  level: RiskLevel;
  disposition: RiskAssessmentDisposition | null;
  blockers: readonly RiskAssessmentBlocker[];
}>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isCanonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validBasis(basis: RiskAssessmentBasis): boolean {
  return SHA256_PATTERN.test(basis.basisHash)
    && Number.isSafeInteger(basis.documentVersion)
    && basis.documentVersion > 0
    && SHA256_PATTERN.test(basis.documentSha256);
}

/** Every component of the material paper basis must match exactly. */
export function riskAssessmentBasisMatches(
  evidence: RiskAssessmentBasis,
  current: RiskAssessmentBasis,
): boolean {
  return evidence.basisHash === current.basisHash
    && evidence.documentVersion === current.documentVersion
    && evidence.documentSha256 === current.documentSha256;
}

/** A basis-changing mutation must atomically apply this fail-closed patch. */
export function riskAssessmentResetPatch(): RiskAssessmentState {
  return { level: "Unassessed", evidence: null };
}

function addBlocker(
  blockers: RiskAssessmentBlocker[],
  code: RiskAssessmentBlockerCode,
  message: string,
): void {
  if (!blockers.some((blocker) => blocker.code === code)) blockers.push({ code, message });
}

export function evaluateRiskAssessment(
  state: RiskAssessmentState,
  currentBasis: RiskAssessmentBasis,
): RiskAssessmentEvaluation {
  const blockers: RiskAssessmentBlocker[] = [];
  const evidence = state.evidence;

  if (state.level === "Unassessed" && evidence === null) {
    addBlocker(blockers, "RISK_ASSESSMENT_REQUIRED", "Assess risk or record an authorized waiver before governed workflow execution.");
  } else if (evidence === null) {
    addBlocker(blockers, "RISK_ASSESSMENT_EVIDENCE_REQUIRED", "A risk label without decision evidence cannot govern workflow.");
  }

  if (evidence !== null) {
    const dispositionAndLevelAgree = evidence.disposition === "assessed"
      ? state.level === evidence.level
      : evidence.level === "Unassessed" && state.level === "Unassessed";
    const evidenceComplete = dispositionAndLevelAgree
      && evidence.decidedByPrincipalId.trim().length > 0
      && evidence.rationale.trim().length > 0
      && isCanonicalInstant(evidence.decidedAt)
      && validBasis(evidence.basis);
    if (!evidenceComplete) {
      addBlocker(blockers, "RISK_ASSESSMENT_EVIDENCE_INVALID", "Risk evidence is incomplete or internally inconsistent.");
    }
    if (!riskAssessmentBasisMatches(evidence.basis, currentBasis)) {
      addBlocker(blockers, "RISK_ASSESSMENT_BASIS_STALE", "Risk evidence does not match the exact current agreement paper.");
    }
  }

  return {
    cleared: blockers.length === 0,
    level: state.level,
    disposition: evidence?.disposition ?? null,
    blockers,
  };
}

export function riskAssessmentRequiresReset(
  state: RiskAssessmentState,
  currentBasis: RiskAssessmentBasis,
): boolean {
  return state.evidence !== null && !riskAssessmentBasisMatches(state.evidence.basis, currentBasis);
}
