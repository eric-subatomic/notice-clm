import {
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { getDb } from "../../db";
import {
  agreementDocumentVersions,
  agreementEvents,
  agreements,
  agreementVersions,
  approvalRequests,
  mutationGuards,
  negotiationRounds,
  outboxEvents,
} from "../../db/schema";
import { computeAgreementEventHash } from "./audit-chain";
import { computeAgreementBasisHash } from "./agreement-basis";
import { evaluateAgreementRiskReadiness } from "./agreement-risk";
import {
  APPROVAL_LANE_LIMIT_ERROR_CODE,
  APPROVAL_LANE_LIMIT_MESSAGE,
  approvalLaneLimitWouldBeExceeded,
  evaluateApprovalPolicy,
  MAX_CURRENT_APPROVAL_LANES,
  requiredApprovalRoles,
  type ApprovalPolicyBasis,
} from "./approval-policy";
import {
  prepareAgreementLifecycleUpdatedIntegrationEvent,
  prepareIntegrationOutboxEvent,
} from "./integration-events";
import { normalizeIsoDate } from "./iso-date";
import { prepareAgreementSnapshot, type EventActor } from "./persistence";

const OPEN_NEGOTIATION_STATUSES = ["prepared", "outbound", "returned", "review"] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type Database = ReturnType<typeof getDb>;
type Agreement = typeof agreements.$inferSelect;
type ApprovalRequest = typeof approvalRequests.$inferSelect;
type WorkingDocument = typeof agreementDocumentVersions.$inferSelect;
type ApprovalLaneCommitSnapshot = Readonly<Pick<ApprovalRequest, "id" | "role" | "status" | "version">>;

export type ApprovalRoutingBatchItem = Parameters<Database["batch"]>[0][number];
export type ApprovalRoutingBatch = readonly [ApprovalRoutingBatchItem, ...ApprovalRoutingBatchItem[]];

export type ApprovalRoutingBlocker = Readonly<{
  code: string;
  message: string;
  status: number;
}>;

export type ApprovalRoutingPolicyReason = Readonly<{
  code: string;
  message: string;
}>;

export type RequiredApprovalRoutingPreview = Readonly<{
  schemaVersion: "1.0";
  actionId: "approval.request";
  mode: "ensure_required";
  input: Readonly<{ mode: "ensure_required"; due: string }>;
  target: Readonly<{
    resourceType: "agreement";
    resourceId: string;
    version: number | null;
    basisHash: string | null;
    documentVersion: number | null;
    documentSha256: string | null;
  }>;
  policy: Readonly<{
    requiredRoles: readonly string[];
    currentExactBasisLanes: readonly Readonly<{
      id: string;
      role: string;
      status: string;
      version: number;
    }>[];
    missingRoles: readonly string[];
    obsoleteApprovalIds: readonly string[];
    reasons: readonly ApprovalRoutingPolicyReason[];
  }>;
  effect: Readonly<{
    kind: "ensure_required_approval_lanes";
    noOp: boolean;
    willMutate: boolean;
    createdRoles: readonly string[];
    supersededApprovalIds: readonly string[];
    approvalStatus: string | null;
    nextAction: string | null;
    agreementVersion: number | null;
  }>;
  blockers: readonly ApprovalRoutingBlocker[];
}>;

export type RequiredApprovalRoutingInspection = Readonly<{
  targetState: "active" | "deleted" | "missing";
  due: string;
  agreement: Agreement | null;
  document: WorkingDocument | null;
  basis: ApprovalPolicyBasis | null;
  currentLanes: readonly ApprovalRequest[];
  requiredRoles: readonly string[];
  missingRoles: readonly string[];
  obsoleteApprovalIds: readonly string[];
  survivingCurrent: readonly ApprovalRequest[];
  resultingApprovalStatus: string | null;
  resultingNextAction: string | null;
  resultingAgreementVersion: number | null;
  policyReasons: readonly ApprovalRoutingPolicyReason[];
  blockers: readonly ApprovalRoutingBlocker[];
  noOp: boolean;
  preview: RequiredApprovalRoutingPreview;
}>;

export type RequiredApprovalCoveragePlan = Readonly<{
  roles: readonly string[];
  missingRoles: readonly string[];
  obsoleteApprovalIds: readonly string[];
  survivingCurrent: readonly ApprovalRequest[];
}>;

function actorId(actor: EventActor): string {
  return "userId" in actor ? actor.userId : actor.id;
}

function currentApprovalBasisPredicate(
  workspaceId: string,
  agreementId: number,
  basis: ApprovalPolicyBasis,
) {
  return and(
    eq(approvalRequests.workspaceId, workspaceId),
    eq(approvalRequests.agreementId, agreementId),
    ne(approvalRequests.status, "Superseded"),
    eq(approvalRequests.basisHash, basis.hash),
    eq(approvalRequests.documentVersion, basis.documentVersion),
    eq(approvalRequests.documentSha256, basis.documentSha256),
  );
}

function currentApprovalLaneCapGuard(
  db: Database,
  workspaceId: string,
  agreementId: number,
  basis: ApprovalPolicyBasis,
) {
  return notExists(db.select({ id: approvalRequests.id }).from(approvalRequests).where(
    currentApprovalBasisPredicate(workspaceId, agreementId, basis),
  ).limit(1).offset(MAX_CURRENT_APPROVAL_LANES));
}

/**
 * Bind every lane that survived inspection to the exact reviewer-visible row
 * version. A single JSON parameter keeps the maximum-lane query below D1's
 * bound-parameter limit while detecting claim-only updates that do not advance
 * the parent agreement version.
 */
export function exactSurvivingApprovalLaneCommitGuard(
  workspaceId: string,
  agreementId: number,
  basis: ApprovalPolicyBasis,
  surviving: readonly ApprovalLaneCommitSnapshot[],
) {
  const expected = JSON.stringify([...surviving]
    .map(({ id, role, status, version }) => ({ id, role, status, version }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return sql`not exists (
    select 1 from json_each(${expected}) as expected_lane
    where not exists (
      select 1 from ${approvalRequests}
      where ${approvalRequests.workspaceId} = ${workspaceId}
        and ${approvalRequests.agreementId} = ${agreementId}
        and ${approvalRequests.basisHash} = ${basis.hash}
        and ${approvalRequests.documentVersion} = ${basis.documentVersion}
        and ${approvalRequests.documentSha256} = ${basis.documentSha256}
        and ${approvalRequests.id} = json_extract(expected_lane.value, '$.id')
        and ${approvalRequests.role} = json_extract(expected_lane.value, '$.role')
        and ${approvalRequests.status} = json_extract(expected_lane.value, '$.status')
        and ${approvalRequests.version} = json_extract(expected_lane.value, '$.version')
    )
  )`;
}

function isValidCurrentRequest(candidate: ApprovalRequest): boolean {
  if (!candidate.requestedByUserId) return false;
  if (candidate.status === "Pending") return true;
  return candidate.status === "Approved"
    && Boolean(candidate.decidedByUserId)
    && Boolean(candidate.basisConfirmedAt)
    && candidate.requestedByUserId !== candidate.decidedByUserId
    && candidate.sourceAgentPlanReviewerUserId !== candidate.decidedByUserId;
}

/** Pure policy coverage calculation shared by inspection tests and both actors. */
export function deriveRequiredApprovalCoveragePlan(
  agreement: Pick<Agreement, "value" | "risk" | "riskDisposition">,
  current: readonly ApprovalRequest[],
): RequiredApprovalCoveragePlan {
  const roles = requiredApprovalRoles(agreement);
  const valid = current.filter(isValidCurrentRequest);
  const pendingRoles = new Set(valid
    .filter((candidate) => candidate.status === "Pending")
    .map((candidate) => candidate.role));
  const approvedOnlyRoles = roles.filter((role) => !pendingRoles.has(role));
  let bestMatchedRoles = new Set<string>();
  let bestTieBreak = "";
  const searchDistinctApprovedCoverage = (
    index: number,
    usedDeciders: ReadonlySet<string>,
    matchedRoles: ReadonlySet<string>,
    choices: readonly string[],
  ): void => {
    if (index === approvedOnlyRoles.length) {
      const tieBreak = choices.join("|");
      if (
        matchedRoles.size > bestMatchedRoles.size
        || (matchedRoles.size === bestMatchedRoles.size && (bestTieBreak === "" || tieBreak < bestTieBreak))
      ) {
        bestMatchedRoles = new Set(matchedRoles);
        bestTieBreak = tieBreak;
      }
      return;
    }
    const role = approvedOnlyRoles[index];
    const candidates = valid
      .filter((candidate) => candidate.role === role && candidate.status === "Approved" && candidate.decidedByUserId)
      .sort((left, right) => left.decidedByUserId! < right.decidedByUserId! ? -1
        : left.decidedByUserId! > right.decidedByUserId! ? 1
          : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    for (const candidate of candidates) {
      const decider = candidate.decidedByUserId!;
      if (usedDeciders.has(decider)) continue;
      searchDistinctApprovedCoverage(
        index + 1,
        new Set([...usedDeciders, decider]),
        new Set([...matchedRoles, role]),
        [...choices, `${role}:${decider}:${candidate.id}`],
      );
    }
    searchDistinctApprovedCoverage(index + 1, usedDeciders, matchedRoles, [...choices, `${role}:~`]);
  };
  searchDistinctApprovedCoverage(0, new Set(), new Set(), []);
  const missingRoles = roles.filter((role) => !pendingRoles.has(role) && !bestMatchedRoles.has(role));
  const obsoleteApprovalIds = current
    .filter((candidate) => !isValidCurrentRequest(candidate) || missingRoles.includes(candidate.role))
    .map((candidate) => candidate.id);
  const obsolete = new Set(obsoleteApprovalIds);
  return {
    roles,
    missingRoles,
    obsoleteApprovalIds,
    survivingCurrent: current.filter((candidate) => !obsolete.has(candidate.id)),
  };
}

function stablePolicyReasons(
  roles: readonly string[],
  current: readonly ApprovalRequest[],
  missingRoles: readonly string[],
  obsoleteApprovalIds: readonly string[],
): ApprovalRoutingPolicyReason[] {
  return [
    {
      code: "APPROVAL_POLICY_REQUIRED_ROLES",
      message: `Current policy requires ${roles.length > 0 ? roles.join(" and ") : "no"} approval lane${roles.length === 1 ? "" : "s"}.`,
    },
    {
      code: "APPROVAL_POLICY_EXACT_BASIS_LANES",
      message: `${current.length} non-superseded approval lane${current.length === 1 ? " is" : "s are"} bound to the exact current agreement paper.`,
    },
    {
      code: "APPROVAL_POLICY_MISSING_ROLES",
      message: missingRoles.length > 0
        ? `Missing valid coverage for ${missingRoles.join(" and ")}.`
        : "Every required role has valid exact-basis coverage.",
    },
    {
      code: "APPROVAL_POLICY_OBSOLETE_LANES",
      message: obsoleteApprovalIds.length > 0
        ? `${obsoleteApprovalIds.length} invalid or replaced lane${obsoleteApprovalIds.length === 1 ? " must" : "s must"} be superseded.`
        : "No exact-basis lanes need to be superseded.",
    },
  ];
}

function stableLanePreview(current: readonly ApprovalRequest[]) {
  return current
    .map((lane) => ({ id: lane.id, role: lane.role, status: lane.status, version: lane.version }))
    .sort((left, right) => left.role < right.role ? -1
      : left.role > right.role ? 1
        : left.id < right.id ? -1
          : left.id > right.id ? 1 : 0);
}

function makePreview(input: Readonly<{
  agreementId: number;
  due: string;
  agreement: Agreement | null;
  basis: ApprovalPolicyBasis | null;
  document: WorkingDocument | null;
  current: readonly ApprovalRequest[];
  roles: readonly string[];
  missingRoles: readonly string[];
  obsoleteApprovalIds: readonly string[];
  policyReasons: readonly ApprovalRoutingPolicyReason[];
  blockers: readonly ApprovalRoutingBlocker[];
  noOp: boolean;
  resultingApprovalStatus: string | null;
  resultingNextAction: string | null;
  resultingAgreementVersion: number | null;
}>): RequiredApprovalRoutingPreview {
  const willMutate = input.blockers.length === 0 && !input.noOp;
  return {
    schemaVersion: "1.0",
    actionId: "approval.request",
    mode: "ensure_required",
    input: { mode: "ensure_required", due: input.due },
    target: {
      resourceType: "agreement",
      resourceId: String(input.agreementId),
      version: input.agreement?.version ?? null,
      basisHash: input.basis?.hash ?? null,
      documentVersion: input.document?.version ?? null,
      documentSha256: input.document?.sha256 ?? null,
    },
    policy: {
      requiredRoles: [...input.roles],
      currentExactBasisLanes: stableLanePreview(input.current),
      missingRoles: [...input.missingRoles],
      obsoleteApprovalIds: [...input.obsoleteApprovalIds].sort(),
      reasons: input.policyReasons.map((reason) => ({ ...reason })),
    },
    effect: {
      kind: "ensure_required_approval_lanes",
      noOp: input.noOp,
      willMutate,
      createdRoles: [...input.missingRoles],
      supersededApprovalIds: [...input.obsoleteApprovalIds].sort(),
      approvalStatus: input.resultingApprovalStatus,
      nextAction: input.resultingNextAction,
      agreementVersion: input.resultingAgreementVersion,
    },
    blockers: input.blockers.map((blocker) => ({ ...blocker })),
  };
}

function unavailableInspection(input: Readonly<{
  targetState: "deleted" | "missing";
  agreementId: number;
  due: string;
}>): RequiredApprovalRoutingInspection {
  const blocker = {
    code: "agreement_not_found",
    message: "Agreement was not found.",
    status: 404,
  } as const;
  const preview = makePreview({
    agreementId: input.agreementId,
    due: input.due,
    agreement: null,
    basis: null,
    document: null,
    current: [],
    roles: [],
    missingRoles: [],
    obsoleteApprovalIds: [],
    policyReasons: [],
    blockers: [blocker],
    noOp: false,
    resultingApprovalStatus: null,
    resultingNextAction: null,
    resultingAgreementVersion: null,
  });
  return {
    targetState: input.targetState,
    due: input.due,
    agreement: null,
    document: null,
    basis: null,
    currentLanes: [],
    requiredRoles: [],
    missingRoles: [],
    obsoleteApprovalIds: [],
    survivingCurrent: [],
    resultingApprovalStatus: null,
    resultingNextAction: null,
    resultingAgreementVersion: null,
    policyReasons: [],
    blockers: [blocker],
    noOp: false,
    preview,
  };
}

/**
 * Read every state dimension that governs required approval routing. The result
 * is a domain object so HTTP and agent adapters can apply their own envelope
 * while comparing the same deterministic preview.
 */
export async function inspectRequiredApprovalRouting(input: Readonly<{
  db: Database;
  workspaceId: string;
  agreementId: number;
  due: string;
}>): Promise<RequiredApprovalRoutingInspection> {
  const due = normalizeIsoDate(input.due) ?? input.due;
  const [candidate] = await input.db.select().from(agreements).where(and(
    eq(agreements.workspaceId, input.workspaceId),
    eq(agreements.id, input.agreementId),
  )).limit(1);
  if (!candidate) return unavailableInspection({ targetState: "missing", agreementId: input.agreementId, due });
  if (candidate.deletedAt !== null) {
    // Deliberately collapse retained soft-deleted state to the ordinary
    // not-found projection so machine callers cannot use this service as an
    // existence oracle.
    return unavailableInspection({ targetState: "deleted", agreementId: input.agreementId, due });
  }

  const agreement = candidate;
  const [[documentCandidate], [openNegotiation]] = await Promise.all([
    input.db.select().from(agreementDocumentVersions).where(and(
      eq(agreementDocumentVersions.workspaceId, input.workspaceId),
      eq(agreementDocumentVersions.agreementId, agreement.id),
    )).orderBy(desc(agreementDocumentVersions.version)).limit(1),
    input.db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
      eq(negotiationRounds.workspaceId, input.workspaceId),
      eq(negotiationRounds.agreementId, agreement.id),
      or(
        inArray(negotiationRounds.status, OPEN_NEGOTIATION_STATUSES),
        isNotNull(negotiationRounds.activeKey),
      ),
    )).limit(1),
  ]);
  const document = documentCandidate
    && Number.isSafeInteger(documentCandidate.version)
    && documentCandidate.version > 0
    && SHA256_PATTERN.test(documentCandidate.sha256)
    ? documentCandidate
    : null;
  const basisHash = document ? await computeAgreementBasisHash(agreement, document) : null;
  const basis = document && basisHash ? {
    hash: basisHash,
    documentVersion: document.version,
    documentSha256: document.sha256,
  } satisfies ApprovalPolicyBasis : null;
  const current = basis
    ? await input.db.select().from(approvalRequests).where(
        currentApprovalBasisPredicate(input.workspaceId, agreement.id, basis),
      ).limit(MAX_CURRENT_APPROVAL_LANES + 1)
    : [];
  const coverage = deriveRequiredApprovalCoveragePlan(agreement, current);
  const policyReasons = stablePolicyReasons(
    coverage.roles,
    current,
    coverage.missingRoles,
    coverage.obsoleteApprovalIds,
  );
  const blockers: ApprovalRoutingBlocker[] = [];
  if (normalizeIsoDate(input.due) === null) {
    blockers.push({
      code: "invalid_approval_due_date",
      message: "Approval due date must be a valid date in YYYY-MM-DD format.",
      status: 400,
    });
  }
  if (agreement.stage === "Active" || agreement.signatureStatus === "Completed") {
    blockers.push({
      code: "executed_agreement_immutable",
      message: "Executed agreements cannot be routed through a new approval cycle. Create an amendment or replacement agreement.",
      status: 409,
    });
  }
  if (!document) {
    blockers.push({
      code: "document_version_required",
      message: "Create and review an immutable working document version before requesting approval.",
      status: 409,
    });
  }
  if (document) {
    const riskReadiness = await evaluateAgreementRiskReadiness(agreement, document);
    if (!riskReadiness.evaluation.cleared) {
      blockers.push({
        code: "risk_assessment_required",
        message: riskReadiness.evaluation.blockers[0]?.message ?? "A current risk decision is required before approval routing.",
        status: 409,
      });
    }
  }
  if (openNegotiation) {
    blockers.push({
      code: "negotiation_round_unresolved",
      message: "Resolve or close the current counterparty review round before requesting approval.",
      status: 409,
    });
  }
  if (current.some((candidate) => candidate.status === "Changes requested")) {
    blockers.push({
      code: "approval_changes_required",
      message: "Address the requested changes and save a new working version before routing approvals again.",
      status: 409,
    });
  }
  if (
    current.length > MAX_CURRENT_APPROVAL_LANES
    || approvalLaneLimitWouldBeExceeded(coverage.survivingCurrent.length, coverage.missingRoles.length)
  ) {
    blockers.push({
      code: APPROVAL_LANE_LIMIT_ERROR_CODE,
      message: APPROVAL_LANE_LIMIT_MESSAGE,
      status: 409,
    });
  }

  const aggregateStatus = basis
    ? evaluateApprovalPolicy(agreement, coverage.survivingCurrent, basis)
    : null;
  const noOp = blockers.length === 0
    && coverage.missingRoles.length === 0
    && coverage.obsoleteApprovalIds.length === 0
    && agreement.approvalStatus === aggregateStatus;
  const resultingApprovalStatus = blockers.length > 0
    ? agreement.approvalStatus
    : coverage.missingRoles.length > 0
      ? "Pending"
      : aggregateStatus;
  const resultingNextAction = blockers.length > 0 || noOp
    ? agreement.nextAction
    : resultingApprovalStatus === "Approved"
      ? "Send to counterparty"
      : `Complete ${coverage.roles.join(" and ")} approval`;
  const resultingAgreementVersion = blockers.length > 0 || noOp
    ? agreement.version
    : agreement.version + 1;
  const preview = makePreview({
    agreementId: agreement.id,
    due,
    agreement,
    basis,
    document,
    current,
    roles: coverage.roles,
    missingRoles: coverage.missingRoles,
    obsoleteApprovalIds: coverage.obsoleteApprovalIds,
    policyReasons,
    blockers,
    noOp,
    resultingApprovalStatus,
    resultingNextAction,
    resultingAgreementVersion,
  });

  return {
    targetState: "active",
    due,
    agreement,
    document,
    basis,
    currentLanes: current,
    requiredRoles: coverage.roles,
    missingRoles: coverage.missingRoles,
    obsoleteApprovalIds: coverage.obsoleteApprovalIds,
    survivingCurrent: coverage.survivingCurrent,
    resultingApprovalStatus,
    resultingNextAction,
    resultingAgreementVersion,
    policyReasons,
    blockers,
    noOp,
    preview,
  };
}

export type ApprovalRoutingAttribution = Readonly<{
  sourceAgentPlanId: string;
  sourceAgentPlanReviewerUserId: string;
  servicePrincipalId: string;
}>;

export type ApprovalRoutingIds = Readonly<{
  approvalsByRole?: Readonly<Record<string, string>>;
  approvalOutboxesByRole?: Readonly<Record<string, string>>;
  eventId?: string;
  snapshotId?: string;
  agreementOutboxId?: string;
  agreementGuardId?: string;
}>;

export type ApprovalRoutingIdPurpose =
  | `approval:${string}`
  | `approval-outbox:${string}`
  | "event"
  | "snapshot"
  | "agreement-outbox"
  | "agreement-guard";

export type RequiredApprovalRoutingBuild = Readonly<{
  statements: ApprovalRoutingBatch;
  createdApprovals: readonly ApprovalRequest[];
  event: typeof agreementEvents.$inferInsert;
  snapshot: typeof agreementVersions.$inferInsert;
  outboxes: readonly (typeof outboxEvents.$inferInsert)[];
  agreement: Agreement;
  result: Readonly<{
    approvals: readonly ApprovalRequest[];
    agreement: Agreement;
    event: typeof agreementEvents.$inferInsert;
    createdRoles: readonly string[];
  }>;
  guardIds: Readonly<{ agreement: string }>;
}>;

function outboxRow(
  id: string,
  now: string,
  event: ReturnType<typeof prepareIntegrationOutboxEvent>,
): typeof outboxEvents.$inferInsert {
  return {
    id,
    workspaceId: event.workspaceId,
    topic: event.topic,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload,
    status: "pending",
    attempts: 0,
    availableAt: now,
    lockedAt: null,
    processedAt: null,
    lastError: null,
    createdAt: now,
  };
}

function requireAttributionConsistency(
  attribution: ApprovalRoutingAttribution | undefined,
): void {
  if (!attribution) return;
  if (
    !attribution.sourceAgentPlanId
    || !attribution.sourceAgentPlanReviewerUserId
    || !attribution.servicePrincipalId
  ) {
    throw new Error("Agent approval attribution is incomplete.");
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

async function assertExecutableInspection(inspection: RequiredApprovalRoutingInspection): Promise<void> {
  const agreement = inspection.agreement!;
  const document = inspection.document!;
  const basis = inspection.basis!;
  if (
    normalizeIsoDate(inspection.due) === null
    || agreement.deletedAt !== null
    || agreement.stage === "Active"
    || agreement.signatureStatus === "Completed"
    || document.workspaceId !== agreement.workspaceId
    || document.agreementId !== agreement.id
    || document.version !== basis.documentVersion
    || document.sha256 !== basis.documentSha256
    || !SHA256_PATTERN.test(document.sha256)
  ) {
    throw new Error("Approval routing inspection contains an ineligible target or document.");
  }
  const [computedBasisHash, riskReadiness] = await Promise.all([
    computeAgreementBasisHash(agreement, document),
    evaluateAgreementRiskReadiness(agreement, document),
  ]);
  if (computedBasisHash !== basis.hash || !riskReadiness.evaluation.cleared) {
    throw new Error("Approval routing inspection contains stale basis or risk evidence.");
  }
  if (
    inspection.currentLanes.length > MAX_CURRENT_APPROVAL_LANES
    || inspection.currentLanes.some((lane) => lane.status === "Changes requested")
    || inspection.currentLanes.some((lane) =>
      lane.workspaceId !== agreement.workspaceId
      || lane.agreementId !== agreement.id
      || lane.status === "Superseded"
      || lane.basisHash !== basis.hash
      || lane.documentVersion !== document.version
      || lane.documentSha256 !== document.sha256)
  ) {
    throw new Error("Approval routing inspection contains lanes outside the exact current basis.");
  }
  const coverage = deriveRequiredApprovalCoveragePlan(agreement, inspection.currentLanes);
  if (
    approvalLaneLimitWouldBeExceeded(coverage.survivingCurrent.length, coverage.missingRoles.length)
    || !sameIds(coverage.obsoleteApprovalIds, inspection.obsoleteApprovalIds)
    || !sameIds(coverage.survivingCurrent.map((lane) => lane.id), inspection.survivingCurrent.map((lane) => lane.id))
    || JSON.stringify(coverage.roles) !== JSON.stringify(inspection.requiredRoles)
    || JSON.stringify(coverage.missingRoles) !== JSON.stringify(inspection.missingRoles)
  ) {
    throw new Error("Approval routing inspection no longer represents current policy coverage.");
  }
  const aggregateStatus = evaluateApprovalPolicy(agreement, coverage.survivingCurrent, basis);
  if (
    coverage.missingRoles.length === 0
    && coverage.obsoleteApprovalIds.length === 0
    && agreement.approvalStatus === aggregateStatus
  ) {
    throw new Error("Approval routing inspection represents a no-op.");
  }
  const approvalStatus = coverage.missingRoles.length > 0 ? "Pending" : aggregateStatus;
  const nextAction = approvalStatus === "Approved"
    ? "Send to counterparty"
    : `Complete ${coverage.roles.join(" and ")} approval`;
  const policyReasons = stablePolicyReasons(
    coverage.roles,
    inspection.currentLanes,
    coverage.missingRoles,
    coverage.obsoleteApprovalIds,
  );
  const expectedPreview = makePreview({
    agreementId: agreement.id,
    due: inspection.due,
    agreement,
    basis,
    document,
    current: inspection.currentLanes,
    roles: coverage.roles,
    missingRoles: coverage.missingRoles,
    obsoleteApprovalIds: coverage.obsoleteApprovalIds,
    policyReasons,
    blockers: [],
    noOp: false,
    resultingApprovalStatus: approvalStatus,
    resultingNextAction: nextAction,
    resultingAgreementVersion: agreement.version + 1,
  });
  if (
    inspection.resultingApprovalStatus !== approvalStatus
    || inspection.resultingNextAction !== nextAction
    || inspection.resultingAgreementVersion !== agreement.version + 1
    || JSON.stringify(inspection.policyReasons) !== JSON.stringify(policyReasons)
    || JSON.stringify(inspection.preview) !== JSON.stringify(expectedPreview)
  ) {
    throw new Error("Approval routing inspection contains caller-authored or stale effects.");
  }
}

/**
 * Build, but do not execute, the guarded routing mutation. Agent execution can
 * append receipt/plan finalizers to `finalStatements`, keeping every approval,
 * audit, snapshot, outbox, and execution effect in one D1 batch.
 */
export async function buildRequiredApprovalRoutingStatements(input: Readonly<{
  db: Database;
  inspection: RequiredApprovalRoutingInspection;
  workspaceId: string;
  requestedByUserId: string;
  actor: EventActor;
  requestId: string;
  now: string;
  attribution?: ApprovalRoutingAttribution;
  ids?: ApprovalRoutingIds;
  idFactory?: (purpose: ApprovalRoutingIdPurpose) => string;
  finalStatements?: readonly ApprovalRoutingBatchItem[];
}>): Promise<RequiredApprovalRoutingBuild> {
  const inspection = input.inspection;
  if (inspection.targetState !== "active" || !inspection.agreement || !inspection.document || !inspection.basis) {
    throw new Error("Approval routing cannot be built without an active exact-basis inspection.");
  }
  if (inspection.blockers.length > 0) {
    throw new Error(`Approval routing is blocked: ${inspection.blockers[0].code}`);
  }
  if (inspection.noOp) {
    throw new Error("A no-op approval routing inspection has no mutation statements.");
  }
  if (inspection.agreement.workspaceId !== input.workspaceId) {
    throw new Error("Approval routing inspection belongs to another workspace.");
  }
  await assertExecutableInspection(inspection);
  // requestedByUserId remains the sponsoring/delegating human. The reviewer
  // is separate durable attribution and is independently excluded by the
  // approval decision separation checks.
  requireAttributionConsistency(input.attribution);

  const resolveId = (purpose: ApprovalRoutingIdPurpose): string => {
    const role = purpose.includes(":") ? purpose.slice(purpose.indexOf(":") + 1) : null;
    const explicit = purpose === "event" ? input.ids?.eventId
      : purpose === "snapshot" ? input.ids?.snapshotId
        : purpose === "agreement-outbox" ? input.ids?.agreementOutboxId
          : purpose === "agreement-guard" ? input.ids?.agreementGuardId
            : purpose.startsWith("approval-outbox:") && role
              ? input.ids?.approvalOutboxesByRole?.[role]
              : purpose.startsWith("approval:") && role
                ? input.ids?.approvalsByRole?.[role]
                : undefined;
    const resolved = explicit ?? input.idFactory?.(purpose) ?? crypto.randomUUID();
    if (!resolved) throw new Error(`Approval routing ID factory returned an empty ${purpose} ID.`);
    return resolved;
  };

  const agreement = inspection.agreement;
  const document = inspection.document;
  const basis = inspection.basis;
  const sourceFields = input.attribution ? {
    sourceAgentPlanId: input.attribution.sourceAgentPlanId,
    sourceAgentPlanReviewerUserId: input.attribution.sourceAgentPlanReviewerUserId,
  } : {};
  const created = inspection.missingRoles.map((role): ApprovalRequest => ({
    id: resolveId(`approval:${role}`),
    workspaceId: input.workspaceId,
    version: 1,
    agreementId: agreement.id,
    basisHash: basis.hash,
    documentVersion: document.version,
    documentSha256: document.sha256,
    role,
    requestedByUserId: input.requestedByUserId,
    approver: `Unassigned ${role}`,
    approverUserId: null,
    status: "Pending",
    decidedByUserId: null,
    decidedAt: null,
    basisConfirmedAt: null,
    sourceAgentPlanId: sourceFields.sourceAgentPlanId ?? null,
    sourceAgentPlanReviewerUserId: sourceFields.sourceAgentPlanReviewerUserId ?? null,
    comment: null,
    due: inspection.due,
    createdAt: input.now,
  }));
  const agreementPatch = {
    approvalStatus: inspection.resultingApprovalStatus!,
    nextAction: inspection.resultingNextAction!,
    version: inspection.resultingAgreementVersion!,
    updated: input.now,
    updatedAt: input.now,
    updatedByUserId: input.requestedByUserId,
  };
  const savedAgreement: Agreement = { ...agreement, ...agreementPatch };
  const attributionDetail = input.attribution
    ? ` Approved agent plan ${input.attribution.sourceAgentPlanId} executed by service principal ${input.attribution.servicePrincipalId}.`
    : "";
  const detail = created.length > 0
    ? `Atomically routed missing ${inspection.missingRoles.join(" and ")} approval${inspection.missingRoles.length === 1 ? "" : "s"} for working version ${document.version} (${document.sha256.slice(0, 12)}…).${attributionDetail}`
    : `Reconciled the aggregate approval state for working version ${document.version}.${attributionDetail}`;
  const [previous] = await input.db.select({
    sequence: agreementEvents.sequence,
    eventHash: agreementEvents.eventHash,
  }).from(agreementEvents).where(and(
    eq(agreementEvents.workspaceId, input.workspaceId),
    eq(agreementEvents.agreementId, agreement.id),
  )).orderBy(desc(agreementEvents.sequence)).limit(1);
  const eventData = {
    id: resolveId("event"),
    workspaceId: input.workspaceId,
    agreementId: agreement.id,
    sequence: (previous?.sequence ?? 0) + 1,
    type: "Approval",
    actorUserId: actorId(input.actor),
    actorEmail: input.actor.email,
    actor: input.actor.displayName.slice(0, 200),
    detail: detail.slice(0, 4_000),
    previousHash: previous?.eventHash ?? null,
    sourceAgentPlanId: input.attribution?.sourceAgentPlanId ?? null,
    createdAt: input.now,
  };
  const event: typeof agreementEvents.$inferInsert = {
    ...eventData,
    eventHash: await computeAgreementEventHash(eventData),
  };
  const snapshotJson = JSON.parse(JSON.stringify(savedAgreement)) as Record<string, unknown>;
  const preparedSnapshot = await prepareAgreementSnapshot(
    savedAgreement,
    input.requestedByUserId,
    event.id,
  );
  const snapshot: typeof agreementVersions.$inferInsert = {
    ...preparedSnapshot,
    id: resolveId("snapshot"),
    snapshot: snapshotJson,
    createdAt: input.now,
  };
  const attributionPayload = input.attribution ? {
    sourceAgentPlanId: input.attribution.sourceAgentPlanId,
    sourceAgentPlanReviewerUserId: input.attribution.sourceAgentPlanReviewerUserId,
    servicePrincipalId: input.attribution.servicePrincipalId,
  } : {};
  const outboxes = created.map((approval) => outboxRow(
    resolveId(`approval-outbox:${approval.role}`),
    input.now,
    prepareIntegrationOutboxEvent({
      workspaceId: input.workspaceId,
      topic: "approval.requested",
      aggregateType: "approval",
      aggregateId: approval.id,
      payload: {
        approvalId: approval.id,
        agreementId: agreement.id,
        requestedByUserId: approval.requestedByUserId,
        approverUserId: null,
        documentVersion: document.version,
        documentSha256: document.sha256,
        basisHash: basis.hash,
        aggregateVersion: approval.version,
        causationId: input.requestId,
        ...attributionPayload,
      },
    }),
  ));
  const agreementIntegrationEvent = prepareAgreementLifecycleUpdatedIntegrationEvent({
    before: agreement,
    agreement: savedAgreement,
    candidateFields: ["approvalStatus"],
    causationId: input.requestId,
  });
  if (agreementIntegrationEvent) {
    outboxes.push(outboxRow(resolveId("agreement-outbox"), input.now, agreementIntegrationEvent));
  }
  const agreementGuardId = resolveId("agreement-guard");
  const expectedPostMutationLaneCount = inspection.survivingCurrent.length + created.length;
  const expectedPostMutationLaneIds = [
    ...inspection.survivingCurrent.map((lane) => lane.id),
    ...created.map((lane) => lane.id),
  ];
  const guardedAgreementUpdate = input.db.update(agreements).set(agreementPatch).where(and(
    eq(agreements.workspaceId, input.workspaceId),
    eq(agreements.id, agreement.id),
    eq(agreements.version, agreement.version),
    eq(agreements.nextAction, agreement.nextAction),
    eq(agreements.stage, agreement.stage),
    eq(agreements.signatureStatus, agreement.signatureStatus),
    eq(agreements.risk, agreement.risk),
    agreement.riskDisposition === null
      ? isNull(agreements.riskDisposition)
      : eq(agreements.riskDisposition, agreement.riskDisposition),
    agreement.riskBasisHash === null
      ? isNull(agreements.riskBasisHash)
      : eq(agreements.riskBasisHash, agreement.riskBasisHash),
    agreement.riskDocumentVersion === null
      ? isNull(agreements.riskDocumentVersion)
      : eq(agreements.riskDocumentVersion, agreement.riskDocumentVersion),
    agreement.riskDocumentSha256 === null
      ? isNull(agreements.riskDocumentSha256)
      : eq(agreements.riskDocumentSha256, agreement.riskDocumentSha256),
    agreement.riskDecisionReason === null
      ? isNull(agreements.riskDecisionReason)
      : eq(agreements.riskDecisionReason, agreement.riskDecisionReason),
    agreement.riskDecidedByUserId === null
      ? isNull(agreements.riskDecidedByUserId)
      : eq(agreements.riskDecidedByUserId, agreement.riskDecidedByUserId),
    agreement.riskDecidedAt === null
      ? isNull(agreements.riskDecidedAt)
      : eq(agreements.riskDecidedAt, agreement.riskDecidedAt),
    isNull(agreements.deletedAt),
    exists(input.db.select({ id: agreementDocumentVersions.id }).from(agreementDocumentVersions).where(and(
      eq(agreementDocumentVersions.workspaceId, input.workspaceId),
      eq(agreementDocumentVersions.agreementId, agreement.id),
      eq(agreementDocumentVersions.version, document.version),
      eq(agreementDocumentVersions.sha256, document.sha256),
    ))),
    notExists(input.db.select({ id: agreementDocumentVersions.id }).from(agreementDocumentVersions).where(and(
      eq(agreementDocumentVersions.workspaceId, input.workspaceId),
      eq(agreementDocumentVersions.agreementId, agreement.id),
      gt(agreementDocumentVersions.version, document.version),
    ))),
    notExists(input.db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
      eq(negotiationRounds.workspaceId, input.workspaceId),
      eq(negotiationRounds.agreementId, agreement.id),
      or(
        inArray(negotiationRounds.status, OPEN_NEGOTIATION_STATUSES),
        isNotNull(negotiationRounds.activeKey),
      ),
    ))),
    currentApprovalLaneCapGuard(input.db, input.workspaceId, agreement.id, basis),
    exactSurvivingApprovalLaneCommitGuard(
      input.workspaceId,
      agreement.id,
      basis,
      inspection.survivingCurrent,
    ),
    notExists(input.db.select({ id: approvalRequests.id }).from(approvalRequests).where(and(
      currentApprovalBasisPredicate(input.workspaceId, agreement.id, basis),
      notInArray(approvalRequests.id, expectedPostMutationLaneIds),
    ))),
    sql`(
      select count(*) from ${approvalRequests}
      where ${approvalRequests.workspaceId} = ${input.workspaceId}
        and ${approvalRequests.agreementId} = ${agreement.id}
        and ${approvalRequests.status} <> 'Superseded'
        and ${approvalRequests.basisHash} = ${basis.hash}
        and ${approvalRequests.documentVersion} = ${basis.documentVersion}
        and ${approvalRequests.documentSha256} = ${basis.documentSha256}
    ) = ${expectedPostMutationLaneCount}`,
  ));

  const statements = [
    ...(inspection.obsoleteApprovalIds.length > 0 ? [input.db.update(approvalRequests).set({
      status: "Superseded",
      version: sql`${approvalRequests.version} + 1`,
    }).where(and(
      eq(approvalRequests.workspaceId, input.workspaceId),
      eq(approvalRequests.agreementId, agreement.id),
      inArray(approvalRequests.id, [...inspection.obsoleteApprovalIds]),
      currentApprovalBasisPredicate(input.workspaceId, agreement.id, basis),
    ))] : []),
    ...(created.length > 0 ? [input.db.insert(approvalRequests).values(created)] : []),
    guardedAgreementUpdate,
    input.db.insert(mutationGuards).values({
      id: agreementGuardId,
      workspaceId: input.workspaceId,
      operation: input.attribution ? "agent.approval.request.agreement" : "approval.ensure_required.agreement",
      guardChanges: sql<number>`changes()`,
      createdAt: input.now,
    }),
    input.db.insert(agreementEvents).values(event),
    input.db.insert(agreementVersions).values(snapshot),
    ...(outboxes.length > 0 ? [input.db.insert(outboxEvents).values(outboxes)] : []),
    input.db.delete(mutationGuards).where(and(
      eq(mutationGuards.workspaceId, input.workspaceId),
      eq(mutationGuards.id, agreementGuardId),
    )),
    ...(input.finalStatements ?? []),
  ] as unknown as ApprovalRoutingBatch;

  return {
    statements,
    createdApprovals: created,
    event,
    snapshot,
    outboxes,
    agreement: savedAgreement,
    result: {
      approvals: [...inspection.survivingCurrent, ...created],
      agreement: savedAgreement,
      event,
      createdRoles: inspection.missingRoles,
    },
    guardIds: { agreement: agreementGuardId },
  };
}
