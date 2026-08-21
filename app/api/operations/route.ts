import { and, asc, desc, eq, exists, inArray, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { ensureStorageSchema } from "../../../db/ensure";
import {
  agreementEvents,
  agreementDocumentVersions,
  agreements,
  agreementVersions,
  approvalRequests,
  mutationGuards,
  obligationCreationReceipts,
  obligationEvidence,
  obligationSchedules,
  obligations,
  outboxEvents,
  signaturePackets,
  users,
  workflowDefinitions,
  workspaceMemberships,
} from "../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../lib/api";
import { computeAgreementBasisHash, computeRiskAssessmentBasisHash } from "../../lib/agreement-basis";
import { evaluateAgreementRiskReadiness } from "../../lib/agreement-risk";
import {
  approvalLaneAuthorityCommitPredicate,
  evaluateApprovalLaneAuthority,
} from "../../lib/approval-authority";
import {
  buildRequiredApprovalRoutingStatements,
  inspectRequiredApprovalRouting,
} from "../../lib/approval-routing-service";
import {
  APPROVAL_LANE_LIMIT_ERROR_CODE,
  APPROVAL_LANE_LIMIT_MESSAGE,
  approvalLaneLimitWouldBeExceeded,
  evaluateApprovalPolicy,
  MAX_CURRENT_APPROVAL_LANES,
  repositoryRequiresApproval,
  requiredApprovalRoles,
  type ApprovalPolicyBasis,
} from "../../lib/approval-policy";
import { apiError, apiJson } from "../../lib/http";
import { sha256Hex } from "../../lib/document-security";
import { canonicalDocumentUploadIdempotencyKey } from "../../lib/document-upload-idempotency";
import { prepareAgreementLifecycleUpdatedIntegrationEvent, prepareAgreementUpdatedIntegrationEvent, prepareIntegrationOutboxEvent } from "../../lib/integration-events";
import {
  appendAgreementEvent,
  findActiveAgreement,
  isAgreementEventSequenceConflict,
  isMutationGuardConflict,
  prepareAgreementEvent,
  prepareAgreementSnapshot,
  prepareOutboxEvent,
} from "../../lib/persistence";
import { obligationCalendarDateInTimeZone } from "../../lib/obligation-recurrence";
import { buildInitialObligationScheduleState } from "../../lib/obligation-scheduler";
import { operationMutationSchema, parseJson } from "../../lib/validation";
import { EnterpriseError } from "../../lib/enterprise-domain";
import { governedWorkflowSnapshot } from "../../lib/workflow-policy";

const ACTIVE_SIGNATURE_STATUSES = ["creating", "pending", "partially_signed", "reconciling", "archived", "completed_review_required"] as const;
const OBLIGATION_OWNER_ROLES = ["admin", "legal", "approver", "requester"] as const;

type Database = ReturnType<typeof getDb>;

async function findEligibleObligationOwner(db: Database, workspaceId: string, userId: string) {
  const [member] = await db.select({
    userId: workspaceMemberships.userId,
    displayName: users.displayName,
    role: workspaceMemberships.role,
  }).from(workspaceMemberships).innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
    eq(workspaceMemberships.workspaceId, workspaceId),
    eq(workspaceMemberships.userId, userId),
    eq(workspaceMemberships.status, "active"),
    eq(users.status, "active"),
    inArray(workspaceMemberships.role, OBLIGATION_OWNER_ROLES),
  )).limit(1);
  return member ?? null;
}

function isObligationEvidenceConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("uq_obligation_evidence_workspace_obligation")
    || (message.includes("unique constraint failed")
      && message.includes("obligation_evidence.workspace_id")
      && message.includes("obligation_evidence.obligation_id"));
}

