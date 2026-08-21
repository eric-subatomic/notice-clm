import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import {
  agentActionPlans,
  agentRuns,
  agreementDocumentVersions,
  agreements,
  approvalRequests,
  negotiationRounds,
  signaturePackets,
} from "../../../../db/schema";
import { computeAgreementBasisHash, computeRiskAssessmentBasisHash } from "../../../lib/agreement-basis";
import { evaluateAgreementRiskReadiness } from "../../../lib/agreement-risk";
import { deriveAgentActionPlanFields, parseAgentActionInput } from "../../../lib/agent-action-contracts";
import {
  AGENT_API_V1_UNSUPPORTED_ACTION_ERROR_CODE,
  actionIds,
  evaluateAction,
  getAgentApiV1ActionCapability,
  getActionDefinition,
  isAgentApiV1ActionId,
  type ActionBlocker,
  type ActionId,
  type ActionTargetPrecondition,
} from "../../../lib/action-registry";
import {
  canonicalJson,
  canonicalJsonDigest,
  computeAgentActionPlanDigest,
  type AgentActionPlanMaterial,
} from "../../../lib/agent-governance";
import { approvalsSatisfyPolicy } from "../../../lib/approval-policy";
import { inspectRequiredApprovalRouting } from "../../../lib/approval-routing-service";
import { handleRouteError } from "../../../lib/api";
import { apiError, apiJson } from "../../../lib/http";
import { authorizeServicePrincipalRequest } from "../../../lib/service-principal-auth";
import { ACTION_CATALOG_VERSION } from "../../../lib/service-principal-auth";
import { parseJson } from "../../../lib/validation";

const MAX_PLAN_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MIN_PLAN_LIFETIME_MS = 60_000;
const OPEN_NEGOTIATION_STATUSES = ["prepared", "outbound", "returned", "review"] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const idempotencyKeySchema = z.string().min(8).max(200)
  .regex(/^[\x21-\x7e]+$/, "Idempotency-Key must contain bounded visible ASCII characters.");
type Database = ReturnType<typeof getDb>;

const canonicalInstantSchema = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "Use a canonical ISO-8601 UTC instant.");

const boundedRecordSchema = z.record(z.string().min(1).max(128), z.unknown()).superRefine((value, context) => {
  if (Object.keys(value).length > 100) {
    context.addIssue({ code: "custom", message: "At most 100 top-level fields are allowed." });
  }
});

const proposalSchema = z.object({
  grantId: z.string().uuid(),
  actionId: z.enum(actionIds),
  target: z.object({
    type: z.literal("agreement"),
    id: z.string().regex(/^[1-9]\d{0,15}$/),
    expectedVersion: z.number().int().positive().optional(),
    expectedBasisHash: z.string().regex(SHA256_PATTERN).optional(),
  }).strict(),
  input: boundedRecordSchema,
  proposedDiff: boundedRecordSchema.default({}),
  actorConfirmed: z.boolean().default(false),
  expiresAt: canonicalInstantSchema.optional(),
  provenance: z.object({
    purpose: z.string().trim().min(3).max(500),
    modelProvider: z.string().trim().min(1).max(100).optional(),
    modelId: z.string().trim().min(1).max(200),
    toolVersion: z.string().trim().min(1).max(200),
    promptSha256: z.string().regex(SHA256_PATTERN).optional(),
    contextSha256: z.string().regex(SHA256_PATTERN).optional(),
  }).strict(),
}).strict();

const listSchema = z.object({
  grantId: z.string().uuid(),
  actionId: z.enum(actionIds),
  resourceType: z.literal("agreement"),
  resourceId: z.string().regex(/^[1-9]\d{0,15}$/),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().uuid().optional(),
}).strict();

