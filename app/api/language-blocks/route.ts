import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { ensureStorageSchema } from "../../../db/ensure";
import { languageBlocks, mutationGuards, outboxEvents, workspaceEvents } from "../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../lib/api";
import { apiError, apiJson } from "../../lib/http";
import { prepareIntegrationOutboxEvent } from "../../lib/integration-events";
import { prepareOutboxEvent, prepareWorkspaceEvent } from "../../lib/persistence";
import { languageBlockMutationSchema, parseJson } from "../../lib/validation";

function serverId(): number {
  return Date.now() * 1_000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 1_000);
}
export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "language:read");
  if (!auth.ok) return auth.response;
  try {
    await ensureStorageSchema();
    const rows = await getDb().select().from(languageBlocks).where(
      eq(languageBlocks.workspaceId, auth.context.workspace.id),
    ).orderBy(desc(languageBlocks.id)).limit(200);
    return apiJson({ languageBlocks: rows, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Approved language could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "language:write", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, languageBlockMutationSchema, 64_000);
    await ensureStorageSchema();
    const id = serverId();
    const record = {
      id,
      workspaceId: auth.context.workspace.id,
      version: 1,
      title: input.title,
      category: input.category,
      profile: input.profile,
      summary: input.summary,
      language: input.language,
      uses: 0,
    };
    const db = getDb();
    const event = await prepareWorkspaceEvent(db, {
      workspaceId: auth.context.workspace.id,
      type: "Approved language",
      detail: `Created approved language block “${record.title}” in ${record.category}.`,
      actor: auth.context.user,
    });
    const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
      workspaceId: auth.context.workspace.id,
      topic: "language.created",
      aggregateType: "language_block",
      aggregateId: String(id),
      payload: { languageBlockId: id, version: 1, aggregateVersion: 1, causationId: auth.requestId },
    }));
    await db.batch([
      db.insert(languageBlocks).values(record),
      db.insert(workspaceEvents).values(event),
      db.insert(outboxEvents).values(outbox),
    ]);
    return apiJson({ languageBlock: record, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Approved language could not be created.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "language:write", { limit: 40 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, languageBlockMutationSchema, 64_000);
    if (!input.id || !input.version) return apiError("validation_failed", "id and version are required when updating approved language.", { status: 400, requestId: auth.requestId });
    await ensureStorageSchema();
    const db = getDb();
    const [current] = await db.select().from(languageBlocks).where(and(
      eq(languageBlocks.workspaceId, auth.context.workspace.id),
      eq(languageBlocks.id, input.id),
    )).limit(1);
    if (!current) return apiError("language_not_found", "Approved language was not found.", { status: 404, requestId: auth.requestId });
    if (current.version !== input.version) return apiError("version_conflict", "Reload this language block before saving.", { status: 409, requestId: auth.requestId });
    const updated = {
      title: input.title,
      category: input.category,
      profile: input.profile,
      summary: input.summary,
      language: input.language,
      version: current.version + 1,
    };
    const event = await prepareWorkspaceEvent(db, {
      workspaceId: auth.context.workspace.id,
      type: "Approved language",
      detail: `Updated approved language block “${updated.title}” to version ${updated.version}.`,
      actor: auth.context.user,
    });
    const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
      workspaceId: auth.context.workspace.id,
      topic: "language.updated",
      aggregateType: "language_block",
      aggregateId: String(input.id),
      payload: { languageBlockId: input.id, version: updated.version, aggregateVersion: updated.version, causationId: auth.requestId },
    }));
    const guardId = crypto.randomUUID();
    const [result] = await db.batch([db.update(languageBlocks).set(updated).where(and(
      eq(languageBlocks.workspaceId, auth.context.workspace.id),
      eq(languageBlocks.id, input.id),
      eq(languageBlocks.version, input.version),
    )), db.insert(mutationGuards).values({ id: guardId, workspaceId: auth.context.workspace.id, operation: "language.update", guardChanges: sql<number>`changes()`, createdAt: new Date().toISOString() }), db.insert(workspaceEvents).values(event), db.insert(outboxEvents).values(outbox), db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, auth.context.workspace.id), eq(mutationGuards.id, guardId)))]);
    if (!result.meta.changes) return apiError("version_conflict", "Reload this language block before saving.", { status: 409, requestId: auth.requestId });
    return apiJson({ languageBlock: { ...current, ...updated }, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Approved language could not be saved.");
  }
}