async function replayObligationCreation(
  db: Database,
  input: Readonly<{
    workspaceId: string;
    userId: string;
    idempotencyKey: string;
    requestSha256: string;
    requestId: string;
    headers: HeadersInit;
  }>,
): Promise<Response | null> {
  const [receipt] = await db.select().from(obligationCreationReceipts).where(and(
    eq(obligationCreationReceipts.workspaceId, input.workspaceId),
    eq(obligationCreationReceipts.userId, input.userId),
    eq(obligationCreationReceipts.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (!receipt) return null;
  if (receipt.requestSha256 !== input.requestSha256) {
    return apiError(
      "idempotency_key_conflict",
      "This obligation-creation key was already used with different schedule data. Use a new key for a different schedule.",
      { status: 409, requestId: input.requestId, headers: input.headers },
    );
  }
  const [[scheduleRow], [obligationRow], [eventRow]] = await Promise.all([
    db.select({ schedule: obligationSchedules }).from(obligationSchedules).innerJoin(agreements, and(
      eq(agreements.workspaceId, obligationSchedules.workspaceId),
      eq(agreements.id, obligationSchedules.agreementId),
      isNull(agreements.deletedAt),
    )).where(and(
      eq(obligationSchedules.workspaceId, input.workspaceId),
      eq(obligationSchedules.agreementId, receipt.agreementId),
      eq(obligationSchedules.id, receipt.scheduleId),
    )).limit(1),
    db.select({ obligation: obligations }).from(obligations).innerJoin(agreements, and(
      eq(agreements.workspaceId, obligations.workspaceId),
      eq(agreements.id, obligations.agreementId),
      isNull(agreements.deletedAt),
    )).where(and(
      eq(obligations.workspaceId, input.workspaceId),
      eq(obligations.agreementId, receipt.agreementId),
      eq(obligations.scheduleId, receipt.scheduleId),
      eq(obligations.id, receipt.obligationId),
    )).limit(1),
    db.select().from(agreementEvents).innerJoin(agreements, and(
      eq(agreements.workspaceId, agreementEvents.workspaceId),
      eq(agreements.id, agreementEvents.agreementId),
      isNull(agreements.deletedAt),
    )).where(and(
      eq(agreementEvents.workspaceId, input.workspaceId),
      eq(agreementEvents.agreementId, receipt.agreementId),
      eq(agreementEvents.id, receipt.agreementEventId),
    )).limit(1).then((rows) => rows.map((row) => row.agreement_events)),
  ]);
  if (!scheduleRow || !obligationRow || !eventRow) {
    return apiError(
      "idempotency_target_unavailable",
      "The prior obligation-creation target is no longer active. Use a new key only after selecting an active agreement.",
      { status: 409, requestId: input.requestId, headers: input.headers },
    );
  }
  const replayHeaders = new Headers(input.headers);
  replayHeaders.set("Idempotency-Replayed", "true");
  return apiJson({
    schedule: scheduleRow.schedule,
    obligation: obligationRow.obligation,
    event: eventRow,
    replay: true,
    requestId: input.requestId,
  }, { requestId: input.requestId, headers: replayHeaders });
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

function loadCurrentApprovalLanes(
  db: Database,
  workspaceId: string,
  agreementId: number,
  basis: ApprovalPolicyBasis,
) {
  return db.select().from(approvalRequests).where(
    currentApprovalBasisPredicate(workspaceId, agreementId, basis),
  ).limit(MAX_CURRENT_APPROVAL_LANES + 1);
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

function approvalLaneLimitError(requestId: string): Response {
  return apiError(APPROVAL_LANE_LIMIT_ERROR_CODE, APPROVAL_LANE_LIMIT_MESSAGE, { status: 409, requestId });
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:read");
  if (!auth.ok) return auth.response;
  try {
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    const [approvals, obligationRows, scheduleRows, evidenceRows, eligibleObligationOwners, events] = await Promise.all([
      auth.context.permissions.has("approval:read")
        ? db.select().from(approvalRequests).where(eq(approvalRequests.workspaceId, workspaceId)).orderBy(desc(approvalRequests.createdAt)).limit(200)
        : Promise.resolve([]),
      auth.context.permissions.has("obligation:read")
        ? db.select({ obligation: obligations }).from(obligations).innerJoin(agreements, and(
            eq(agreements.workspaceId, obligations.workspaceId),
            eq(agreements.id, obligations.agreementId),
            isNull(agreements.deletedAt),
          )).where(eq(obligations.workspaceId, workspaceId)).orderBy(obligations.dueDate).limit(200)
          .then((rows) => rows.map((row) => row.obligation))
        : Promise.resolve([]),
      auth.context.permissions.has("obligation:read")
        ? db.select({ schedule: obligationSchedules }).from(obligationSchedules).innerJoin(agreements, and(
            eq(agreements.workspaceId, obligationSchedules.workspaceId),
            eq(agreements.id, obligationSchedules.agreementId),
            isNull(agreements.deletedAt),
          )).where(eq(obligationSchedules.workspaceId, workspaceId))
          .orderBy(asc(obligationSchedules.anchorDate), asc(obligationSchedules.createdAt)).limit(200)
          .then((rows) => rows.map((row) => row.schedule))
        : Promise.resolve([]),
      auth.context.permissions.has("obligation:read")
        ? db.select({ evidence: obligationEvidence }).from(obligationEvidence).innerJoin(agreements, and(
            eq(agreements.workspaceId, obligationEvidence.workspaceId),
            eq(agreements.id, obligationEvidence.agreementId),
            isNull(agreements.deletedAt),
          )).where(eq(obligationEvidence.workspaceId, workspaceId))
          .orderBy(desc(obligationEvidence.createdAt)).limit(200)
          .then((rows) => rows.map((row) => row.evidence))
        : Promise.resolve([]),
      auth.context.permissions.has("obligation:read")
        ? db.select({
            userId: users.id,
            displayName: users.displayName,
            role: workspaceMemberships.role,
          }).from(workspaceMemberships).innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
            eq(workspaceMemberships.workspaceId, workspaceId),
            eq(workspaceMemberships.status, "active"),
            eq(users.status, "active"),
            inArray(workspaceMemberships.role, OBLIGATION_OWNER_ROLES),
          )).orderBy(asc(users.displayName))
        : Promise.resolve([]),
      auth.context.permissions.has("audit:read")
        ? db.select().from(agreementEvents).where(eq(agreementEvents.workspaceId, workspaceId)).orderBy(desc(agreementEvents.createdAt)).limit(300)
        : Promise.resolve([]),
    ]);
    return apiJson({
      approvals,
      obligations: obligationRows,
      obligationSchedules: scheduleRows,
      obligationEvidence: evidenceRows,
      eligibleObligationOwners,
      events,
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Agreement operations could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:read", { limit: 80 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, operationMutationSchema, 32_000);
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    const now = new Date().toISOString();

    if (input.entity === "risk" && (input.action === "assess" || input.action === "waive")) {
      const requiredPermission = input.action === "assess" ? "risk:assess" : "risk:waive";
      if (!auth.context.permissions.has(requiredPermission)) return permissionDenied(auth.requestId);
      const agreement = await findActiveAgreement(db, workspaceId, input.record.agreementId);
      if (!agreement) return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId: auth.requestId });
      if (agreement.version !== input.record.agreementVersion) {
        return apiError("version_conflict", "Reload the agreement before recording its risk decision.", { status: 409, requestId: auth.requestId });
      }
      if (agreement.stage === "Active" || agreement.signatureStatus === "Completed") {
        return apiError("executed_agreement_immutable", "Risk evidence on an executed agreement is immutable. Create an amendment or replacement agreement.", { status: 409, requestId: auth.requestId });
      }
      const [[documentVersion], [activeSignature], [workflowDefinition]] = await Promise.all([
        db.select().from(agreementDocumentVersions).where(and(
          eq(agreementDocumentVersions.workspaceId, workspaceId),
          eq(agreementDocumentVersions.agreementId, agreement.id),
        )).orderBy(desc(agreementDocumentVersions.version)).limit(1),
        db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
          eq(signaturePackets.workspaceId, workspaceId),
          eq(signaturePackets.agreementId, agreement.id),
          inArray(signaturePackets.status, ACTIVE_SIGNATURE_STATUSES),
        )).limit(1),
        agreement.workflowDefinitionId
          ? db.select({
              id: workflowDefinitions.id,
              definition: workflowDefinitions.definition,
              definitionSha256: workflowDefinitions.definitionSha256,
            }).from(workflowDefinitions).where(and(
              eq(workflowDefinitions.workspaceId, workspaceId),
              eq(workflowDefinitions.id, agreement.workflowDefinitionId),
              inArray(workflowDefinitions.status, ["published", "retired"]),
            )).limit(1)
          : Promise.resolve([]),
      ]);
      if (activeSignature) {
        return apiError("signature_in_flight", "Risk evidence cannot change while a signature packet is active or awaiting signed-evidence review.", {
          status: 409, requestId: auth.requestId,
        });
      }
      if (!documentVersion) {
        return apiError("document_version_required", "Create and review an immutable working document version before assessing risk.", { status: 409, requestId: auth.requestId });
      }
      const riskBasisHash = await computeRiskAssessmentBasisHash(agreement, documentVersion);
      if (
        input.record.basisHash !== riskBasisHash
        || input.record.documentVersion !== documentVersion.version
        || input.record.documentSha256 !== documentVersion.sha256
      ) {
        return apiError("risk_basis_changed", "The agreement paper changed after review. Reload and assess the exact current working version.", { status: 409, requestId: auth.requestId });
      }

      const proposedRisk = input.action === "assess" ? input.record.level : "Unassessed";
      const proposedDisposition = input.action === "assess" ? "assessed" as const : "waived" as const;
      let proposed = { ...agreement, risk: proposedRisk, riskDisposition: proposedDisposition };
      let workflowPolicyPatch: Readonly<{ workflowPolicySha256: string | null; workflowApprovalLanes: string[] | null }> | null = null;
      if (agreement.workflowDefinitionId) {
        if (!workflowDefinition) {
          return apiError("workflow_policy_unavailable", "The agreement's governed workflow is unavailable. Restore or replace it before recording risk.", { status: 409, requestId: auth.requestId, headers: auth.headers });
        }
        try {
          const workflowSnapshot = await governedWorkflowSnapshot(workflowDefinition.definition, proposed);
          if (workflowSnapshot.policySha256 !== workflowDefinition.definitionSha256
            || workflowSnapshot.policySha256 !== agreement.workflowPolicySha256) {
            return apiError("workflow_digest_mismatch", "The agreement's governed workflow does not match its immutable policy snapshot.", { status: 409, requestId: auth.requestId, headers: auth.headers });
          }
          workflowPolicyPatch = {
            workflowPolicySha256: workflowSnapshot.policySha256,
            workflowApprovalLanes: workflowSnapshot.approvalLanes,
          };
          proposed = { ...proposed, ...workflowPolicyPatch };
        } catch (error) {
          if (error instanceof EnterpriseError) {
            return apiError(error.code, error.message, { status: error.status, requestId: auth.requestId, headers: auth.headers });
          }
          throw error;
        }
      }
      const approvalStatus = repositoryRequiresApproval(proposed) ? "Required" : "Not required";
      const patch = {
        risk: proposedRisk,
        riskDisposition: proposedDisposition,
        riskBasisHash,
        riskDocumentVersion: documentVersion.version,
        riskDocumentSha256: documentVersion.sha256,
        riskDecisionReason: input.record.rationale,
        riskDecidedByUserId: auth.context.user.id,
        riskDecidedAt: now,
        ...(workflowPolicyPatch ?? {}),
        approvalStatus,
        signatureStatus: "Not sent",
        nextAction: approvalStatus === "Required" ? "Request required approval" : "Advance the risk-cleared agreement",
        version: agreement.version + 1,
        updated: now,
        updatedAt: now,
        updatedByUserId: auth.context.user.id,
      };
      const savedAgreement: typeof agreements.$inferSelect = { ...agreement, ...patch };
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: agreement.id,
        type: "Risk",
        detail: input.action === "assess"
          ? `Recorded ${proposedRisk.toLowerCase()} risk after human review of working version ${documentVersion.version} (${documentVersion.sha256.slice(0, 12)}…).`
          : `Recorded an authorized risk-assessment waiver after human review of working version ${documentVersion.version} (${documentVersion.sha256.slice(0, 12)}…).`,
        actor: auth.context.user,
        createdAt: now,
      });
      const snapshot = await prepareAgreementSnapshot(savedAgreement, auth.context.user.id, event.id);
      const outbox = prepareOutboxEvent(prepareAgreementUpdatedIntegrationEvent({
        agreement: savedAgreement,
        changedFields: ["risk", "riskDisposition", "approvalStatus"],
        causationId: auth.requestId,
      }));
      const guardId = crypto.randomUUID();
      const [result] = await db.batch([
        db.update(agreements).set(patch).where(and(
          eq(agreements.workspaceId, workspaceId),
          eq(agreements.id, agreement.id),
          eq(agreements.version, agreement.version),
          eq(agreements.nextAction, agreement.nextAction),
          notExists(db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
            eq(signaturePackets.workspaceId, workspaceId),
            eq(signaturePackets.agreementId, agreement.id),
            inArray(signaturePackets.status, ACTIVE_SIGNATURE_STATUSES),
          ))),
        )),
        db.insert(mutationGuards).values({ id: guardId, workspaceId, operation: `risk.${input.action}`, guardChanges: sql<number>`changes()`, createdAt: now }),
        db.update(approvalRequests).set({ status: "Superseded", version: sql`${approvalRequests.version} + 1` }).where(and(
          eq(approvalRequests.workspaceId, workspaceId),
          eq(approvalRequests.agreementId, agreement.id),
          inArray(approvalRequests.status, ["Pending", "Approved", "Changes requested"]),
        )),
        db.insert(agreementEvents).values(event),
        db.insert(agreementVersions).values(snapshot),
        db.insert(outboxEvents).values(outbox),
        db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), eq(mutationGuards.id, guardId))),
      ]);
      if (!result.meta.changes) {
        return apiError("version_conflict", "The agreement changed while risk evidence was recorded. Reload before retrying.", { status: 409, requestId: auth.requestId });
      }
      return apiJson({ agreement: savedAgreement, event, riskBasisHash, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }

    if (input.entity === "approval" && input.action === "ensure_required") {
      if (!auth.context.permissions.has("approval:request")) return permissionDenied(auth.requestId);
      const routing = await inspectRequiredApprovalRouting({
        db,
        workspaceId,
        agreementId: input.record.agreementId,
        due: input.record.due,
      });
      const blocker = routing.blockers[0];
      if (blocker) {
        return apiError(blocker.code, blocker.message, {
          status: blocker.status,
          requestId: auth.requestId,
        });
      }
      if (routing.noOp) {
        return apiJson({
          approvals: routing.survivingCurrent,
          agreement: routing.agreement,
          createdRoles: [],
          requestId: auth.requestId,
        }, { requestId: auth.requestId, headers: auth.headers });
      }
      const mutation = await buildRequiredApprovalRoutingStatements({
        db,
        inspection: routing,
        workspaceId,
        requestedByUserId: auth.context.user.id,
        actor: auth.context.user,
        requestId: auth.requestId,
        now,
      });
      try {
        await db.batch(mutation.statements as Parameters<typeof db.batch>[0]);
      } catch (error) {
        if (!isMutationGuardConflict(error)) throw error;
        const refreshed = await inspectRequiredApprovalRouting({
          db,
          workspaceId,
          agreementId: input.record.agreementId,
          due: input.record.due,
        });
        const laneBlocker = refreshed.blockers.find((candidate) =>
          candidate.code === APPROVAL_LANE_LIMIT_ERROR_CODE);
        if (laneBlocker) {
          return apiError(laneBlocker.code, laneBlocker.message, {
            status: laneBlocker.status,
            requestId: auth.requestId,
          });
        }
        return apiError("version_conflict", "The agreement or approval lanes changed while required approvals were routed. Reload before retrying.", { status: 409, requestId: auth.requestId });
      }
      return apiJson({ ...mutation.result, requestId: auth.requestId }, {
        status: mutation.createdApprovals.length > 0 ? 201 : 200,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }

    if (input.entity === "approval" && input.action === "create") {
      if (!auth.context.permissions.has("approval:request")) return permissionDenied(auth.requestId);
      const agreement = await findActiveAgreement(db, workspaceId, input.record.agreementId);
      if (!agreement) return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId: auth.requestId });
      if (agreement.stage === "Active" || agreement.signatureStatus === "Completed") {
        return apiError("executed_agreement_immutable", "Executed agreements cannot be routed through a new approval cycle. Create an amendment or replacement agreement.", { status: 409, requestId: auth.requestId });
      }
      const [documentVersion] = await db.select().from(agreementDocumentVersions).where(and(
        eq(agreementDocumentVersions.workspaceId, workspaceId),
        eq(agreementDocumentVersions.agreementId, agreement.id),
      )).orderBy(desc(agreementDocumentVersions.version)).limit(1);
      if (!documentVersion) return apiError("document_version_required", "Create and review an immutable working document version before requesting approval.", { status: 409, requestId: auth.requestId });
      const riskReadiness = await evaluateAgreementRiskReadiness(agreement, documentVersion);
      if (!riskReadiness.evaluation.cleared) {
        return apiError("risk_assessment_required", riskReadiness.evaluation.blockers[0]?.message ?? "A current risk decision is required before approval routing.", { status: 409, requestId: auth.requestId });
      }
      const basisHash = await computeAgreementBasisHash(agreement, documentVersion);
      const approvalBasis = {
        hash: basisHash,
        documentVersion: documentVersion.version,
        documentSha256: documentVersion.sha256,
      };
      const currentApprovalLanes = await loadCurrentApprovalLanes(db, workspaceId, agreement.id, approvalBasis);
      if (currentApprovalLanes.length > MAX_CURRENT_APPROVAL_LANES) return approvalLaneLimitError(auth.requestId);
      if (currentApprovalLanes.some((candidate) => candidate.status === "Changes requested")) {
        return apiError("approval_changes_required", "Address the requested changes and save a new working version before routing approvals again.", { status: 409, requestId: auth.requestId });
      }
      const currentRequest = currentApprovalLanes.find((candidate) =>
        candidate.role === input.record.role
        && candidate.status === "Pending"
        && Boolean(candidate.requestedByUserId));
      if (currentRequest) {
        return apiError("approval_request_exists", `A current ${input.record.role} approval request already exists.`, { status: 409, requestId: auth.requestId });
      }
      if (approvalLaneLimitWouldBeExceeded(currentApprovalLanes.length)) return approvalLaneLimitError(auth.requestId);
      let approver = `Unassigned ${input.record.role}`;
      if (input.record.approverUserId) {
        if (input.record.approverUserId === auth.context.user.id) {
          return apiError("self_approval_not_allowed", "Select a different authorized member to preserve separation between requester and approver.", { status: 400, requestId: auth.requestId });
        }
        const [member] = await db.select({
          userId: workspaceMemberships.userId,
          displayName: users.displayName,
          role: workspaceMemberships.role,
        }).from(workspaceMemberships).innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.userId, input.record.approverUserId),
          eq(workspaceMemberships.status, "active"),
          inArray(workspaceMemberships.role, ["admin", "legal", "approver"]),
          eq(users.status, "active"),
        )).limit(1);
        if (!member) return apiError("approver_not_found", "The selected approver is not an active workspace member.", { status: 400, requestId: auth.requestId });
        const authority = await evaluateApprovalLaneAuthority(db, {
          workspaceId,
          lane: input.record.role,
          userId: member.userId,
          role: member.role,
          currencyCode: agreement.currencyCode,
          amountMinor: agreement.valueMinor,
        });
        if (!authority.authorized) {
          return apiError(
            "approver_not_authorized",
            authority.blocker?.message ?? "The selected member is not authorized for this approval lane.",
            { status: 400, requestId: auth.requestId },
          );
        }
        approver = member.displayName;
      }
      const approval = {
        id: crypto.randomUUID(),
        workspaceId,
        version: 1,
        agreementId: agreement.id,
        basisHash,
        documentVersion: documentVersion.version,
        documentSha256: documentVersion.sha256,
        role: input.record.role,
        requestedByUserId: auth.context.user.id,
        approver,
        approverUserId: input.record.approverUserId ?? null,
        status: "Pending",
        decidedByUserId: null,
        decidedAt: null,
        basisConfirmedAt: null,
        comment: null,
        due: input.record.due,
        createdAt: now,
      };
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: agreement.id,
        type: "Approval",
        detail: `${approval.role} approval requested from ${approval.approver} for working version ${documentVersion.version} (${documentVersion.sha256.slice(0, 12)}…).`,
        actor: auth.context.user,
        createdAt: now,
      });
      const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
        workspaceId,
        topic: "approval.requested",
        aggregateType: "approval",
        aggregateId: approval.id,
        payload: {
          approvalId: approval.id,
          agreementId: agreement.id,
          requestedByUserId: approval.requestedByUserId,
          approverUserId: approval.approverUserId,
          documentVersion: documentVersion.version,
          documentSha256: documentVersion.sha256,
          basisHash,
          aggregateVersion: approval.version,
          causationId: auth.requestId,
        },
      }));
      const agreementGuardId = crypto.randomUUID();
      const savedAgreement: typeof agreements.$inferSelect = {
        ...agreement,
        approvalStatus: "Pending",
        version: agreement.version + 1,
        updated: now,
        updatedAt: now,
        updatedByUserId: auth.context.user.id,
      };
      const snapshot = await prepareAgreementSnapshot(savedAgreement, auth.context.user.id, event.id);
      const agreementIntegrationEvent = prepareAgreementLifecycleUpdatedIntegrationEvent({
        before: agreement,
        agreement: savedAgreement,
        candidateFields: ["approvalStatus"],
        causationId: auth.requestId,
      });
      const agreementOutbox = agreementIntegrationEvent ? prepareOutboxEvent(agreementIntegrationEvent) : null;
      try {
        await db.batch([
          db.update(approvalRequests).set({ status: "Superseded", version: sql`${approvalRequests.version} + 1` }).where(and(
            eq(approvalRequests.workspaceId, workspaceId),
            eq(approvalRequests.agreementId, agreement.id),
            eq(approvalRequests.status, "Pending"),
            or(ne(approvalRequests.basisHash, basisHash), eq(approvalRequests.role, approval.role)),
          )),
          db.insert(approvalRequests).values(approval),
          db.update(agreements).set({ approvalStatus: "Pending", version: agreement.version + 1, updated: now, updatedAt: now, updatedByUserId: auth.context.user.id }).where(and(
            eq(agreements.workspaceId, workspaceId),
            eq(agreements.id, agreement.id),
            eq(agreements.version, agreement.version),
            eq(agreements.nextAction, agreement.nextAction),
            currentApprovalLaneCapGuard(db, workspaceId, agreement.id, approvalBasis),
          )),
          db.insert(mutationGuards).values({ id: agreementGuardId, workspaceId, operation: "approval.create.agreement", guardChanges: sql<number>`changes()`, createdAt: now }),
          db.insert(agreementEvents).values(event),
          db.insert(agreementVersions).values(snapshot),
          db.insert(outboxEvents).values(outbox),
          ...(agreementOutbox ? [db.insert(outboxEvents).values(agreementOutbox)] : []),
          db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), eq(mutationGuards.id, agreementGuardId))),
        ]);
      } catch (error) {
        if (!isMutationGuardConflict(error)) throw error;
        const refreshed = await loadCurrentApprovalLanes(db, workspaceId, agreement.id, approvalBasis);
        if (refreshed.some((candidate) =>
          candidate.role === input.record.role
          && candidate.status === "Pending"
          && Boolean(candidate.requestedByUserId))) {
          return apiError("approval_request_exists", `A current ${input.record.role} approval request already exists.`, { status: 409, requestId: auth.requestId });
        }
        if (approvalLaneLimitWouldBeExceeded(refreshed.length)) return approvalLaneLimitError(auth.requestId);
        return apiError("version_conflict", "The agreement or approval lanes changed while the additional approval was routed. Reload before retrying.", { status: 409, requestId: auth.requestId });
      }
      return apiJson({ approval, event, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
    }

    if (input.entity === "approval" && input.action === "claim") {
      if (!auth.context.permissions.has("approval:decide")) return permissionDenied(auth.requestId);
      const [current] = await db.select().from(approvalRequests).where(and(
        eq(approvalRequests.workspaceId, workspaceId),
        eq(approvalRequests.id, input.record.id),
      )).limit(1);
      if (!current) return apiError("approval_not_found", "Approval request was not found.", { status: 404, requestId: auth.requestId });
      if (current.status !== "Pending") return apiError("approval_already_decided", "Only a pending request can be claimed.", { status: 409, requestId: auth.requestId });
      if (input.record.version !== undefined && current.version !== input.record.version) return apiError("version_conflict", "Reload this approval before claiming it.", { status: 409, requestId: auth.requestId });
      if (!current.requestedByUserId) return apiError("approval_requester_unverified", "This legacy approval must be superseded with a newly attributed request.", { status: 409, requestId: auth.requestId });
      if (current.requestedByUserId === auth.context.user.id) return apiError("self_approval_not_allowed", "The requester cannot claim their own approval.", { status: 403, requestId: auth.requestId });
      if (current.sourceAgentPlanReviewerUserId === auth.context.user.id) {
        return apiError(
          "agent_plan_reviewer_separation_required",
          "The human who approved the agent plan cannot claim an approval lane created by that plan.",
          { status: 403, requestId: auth.requestId },
        );
      }
      if (current.approverUserId) return apiError("approval_already_assigned", "This approval is already assigned to an authorized member.", { status: 409, requestId: auth.requestId });
      const claimAgreement = await findActiveAgreement(db, workspaceId, current.agreementId);
      if (!claimAgreement) return apiError("agreement_not_found", "The agreement for this approval is no longer active.", { status: 404, requestId: auth.requestId });
      const claimAuthorityBasis = {
        workspaceId,
        lane: current.role,
        userId: auth.context.user.id,
        role: auth.context.role,
        currencyCode: claimAgreement.currencyCode,
        amountMinor: claimAgreement.valueMinor,
      } as const;
      const claimAuthority = await evaluateApprovalLaneAuthority(db, claimAuthorityBasis);
      if (!claimAuthority.authorized) {
        return apiError(
          claimAuthority.blocker?.code ?? "approval_lane_authority_required",
          claimAuthority.blocker?.message ?? "You are not authorized for this approval lane.",
          { status: 403, requestId: auth.requestId },
        );
      }
      const version = current.version + 1;
      const patch = { approverUserId: auth.context.user.id, approver: auth.context.user.displayName, version };
      const guardId = crypto.randomUUID();
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: current.agreementId,
        type: "Approval",
        detail: `${current.role} approval claimed by ${auth.context.user.displayName}.`,
        actor: auth.context.user,
        createdAt: now,
      });
      const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
        workspaceId,
        topic: "approval.assigned",
        aggregateType: "approval",
        aggregateId: current.id,
        payload: { approvalId: current.id, agreementId: current.agreementId, approverUserId: auth.context.user.id, aggregateVersion: version, causationId: auth.requestId },
      }));
      const [result] = await db.batch([
        db.update(approvalRequests).set(patch).where(and(
          eq(approvalRequests.workspaceId, workspaceId),
          eq(approvalRequests.id, current.id),
          eq(approvalRequests.version, current.version),
          eq(approvalRequests.status, "Pending"),
          sql`${approvalRequests.approverUserId} is null`,
          or(
            isNull(approvalRequests.sourceAgentPlanReviewerUserId),
            ne(approvalRequests.sourceAgentPlanReviewerUserId, auth.context.user.id),
          ),
          approvalLaneAuthorityCommitPredicate(db, claimAuthorityBasis),
        )),
        db.insert(mutationGuards).values({
          id: guardId,
          workspaceId,
          operation: "approval.claim",
          guardChanges: sql<number>`changes()`,
          createdAt: now,
        }),
        db.insert(agreementEvents).values(event),
        db.insert(outboxEvents).values(outbox),
        db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), eq(mutationGuards.id, guardId))),
      ]);
      if (!result.meta.changes) return apiError("version_conflict", "This approval was claimed by someone else. Reload the queue.", { status: 409, requestId: auth.requestId });
      return apiJson({ approval: { ...current, ...patch }, event, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }

    if (input.entity === "approval" && input.action === "decide") {
      if (!auth.context.permissions.has("approval:decide")) return permissionDenied(auth.requestId);
      const [current] = await db.select().from(approvalRequests).where(and(
        eq(approvalRequests.workspaceId, workspaceId),
        eq(approvalRequests.id, input.record.id),
      )).limit(1);
      if (!current) return apiError("approval_not_found", "Approval request was not found.", { status: 404, requestId: auth.requestId });
      if (current.status !== "Pending") return apiError("approval_already_decided", "This approval request has already been decided.", { status: 409, requestId: auth.requestId });
      if (current.version !== input.record.version) return apiError("version_conflict", "Reload this approval before deciding it.", { status: 409, requestId: auth.requestId });
      if (!current.requestedByUserId) {
        return apiError("approval_requester_unverified", "This approval predates requester attribution. Supersede it with a new request before recording a decision.", { status: 409, requestId: auth.requestId });
      }
      if (current.requestedByUserId === auth.context.user.id) {
        return apiError("self_approval_not_allowed", "A request must be decided by a different authorized member.", { status: 403, requestId: auth.requestId });
      }
      if (current.sourceAgentPlanReviewerUserId === auth.context.user.id) {
        return apiError(
          "agent_plan_reviewer_separation_required",
          "The human who approved the agent plan cannot decide an approval lane created by that plan.",
          { status: 403, requestId: auth.requestId },
        );
      }
      if (auth.context.role === "approver" && current.approverUserId !== auth.context.user.id) return permissionDenied(auth.requestId);

      const agreement = await findActiveAgreement(db, workspaceId, current.agreementId);
      if (!agreement) throw new Error("Approval references an unavailable agreement");
      const decisionAuthorityBasis = {
        workspaceId,
        lane: current.role,
        userId: auth.context.user.id,
        role: auth.context.role,
        currencyCode: agreement.currencyCode,
        amountMinor: agreement.valueMinor,
      } as const;
      const decisionAuthority = await evaluateApprovalLaneAuthority(db, decisionAuthorityBasis);
      if (!decisionAuthority.authorized) {
        return apiError(
          decisionAuthority.blocker?.code ?? "approval_lane_authority_required",
          decisionAuthority.blocker?.message ?? "You are not authorized for this approval lane.",
          { status: 403, requestId: auth.requestId },
        );
      }
      const [documentVersion] = await db.select().from(agreementDocumentVersions).where(and(
        eq(agreementDocumentVersions.workspaceId, workspaceId),
        eq(agreementDocumentVersions.agreementId, agreement.id),
      )).orderBy(desc(agreementDocumentVersions.version)).limit(1);
      const currentBasisHash = documentVersion ? await computeAgreementBasisHash(agreement, documentVersion) : null;
      if (!documentVersion || current.basisHash !== currentBasisHash || current.documentVersion !== documentVersion.version || current.documentSha256 !== documentVersion.sha256) {
        return apiError("approval_basis_changed", "The agreement paper changed after this request was created. Create a new approval request for the current working version.", { status: 409, requestId: auth.requestId });
      }
      if (
        input.record.basisHash !== currentBasisHash
        || input.record.documentVersion !== documentVersion.version
        || input.record.documentSha256 !== documentVersion.sha256
      ) {
        return apiError("approval_confirmation_stale", "The confirmation does not match the exact current approval basis. Reload the paper before deciding.", { status: 409, requestId: auth.requestId });
      }
      const riskReadiness = await evaluateAgreementRiskReadiness(agreement, documentVersion);
      if (!riskReadiness.evaluation.cleared) {
        return apiError("risk_assessment_required", riskReadiness.evaluation.blockers[0]?.message ?? "A current risk decision is required before approval.", { status: 409, requestId: auth.requestId });
      }

      const version = current.version + 1;
      const approvalPatch = {
        status: input.record.status,
        comment: input.record.comment ?? null,
        decidedByUserId: auth.context.user.id,
        decidedAt: now,
        basisConfirmedAt: now,
        version,
      };

      const related = await loadCurrentApprovalLanes(db, workspaceId, current.agreementId, {
        hash: currentBasisHash,
        documentVersion: documentVersion.version,
        documentSha256: documentVersion.sha256,
      });
      if (related.length > MAX_CURRENT_APPROVAL_LANES) return approvalLaneLimitError(auth.requestId);
      if (
        input.record.status === "Approved"
        && requiredApprovalRoles(agreement).includes(current.role)
        && related.some((candidate) =>
          candidate.id !== current.id
          && requiredApprovalRoles(agreement).includes(candidate.role)
          && candidate.status === "Approved"
          && candidate.decidedByUserId === auth.context.user.id
          && candidate.basisHash === currentBasisHash
          && candidate.documentVersion === documentVersion.version
          && candidate.documentSha256 === documentVersion.sha256)
      ) {
        return apiError(
          "distinct_required_approver_needed",
          "A different authorized person must decide each required approval lane for this exact paper.",
          { status: 409, requestId: auth.requestId },
        );
      }
      const proposedRequests = related.map((item) => item.id === current.id ? { ...item, ...approvalPatch } : item);
      const approvalStatus = evaluateApprovalPolicy(agreement, proposedRequests, {
        hash: currentBasisHash,
        documentVersion: documentVersion.version,
        documentSha256: documentVersion.sha256,
      });
      const nextAction = approvalStatus === "Approved" ? "Send to counterparty" : approvalStatus === "Changes requested" ? "Address requested changes" : agreement.nextAction;
      const agreementPatch = {
        approvalStatus,
        nextAction,
        version: agreement.version + 1,
        updated: now,
        updatedAt: now,
        updatedByUserId: auth.context.user.id,
      };
      const savedAgreement: typeof agreements.$inferSelect = { ...agreement, ...agreementPatch };
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: agreement.id,
        type: "Approval",
        detail: `${current.role} approval ${input.record.status.toLowerCase()}.`,
        actor: auth.context.user,
        createdAt: now,
      });
      const snapshot = await prepareAgreementSnapshot(savedAgreement, auth.context.user.id, event.id);
      const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
        workspaceId,
        topic: "approval.decided",
        aggregateType: "approval",
        aggregateId: current.id,
        payload: { approvalId: current.id, agreementId: agreement.id, status: input.record.status, decidedByUserId: auth.context.user.id, basisHash: currentBasisHash, documentVersion: documentVersion.version, documentSha256: documentVersion.sha256, basisConfirmedAt: now, aggregateVersion: version, causationId: auth.requestId },
      }));
      const agreementIntegrationEvent = prepareAgreementLifecycleUpdatedIntegrationEvent({
        before: agreement,
        agreement: savedAgreement,
        candidateFields: ["approvalStatus"],
        causationId: auth.requestId,
      });
      const agreementOutbox = agreementIntegrationEvent ? prepareOutboxEvent(agreementIntegrationEvent) : null;
      const approvalGuardId = crypto.randomUUID();
      const agreementGuardId = crypto.randomUUID();
      const [approvalResult, , agreementResult] = await db.batch([
        db.update(approvalRequests).set(approvalPatch).where(and(
          eq(approvalRequests.workspaceId, workspaceId),
          eq(approvalRequests.id, current.id),
          eq(approvalRequests.version, current.version),
          or(
            isNull(approvalRequests.sourceAgentPlanReviewerUserId),
            ne(approvalRequests.sourceAgentPlanReviewerUserId, auth.context.user.id),
          ),
          approvalLaneAuthorityCommitPredicate(db, decisionAuthorityBasis),
        )),
        db.insert(mutationGuards).values({
          id: approvalGuardId,
          workspaceId,
          operation: "approval.decide.request",
          guardChanges: sql<number>`changes()`,
          createdAt: now,
        }),
        db.update(agreements).set(agreementPatch).where(and(
          eq(agreements.workspaceId, workspaceId),
          eq(agreements.id, agreement.id),
          eq(agreements.version, agreement.version),
          eq(agreements.nextAction, agreement.nextAction),
        )),
        db.insert(mutationGuards).values({
          id: agreementGuardId,
          workspaceId,
          operation: "approval.decide.agreement",
          guardChanges: sql<number>`changes()`,
          createdAt: now,
        }),
        db.insert(agreementEvents).values(event),
        db.insert(agreementVersions).values(snapshot),
        db.insert(outboxEvents).values(outbox),
        ...(agreementOutbox ? [db.insert(outboxEvents).values(agreementOutbox)] : []),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, workspaceId),
          inArray(mutationGuards.id, [approvalGuardId, agreementGuardId]),
        )),
      ]);
      if (!approvalResult.meta.changes || !agreementResult.meta.changes) {
        return apiError("version_conflict", "The approval or agreement changed while the decision was saved. Reload before retrying.", { status: 409, requestId: auth.requestId });
      }
      return apiJson({ approval: { ...current, status: input.record.status, comment: input.record.comment ?? null, decidedByUserId: auth.context.user.id, decidedAt: now, basisConfirmedAt: now, version }, agreement: savedAgreement, event, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }

    if (input.entity === "obligation" && input.action === "create") {
      if (!auth.context.permissions.has("obligation:write")) return permissionDenied(auth.requestId);
      const rawIdempotencyKey = request.headers.get("idempotency-key");
      if (rawIdempotencyKey === null) {
        return apiError(
          "idempotency_key_required",
          "Idempotency-Key is required for obligation schedule creation and must be retained for every retry.",
          { status: 400, requestId: auth.requestId, headers: auth.headers },
        );
      }
      const idempotencyKey = canonicalDocumentUploadIdempotencyKey(rawIdempotencyKey);
      if (!idempotencyKey) {
        return apiError(
          "invalid_idempotency_key",
          "Idempotency-Key must be a canonical lowercase UUID.",
          { status: 400, requestId: auth.requestId, headers: auth.headers },
        );
      }
      const requestSha256 = await sha256Hex(JSON.stringify({
        schema: "notice.obligation-schedule-create.v1",
        record: input.record,
      }));
      const existingReplay = await replayObligationCreation(db, {
        workspaceId,
        userId: auth.context.user.id,
        idempotencyKey,
        requestSha256,
        requestId: auth.requestId,
        headers: auth.headers,
      });
      if (existingReplay) return existingReplay;
      const agreement = await findActiveAgreement(db, workspaceId, input.record.agreementId);
      if (!agreement) return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId: auth.requestId });
      if (agreement.stage !== "Active" && agreement.signatureStatus !== "Completed") {
        return apiError(
          "obligation_agreement_not_executed",
          "Obligations can be created only for an active or completed agreement.",
          { status: 409, requestId: auth.requestId },
        );
      }
      const ownerUserId = input.record.ownerUserId ?? auth.context.user.id;
      const member = await findEligibleObligationOwner(db, workspaceId, ownerUserId);
      if (!member) {
        return apiError(
          "obligation_owner_ineligible",
          "The selected owner must be an active admin, legal, approver, or requester workspace member.",
          { status: 400, requestId: auth.requestId },
        );
      }
      const recurrence = input.record.recurrence ?? {
        unit: "once" as const,
        interval: 1,
        timezone: "Etc/UTC",
        reminderLeadDays: [0],
      };
      if (
        recurrence.unit !== "once"
        && input.record.dueDate < obligationCalendarDateInTimeZone(new Date(now), recurrence.timezone)
      ) {
        return apiError(
          "recurring_obligation_anchor_in_past",
          "A recurring schedule must begin today or later in its configured time zone.",
          { status: 400, requestId: auth.requestId },
        );
      }
      const initial = buildInitialObligationScheduleState({
        recurrenceUnit: recurrence.unit,
        recurrenceInterval: recurrence.interval,
        anchorDate: input.record.dueDate,
        endDate: recurrence.endDate ?? null,
        timezone: recurrence.timezone,
        reminderLeadDays: recurrence.reminderLeadDays,
      });
      const scheduleId = crypto.randomUUID();
      const schedule = {
        id: scheduleId,
        workspaceId,
        agreementId: agreement.id,
        version: 1,
        title: input.record.title,
        source: input.record.source,
        ownerUserId,
        owner: member.displayName,
        timezone: recurrence.timezone,
        recurrenceUnit: recurrence.unit,
        recurrenceInterval: recurrence.interval,
        anchorDate: input.record.dueDate,
        endDate: recurrence.endDate ?? null,
        reminderLeadDays: [...initial.reminderLeadDays],
        status: initial.cursor.status,
        nextOccurrenceNumber: initial.cursor.nextOccurrenceNumber,
        nextOccurrenceDate: initial.cursor.nextOccurrenceDate,
        nextMaterializationDate: initial.cursor.nextMaterializationDate,
        supersedesScheduleId: null,
        createdByUserId: auth.context.user.id,
        createdAt: now,
        updatedByUserId: auth.context.user.id,
        updatedAt: now,
      } satisfies typeof obligationSchedules.$inferInsert;
      const obligation = {
        id: crypto.randomUUID(),
        workspaceId,
        version: 1,
        agreementId: agreement.id,
        scheduleId,
        occurrenceNumber: initial.occurrence.occurrenceNumber,
        title: schedule.title,
        dueDate: initial.occurrence.dueDate,
        owner: member.displayName,
        ownerUserId,
        status: "Open" as const,
        completedByUserId: null,
        completedAt: null,
        completionEvidence: null,
        cadence: initial.occurrence.cadence,
        source: schedule.source,
        timezone: initial.occurrence.timezone,
        reminderLeadDays: [...initial.occurrence.reminderLeadDays],
        nextReminderDate: initial.occurrence.nextReminderDate,
        createdByUserId: auth.context.user.id,
        createdAt: now,
      } satisfies typeof obligations.$inferInsert;
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: agreement.id,
        type: "Obligation",
        detail: `Created ${obligation.cadence.toLowerCase()} obligation schedule “${obligation.title}” and occurrence 1 due ${obligation.dueDate}.`,
        actor: auth.context.user,
        createdAt: now,
      });
      const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
        workspaceId,
        topic: "obligation.created",
        aggregateType: "obligation",
        aggregateId: obligation.id,
        payload: {
          obligationId: obligation.id,
          scheduleId,
          occurrenceNumber: 1,
          agreementId: agreement.id,
          ownerUserId: obligation.ownerUserId,
          dueDate: obligation.dueDate,
          aggregateVersion: obligation.version,
          causationId: auth.requestId,
        },
      }));
      const creationReceipt = {
        workspaceId,
        userId: auth.context.user.id,
        idempotencyKey,
        requestSha256,
        agreementId: agreement.id,
        scheduleId,
        obligationId: obligation.id,
        agreementEventId: event.id,
        createdAt: now,
      } satisfies typeof obligationCreationReceipts.$inferInsert;
      const guardId = crypto.randomUUID();
      try {
        await db.batch([
          // The schedule insert is also the parent/owner CAS. Its immediately
          // following changes() guard rolls back the whole batch if either
          // eligibility basis changed after the preliminary reads.
          db.insert(obligationSchedules).select(db.select({
          id: sql<string>`${schedule.id}`.as("id"),
          workspaceId: agreements.workspaceId,
          agreementId: agreements.id,
          version: sql<number>`${schedule.version}`.as("version"),
          title: sql<string>`${schedule.title}`.as("title"),
          source: sql<string>`${schedule.source}`.as("source"),
          ownerUserId: sql<string | null>`${schedule.ownerUserId}`.as("owner_user_id"),
          owner: sql<string>`${schedule.owner}`.as("owner"),
          timezone: sql<string>`${schedule.timezone}`.as("timezone"),
          recurrenceUnit: sql<typeof schedule.recurrenceUnit>`${schedule.recurrenceUnit}`.as("recurrence_unit"),
          recurrenceInterval: sql<number>`${schedule.recurrenceInterval}`.as("recurrence_interval"),
          anchorDate: sql<string>`${schedule.anchorDate}`.as("anchor_date"),
          endDate: sql<string | null>`${schedule.endDate}`.as("end_date"),
          reminderLeadDays: sql<number[]>`${JSON.stringify(schedule.reminderLeadDays)}`.as("reminder_lead_days"),
          status: sql<typeof schedule.status>`${schedule.status}`.as("status"),
          nextOccurrenceNumber: sql<number | null>`${schedule.nextOccurrenceNumber}`.as("next_occurrence_number"),
          nextOccurrenceDate: sql<string | null>`${schedule.nextOccurrenceDate}`.as("next_occurrence_date"),
          nextMaterializationDate: sql<string | null>`${schedule.nextMaterializationDate}`.as("next_materialization_date"),
          supersedesScheduleId: sql<string | null>`${null}`.as("supersedes_schedule_id"),
          createdByUserId: sql<string | null>`${schedule.createdByUserId}`.as("created_by_user_id"),
          createdAt: sql<string>`${schedule.createdAt}`.as("created_at"),
          updatedByUserId: sql<string | null>`${schedule.updatedByUserId}`.as("updated_by_user_id"),
          updatedAt: sql<string>`${schedule.updatedAt}`.as("updated_at"),
        }).from(agreements).where(and(
          eq(agreements.workspaceId, workspaceId),
          eq(agreements.id, agreement.id),
          eq(agreements.version, agreement.version),
          isNull(agreements.deletedAt),
          or(eq(agreements.stage, "Active"), eq(agreements.signatureStatus, "Completed")),
          exists(db.select({ userId: workspaceMemberships.userId }).from(workspaceMemberships)
            .innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
              eq(workspaceMemberships.workspaceId, workspaceId),
              eq(workspaceMemberships.userId, ownerUserId),
              eq(workspaceMemberships.status, "active"),
              eq(users.status, "active"),
              inArray(workspaceMemberships.role, OBLIGATION_OWNER_ROLES),
            ))),
        ))),
        db.insert(mutationGuards).values({
          id: guardId,
          workspaceId,
          operation: "obligation.create.agreement",
          guardChanges: sql<number>`changes()`,
          createdAt: now,
        }),
        db.insert(obligations).values(obligation),
        db.insert(obligationCreationReceipts).values(creationReceipt),
        db.insert(agreementEvents).values(event),
        db.insert(outboxEvents).values(outbox),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, workspaceId),
          eq(mutationGuards.id, guardId),
        )),
        ]);
      } catch (error) {
        const replay = await replayObligationCreation(db, {
          workspaceId,
          userId: auth.context.user.id,
          idempotencyKey,
          requestSha256,
          requestId: auth.requestId,
          headers: auth.headers,
        });
        if (replay) return replay;
        if (!isMutationGuardConflict(error) && !isAgreementEventSequenceConflict(error)) throw error;
        return apiError(
          "obligation_basis_changed",
          "The agreement or selected owner changed while the schedule was created. Reload before retrying.",
          { status: 409, requestId: auth.requestId },
        );
      }
      const creationHeaders = new Headers(auth.headers);
      creationHeaders.set("Idempotency-Replayed", "false");
      return apiJson({ schedule, obligation, event, replay: false, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: creationHeaders });
    }

    if (input.entity === "obligation" && input.action === "complete") {
      const canOverride = auth.context.permissions.has("obligation:write");
      const canFulfillOwned = auth.context.permissions.has("obligation:fulfill");
      if (!canOverride && !canFulfillOwned) return permissionDenied(auth.requestId);
      const [currentRow] = await db.select({ obligation: obligations }).from(obligations).innerJoin(agreements, and(
        eq(agreements.workspaceId, obligations.workspaceId),
        eq(agreements.id, obligations.agreementId),
        isNull(agreements.deletedAt),
      )).where(and(
        eq(obligations.workspaceId, workspaceId),
        eq(obligations.id, input.record.id),
      )).limit(1);
      const current = currentRow?.obligation;
      if (!current) return apiError("obligation_not_found", "Obligation was not found.", { status: 404, requestId: auth.requestId });
      const completingOwnObligation = current.ownerUserId === auth.context.user.id;
      if (!completingOwnObligation && !canOverride) return permissionDenied(auth.requestId);
      if (!completingOwnObligation && !input.record.overrideReason) {
        return apiError(
          "obligation_override_reason_required",
          "A reason is required when completing an obligation assigned to another owner.",
          { status: 400, requestId: auth.requestId },
        );
      }
      if (current.status === "Complete") return apiError("obligation_already_complete", "This obligation is already complete.", { status: 409, requestId: auth.requestId });
      if (input.record.version !== current.version) return apiError("version_conflict", "Reload this obligation before completing it.", { status: 409, requestId: auth.requestId });
      const version = current.version + 1;
      const obligationPatch = {
        status: "Complete",
        completionEvidence: input.record.evidence,
        completedByUserId: auth.context.user.id,
        completedAt: now,
        version,
      };
      const evidence = {
        id: crypto.randomUUID(),
        workspaceId,
        agreementId: current.agreementId,
        obligationId: current.id,
        evidenceText: input.record.evidence,
        evidenceSha256: await sha256Hex(input.record.evidence),
        submittedByUserId: auth.context.user.id,
        overrideReason: !completingOwnObligation ? input.record.overrideReason ?? null : null,
        provenance: "native" as const,
        createdAt: now,
      } satisfies typeof obligationEvidence.$inferInsert;
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: current.agreementId,
        type: "Obligation",
        detail: !completingOwnObligation
          ? `Completed “${current.title}” with recorded evidence using an authorized owner override. Reason: ${input.record.overrideReason}`
          : `Completed “${current.title}” with recorded evidence.`,
        actor: auth.context.user,
        createdAt: now,
      });
      const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
        workspaceId,
        topic: "obligation.completed",
        aggregateType: "obligation",
        aggregateId: current.id,
        payload: {
          obligationId: current.id,
          agreementId: current.agreementId,
          aggregateVersion: version,
          causationId: auth.requestId,
          ...(!completingOwnObligation ? { overrideReason: input.record.overrideReason } : {}),
        },
      }));
      const guardId = crypto.randomUUID();
      try {
        await db.batch([
          db.update(obligations).set(obligationPatch).where(and(
            eq(obligations.workspaceId, workspaceId),
            eq(obligations.id, current.id),
            eq(obligations.version, current.version),
            ne(obligations.status, "Complete"),
            ...(completingOwnObligation
              ? [eq(obligations.ownerUserId, auth.context.user.id)]
              : []),
            exists(db.select({ id: agreements.id }).from(agreements).where(and(
              eq(agreements.workspaceId, workspaceId),
              eq(agreements.id, current.agreementId),
              isNull(agreements.deletedAt),
            ))),
          )),
          db.insert(mutationGuards).values({ id: guardId, workspaceId, operation: "obligation.complete", guardChanges: sql<number>`changes()`, createdAt: now }),
          db.insert(obligationEvidence).values(evidence),
          db.insert(agreementEvents).values(event),
          db.insert(outboxEvents).values(outbox),
          db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), eq(mutationGuards.id, guardId))),
        ]);
      } catch (error) {
        if (isObligationEvidenceConflict(error)) {
          return apiError("obligation_already_complete", "This obligation already has immutable completion evidence.", { status: 409, requestId: auth.requestId });
        }
        if (!isMutationGuardConflict(error) && !isAgreementEventSequenceConflict(error)) throw error;
        return apiError("version_conflict", "Reload this obligation before completing it.", { status: 409, requestId: auth.requestId });
      }
      return apiJson({
        obligation: {
          ...current,
          status: "Complete",
          completionEvidence: input.record.evidence,
          completedByUserId: auth.context.user.id,
          completedAt: now,
          version,
        },
        evidence,
        event,
        requestId: auth.requestId,
      }, { requestId: auth.requestId, headers: auth.headers });
    }

    if (input.entity === "obligation" && input.action === "reassign") {
      if (!auth.context.permissions.has("obligation:write")) return permissionDenied(auth.requestId);
      const [scheduleRow] = await db.select({ schedule: obligationSchedules }).from(obligationSchedules)
        .innerJoin(agreements, and(
          eq(agreements.workspaceId, obligationSchedules.workspaceId),
          eq(agreements.id, obligationSchedules.agreementId),
          isNull(agreements.deletedAt),
        )).where(and(
          eq(obligationSchedules.workspaceId, workspaceId),
          eq(obligationSchedules.id, input.record.scheduleId),
        )).limit(1);
      const current = scheduleRow?.schedule;
      if (!current) {
        return apiError("obligation_schedule_not_found", "Obligation schedule was not found.", { status: 404, requestId: auth.requestId });
      }
      if (input.record.version !== current.version) {
        return apiError("version_conflict", "Reload this obligation schedule before reassigning it.", { status: 409, requestId: auth.requestId });
      }
      if (input.record.newOwnerUserId === current.ownerUserId) {
        return apiError("obligation_owner_unchanged", "The selected member already owns this obligation schedule.", { status: 409, requestId: auth.requestId });
      }
      const newOwner = await findEligibleObligationOwner(db, workspaceId, input.record.newOwnerUserId);
      if (!newOwner) {
        return apiError(
          "obligation_owner_ineligible",
          "The selected owner must be an active admin, legal, approver, or requester workspace member.",
          { status: 400, requestId: auth.requestId },
        );
      }
      const version = current.version + 1;
      const schedulePatch = {
        ownerUserId: newOwner.userId,
        owner: newOwner.displayName,
        version,
        updatedByUserId: auth.context.user.id,
        updatedAt: now,
      };
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: current.agreementId,
        type: "Obligation",
        detail: `Reassigned obligation schedule “${current.title}” and all open occurrences from ${current.owner} to ${newOwner.displayName}. Reason: ${input.record.reason}`,
        actor: auth.context.user,
        createdAt: now,
      });
      const guardId = crypto.randomUUID();
      try {
        await db.batch([
          db.update(obligationSchedules).set(schedulePatch).where(and(
            eq(obligationSchedules.workspaceId, workspaceId),
            eq(obligationSchedules.id, current.id),
            eq(obligationSchedules.version, current.version),
            exists(db.select({ id: agreements.id }).from(agreements).where(and(
              eq(agreements.workspaceId, workspaceId),
              eq(agreements.id, current.agreementId),
              isNull(agreements.deletedAt),
            ))),
            exists(db.select({ userId: workspaceMemberships.userId }).from(workspaceMemberships)
              .innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
                eq(workspaceMemberships.workspaceId, workspaceId),
                eq(workspaceMemberships.userId, newOwner.userId),
                eq(workspaceMemberships.status, "active"),
                eq(users.status, "active"),
                inArray(workspaceMemberships.role, OBLIGATION_OWNER_ROLES),
              ))),
          )),
          db.insert(mutationGuards).values({
            id: guardId,
            workspaceId,
            operation: "obligation.schedule.reassign",
            guardChanges: sql<number>`changes()`,
            createdAt: now,
          }),
          db.update(obligations).set({
            ownerUserId: newOwner.userId,
            owner: newOwner.displayName,
            version: sql`${obligations.version} + 1`,
          }).where(and(
            eq(obligations.workspaceId, workspaceId),
            eq(obligations.scheduleId, current.id),
            eq(obligations.status, "Open"),
          )),
          db.insert(agreementEvents).values(event),
          db.delete(mutationGuards).where(and(
            eq(mutationGuards.workspaceId, workspaceId),
            eq(mutationGuards.id, guardId),
          )),
        ]);
      } catch (error) {
        if (!isMutationGuardConflict(error) && !isAgreementEventSequenceConflict(error)) throw error;
        return apiError(
          "obligation_schedule_basis_changed",
          "The schedule, agreement, or selected owner changed while reassignment was saved. Reload before retrying.",
          { status: 409, requestId: auth.requestId },
        );
      }
      const updatedOpenOccurrences = await db.select().from(obligations).where(and(
        eq(obligations.workspaceId, workspaceId),
        eq(obligations.scheduleId, current.id),
        eq(obligations.status, "Open"),
      )).orderBy(asc(obligations.occurrenceNumber));
      return apiJson({
        schedule: { ...current, ...schedulePatch },
        updatedOpenOccurrences,
        event,
        requestId: auth.requestId,
      }, { requestId: auth.requestId, headers: auth.headers });
    }

    if (input.entity === "obligation" && input.action === "schedule_status") {
      if (!auth.context.permissions.has("obligation:write")) return permissionDenied(auth.requestId);
      const [scheduleRow] = await db.select({ schedule: obligationSchedules }).from(obligationSchedules)
        .innerJoin(agreements, and(
          eq(agreements.workspaceId, obligationSchedules.workspaceId),
          eq(agreements.id, obligationSchedules.agreementId),
          isNull(agreements.deletedAt),
        )).where(and(
          eq(obligationSchedules.workspaceId, workspaceId),
          eq(obligationSchedules.id, input.record.scheduleId),
        )).limit(1);
      const current = scheduleRow?.schedule;
      if (!current) {
        return apiError("obligation_schedule_not_found", "Obligation schedule was not found.", { status: 404, requestId: auth.requestId });
      }
      if (input.record.version !== current.version) {
        return apiError("version_conflict", "Reload this obligation schedule before changing its status.", { status: 409, requestId: auth.requestId });
      }
      if (current.status === "ended") {
        return apiError("obligation_schedule_ended", "An ended obligation schedule cannot be resumed or paused.", { status: 409, requestId: auth.requestId });
      }
      if (input.record.status === current.status) {
        return apiError("obligation_schedule_status_unchanged", "The obligation schedule already has this status.", { status: 409, requestId: auth.requestId });
      }
      if (input.record.status === "active" && !await findEligibleObligationOwner(db, workspaceId, current.ownerUserId ?? "")) {
        return apiError(
          "obligation_owner_ineligible",
          "Assign an active eligible owner before resuming this obligation schedule.",
          { status: 409, requestId: auth.requestId },
        );
      }
      const version = current.version + 1;
      const schedulePatch = {
        status: input.record.status,
        version,
        ...(input.record.status === "ended" ? {
          nextOccurrenceNumber: null,
          nextOccurrenceDate: null,
          nextMaterializationDate: null,
        } : {}),
        updatedByUserId: auth.context.user.id,
        updatedAt: now,
      };
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: current.agreementId,
        type: "Obligation",
        detail: `Changed obligation schedule “${current.title}” from ${current.status} to ${input.record.status}. Reason: ${input.record.reason}`,
        actor: auth.context.user,
        createdAt: now,
      });
      const guardId = crypto.randomUUID();
      try {
        await db.batch([
          db.update(obligationSchedules).set(schedulePatch).where(and(
            eq(obligationSchedules.workspaceId, workspaceId),
            eq(obligationSchedules.id, current.id),
            eq(obligationSchedules.version, current.version),
            ne(obligationSchedules.status, "ended"),
            exists(db.select({ id: agreements.id }).from(agreements).where(and(
              eq(agreements.workspaceId, workspaceId),
              eq(agreements.id, current.agreementId),
              isNull(agreements.deletedAt),
            ))),
            ...(input.record.status === "active" ? [
              exists(db.select({ userId: workspaceMemberships.userId }).from(workspaceMemberships)
                .innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
                  eq(workspaceMemberships.workspaceId, workspaceId),
                  eq(workspaceMemberships.userId, current.ownerUserId ?? ""),
                  eq(workspaceMemberships.status, "active"),
                  eq(users.status, "active"),
                  inArray(workspaceMemberships.role, OBLIGATION_OWNER_ROLES),
                ))),
            ] : []),
          )),
          db.insert(mutationGuards).values({
            id: guardId,
            workspaceId,
            operation: "obligation.schedule.status",
            guardChanges: sql<number>`changes()`,
            createdAt: now,
          }),
          db.insert(agreementEvents).values(event),
          db.delete(mutationGuards).where(and(
            eq(mutationGuards.workspaceId, workspaceId),
            eq(mutationGuards.id, guardId),
          )),
        ]);
      } catch (error) {
        if (!isMutationGuardConflict(error) && !isAgreementEventSequenceConflict(error)) throw error;
        return apiError(
          "obligation_schedule_basis_changed",
          "The schedule, agreement, or owner changed while its status was saved. Reload before retrying.",
          { status: 409, requestId: auth.requestId },
        );
      }
      return apiJson({ schedule: { ...current, ...schedulePatch }, event, requestId: auth.requestId }, {
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }

    if (input.entity === "event" && input.action === "comment") {
      if (!auth.context.permissions.has("audit:append")) return permissionDenied(auth.requestId);
      const agreement = await findActiveAgreement(db, workspaceId, input.record.agreementId);
      if (!agreement) return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId: auth.requestId });
      const event = await appendAgreementEvent(db, {
        workspaceId,
        agreementId: agreement.id,
        type: input.record.eventType,
        detail: input.record.detail,
        actor: auth.context.user,
        createdAt: now,
      });
      return apiJson({ event, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
    }

    return apiError("unsupported_operation", "This operation is not supported.", { status: 400, requestId: auth.requestId });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Agreement operation could not be completed.");
  }
}

function permissionDenied(requestId: string) {
  return apiError("permission_denied", "You do not have permission to perform this action.", { status: 403, requestId });
}
