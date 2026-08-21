import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import { savedViews } from "../../../../../db/schema";
import { authorizeApiRequest } from "../../../../lib/api";
import { executeEnterpriseMutation, enterpriseRouteError, parseEnterpriseListQuery } from "../../../../lib/enterprise-api";
import { assertExpectedVersion, EnterpriseError, isUniqueConstraintError, omitEnterpriseProperties } from "../../../../lib/enterprise-domain";
import { requireActiveWorkspaceMember } from "../../../../lib/enterprise-references";
import { savedViewCreateSchema, savedViewDeleteSchema, savedViewPatchSchema } from "../../../../lib/enterprise-validation";
import { apiJson } from "../../../../lib/http";
import { parseJson } from "../../../../lib/validation";

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin");
  if (!auth.ok) return auth.response;
  try {
    const query = parseEnterpriseListQuery(request);
    const ownerUserId = new URL(request.url).searchParams.get("ownerUserId")?.trim();
    if (ownerUserId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerUserId)) {
      throw new EnterpriseError(400, "invalid_query", "ownerUserId must be a UUID.");
    }
    if (query.status) throw new EnterpriseError(400, "invalid_query", "Saved views do not support a status filter.");
    await ensureStorageSchema();
    const conditions = [eq(savedViews.workspaceId, auth.context.workspace.id)];
    if (query.id) conditions.push(eq(savedViews.id, query.id));
    if (ownerUserId) conditions.push(eq(savedViews.ownerUserId, ownerUserId));
    const views = await getDb().select().from(savedViews).where(and(...conditions)).orderBy(desc(savedViews.updatedAt)).limit(query.limit);
    return apiJson({ savedViews: views, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Saved views could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 40 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, savedViewCreateSchema, 28_000);
    await ensureStorageSchema();
    const db = getDb();
    await requireActiveWorkspaceMember(db, auth.context.workspace.id, input.ownerUserId);
    const now = new Date().toISOString();
    const view = {
      id: crypto.randomUUID(), workspaceId: auth.context.workspace.id, version: 1, ...input,
      createdAt: now, updatedAt: now,
    };
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: view.workspaceId, actor: auth.context.user, type: "SavedViewCreated",
        detail: { action: "saved_view.created", savedViewId: view.id, ownerUserId: view.ownerUserId, resourceType: view.resourceType, version: 1 },
        steps: [{ statement: db.insert(savedViews).values(view) }], createdAt: now,
      });
    } catch (error) {
      if (isUniqueConstraintError(error, ["saved_views.workspace_id", "saved_views.owner_user_id", "saved_views.resource_type", "saved_views.name"])) {
        throw new EnterpriseError(409, "saved_view_exists", "That owner already has a saved view with this name for the resource type.");
      }
      throw error;
    }
    return apiJson({ savedView: view, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The saved view could not be created.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, savedViewPatchSchema, 28_000);
    await ensureStorageSchema();
    const db = getDb();
    const [current] = await db.select().from(savedViews).where(and(
      eq(savedViews.workspaceId, auth.context.workspace.id), eq(savedViews.id, input.id),
    )).limit(1);
    if (!current) throw new EnterpriseError(404, "saved_view_not_found", "Saved view was not found.");
    assertExpectedVersion(current.version, input.version);
    await requireActiveWorkspaceMember(db, current.workspaceId, current.ownerUserId);
    const changes = omitEnterpriseProperties(input, ["id", "version"]);
    const now = new Date().toISOString();
    const saved = { ...current, ...changes, version: current.version + 1, updatedAt: now };
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: current.workspaceId, actor: auth.context.user, type: "SavedViewUpdated",
        detail: { action: "saved_view.updated", savedViewId: current.id, previousVersion: current.version, version: saved.version },
        steps: [{ statement: db.update(savedViews).set({ ...changes, version: saved.version, updatedAt: now }).where(and(
          eq(savedViews.workspaceId, current.workspaceId), eq(savedViews.id, current.id), eq(savedViews.version, current.version),
        )), guardOperation: "saved-view.update" }], createdAt: now,
      });
    } catch (error) {
      if (isUniqueConstraintError(error, ["saved_views.workspace_id", "saved_views.owner_user_id", "saved_views.resource_type", "saved_views.name"])) {
        throw new EnterpriseError(409, "saved_view_exists", "That owner already has a saved view with this name for the resource type.");
      }
      throw error;
    }
    return apiJson({ savedView: saved, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The saved view could not be updated.");
  }
}

export async function DELETE(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, savedViewDeleteSchema, 10_000);
    await ensureStorageSchema();
    const db = getDb();
    const [current] = await db.select().from(savedViews).where(and(
      eq(savedViews.workspaceId, auth.context.workspace.id), eq(savedViews.id, input.id),
    )).limit(1);
    if (!current) throw new EnterpriseError(404, "saved_view_not_found", "Saved view was not found.");
    assertExpectedVersion(current.version, input.version);
    const now = new Date().toISOString();
    await executeEnterpriseMutation(db, {
      workspaceId: current.workspaceId, actor: auth.context.user, type: "SavedViewDeleted",
      detail: { action: "saved_view.deleted", savedViewId: current.id, ownerUserId: current.ownerUserId, reason: input.reason, version: current.version },
      steps: [{ statement: db.delete(savedViews).where(and(
        eq(savedViews.workspaceId, current.workspaceId), eq(savedViews.id, current.id), eq(savedViews.version, current.version),
      )), guardOperation: "saved-view.delete" }], createdAt: now,
    });
    return apiJson({ deleted: true, id: current.id, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The saved view could not be removed.");
  }
}