function uuidFromSha256(digest: string): string {
  const value = digest.slice(0, 32).split("");
  value[12] = "5";
  value[16] = "8";
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function idempotencyEvidence(plan: typeof agentActionPlans.$inferSelect): Readonly<{
  keySha256: string;
  requestSha256: string;
}> | null {
  if (!plan.provenance || typeof plan.provenance !== "object" || Array.isArray(plan.provenance)) return null;
  const candidate = (plan.provenance as Record<string, unknown>).idempotency;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const keySha256 = (candidate as Record<string, unknown>).keySha256;
  const requestSha256 = (candidate as Record<string, unknown>).requestSha256;
  return typeof keySha256 === "string" && SHA256_PATTERN.test(keySha256)
    && typeof requestSha256 === "string" && SHA256_PATTERN.test(requestSha256)
    ? { keySha256, requestSha256 }
    : null;
}

function isPlanInsertConflict(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("unique constraint failed")
    && (message.includes("agent_action_plans") || message.includes("agent_runs"));
}

function isExactProposalReplay(
  plan: typeof agentActionPlans.$inferSelect,
  expected: Readonly<{
    keySha256: string;
    requestSha256: string;
    grantId: string;
    actionId: string;
    resourceType: string;
    resourceId: string;
  }>,
): boolean {
  const evidence = idempotencyEvidence(plan);
  return Boolean(
    evidence
    && evidence.keySha256 === expected.keySha256
    && evidence.requestSha256 === expected.requestSha256
    && plan.grantId === expected.grantId
    && plan.actionId === expected.actionId
    && plan.resourceType === expected.resourceType
    && plan.resourceId === expected.resourceId,
  );
}

function planProjection(plan: typeof agentActionPlans.$inferSelect) {
  return {
    id: plan.id,
    principalId: plan.principalId,
    grantId: plan.grantId,
    actionId: plan.actionId,
    target: { type: plan.resourceType, id: plan.resourceId },
    status: plan.status,
    riskTier: plan.riskTier,
    input: plan.canonicalInput,
    inputSha256: plan.inputSha256,
    planSha256: plan.planSha256,
    expectedVersion: plan.expectedVersion,
    basisHash: plan.basisHash,
    workingDocument: plan.documentVersion && plan.documentSha256
      ? { version: plan.documentVersion, sha256: plan.documentSha256 }
      : null,
    policyVersion: plan.policyVersion,
    before: plan.beforeSnapshot,
    proposedDiff: plan.proposedDiff,
    blockers: plan.blockers,
    provenance: plan.provenance,
    expiresAt: plan.expiresAt,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

async function loadActiveAgreementTarget(db: Database, workspaceId: string, agreementId: number) {
  const [agreement] = await db.select().from(agreements).where(and(
    eq(agreements.workspaceId, workspaceId),
    eq(agreements.id, agreementId),
    isNull(agreements.deletedAt),
  )).limit(1);
  return agreement ?? null;
}

async function agreementPlanningSnapshot(db: Database, workspaceId: string, agreementId: number, actionId: ActionId) {
  const agreement = await loadActiveAgreementTarget(db, workspaceId, agreementId);
  if (!agreement) return null;

  const [[document], approvals, [openNegotiation], [activeSignature]] = await Promise.all([
    db.select({ version: agreementDocumentVersions.version, sha256: agreementDocumentVersions.sha256 })
      .from(agreementDocumentVersions).where(and(
        eq(agreementDocumentVersions.workspaceId, workspaceId),
        eq(agreementDocumentVersions.agreementId, agreementId),
      )).orderBy(desc(agreementDocumentVersions.version)).limit(1),
    db.select().from(approvalRequests).where(and(
      eq(approvalRequests.workspaceId, workspaceId),
      eq(approvalRequests.agreementId, agreementId),
    )),
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
  const exactDocument = document
    && Number.isSafeInteger(document.version)
    && document.version > 0
    && SHA256_PATTERN.test(document.sha256)
    ? document
    : null;
  const workflowBasisHash = exactDocument ? await computeAgreementBasisHash(agreement, exactDocument) : null;
  const riskBasisHash = exactDocument ? await computeRiskAssessmentBasisHash(agreement, exactDocument) : null;
  const planBasisHash = (actionId === "risk.assess" || actionId === "risk.waive")
    ? riskBasisHash
    : workflowBasisHash;
  // The digest must also bind the absence of a working paper for read plans.
  const durableBasisHash = planBasisHash ?? await canonicalJsonDigest({
    kind: "notice.agreement-without-working-document",
    workspaceId,
    agreementId,
    agreementVersion: agreement.version,
  });
  const riskReadiness = exactDocument ? await evaluateAgreementRiskReadiness(agreement, exactDocument) : null;
  const preconditions: ActionTargetPrecondition[] = [];
  if (exactDocument) preconditions.push("working_document_present");
  if (riskReadiness?.evaluation.cleared) preconditions.push("risk_cleared");
  if (!openNegotiation) preconditions.push("no_open_changes");
  if (exactDocument && workflowBasisHash && approvalsSatisfyPolicy(agreement, approvals, {
    hash: workflowBasisHash,
    documentVersion: exactDocument.version,
    documentSha256: exactDocument.sha256,
  })) preconditions.push("approvals_satisfied");
  if (!activeSignature) preconditions.push("signature_not_in_flight");

  return {
    agreement,
    document: exactDocument,
    actionBasisHash: planBasisHash,
    durableBasisHash,
    preconditions,
    before: {
      agreement: {
        id: agreement.id,
        version: agreement.version,
        party: agreement.party,
        side: agreement.side,
        type: agreement.type,
        value: agreement.value,
        valueMinor: agreement.valueMinor,
        currencyCode: agreement.currencyCode,
        stage: agreement.stage,
        owner: agreement.owner,
        ownerUserId: agreement.ownerUserId,
        primaryCounterpartyId: agreement.primaryCounterpartyId,
        legalEntityId: agreement.legalEntityId,
        governedTemplateVersionId: agreement.governedTemplateVersionId,
        workflowDefinitionId: agreement.workflowDefinitionId,
        workflowPolicySha256: agreement.workflowPolicySha256,
        workflowApprovalLanes: agreement.workflowApprovalLanes,
        department: agreement.department,
        risk: agreement.risk,
        riskDisposition: agreement.riskDisposition,
        approvalStatus: agreement.approvalStatus,
        signatureStatus: agreement.signatureStatus,
        effectiveDate: agreement.effectiveDate,
        expirationDate: agreement.expirationDate,
      },
      workingDocument: exactDocument,
    },
  };
}

export async function GET(request: Request) {
  const parsed = listSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return apiError("invalid_plan_query", "An exact action and agreement resource are required.", { status: 400 });
  }
  if (!isAgentApiV1ActionId(parsed.data.actionId)) {
    const capability = getAgentApiV1ActionCapability(parsed.data.actionId);
    return apiError(
      AGENT_API_V1_UNSUPPORTED_ACTION_ERROR_CODE,
      capability.blocker?.message ?? "The requested action is not supported by the v1 agent contract.",
      { status: 409 },
    );
  }
  const resource = { type: parsed.data.resourceType, id: parsed.data.resourceId } as const;
  const auth = await authorizeServicePrincipalRequest(request, parsed.data.actionId, resource, parsed.data.grantId);
  if (!auth.ok) return auth.response;
  try {
    await ensureStorageSchema();
    const db = getDb();
    const agreementId = Number(resource.id);
    const activeAgreement = Number.isSafeInteger(agreementId)
      ? await loadActiveAgreementTarget(db, auth.workspace.id, agreementId)
      : null;
    if (!activeAgreement) {
      return apiError("agreement_not_found", "Agreement was not found.", {
        status: 404, requestId: auth.requestId, headers: auth.headers,
      });
    }
    let cursorCondition;
    if (parsed.data.cursor) {
      const [cursor] = await db.select({ id: agentActionPlans.id, createdAt: agentActionPlans.createdAt })
        .from(agentActionPlans).where(and(
          eq(agentActionPlans.workspaceId, auth.workspace.id),
          eq(agentActionPlans.principalId, auth.principal.id),
          eq(agentActionPlans.grantId, auth.grant.id),
          eq(agentActionPlans.actionId, parsed.data.actionId),
          eq(agentActionPlans.resourceType, resource.type),
          eq(agentActionPlans.resourceId, resource.id),
          eq(agentActionPlans.id, parsed.data.cursor),
        )).limit(1);
      if (!cursor) return apiError("invalid_cursor", "The plan cursor is invalid for this authority scope.", {
        status: 400, requestId: auth.requestId, headers: auth.headers,
      });
      cursorCondition = or(
        lt(agentActionPlans.createdAt, cursor.createdAt),
        and(eq(agentActionPlans.createdAt, cursor.createdAt), lt(agentActionPlans.id, cursor.id)),
      );
    }
    const rows = await db.select().from(agentActionPlans).where(and(
      eq(agentActionPlans.workspaceId, auth.workspace.id),
      eq(agentActionPlans.principalId, auth.principal.id),
      eq(agentActionPlans.grantId, auth.grant.id),
      eq(agentActionPlans.actionId, parsed.data.actionId),
      eq(agentActionPlans.resourceType, resource.type),
      eq(agentActionPlans.resourceId, resource.id),
      cursorCondition,
    )).orderBy(desc(agentActionPlans.createdAt), desc(agentActionPlans.id)).limit(parsed.data.limit + 1);
    const hasMore = rows.length > parsed.data.limit;
    const page = rows.slice(0, parsed.data.limit);
    if (!await loadActiveAgreementTarget(db, auth.workspace.id, agreementId)) {
      return apiError("agreement_not_found", "Agreement was not found.", {
        status: 404, requestId: auth.requestId, headers: auth.headers,
      });
    }
    return apiJson({
      plans: page.map(planProjection),
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Agent plans could not be loaded.");
  }
}

export async function POST(request: Request) {
  let input: z.output<typeof proposalSchema>;
  try {
    input = await parseJson(request, proposalSchema, 128_000);
  } catch (error) {
    return handleRouteError(error, undefined, "The plan proposal was invalid.");
  }
  if (!isAgentApiV1ActionId(input.actionId)) {
    const capability = getAgentApiV1ActionCapability(input.actionId);
    return apiError(
      AGENT_API_V1_UNSUPPORTED_ACTION_ERROR_CODE,
      capability.blocker?.message ?? "The requested action is not supported by the v1 agent contract.",
      { status: 409 },
    );
  }
  const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!idempotencyKey.success) {
    return apiError("idempotency_key_required", "A bounded Idempotency-Key is required and must be retained for every plan-proposal retry.", {
      status: 400,
    });
  }
  const definition = getActionDefinition(input.actionId);
  if (!definition.targetTypes.includes("agreement")) {
    return apiError("action_not_executable", "This action cannot be planned against an agreement target.", { status: 409 });
  }
  const resource = { type: input.target.type, id: input.target.id } as const;
  const auth = await authorizeServicePrincipalRequest(request, input.actionId, resource, input.grantId);
  if (!auth.ok) return auth.response;
  try {
    await ensureStorageSchema();
    const db = getDb();
    const keySha256 = await canonicalJsonDigest({
      kind: "notice.agent-plan-idempotency-key",
      workspaceId: auth.workspace.id,
      principalId: auth.principal.id,
      key: idempotencyKey.data,
    });
    const parsedActionInput = parseAgentActionInput(input.actionId, input.input);
    if (input.actionId === "approval.request" && Object.keys(input.proposedDiff).length > 0) {
      return apiError("caller_authored_effect_forbidden", "Approval routing effects are derived exclusively from current server policy and target state.", {
        status: 400, requestId: auth.requestId, headers: auth.headers,
      });
    }
    const requestSha256 = await canonicalJsonDigest({
      kind: "notice.agent-plan-proposal-request",
      input: { ...input, input: parsedActionInput },
    });
    const planId = uuidFromSha256(keySha256);
    const agreementId = Number(input.target.id);
    if (!Number.isSafeInteger(agreementId)) {
      return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId: auth.requestId, headers: auth.headers });
    }
    const [existingPlan] = await db.select().from(agentActionPlans).where(and(
      eq(agentActionPlans.workspaceId, auth.workspace.id),
      eq(agentActionPlans.principalId, auth.principal.id),
      eq(agentActionPlans.id, planId),
    )).limit(1);
    if (existingPlan) {
      if (!isExactProposalReplay(existingPlan, {
        keySha256,
        requestSha256,
        grantId: input.grantId,
        actionId: input.actionId,
        resourceType: resource.type,
        resourceId: resource.id,
      })) {
        return apiError("idempotency_key_conflict", "This Idempotency-Key was already used for a different plan proposal.", {
          status: 409, requestId: auth.requestId, headers: auth.headers,
        });
      }
      const activeAgreement = await loadActiveAgreementTarget(db, auth.workspace.id, agreementId);
      if (!activeAgreement) {
        return apiError("agreement_not_found", "Agreement was not found.", {
          status: 404, requestId: auth.requestId, headers: auth.headers,
        });
      }
      const replayHeaders = new Headers(auth.headers);
      replayHeaders.set("Idempotency-Replayed", "true");
      return apiJson({ plan: planProjection(existingPlan), replay: true, requestId: auth.requestId }, {
        requestId: auth.requestId,
        headers: replayHeaders,
      });
    }
    const snapshot = await agreementPlanningSnapshot(db, auth.workspace.id, agreementId, input.actionId);
    if (!snapshot) return apiError("agreement_not_found", "Agreement was not found.", {
      status: 404, requestId: auth.requestId, headers: auth.headers,
    });

    const approvalRouting = input.actionId === "approval.request"
      ? await inspectRequiredApprovalRouting({
        db,
        workspaceId: auth.workspace.id,
        agreementId,
        due: (parsedActionInput as { due: string }).due,
      })
      : null;
    if (approvalRouting?.blockers.length) {
      const blocker = approvalRouting.blockers[0];
      return apiError(blocker.code, blocker.message, {
        status: blocker.status, requestId: auth.requestId, headers: auth.headers,
      });
    }
    if (approvalRouting?.noOp) {
      return apiError("action_no_effect", "The required approval lanes and aggregate approval state already match current policy for this exact paper.", {
        status: 409, requestId: auth.requestId, headers: auth.headers,
      });
    }
    const derivedFields = deriveAgentActionPlanFields({
      actionId: input.actionId,
      actionInput: parsedActionInput,
      callerProposedDiff: input.proposedDiff,
      approvalRouting,
    });

    const evaluation = evaluateAction(definition, {
      actor: { kind: "agent", permissions: auth.effectivePermissions },
      target: {
        type: resource.type,
        id: resource.id,
        version: snapshot.agreement.version,
        ...(snapshot.actionBasisHash ? { basisHash: snapshot.actionBasisHash } : {}),
        stage: snapshot.agreement.stage,
        satisfiedPreconditions: snapshot.preconditions,
      },
      attempt: {
        expectedVersion: input.target.expectedVersion,
        expectedBasisHash: input.target.expectedBasisHash,
        ...(input.actorConfirmed ? {
          confirmation: { by: "agent" as const, basisHash: input.target.expectedBasisHash },
        } : {}),
      },
    });
    const blockers: ActionBlocker[] = [...evaluation.blockers];
    const humanGateCodes = new Set(["ACTION_APPROVED_PLAN_REQUIRED", "ACTION_CONFIRMATION_REQUIRED", "ACTION_HUMAN_REQUIRED"]);
    const nonGateBlockers = blockers.filter((blocker) => !humanGateCodes.has(blocker.code));
    const requiresHumanApproval = definition.executionPolicy === "plan_required"
      || definition.confirmationPolicy === "human_confirmation"
      || definition.confirmationPolicy === "exact_basis_confirmation";
    const status = definition.executionPolicy === "human_only"
      ? "draft" as const
      : nonGateBlockers.length > 0
        ? "draft" as const
        : requiresHumanApproval
          ? "pending_approval" as const
          : evaluation.allowed
            ? "approved" as const
            : "draft" as const;

    const now = new Date().toISOString();
    const defaultExpiryMs = Math.min(Date.parse(auth.grant.expiresAt), Date.parse(now) + 60 * 60_000);
    const expiresAt = input.expiresAt ?? new Date(defaultExpiryMs).toISOString();
    const lifetime = Date.parse(expiresAt) - Date.parse(now);
    if (lifetime < MIN_PLAN_LIFETIME_MS || lifetime > MAX_PLAN_LIFETIME_MS || expiresAt > auth.grant.expiresAt) {
      return apiError("invalid_plan_window", "A plan must remain valid for at least one minute, expire within 24 hours, and never outlive its grant.", {
        status: 400, requestId: auth.requestId, headers: auth.headers,
      });
    }

    const canonicalInput = JSON.parse(canonicalJson(derivedFields.input)) as Record<string, unknown>;
    const canonicalDiff = JSON.parse(canonicalJson(derivedFields.proposedDiff)) as Record<string, unknown>;
    const canonicalBefore = JSON.parse(canonicalJson(snapshot.before)) as Record<string, unknown>;
    const inputSha256 = await canonicalJsonDigest(canonicalInput);
    const runId = crypto.randomUUID();
    const actionDefinition = {
      catalogVersion: ACTION_CATALOG_VERSION,
      id: definition.id,
      implementationVersion: definition.implementationVersion,
      label: definition.label,
      targetTypes: [...definition.targetTypes],
      permissions: [...definition.permissions],
      riskTier: definition.riskTier,
      executionPolicy: definition.executionPolicy,
      confirmationPolicy: definition.confirmationPolicy,
      requiresTargetVersion: definition.requiresTargetVersion,
      requiresBasis: definition.requiresBasis,
      allowedStages: definition.allowedStages ? [...definition.allowedStages] : null,
      preconditions: [...definition.preconditions],
    };
    const persistedBlockers = blockers.map((blocker) => ({ ...blocker }));
    const provenance = {
      schemaVersion: "1.0",
      requestId: auth.requestId,
      identitySource: auth.context.identitySource,
      servicePrincipal: { id: auth.principal.id, name: auth.principal.name, version: auth.principal.version },
      grant: { id: auth.grant.id, policyVersion: auth.grant.policyVersion },
      sponsor: { userId: auth.sponsor.id, role: auth.membership.role },
      run: { id: runId, ...input.provenance },
      actionDefinition,
      idempotency: { keySha256, requestSha256 },
      submittedAt: now,
    };
    const material: AgentActionPlanMaterial = {
      schemaVersion: "1.0",
      planId,
      workspaceId: auth.workspace.id,
      serviceAccountId: auth.principal.id,
      grantId: auth.grant.id,
      delegatorPrincipalId: auth.sponsor.id,
      actionId: input.actionId,
      target: {
        resourceType: resource.type,
        resourceId: resource.id,
        version: snapshot.agreement.version,
        basisHash: snapshot.durableBasisHash,
      },
      input: canonicalInput,
      policyVersion: auth.grant.policyVersion,
      actionDefinition,
      riskTier: definition.riskTier,
      beforeSnapshot: canonicalBefore,
      proposedDiff: canonicalDiff,
      blockers: persistedBlockers,
      provenance,
      createdAt: now,
      expiresAt,
    };
    const planSha256 = await computeAgentActionPlanDigest(material);
    // Bound the values again after canonical serialization, before D1 checks.
    if (canonicalJson(canonicalInput).length > 65_536 || canonicalJson(canonicalDiff).length > 65_536 || canonicalJson(provenance).length > 32_768) {
      return apiError("plan_payload_too_large", "The canonical plan payload exceeds its durable size limit.", {
        status: 413, requestId: auth.requestId, headers: auth.headers,
      });
    }

    const plan = {
      id: planId,
      workspaceId: auth.workspace.id,
      principalId: auth.principal.id,
      grantId: auth.grant.id,
      runId,
      actionId: input.actionId,
      resourceType: resource.type,
      resourceId: resource.id,
      agreementId,
      canonicalInput,
      inputSha256,
      planSha256,
      expectedVersion: snapshot.agreement.version,
      basisHash: snapshot.durableBasisHash,
      documentVersion: snapshot.document?.version ?? null,
      documentSha256: snapshot.document?.sha256 ?? null,
      policyVersion: auth.grant.policyVersion,
      riskTier: definition.riskTier,
      status,
      beforeSnapshot: canonicalBefore,
      proposedDiff: canonicalDiff,
      blockers: persistedBlockers,
      provenance,
      createdByUserId: null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.batch([
        db.insert(agentRuns).values({
          id: runId,
          workspaceId: auth.workspace.id,
          principalId: auth.principal.id,
          grantId: auth.grant.id,
          sponsorUserId: auth.sponsor.id,
          purpose: input.provenance.purpose,
          // Proposal generation is complete once its exact durable plan is
          // committed. Execution, if any, receives its own durable receipt.
          status: "succeeded",
          modelProvider: input.provenance.modelProvider ?? null,
          modelId: input.provenance.modelId,
          toolVersion: input.provenance.toolVersion,
          promptSha256: input.provenance.promptSha256 ?? null,
          contextSha256: input.provenance.contextSha256 ?? null,
          startedAt: now,
          completedAt: now,
        }),
        db.insert(agentActionPlans).values(plan),
      ]);
    } catch (error) {
      if (!isPlanInsertConflict(error)) throw error;
      // A same-key concurrent request derives the same plan ID. Re-read the
      // winner after the atomic batch collision and classify its durable
      // evidence instead of surfacing a timing-dependent internal error.
      const [winner] = await db.select().from(agentActionPlans).where(and(
        eq(agentActionPlans.workspaceId, auth.workspace.id),
        eq(agentActionPlans.principalId, auth.principal.id),
        eq(agentActionPlans.id, planId),
      )).limit(1);
      if (winner && isExactProposalReplay(winner, {
        keySha256,
        requestSha256,
        grantId: input.grantId,
        actionId: input.actionId,
        resourceType: resource.type,
        resourceId: resource.id,
      })) {
        const activeAgreement = await loadActiveAgreementTarget(db, auth.workspace.id, agreementId);
        if (!activeAgreement) {
          return apiError("agreement_not_found", "Agreement was not found.", {
            status: 404, requestId: auth.requestId, headers: auth.headers,
          });
        }
        const replayHeaders = new Headers(auth.headers);
        replayHeaders.set("Idempotency-Replayed", "true");
        return apiJson({ plan: planProjection(winner), replay: true, requestId: auth.requestId }, {
          requestId: auth.requestId,
          headers: replayHeaders,
        });
      }
      return apiError("idempotency_key_conflict", "The concurrent plan proposal did not match this exact Idempotency-Key request.", {
        status: 409, requestId: auth.requestId, headers: auth.headers,
      });
    }
    const activeAgreement = await loadActiveAgreementTarget(db, auth.workspace.id, agreementId);
    if (!activeAgreement) {
      return apiError("agreement_not_found", "Agreement was not found.", {
        status: 404, requestId: auth.requestId, headers: auth.headers,
      });
    }
    return apiJson({ plan: planProjection(plan), requestId: auth.requestId }, {
      status: 201, requestId: auth.requestId, headers: auth.headers,
    });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "The agent plan could not be created.");
  }
}
