export type ApprovalPolicyAgreement = Readonly<{
  value: number;
  valueMinor?: number;
  currencyCode?: string;
  risk: string;
  riskDisposition?: string | null;
  approvalStatus: string;
  workflowPolicySha256?: string | null;
  workflowApprovalLanes?: readonly string[] | null;
}>;

export type ApprovalPolicyBasis = Readonly<{
  hash: string;
  documentVersion: number;
  documentSha256: string;
}>;

export const APPROVAL_VALUE_CURRENCY = "USD" as const;
export const FINANCE_APPROVAL_THRESHOLD_USD = 100_000;
export const FINANCE_APPROVAL_THRESHOLD_USD_MINOR = FINANCE_APPROVAL_THRESHOLD_USD * 100;
export const MAX_CURRENT_APPROVAL_LANES = 20;
export const APPROVAL_LANE_LIMIT_ERROR_CODE = "approval_lane_limit_reached";
export const APPROVAL_LANE_LIMIT_BLOCKER_CODE = "APPROVAL_LANE_LIMIT_REACHED";
export const APPROVAL_LANE_LIMIT_MESSAGE = `An exact agreement basis may have at most ${MAX_CURRENT_APPROVAL_LANES} current approval lanes.`;

export function approvalLaneLimitWouldBeExceeded(currentCount: number, additionalCount = 1): boolean {
  return !Number.isSafeInteger(currentCount)
    || currentCount < 0
    || !Number.isSafeInteger(additionalCount)
    || additionalCount < 0
    || currentCount + additionalCount > MAX_CURRENT_APPROVAL_LANES;
}

export type ApprovalPolicyRequest = Readonly<{
  role: string;
  status: string;
  requestedByUserId: string | null;
  decidedByUserId: string | null;
  /** Human who approved the machine plan that created this request. */
  sourceAgentPlanReviewerUserId?: string | null;
  basisConfirmedAt?: string | null;
  basisHash: string;
  documentVersion: number;
  documentSha256: string;
}>;

/**
 * Shipped starter policy. Every opted-in/required review needs Legal; high-risk
 * or over-100,000-USD work also needs Finance. Customers must approve or
 * deliberately replace this server policy before go-live.
 */
function financeReviewRequired(agreement: Pick<ApprovalPolicyAgreement, "value" | "valueMinor" | "currencyCode" | "risk" | "riskDisposition">): boolean {
  const currencyCode = agreement.currencyCode ?? APPROVAL_VALUE_CURRENCY;
  const amountMinor = agreement.valueMinor ?? agreement.value * 100;
  // The starter policy has no FX-rate dependency. Any material non-USD value
  // therefore goes to Finance; customers may replace this with a governed,
  // versioned workflow definition containing their approved currency limits.
  return agreement.risk === "High"
    || agreement.riskDisposition === "waived"
    || (currencyCode === APPROVAL_VALUE_CURRENCY
      ? amountMinor > FINANCE_APPROVAL_THRESHOLD_USD_MINOR
      : amountMinor > 0);
}

export function requiredApprovalRoles(agreement: Pick<ApprovalPolicyAgreement, "value" | "valueMinor" | "currencyCode" | "risk" | "riskDisposition" | "workflowPolicySha256" | "workflowApprovalLanes">): string[] {
  if (agreement.workflowPolicySha256) {
    const lanes = agreement.workflowApprovalLanes ?? [];
    // Published workflow snapshots are validated on write and protected by DB
    // checks. A malformed persisted snapshot remains fail-closed rather than
    // silently falling back to the starter policy.
    if (lanes.length < 1 || lanes.length > MAX_CURRENT_APPROVAL_LANES
      || lanes.some((lane) => typeof lane !== "string" || lane.trim() !== lane || lane.length < 1 || lane.length > 120)
      || new Set(lanes.map((lane) => lane.toLocaleLowerCase("en-US"))).size !== lanes.length) {
      return ["Workflow policy repair required"];
    }
    return [...lanes];
  }
  return financeReviewRequired(agreement)
    ? ["Legal", "Finance"]
    : ["Legal"];
}

export function repositoryRequiresApproval(agreement: Pick<ApprovalPolicyAgreement, "value" | "valueMinor" | "currencyCode" | "risk" | "riskDisposition" | "workflowPolicySha256" | "workflowApprovalLanes">): boolean {
  if (agreement.workflowPolicySha256) return true;
  return financeReviewRequired(agreement);
}

export function hasGovernedRiskDecision(
  agreement: Pick<ApprovalPolicyAgreement, "risk" | "riskDisposition">,
): boolean {
  return agreement.riskDisposition === "waived"
    ? agreement.risk === "Unassessed"
    : agreement.riskDisposition === "assessed" && ["Low", "Medium", "High"].includes(agreement.risk);
}

export function currentApprovalRequests(
  requests: readonly ApprovalPolicyRequest[],
  basis: ApprovalPolicyBasis,
): ApprovalPolicyRequest[] {
  return requests.filter((request) =>
    request.status !== "Superseded" &&
    request.basisHash === basis.hash &&
    request.documentVersion === basis.documentVersion &&
    request.documentSha256 === basis.documentSha256,
  );
}

export function evaluateApprovalPolicy(
  agreement: Pick<ApprovalPolicyAgreement, "value" | "valueMinor" | "currencyCode" | "risk" | "riskDisposition" | "workflowPolicySha256" | "workflowApprovalLanes">,
  requests: readonly ApprovalPolicyRequest[],
  basis: ApprovalPolicyBasis,
): "Pending" | "Approved" | "Changes requested" {
  const current = currentApprovalRequests(requests, basis);
  if (current.some((request) => request.status === "Changes requested")) return "Changes requested";
  const required = requiredApprovalRoles(agreement);
  const isSeparatedApproval = (request: ApprovalPolicyRequest) =>
    request.status === "Approved" &&
    Boolean(request.basisConfirmedAt) &&
    Boolean(request.requestedByUserId) &&
    Boolean(request.decidedByUserId) &&
    request.requestedByUserId !== request.decidedByUserId &&
    request.sourceAgentPlanReviewerUserId !== request.decidedByUserId;
  const requiredCandidates = required.map((role) => current.filter((request) =>
    request.role === role && isSeparatedApproval(request)));
  function hasDistinctRequiredDeciders(index: number, used: Set<string>): boolean {
    if (index === requiredCandidates.length) return true;
    return requiredCandidates[index].some((request) => {
      const decider = request.decidedByUserId!;
      if (used.has(decider)) return false;
      const next = new Set(used);
      next.add(decider);
      return hasDistinctRequiredDeciders(index + 1, next);
    });
  }
  const requiredComplete = requiredCandidates.every((candidates) => candidates.length > 0)
    && hasDistinctRequiredDeciders(0, new Set());
  return requiredComplete && current.length > 0 && current.every(isSeparatedApproval)
    ? "Approved"
    : "Pending";
}

export function approvalsSatisfyPolicy(
  agreement: ApprovalPolicyAgreement,
  requests: readonly ApprovalPolicyRequest[],
  basis: ApprovalPolicyBasis,
): boolean {
  if (!hasGovernedRiskDecision(agreement)) return false;
  if (agreement.approvalStatus === "Not required") return !repositoryRequiresApproval(agreement);
  return agreement.approvalStatus === "Approved" && evaluateApprovalPolicy(agreement, requests, basis) === "Approved";
}
