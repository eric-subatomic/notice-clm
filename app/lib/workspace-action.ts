export type WorkspaceActionKind =
  | "obligations"
  | "signature"
  | "signature_status"
  | "counterparty_exchange"
  | "document_review"
  | "changes"
  | "request_approval"
  | "review_approvals"
  | "advance";

export type WorkspaceAction = Readonly<{
  kind: WorkspaceActionKind;
  label: string;
  available: boolean;
}>;

export function isActiveNegotiationQueueAction(nextAction: string): boolean {
  const normalized = nextAction.trim().toLowerCase();
  return normalized.includes("negotiation round")
    || /^close failed delivery round \d+ and prepare a new review round$/.test(normalized);
}

function initialDocumentAction(nextAction: string): WorkspaceAction | null {
  switch (nextAction.trim().toLowerCase()) {
    case "review the generated working draft":
      return { kind: "document_review", label: "Review working draft", available: true };
    case "review the imported source and prepare the working paper":
      return { kind: "document_review", label: "Review imported contract", available: true };
    case "add a source document or create a working paper":
      return { kind: "document_review", label: "Add working paper", available: true };
    default:
      return null;
  }
}

export function deriveWorkspaceAction(input: Readonly<{
  stage: "Intake" | "Draft" | "Review" | "Negotiation" | "Signature" | "Active";
  nextAction: string;
  approvalStatus: "Not required" | "Required" | "Pending" | "Approved" | "Changes requested";
  openChanges: number;
  canRequestApprovals: boolean;
  canUpdateAgreement: boolean;
  signatureInFlight: boolean;
  nextStage: string | null;
}>): WorkspaceAction {
  if (input.stage === "Active") return { kind: "obligations", label: "View obligations", available: true };
  if (isActiveNegotiationQueueAction(input.nextAction)) {
    return { kind: "counterparty_exchange", label: "Review counterparty exchange", available: true };
  }
  const documentAction = initialDocumentAction(input.nextAction);
  if (documentAction) return documentAction;
  if (input.stage === "Signature") {
    if (input.signatureInFlight) {
      return { kind: "signature_status", label: "View signature status", available: true };
    }
    return {
      kind: "signature",
      label: "Create signature packet",
      available: input.canUpdateAgreement,
    };
  }
  if (input.openChanges > 0) {
    return {
      kind: "changes",
      label: `Review ${input.openChanges} change${input.openChanges === 1 ? "" : "s"}`,
      available: true,
    };
  }
  if (input.approvalStatus === "Required") {
    return input.canRequestApprovals
      ? { kind: "request_approval", label: "Request approval", available: true }
      : { kind: "review_approvals", label: "Approval required", available: true };
  }
  if (input.approvalStatus === "Pending") {
    return input.canRequestApprovals
      ? { kind: "request_approval", label: "Check approval routing", available: true }
      : { kind: "review_approvals", label: "Review approvals", available: true };
  }
  if (input.approvalStatus === "Changes requested") {
    return { kind: "review_approvals", label: "Review approvals", available: true };
  }
  return {
    kind: "advance",
    label: input.nextStage ? `Advance to ${input.nextStage}` : "Review contract",
    available: input.canUpdateAgreement,
  };
}
