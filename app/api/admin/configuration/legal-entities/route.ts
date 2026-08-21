import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import { legalEntities } from "../../../../../db/schema";
import { authorizeApiRequest } from "../../../../lib/api";
import { executeEnterpriseMutation, enterpriseRouteError, parseEnterpriseListQuery } from "../../../../lib/enterprise-api";
import { assertExpectedVersion, EnterpriseError, isUniqueConstraintError, omitEnterpriseProperties } from "../../../../lib/enterprise-domain";
import { legalEntityCreateSchema, legalEntityPatchSchema } from "../../../../lib/enterprise-validation";
import { apiJson } from "../../../../lib/http";
import { parseJson } from "../../../../lib/validation";

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin");
  if (!auth.ok) return auth.response;
  try {
    const query = parseEnterpriseListQuery(request);
    await ensureStorageSchema();
    const conditions = [eq(legalEntities.workspaceId, auth.context.workspace.id)];
    if (query.id) conditions.push(eq(legalEntities.id, query.id));
    if (query.status === "active" || query.status === "inactive") conditions.push(eq(legalEntities.status, query.status));
    else if (query.status) throw new EnterpriseError(400, "invalid_query", "Unsupported legal entity status.");
    const entities = await getDb().select().from(legalEntities)
      .where(and(...conditions)).orderBy(desc(legalEntities.updatedAt)).limit(query.limit);
    return apiJson({ legalEntities: entities, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Legal entities could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, legalEntityCreateSchema, 12_000);
    await ensureStorageSchema();
    const now = new Date().toISOString();
    const entity = {
      id: crypto.randomUUID(), workspaceId: auth.context.workspace.id, version: 1,
      ...input, status: "active" as const, createdByUserId: auth.context.user.id,
      createdAt: now, updatedByUserId: auth.context.user.id, updatedAt: now,
    };
    const db = getDb();
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: entity.workspaceId, actor: auth.context.user, type: "LegalEntityCreated",
        detail: { action: "legal_entity.created", legalEntityId: entity.id, version: 1 },
        steps: [{ statement: db.insert(legalEntities).values(entity) }], createdAt: now,
      });
    } catch (error) {
      if (isUniqueConstraintError(error, ["legal_entities.workspace_id", "legal_entities.legal_name"])) {
        throw new EnterpriseError(409, "legal_entity_exists", "A legal entity with that legal name already exists in this workspace.");
      }
      throw error;
    }
    return apiJson({ legalEntity: entity, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The legal entity could not be created.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, legalEntityPatchSchema, 12_000);
    await ensureStorageSchema();
    const db = getDb();
    const [current] = await db.select().from(legalEntities).where(and(
      eq(legalEntities.workspaceId, auth.context.workspace.id), eq(legalEntities.id, input.id),
    )).limit(1);
    if (!current) throw new EnterpriseError(404, "legal_entity_not_found", "Legal entity was not found.");
    assertExpectedVersion(current.version, input.version);
    const changes = omitEnterpriseProperties(input, ["id", "version"]);
    const now = new Date().toISOString();
    const saved = { ...current, ...changes, version: current.version + 1, updatedByUserId: auth.context.user.id, updatedAt: now };
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: current.workspaceId, actor: auth.context.user, type: "LegalEntityUpdated",
        detail: { action: "legal_entity.updated", legalEntityId: current.id, previousVersion: current.version, version: saved.version },
        steps: [{
          statement: db.update(legalEntities).set({ ...changes, version: saved.version, updatedByUserId: saved.updatedByUserId, updatedAt: now }).where(and(
            eq(legalEntities.workspaceId, current.workspaceId), eq(legalEntities.id, current.id), eq(legalEntities.version, current.version),
          )),
          guardOperation: "legal-entity.update",
        }], createdAt: now,
      });
    } catch (error) {
      if (isUniqueConstraintError(error, ["legal_entities.workspace_id", "legal_entities.legal_name"])) {
        throw new EnterpriseError(409, "legal_entity_exists", "A legal entity with that legal name already exists in this workspace.");
      }
      throw error;
    }
    return apiJson({ legalEntity: saved, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The legal entity could not be updated.");
  }
}
