import { and, desc, eq, max, notExists } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import { intakeForms, workflowDefinitions } from "../../../../../db/schema";
import { authorizeApiRequest } from "../../../../lib/api";
import { executeEnterpriseMutation, enterpriseRouteError, parseEnterpriseListQuery } from "../../../../lib/enterprise-api";
import {
  assertDistinctPublisher,
  assertExpectedVersion,
  assertLifecycleTransition,
  enterpriseContentDigest,
  EnterpriseError,
  isUniqueConstraintError,
} from "../../../../lib/enterprise-domain";
import { workflowPatchSchema, workflowPostSchema } from "../../../../lib/enterprise-validation";
import { apiJson } from "../../../../lib/http";
import { parseJson } from "../../../../lib/validation";
import { parseGovernedWorkflowDefinition } from "../../../../lib/workflow-policy";

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin");
  if (!auth.ok) return auth.response;
  try {
    const query = parseEnterpriseListQuery(request);
    await ensureStorageSchema();
    const conditions = [eq(workflowDefinitions.workspaceId, auth.context.workspace.id)];
    if (query.id) conditions.push(eq(workflowDefinitions.id, query.id));
    if (query.status === "draft" || query.status === "published" || query.status === "retired") conditions.push(eq(workflowDefinitions.status, query.status));
    else if (query.status) throw new EnterpriseError(400, "invalid_query", "Unsupported workflow status.");
    const workflows = await getDb().select().from(workflowDefinitions).where(and(...conditions))
      .orderBy(desc(workflowDefinitions.createdAt)).limit(query.limit);
    return apiJson({ workflows, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Workflow definitions could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, workflowPostSchema, 80_000);
    await ensureStorageSchema();
    const db = getDb();
    const [latest] = await db.select({ version: max(workflowDefinitions.version) }).from(workflowDefinitions).where(and(
      eq(workflowDefinitions.workspaceId, auth.context.workspace.id), eq(workflowDefinitions.name, input.name),
    ));
    const semanticVersion = (latest?.version ?? 0) + 1;
    const definition = parseGovernedWorkflowDefinition(input.definition);
    const definitionSha256 = await enterpriseContentDigest(definition);
    const now = new Date().toISOString();
    const workflow = {
      id: crypto.randomUUID(), workspaceId: auth.context.workspace.id, version: semanticVersion,
      name: input.name, description: input.description, status: "draft" as const, definition,
      definitionSha256, createdByUserId: auth.context.user.id, createdAt: now,
      updatedByUserId: auth.context.user.id, updatedAt: now, publishedByUserId: null, publishedAt: null,
    };
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: workflow.workspaceId, actor: auth.context.user, type: "WorkflowDefinitionCreated",
        detail: { action: "workflow_definition.created", workflowId: workflow.id, semanticVersion, definitionSha256 },
        steps: [{ statement: db.insert(workflowDefinitions).values(workflow) }], createdAt: now,
      });
    } catch (error) {
      if (isUniqueConstraintError(error, ["workflow_definitions.workspace_id", "workflow_definitions.name", "workflow_definitions.version"])) {
        throw new EnterpriseError(409, "version_conflict", "Another workflow version was created. Reload before retrying.");
      }
      throw error;
    }
    return apiJson({ workflow, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The workflow definition could not be created.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 40 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, workflowPatchSchema, 12_000);
    await ensureStorageSchema();
    const db = getDb();
    const [workflow] = await db.select().from(workflowDefinitions).where(and(
      eq(workflowDefinitions.workspaceId, auth.context.workspace.id), eq(workflowDefinitions.id, input.id),
    )).limit(1);
    if (!workflow) throw new EnterpriseError(404, "workflow_not_found", "Workflow definition was not found.");
    assertExpectedVersion(workflow.version, input.version);
    const nextStatus = input.action === "publish" ? "published" : "retired";
    assertLifecycleTransition(workflow.status, nextStatus);
    const now = new Date().toISOString();
    if (input.action === "publish") {
      assertDistinctPublisher(workflow.createdByUserId, auth.context.user.id);
      const definition = parseGovernedWorkflowDefinition(workflow.definition);
      const verifiedDigest = await enterpriseContentDigest(definition);
      if (verifiedDigest !== workflow.definitionSha256) throw new EnterpriseError(409, "content_digest_mismatch", "Workflow content no longer matches its immutable digest.");
      await executeEnterpriseMutation(db, {
        workspaceId: workflow.workspaceId, actor: auth.context.user, type: "WorkflowDefinitionPublished",
        detail: { action: "workflow_definition.published", workflowId: workflow.id, semanticVersion: workflow.version, reason: input.reason, definitionSha256: workflow.definitionSha256 },
        steps: [{ statement: db.update(workflowDefinitions).set({
          status: "published", publishedByUserId: auth.context.user.id, publishedAt: now,
          updatedByUserId: auth.context.user.id, updatedAt: now,
        }).where(and(
          eq(workflowDefinitions.workspaceId, workflow.workspaceId), eq(workflowDefinitions.id, workflow.id),
          eq(workflowDefinitions.version, workflow.version), eq(workflowDefinitions.status, "draft"),
        )), guardOperation: "workflow-definition.publish" }], createdAt: now,
      });
      return apiJson({ workflow: { ...workflow, status: "published", publishedByUserId: auth.context.user.id, publishedAt: now, updatedByUserId: auth.context.user.id, updatedAt: now }, requestId: auth.requestId }, {
        requestId: auth.requestId, headers: auth.headers,
      });
    }
    const [publishedForm] = await db.select({ id: intakeForms.id }).from(intakeForms).where(and(
      eq(intakeForms.workspaceId, workflow.workspaceId), eq(intakeForms.workflowDefinitionId, workflow.id), eq(intakeForms.status, "published"),
    )).limit(1);
    if (publishedForm) throw new EnterpriseError(409, "workflow_in_use", "Retire published intake forms that use this workflow before retiring it.");
    await executeEnterpriseMutation(db, {
      workspaceId: workflow.workspaceId, actor: auth.context.user, type: "WorkflowDefinitionRetired",
      detail: { action: "workflow_definition.retired", workflowId: workflow.id, semanticVersion: workflow.version, reason: input.reason, definitionSha256: workflow.definitionSha256 },
      steps: [{ statement: db.update(workflowDefinitions).set({
        status: "retired", updatedByUserId: auth.context.user.id, updatedAt: now,
      }).where(and(
        eq(workflowDefinitions.workspaceId, workflow.workspaceId), eq(workflowDefinitions.id, workflow.id),
        eq(workflowDefinitions.version, workflow.version), eq(workflowDefinitions.status, "published"),
        notExists(db.select({ id: intakeForms.id }).from(intakeForms).where(and(
          eq(intakeForms.workspaceId, workflow.workspaceId),
          eq(intakeForms.workflowDefinitionId, workflow.id),
          eq(intakeForms.status, "published"),
        )).limit(1)),
      )), guardOperation: "workflow-definition.retire" }], createdAt: now,
    });
    return apiJson({ workflow: { ...workflow, status: "retired", updatedByUserId: auth.context.user.id, updatedAt: now }, requestId: auth.requestId }, {
      requestId: auth.requestId, headers: auth.headers,
    });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The workflow definition could not be transitioned.");
  }
}
