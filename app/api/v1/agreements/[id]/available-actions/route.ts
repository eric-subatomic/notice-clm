import { and, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { ensureStorageSchema } from "../../../../../../db/ensure";
import {
  agreementDocumentVersions,
  agreements,
  approvalRequests,
  negotiationRounds,
  signaturePackets,
} from "../../../../../../db/schema";
import { computeAgreementBasisHash } from "../../../../../lib/agreement-basis";
import { evaluateAgreementRiskReadiness } from "../../../../../lib/agreement-risk";
import { actionRegistry, type ActionId, type ActionTargetPrecondition } from "../../../../../lib/action-registry";
import {
  APPROVAL_LANE_LIMIT_BLOCKER_CODE,
  APPROVAL_LANE_LIMIT_MESSAGE,
  approvalsSatisfyPolicy,
  MAX_CURRENT_APPROVAL_LANES,
} from "../../../../../lib/approval-policy";
import { handleRouteError } from "../../../../../lib/api";
import { apiError, apiJson } from "../../../../../lib/http";
import {
  AGENT_API_SCHEMA_VERSION,
  authorizeResolvedServiceAction,
  authorizeV1ReadRequest,
  buildActionAffordance,
  type AgentAuthorityBlocker,
} from "../../../../../lib/service-principal-auth";

const OPEN_NEGOTIATION_STATUSES = ["prepared", "outbound", "returned", "review"] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function agreementNotFound(requestId: string, headers: HeadersInit): Response {
  return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId, headers });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizeV1ReadRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const rawId = (await context.params).id;
    if (!/^[1-9]\d*$/.test(rawId)) return agreementNotFound(auth.requestId, auth.headers);
    const agreementId = Number(rawId);
    if (!Number.isSafeInteger(agreementId)) return agreementNotFound(auth.requestId, auth.headers);
    const resource = { type: "agreement", id: String(agreementId) } as const;

    if (auth.actor.kind === "human") {
      if (!auth.actor.context.permissions.has("agreement:read")) {
        return apiError("permission_denied", "You do not have permission to read this agreement.", {
          status: 403,
          requestId: auth.requestId,
          headers: auth.headers,
        });
      }
    } else {
      const readAuthority = authorizeResolvedServiceAction(auth.actor.context, "agreement.read", resource);
      if (!readAuthority.authorized) {
        return apiError("service_authority_denied", "No single active grant authorizes this agreement resource.", {
          status: 403,
          requestId: auth.requestId,
          headers: auth.headers,
        });
      }
    }

    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.actor.context.workspace.id;
    const [agreement] = await db.select().from(agreements).where(and(
      eq(agreements.workspaceId, workspaceId),
      eq(agreements.id, agreementId),
      isNull(agreements.deletedAt),
    )).limit(1);
    if (!agreement) return agreementNotFound(auth.requestId, auth.headers);

    const [[workingDocument], [openNegotiation], [activeSignature]] = await Promise.all([
      db.select({
        version: agreementDocumentVersions.version,
        sha256: agreementDocumentVersions.sha256,
      }).from(agreementDocumentVersions).where(and(
        eq(agreementDocumentVersions.workspaceId, workspaceId),
        eq(agreementDocumentVersions.agreementId, agreementId),
      )).orderBy(desc(agreementDocumentVersions.version)).limit(1),
      db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
        eq(negotiationRounds.workspaceId, workspaceId),
        eq(negotiationRounds.agreementId, agreementId),
        inArray(negotiationRounds.status, OPEN_NEGOTIATION_STATUSES),
      )).limit(1),
      db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
        eq(signaturePackets.workspaceId, workspaceId),
        eq(signaturePackets.agreementId, agreementId),
        isNotNull(signaturePackets.activeKey),
      )).limit(1),
    ]);

    const exactDocument = workingDocument
      && Number.isSafeInteger(workingDocument.version)
      && workingDocument.version > 0
      && SHA256_PATTERN.test(workingDocument.sha256)
      ? workingDocument
      : null;
    const riskReadiness = exactDocument
      ? await evaluateAgreementRiskReadiness(agreement, exactDocument)
      : null;
    const workflowBasisHash = exactDocument
      ? await computeAgreementBasisHash(agreement, exactDocument)
      : null;
    const approvals = exactDocument && workflowBasisHash
      ? await db.select().from(approvalRequests).where(and(
          eq(approvalRequests.workspaceId, workspaceId),
          eq(approvalRequests.agreementId, agreementId),
          ne(approvalRequests.status, "Superseded"),
          eq(approvalRequests.basisHash, workflowBasisHash),
          eq(approvalRequests.documentVersion, exactDocument.version),
          eq(approvalRequests.documentSha256, exactDocument.sha256),
        )).limit(MAX_CURRENT_APPROVAL_LANES + 1)
      : [];
    const approvalLaneLimitReached = approvals.length >= MAX_CURRENT_APPROVAL_LANES;
    const approvalSatisfied = exactDocument && workflowBasisHash
      && approvals.length <= MAX_CURRENT_APPROVAL_LANES
      ? approvalsSatisfyPolicy(agreement, approvals, {
        hash: workflowBasisHash,
        documentVersion: exactDocument.version,
        documentSha256: exactDocument.sha256,
      })
      : false;
    const preconditions: ActionTargetPrecondition[] = [];
    if (exactDocument) preconditions.push("working_document_present");
    if (riskReadiness?.evaluation.cleared) preconditions.push("risk_cleared");
    if (!openNegotiation) preconditions.push("no_open_changes");
    if (approvalSatisfied) preconditions.push("approvals_satisfied");
    if (!activeSignature) preconditions.push("signature_not_in_flight");
    const humanContext = auth.actor.kind === "human" ? auth.actor.context : null;
    const serviceContext = auth.actor.kind === "service" ? auth.actor.context : null;
    const applyApprovalLaneLimit = (
      actionId: ActionId,
      affordance: ReturnType<typeof buildActionAffordance>,
    ) => actionId === "approval.request" && approvalLaneLimitReached
      ? {
        ...affordance,
        availableNow: false,
        blockers: [
          ...affordance.blockers,
          { code: APPROVAL_LANE_LIMIT_BLOCKER_CODE, message: APPROVAL_LANE_LIMIT_MESSAGE },
        ],
      }
      : affordance;

    const actions = actionRegistry
      .filter((definition) => definition.targetTypes.includes("agreement"))
      .map((definition) => {
        const basisHash = definition.id === "risk.assess" || definition.id === "risk.waive"
          ? riskReadiness?.basisHash
          : workflowBasisHash;
        if (humanContext) {
          const missingPermissions = definition.permissions.filter((permission) =>
            !humanContext.permissions.has(permission as never));
          const authorityBlockers: AgentAuthorityBlocker[] = missingPermissions.map((permission) => ({
            code: "ACTION_PERMISSION_REQUIRED",
            permission,
            message: `Missing permission: ${permission}.`,
          }));
          return applyApprovalLaneLimit(definition.id, buildActionAffordance({
            definition,
            actorKind: "human",
            permissions: humanContext.permissions,
            target: {
              type: "agreement",
              id: resource.id,
              version: agreement.version,
              ...(basisHash ? { basisHash } : {}),
              ...(exactDocument ? {
                documentVersion: exactDocument.version,
                documentSha256: exactDocument.sha256,
              } : {}),
              stage: agreement.stage,
              satisfiedPreconditions: preconditions,
            },
            authority: { authorized: missingPermissions.length === 0, blockers: authorityBlockers },
          }));
        }

        const authority = authorizeResolvedServiceAction(
          serviceContext!,
          definition.id as ActionId,
          resource,
        );
        return applyApprovalLaneLimit(definition.id, buildActionAffordance({
          definition,
          actorKind: "agent",
          permissions: authority.effectivePermissions,
          target: {
            type: "agreement",
            id: resource.id,
            version: agreement.version,
            ...(basisHash ? { basisHash } : {}),
            ...(exactDocument ? {
              documentVersion: exactDocument.version,
              documentSha256: exactDocument.sha256,
            } : {}),
            stage: agreement.stage,
            satisfiedPreconditions: preconditions,
          },
          authority,
        }));
      });

    const actor = auth.actor.kind === "human"
      ? { kind: "human" as const, userId: auth.actor.context.user.id, role: auth.actor.context.role }
      : {
        kind: "service" as const,
        principalId: auth.actor.context.principal.id,
        principalVersion: auth.actor.context.principal.version,
      };
    return apiJson({
      schemaVersion: AGENT_API_SCHEMA_VERSION,
      actor,
      agreement: {
        id: agreement.id,
        version: agreement.version,
        stage: agreement.stage,
      },
      evidence: {
        targetVersion: agreement.version,
        workingDocument: exactDocument
          ? { version: exactDocument.version, sha256: exactDocument.sha256 }
          : null,
        risk: {
          level: agreement.risk,
          disposition: agreement.riskDisposition,
          basisHash: riskReadiness?.basisHash ?? null,
          cleared: riskReadiness?.evaluation.cleared ?? false,
          blockers: riskReadiness?.evaluation.blockers ?? [{
            code: "RISK_ASSESSMENT_EVIDENCE_REQUIRED",
            message: "A valid working document is required before risk can be governed.",
          }],
        },
        approval: {
          status: agreement.approvalStatus,
          basisHash: workflowBasisHash,
          documentVersion: exactDocument?.version ?? null,
          documentSha256: exactDocument?.sha256 ?? null,
          satisfied: approvalSatisfied,
        },
        preconditions: {
          workingDocumentPresent: Boolean(exactDocument),
          riskCleared: riskReadiness?.evaluation.cleared ?? false,
          noOpenChanges: !openNegotiation,
          approvalsSatisfied: approvalSatisfied,
          signatureNotInFlight: !activeSignature,
        },
      },
      actions,
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Available actions could not be evaluated.");
  }
}
