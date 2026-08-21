import { computeRiskAssessmentBasisHash, type AgreementBasisRecord, type DocumentBasisRecord } from "./agreement-basis";
import {
  evaluateRiskAssessment,
  riskLevels,
  type AssessedRiskLevel,
  type RiskAssessmentEvaluation,
  type RiskAssessmentState,
  type RiskLevel,
} from "./risk-assessment";

export type PersistedAgreementRisk = AgreementBasisRecord & Readonly<{
  riskDisposition?: string | null;
  riskBasisHash?: string | null;
  riskDocumentVersion?: number | null;
  riskDocumentSha256?: string | null;
  riskDecisionReason?: string | null;
  riskDecidedByUserId?: string | null;
  riskDecidedAt?: string | null;
}>;

function persistedRiskLevel(value: string): RiskLevel {
  return (riskLevels as readonly string[]).includes(value) ? value as RiskLevel : "Unassessed";
}

export function persistedRiskAssessmentState(agreement: PersistedAgreementRisk): RiskAssessmentState {
  const level = persistedRiskLevel(agreement.risk);
  const disposition = agreement.riskDisposition;
  if (disposition !== "assessed" && disposition !== "waived") return { level, evidence: null };

  const basis = {
    basisHash: agreement.riskBasisHash ?? "",
    documentVersion: agreement.riskDocumentVersion ?? 0,
    documentSha256: agreement.riskDocumentSha256 ?? "",
  };
  const common = {
    basis,
    decidedByPrincipalId: agreement.riskDecidedByUserId ?? "",
    decidedAt: agreement.riskDecidedAt ?? "",
    rationale: agreement.riskDecisionReason ?? "",
  };
  return disposition === "waived"
    ? { level, evidence: { ...common, disposition, level: "Unassessed" } }
    : { level, evidence: { ...common, disposition, level: level as AssessedRiskLevel } };
}

export async function evaluateAgreementRiskReadiness(
  agreement: PersistedAgreementRisk,
  document: DocumentBasisRecord,
): Promise<Readonly<{ basisHash: string; evaluation: RiskAssessmentEvaluation }>> {
  const basisHash = await computeRiskAssessmentBasisHash(agreement, document);
  return {
    basisHash,
    evaluation: evaluateRiskAssessment(persistedRiskAssessmentState(agreement), {
      basisHash,
      documentVersion: document.version,
      documentSha256: document.sha256,
    }),
  };
}
