import { sha256Hex } from "./document-security";

export type AgreementBasisRecord = Readonly<{
  workspaceId: string;
  id: number;
  party: string;
  side: string;
  type: string;
  value: number;
  valueMinor?: number;
  currencyCode?: string;
  department: string;
  risk: string;
  riskDisposition?: string | null;
  effectiveDate: string;
  expirationDate: string;
  workflowDefinitionId?: string | null;
  workflowPolicySha256?: string | null;
  workflowApprovalLanes?: readonly string[] | null;
}>;

export type DocumentBasisRecord = Readonly<{
  version: number;
  sha256: string;
}>;

/**
 * Stable digest of the material agreement metadata and exact working paper.
 * Workflow-only fields (stage, approval status, next action) are intentionally
 * excluded so recording a decision cannot invalidate the basis it approves.
 */
export async function computeAgreementBasisHash(
  agreement: AgreementBasisRecord,
  document: DocumentBasisRecord,
): Promise<string> {
  return sha256Hex(JSON.stringify({
    schemaVersion: "3.0",
    workspaceId: agreement.workspaceId,
    agreementId: agreement.id,
    party: agreement.party,
    side: agreement.side,
    type: agreement.type,
    value: agreement.value,
    valueMinor: agreement.valueMinor ?? agreement.value * 100,
    currencyCode: agreement.currencyCode ?? "USD",
    department: agreement.department,
    risk: agreement.risk,
    riskDisposition: agreement.riskDisposition ?? null,
    effectiveDate: agreement.effectiveDate,
    expirationDate: agreement.expirationDate,
    workflowDefinitionId: agreement.workflowDefinitionId ?? null,
    workflowPolicySha256: agreement.workflowPolicySha256 ?? null,
    workflowApprovalLanes: agreement.workflowApprovalLanes ?? null,
    documentVersion: document.version,
    documentSha256: document.sha256,
  }));
}

/**
 * Basis used by the risk decision itself. Risk output is deliberately excluded
 * so recording an assessment cannot invalidate the evidence that authorized
 * it. Approval/signature basis above includes the resulting risk decision.
 */
export async function computeRiskAssessmentBasisHash(
  agreement: AgreementBasisRecord,
  document: DocumentBasisRecord,
): Promise<string> {
  return sha256Hex(JSON.stringify({
    schemaVersion: "2.0",
    purpose: "risk-assessment",
    workspaceId: agreement.workspaceId,
    agreementId: agreement.id,
    party: agreement.party,
    side: agreement.side,
    type: agreement.type,
    value: agreement.value,
    valueMinor: agreement.valueMinor ?? agreement.value * 100,
    currencyCode: agreement.currencyCode ?? "USD",
    department: agreement.department,
    effectiveDate: agreement.effectiveDate,
    expirationDate: agreement.expirationDate,
    workflowDefinitionId: agreement.workflowDefinitionId ?? null,
    workflowPolicySha256: agreement.workflowPolicySha256 ?? null,
    workflowApprovalLanes: agreement.workflowApprovalLanes ?? null,
    documentVersion: document.version,
    documentSha256: document.sha256,
  }));
}
