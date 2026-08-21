import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../db";
import { ensureStorageSchema } from "../../../db/ensure";
import { savedViews } from "../../../db/schema";
import { authorizeApiRequest } from "../../lib/api";
import { executeEnterpriseMutation, enterpriseRouteError } from "../../lib/enterprise-api";
import { assertBoundedJson, EnterpriseError, isUniqueConstraintError } from "../../lib/enterprise-domain";
import { apiJson } from "../../lib/http";
import { parseJson } from "../../lib/validation";

const resources = [
  "agreements",
  "approvals",
  "signatures",
  "obligations",
  "obligation_schedules",
  "events",
  "portfolio_report",
  "intake_submissions",
] as const;

const resourceSchema = z.enum(resources);
const safeName = z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/u);
const boundedRecord = (maxBytes: number) => z.record(z.string().min(1).max(120), z.unknown()).superRefine((value, context) => {
  try { assertBoundedJson(value, { maxBytes }); } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid saved-view configuration" });
  }
});

const createSchema = z.object({
  resourceType: resourceSchema,
  name: safeName,
  filter: boundedRecord(16_384),
  sort: boundedRecord(4_096),
  shared: z.boolean().default(false),
}).strict();

const patchSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  name: safeName.optional(),
  filter: boundedRecord(16_384).optional(),
  sort: boundedRecord(4_096).optional(),
  shared: z.boolean().optional(),
}).strict().refine((input) => input.name !== undefined || input.filter !== undefined || input.sort !== undefined || input.shared !== undefined, "At least one field must be changed");

const deleteSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  reason: z.string().trim().min(8).max(500),
}).strict();

function canManageOwner(role: string, currentUserId: string, ownerUserId: string): boolean {
  return role === "admin" || currentUserId === ownerUserId;
}

function isWrappedUniqueConstraintError(error: unknown, fragments: readonly string[]): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (isUniqueConstraintError(current, fragments)) return true;
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return false;
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:read");
  if (!auth.ok) return auth.response;
  try {
    await ensureStorageSchema();
    const url = new URL(request.url);
    const unknown = Array.from(url.searchParams.keys()).filter((key) => key !== "resourceType" && key !== "limit");
    if (unknown.length) throw new EnterpriseError(400, "invalid_query", `Unsupported query parameter: ${unknown[0]}`);
    const parsedResource = url.searchParams.get("resourceType");
    const resourceType = parsedResource === null ? null : resourceSchema.safeParse(parsedResource);
    if (resourceType && !resourceType.success) throw new EnterpriseError(400, "invalid_query", "resourceType is not supported.");
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new EnterpriseError(400, "invalid_query", "limit must be an integer between 1 and 200.");
    const rows = await getDb().select().from(savedViews).where(and(
      eq(savedViews.workspaceId, auth.context.workspace.id),
      or(eq(savedViews.ownerUserId, auth.context.user.id), eq(savedViews.shared, true)),
      resourceType?.success ? eq(savedViews.resourceType, resourceType.data) : undefined,
    )).orderBy(desc(savedViews.updatedAt), desc(savedViews.id)).limit(limit);
    return apiJson({ savedViews: rows, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Saved views could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:read", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, createSchema, 24_000);
    await ensureStorageSchema();
    const db = getDb();
    const now = new Date().toISOString();
    const view = {
      id: crypto.randomUUID(),
      workspaceId: auth.context.workspace.id,
      version: 1,
      ownerUserId: auth.context.user.id,
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: view.workspaceId,
        actor: auth.context.user,
        type: "SavedViewCreated",
        detail: { action: "saved_view.created", savedViewId: view.id, resourceType: view.resourceType, shared: view.shared },
        steps: [{ statement: db.insert(savedViews).values(view) }],
        createdAt: now,
      });
    } catch (error) {
      if (isWrappedUniqueConstraintError(error, ["saved_views.workspace_id", "saved_views.owner_user_id", "saved_views.resource_type", "saved_views.name"])) {
        throw new EnterpriseError(409, "saved_view_exists", "You already have a saved view with this name for the selected resource.");
      }
      throw error;
    }
    return apiJson({ savedView: view, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The saved view could not be created.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:read", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, patchSchema, 24_000);
    await ensureStorageSchema();
    const db = getDb();
    const [current] = await db.select().from(savedViews).where(and(
      eq(savedViews.workspaceId, auth.context.workspace.id),
      eq(savedViews.id, input.id),
    )).limit(1);
    if (!current) throw new EnterpriseError(404, "saved_view_not_found", "Saved view was not found.");
    if (!canManageOwner(auth.context.role, auth.context.user.id, current.ownerUserId)) {
      throw new EnterpriseError(403, "saved_view_owner_required", "Only the owner or a workspace administrator can change this view.");
    }
    if (current.version !== input.version) throw new EnterpriseError(409, "version_conflict", "This saved view changed. Reload before retrying.");
    const changes = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.filter !== undefined ? { filter: input.filter } : {}),
      ...(input.sort !== undefined ? { sort: input.sort } : {}),
      ...(input.shared !== undefined ? { shared: input.shared } : {}),
    };
    const now = new Date().toISOString();
    const saved = { ...current, ...changes, version: current.version + 1, updatedAt: now };
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: current.workspaceId,
        actor: auth.context.user,
        type: "SavedViewUpdated",
        detail: { action: "saved_view.updated", savedViewId: current.id, version: saved.version },
        steps: [{
          statement: db.update(savedViews).set({ ...changes, version: saved.version, updatedAt: now }).where(and(
            eq(savedViews.workspaceId, current.workspaceId), eq(savedViews.id, current.id), eq(savedViews.version, current.version),
          )),
          guardOperation: "saved-view.self.update",
        }],
        createdAt: now,
      });
    } catch (error) {
      if (isWrappedUniqueConstraintError(error, ["saved_views.workspace_id", "saved_views.owner_user_id", "saved_views.resource_type", "saved_views.name"])) {
        throw new EnterpriseError(409, "saved_view_exists", "You already have a saved view with this name for the selected resource.");
      }
      throw error;
    }
    return apiJson({ savedView: saved, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The saved view could not be updated.");
  }
}

export async function DELETE(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:read", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, deleteSchema, 12_000);
    await ensureStorageSchema();
    const db = getDb();
    const [current] = await db.select().from(savedViews).where(and(
      eq(savedViews.workspaceId, auth.context.workspace.id), eq(savedViews.id, input.id),
    )).limit(1);
    if (!current) throw new EnterpriseError(404, "saved_view_not_found", "Saved view was not found.");
    if (!canManageOwner(auth.context.role, auth.context.user.id, current.ownerUserId)) {
      throw new EnterpriseError(403, "saved_view_owner_required", "Only the owner or a workspace administrator can remove this view.");
    }
    if (current.version !== input.version) throw new EnterpriseError(409, "version_conflict", "This saved view changed. Reload before retrying.");
    const now = new Date().toISOString();
    await executeEnterpriseMutation(db, {
      workspaceId: current.workspaceId,
      actor: auth.context.user,
      type: "SavedViewDeleted",
      detail: { action: "saved_view.deleted", savedViewId: current.id, reason: input.reason },
      steps: [{
        statement: db.delete(savedViews).where(and(
          eq(savedViews.workspaceId, current.workspaceId), eq(savedViews.id, current.id), eq(savedViews.version, current.version),
        )),
        guardOperation: "saved-view.self.delete",
      }],
      createdAt: now,
    });
    return apiJson({ deleted: true, id: current.id, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The saved view could not be removed.");
  }
}
