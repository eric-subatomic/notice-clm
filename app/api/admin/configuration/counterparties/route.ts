import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import { counterparties } from "../../../../../db/schema";
import { authorizeApiRequest } from "../../../../lib/api";
import { executeEnterpriseMutation, enterpriseRouteError, parseEnterpriseListQuery } from "../../../../lib/enterprise-api";
import { assertExpectedVersion, counterpartyDedupeKey, EnterpriseError, isUniqueConstraintError, normalizeCounterpartyDomain, omitEnterpriseProperties } from "../../../../lib/enterprise-domain";
import { counterpartyCreateSchema, counterpartyPatchSchema } from "../../../../lib/enterprise-validation";
import { apiJson } from "../../../../lib/http";
import { parseJson } from "../../../../lib/validation";

type Counterparty = typeof counterparties.$inferSelect;
function publicCounterparty(row: Counterparty) {
  return omitEnterpriseProperties(row, ["dedupeKey"]);
}

function collisionError(row: Counterparty): EnterpriseError {
  return new EnterpriseError(409, "counterparty_duplicate", "A matching counterparty already exists in this workspace.", {
    counterpartyId: row.id, displayName: row.displayName, version: row.version,
  });
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin");
  if (!auth.ok) return auth.response;
  try {
    const query = parseEnterpriseListQuery(request);
    await ensureStorageSchema();
    const conditions = [eq(counterparties.workspaceId, auth.context.workspace.id)];
    if (query.id) conditions.push(eq(counterparties.id, query.id));
    if (query.status === "active" || query.status === "inactive" || query.status === "blocked") conditions.push(eq(counterparties.status, query.status));
    else if (query.status) throw new EnterpriseError(400, "invalid_query", "Unsupported counterparty status.");
    const rows = await getDb().select().from(counterparties).where(and(...conditions))
      .orderBy(desc(counterparties.updatedAt)).limit(query.limit);
    return apiJson({ counterparties: rows.map(publicCounterparty), requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Counterparties could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, counterpartyCreateSchema, 12_000);
    await ensureStorageSchema();
    const db = getDb();
    const dedupeKey = counterpartyDedupeKey(input);
    const [collision] = await db.select().from(counterparties).where(and(
      eq(counterparties.workspaceId, auth.context.workspace.id), eq(counterparties.dedupeKey, dedupeKey),
    )).limit(1);
    if (collision) throw collisionError(collision);
    const now = new Date().toISOString();
    const counterparty = {
      id: crypto.randomUUID(), workspaceId: auth.context.workspace.id, version: 1,
      ...input, domain: normalizeCounterpartyDomain(input.domain), dedupeKey, status: "active" as const,
      createdByUserId: auth.context.user.id, createdAt: now, updatedByUserId: auth.context.user.id, updatedAt: now,
    };
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: counterparty.workspaceId, actor: auth.context.user, type: "CounterpartyCreated",
        detail: { action: "counterparty.created", counterpartyId: counterparty.id, version: 1 },
        steps: [{ statement: db.insert(counterparties).values(counterparty) }], createdAt: now,
      });
    } catch (error) {
      if (isUniqueConstraintError(error, ["counterparties.workspace_id", "counterparties.dedupe_key"])) {
        const [racedCollision] = await db.select().from(counterparties).where(and(
          eq(counterparties.workspaceId, counterparty.workspaceId), eq(counterparties.dedupeKey, dedupeKey),
        )).limit(1);
        if (racedCollision) throw collisionError(racedCollision);
      }
      throw error;
    }
    return apiJson({ counterparty: publicCounterparty(counterparty), requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The counterparty could not be created.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, counterpartyPatchSchema, 12_000);
    await ensureStorageSchema();
    const db = getDb();
    const [current] = await db.select().from(counterparties).where(and(
      eq(counterparties.workspaceId, auth.context.workspace.id), eq(counterparties.id, input.id),
    )).limit(1);
    if (!current) throw new EnterpriseError(404, "counterparty_not_found", "Counterparty was not found.");
    assertExpectedVersion(current.version, input.version);
    const changes = omitEnterpriseProperties(input, ["id", "version"]);
    const identity = {
      legalName: changes.legalName ?? current.legalName,
      domain: changes.domain ?? current.domain,
      jurisdiction: changes.jurisdiction ?? current.jurisdiction,
      registrationNumber: changes.registrationNumber ?? current.registrationNumber,
      externalId: changes.externalId ?? current.externalId,
    };
    const dedupeKey = counterpartyDedupeKey(identity);
    const [collision] = await db.select().from(counterparties).where(and(
      eq(counterparties.workspaceId, current.workspaceId), eq(counterparties.dedupeKey, dedupeKey), ne(counterparties.id, current.id),
    )).limit(1);
    if (collision) throw collisionError(collision);
    const now = new Date().toISOString();
    const normalizedChanges = { ...changes, ...(changes.domain !== undefined ? { domain: normalizeCounterpartyDomain(changes.domain) } : {}), dedupeKey };
    const saved = { ...current, ...normalizedChanges, version: current.version + 1, updatedByUserId: auth.context.user.id, updatedAt: now };
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: current.workspaceId, actor: auth.context.user, type: "CounterpartyUpdated",
        detail: { action: "counterparty.updated", counterpartyId: current.id, previousVersion: current.version, version: saved.version },
        steps: [{
          statement: db.update(counterparties).set({ ...normalizedChanges, version: saved.version, updatedByUserId: saved.updatedByUserId, updatedAt: now }).where(and(
            eq(counterparties.workspaceId, current.workspaceId), eq(counterparties.id, current.id), eq(counterparties.version, current.version),
          )), guardOperation: "counterparty.update",
        }], createdAt: now,
      });
    } catch (error) {
      if (isUniqueConstraintError(error, ["counterparties.workspace_id", "counterparties.dedupe_key"])) {
        const [racedCollision] = await db.select().from(counterparties).where(and(
          eq(counterparties.workspaceId, current.workspaceId), eq(counterparties.dedupeKey, dedupeKey), ne(counterparties.id, current.id),
        )).limit(1);
        if (racedCollision) throw collisionError(racedCollision);
      }
      throw error;
    }
    return apiJson({ counterparty: publicCounterparty(saved), requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The counterparty could not be updated.");
  }
}
