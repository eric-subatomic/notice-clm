import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { documents, ingestionBatches, ingestionItems, mutationGuards } from "../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import { sha256Hex } from "../../../lib/document-security";
import {
  canonicalRepositoryJson,
  ingestionIdempotencyKey,
  ingestionPatchSchema,
  ingestionPostSchema,
  repositoryDigest,
  RepositoryIntelligenceError,
} from "../../../lib/repository-intelligence";
import { apiError, apiJson } from "../../../lib/http";
import { parseJson } from "../../../lib/validation";

function routeError(error: unknown, requestId: string): Response {
  if (error instanceof RepositoryIntelligenceError) return apiError(error.code, error.message, { status: error.status, requestId });
  return handleRouteError(error, requestId, "Bulk ingestion bookkeeping could not be processed.");
}

function uniqueConflict(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).toLowerCase().includes("unique constraint failed");
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "document:read");
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !["batchId", "status", "limit"].includes(key))) throw new RepositoryIntelligenceError(400, "invalid_query", "Unsupported ingestion query parameter.");
    const batchId = url.searchParams.get("batchId");
    const status = url.searchParams.get("status");
    const limitRaw = url.searchParams.get("limit") ?? "50";
    if (batchId !== null && !/^[0-9a-f-]{36}$/i.test(batchId)) throw new RepositoryIntelligenceError(400, "invalid_query", "Batch ID is invalid.");
    if (status !== null && !["awaiting_upload", "review", "completed", "cancelled"].includes(status)) throw new RepositoryIntelligenceError(400, "invalid_query", "Batch status is invalid.");
    if (!/^[1-9][0-9]?$/.test(limitRaw)) throw new RepositoryIntelligenceError(400, "invalid_query", "Limit must be between 1 and 99.");
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    const conditions = [eq(ingestionBatches.workspaceId, workspaceId)];
    if (batchId) conditions.push(eq(ingestionBatches.id, batchId));
    if (status) conditions.push(eq(ingestionBatches.status, status as typeof ingestionBatches.$inferSelect.status));
    const batches = await db.select().from(ingestionBatches).where(and(...conditions)).orderBy(desc(ingestionBatches.updatedAt), desc(ingestionBatches.id)).limit(Number(limitRaw));
    const batchIds = batches.map((batch) => batch.id);
    const items = batchIds.length === 0 ? [] : await db.select().from(ingestionItems).where(and(
      eq(ingestionItems.workspaceId, workspaceId), inArray(ingestionItems.batchId, batchIds),
    )).limit(Math.min(4_950, batchIds.length * 50));
    return apiJson({ batches, items, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return routeError(error, auth.requestId);
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "document:upload", { limit: 15 });
  if (!auth.ok) return auth.response;
  try {
    const key = ingestionIdempotencyKey(request);
    const input = await parseJson(request, ingestionPostSchema, 100_000);
    const keyDigest = await sha256Hex(key);
    const requestSha256 = await sha256Hex(canonicalRepositoryJson(input));
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    const [receipt] = await db.select().from(ingestionBatches).where(and(
      eq(ingestionBatches.workspaceId, workspaceId), eq(ingestionBatches.createdByUserId, auth.context.user.id),
      eq(ingestionBatches.idempotencyKeySha256, keyDigest),
    )).limit(1);
    if (receipt) {
      if (receipt.requestSha256 !== requestSha256) throw new RepositoryIntelligenceError(409, "idempotency_conflict", "This idempotency key was already used for a different ingestion request.");
      const items = await db.select().from(ingestionItems).where(and(eq(ingestionItems.workspaceId, workspaceId), eq(ingestionItems.batchId, receipt.id))).limit(50);
      return apiJson({ batch: receipt, items, idempotentReplay: true, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }

    const sourceHashes = [...new Set(input.items.map((item) => item.sha256))];
    const linkedDocumentIds = [...new Set(input.items.flatMap((item) => item.documentId ? [item.documentId] : []))];
    const [linkedDocuments, duplicateDocuments] = await Promise.all([
      linkedDocumentIds.length === 0 ? Promise.resolve([]) : db.select({ id: documents.id, sha256: documents.sha256 }).from(documents).where(and(
        eq(documents.workspaceId, workspaceId), isNull(documents.deletedAt), inArray(documents.id, linkedDocumentIds),
      )).orderBy(asc(documents.id)).limit(linkedDocumentIds.length),
      db.select({ id: sql<string>`min(${documents.id})`, sha256: documents.sha256 }).from(documents).where(and(
        eq(documents.workspaceId, workspaceId), isNull(documents.deletedAt), inArray(documents.sha256, sourceHashes),
      )).groupBy(documents.sha256).limit(sourceHashes.length),
    ]);
    const documentById = new Map(linkedDocuments.map((document) => [document.id, document]));
    const documentBySha = new Map(duplicateDocuments.map((document) => [document.sha256, document]));
    for (const item of input.items) {
      if (item.documentId && (!documentById.has(item.documentId) || documentById.get(item.documentId)!.sha256 !== item.sha256)) {
        throw new RepositoryIntelligenceError(422, "document_source_mismatch", `Linked document for ${item.fileName} is unavailable or has a different SHA-256 digest.`);
      }
    }

    const batchId = crypto.randomUUID();
    const now = new Date().toISOString();
    const seen = new Set<string>();
    const items = await Promise.all(input.items.map(async (item, ordinal) => {
      const linked = item.documentId ? documentById.get(item.documentId)! : null;
      const duplicate = linked ? null : documentBySha.get(item.sha256) ?? null;
      const duplicateInBatch = seen.has(item.sha256);
      seen.add(item.sha256);
      const status = linked ? "pending_extraction" as const : duplicate || duplicateInBatch ? "duplicate" as const : "awaiting_upload" as const;
      const blocker = linked
        ? { code: "extraction_provider_not_configured", message: "The source is linked, but no extraction provider has registered an immutable working version." }
        : duplicate
          ? { code: "duplicate_document", message: "A live document with this exact SHA-256 digest already exists in the workspace." }
          : duplicateInBatch
            ? { code: "duplicate_in_batch", message: "This exact source appears earlier in the same bounded batch." }
            : { code: "upload_required", message: "Upload and malware-scan this source through the governed document import endpoint before extraction." };
      return {
        id: crypto.randomUUID(), workspaceId, batchId, ordinal, fileName: item.fileName, contentType: item.contentType,
        size: item.size, sourceSha256: item.sha256,
        dedupeSha256: await repositoryDigest({ sha256: item.sha256, size: item.size, contentType: item.contentType }),
        documentId: linked?.id ?? null, duplicateOfDocumentId: duplicate?.id ?? null, status,
        blockerCode: blocker.code, blockerMessage: blocker.message,
        reviewedByUserId: null, reviewedAt: null, reviewReason: null, createdAt: now, updatedAt: now,
      };
    }));
    const awaitingUpload = items.some((item) => item.status === "awaiting_upload");
    const allDuplicates = items.every((item) => item.status === "duplicate");
    const batch = {
      id: batchId, workspaceId, createdByUserId: auth.context.user.id, idempotencyKeySha256: keyDigest,
      requestSha256, status: allDuplicates ? "completed" as const : awaitingUpload ? "awaiting_upload" as const : "review" as const,
      itemCount: items.length, acceptedCount: 0, rejectedCount: 0,
      blockerCode: allDuplicates ? null : awaitingUpload ? "upload_required" : "extraction_provider_not_configured",
      blockerMessage: allDuplicates
        ? null
        : awaitingUpload
          ? "One or more sources must be uploaded through the governed document import endpoint."
          : "No extraction provider has registered agreement working versions for this batch.",
      createdAt: now, updatedAt: now, completedAt: allDuplicates ? now : null,
    };
    try {
      await db.batch([
        db.insert(ingestionBatches).values(batch),
        ...items.map((item) => db.insert(ingestionItems).values(item)),
      ] as unknown as Parameters<typeof db.batch>[0]);
    } catch (error) {
      if (!uniqueConflict(error)) throw error;
      const [winner] = await db.select().from(ingestionBatches).where(and(
        eq(ingestionBatches.workspaceId, workspaceId), eq(ingestionBatches.createdByUserId, auth.context.user.id),
        eq(ingestionBatches.idempotencyKeySha256, keyDigest),
      )).limit(1);
      if (!winner || winner.requestSha256 !== requestSha256) {
        throw new RepositoryIntelligenceError(409, "idempotency_conflict", "This idempotency key was already used for a different ingestion request.");
      }
      const winnerItems = await db.select().from(ingestionItems).where(and(
        eq(ingestionItems.workspaceId, workspaceId), eq(ingestionItems.batchId, winner.id),
      )).limit(50);
      return apiJson({ batch: winner, items: winnerItems, idempotentReplay: true, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }
    return apiJson({
      batch, items,
      execution: { status: "blocked", externalCallMade: false, blocker: { code: batch.blockerCode, message: batch.blockerMessage } },
      requestId: auth.requestId,
    }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return routeError(error, auth.requestId);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "document:upload", { limit: 40 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, ingestionPatchSchema, 12_000);
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    const [item] = await db.select().from(ingestionItems).where(and(eq(ingestionItems.workspaceId, workspaceId), eq(ingestionItems.id, input.itemId))).limit(1);
    if (!item) throw new RepositoryIntelligenceError(404, "ingestion_item_not_found", "Ingestion item was not found.");
    const now = new Date().toISOString();
    if (input.action === "link_document") {
      if (item.status !== "awaiting_upload") throw new RepositoryIntelligenceError(409, "ingestion_item_not_linkable", "Only an awaiting-upload item can be linked.");
      const [document] = await db.select({ id: documents.id, sha256: documents.sha256 }).from(documents).where(and(
        eq(documents.workspaceId, workspaceId), eq(documents.id, input.documentId), eq(documents.sha256, item.sourceSha256), isNull(documents.deletedAt),
      )).limit(1);
      if (!document) throw new RepositoryIntelligenceError(422, "document_source_mismatch", "The linked live document does not match this item's exact SHA-256 digest.");
      const guardId = crypto.randomUUID();
      await db.batch([
        db.update(ingestionItems).set({
          documentId: document.id, status: "pending_extraction", blockerCode: "extraction_provider_not_configured",
          blockerMessage: "No extraction provider has registered an immutable agreement working version.", updatedAt: now,
        }).where(and(eq(ingestionItems.workspaceId, workspaceId), eq(ingestionItems.id, item.id), eq(ingestionItems.status, "awaiting_upload"))),
        db.insert(mutationGuards).values({ id: guardId, workspaceId, operation: "ingestion-item.link-document", guardChanges: sql<number>`changes()`, createdAt: now }),
        db.update(ingestionBatches).set({
          status: sql`case when not exists (
            select 1 from ingestion_items as pending_upload
            where pending_upload.workspace_id = ${workspaceId}
              and pending_upload.batch_id = ${item.batchId}
              and pending_upload.status = 'awaiting_upload'
          ) then 'review' else ${ingestionBatches.status} end`,
          blockerCode: sql`case when not exists (
            select 1 from ingestion_items as pending_upload
            where pending_upload.workspace_id = ${workspaceId}
              and pending_upload.batch_id = ${item.batchId}
              and pending_upload.status = 'awaiting_upload'
          ) then 'extraction_provider_not_configured' else ${ingestionBatches.blockerCode} end`,
          blockerMessage: sql`case when not exists (
            select 1 from ingestion_items as pending_upload
            where pending_upload.workspace_id = ${workspaceId}
              and pending_upload.batch_id = ${item.batchId}
              and pending_upload.status = 'awaiting_upload'
          ) then 'Linked sources are waiting for registered extraction evidence.' else ${ingestionBatches.blockerMessage} end`,
          updatedAt: now,
        }).where(and(eq(ingestionBatches.workspaceId, workspaceId), eq(ingestionBatches.id, item.batchId))),
        db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), eq(mutationGuards.id, guardId))),
      ]);
      return apiJson({ item: { ...item, documentId: document.id, status: "pending_extraction", blockerCode: "extraction_provider_not_configured", blockerMessage: "No extraction provider has registered an immutable agreement working version.", updatedAt: now }, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }

    if (item.status !== "review_required") throw new RepositoryIntelligenceError(409, "ingestion_item_not_reviewable", "This item is not ready for a human review decision.");
    const status = input.decision === "accept" ? "accepted" as const : "rejected" as const;
    const [batch] = await db.select().from(ingestionBatches).where(and(eq(ingestionBatches.workspaceId, workspaceId), eq(ingestionBatches.id, item.batchId))).limit(1);
    if (!batch || batch.status === "cancelled") throw new RepositoryIntelligenceError(409, "ingestion_batch_unavailable", "The ingestion batch is unavailable for review.");
    const guardId = crypto.randomUUID();
    await db.batch([
      db.update(ingestionItems).set({
        status, blockerCode: status === "accepted" ? "proposal_review_required" : "item_rejected",
        blockerMessage: status === "accepted" ? "Extraction proposals still require separate human review before any governed application." : "The ingestion item was rejected.",
        reviewedByUserId: auth.context.user.id, reviewedAt: now, reviewReason: input.reason, updatedAt: now,
      }).where(and(eq(ingestionItems.workspaceId, workspaceId), eq(ingestionItems.id, item.id), eq(ingestionItems.status, "review_required"))),
      db.insert(mutationGuards).values({ id: guardId, workspaceId, operation: "ingestion-item.review", guardChanges: sql<number>`changes()`, createdAt: now }),
      db.update(ingestionBatches).set({
        acceptedCount: status === "accepted" ? sql`${ingestionBatches.acceptedCount} + 1` : ingestionBatches.acceptedCount,
        rejectedCount: status === "rejected" ? sql`${ingestionBatches.rejectedCount} + 1` : ingestionBatches.rejectedCount,
        status: sql`case when not exists (
          select 1 from ingestion_items as remaining_item
          where remaining_item.workspace_id = ${workspaceId}
            and remaining_item.batch_id = ${batch.id}
            and remaining_item.status not in ('accepted', 'rejected', 'duplicate')
        ) then 'completed' else 'review' end`,
        blockerCode: sql`case when not exists (
          select 1 from ingestion_items as remaining_item
          where remaining_item.workspace_id = ${workspaceId}
            and remaining_item.batch_id = ${batch.id}
            and remaining_item.status not in ('accepted', 'rejected', 'duplicate')
        ) then null else ${ingestionBatches.blockerCode} end`,
        blockerMessage: sql`case when not exists (
          select 1 from ingestion_items as remaining_item
          where remaining_item.workspace_id = ${workspaceId}
            and remaining_item.batch_id = ${batch.id}
            and remaining_item.status not in ('accepted', 'rejected', 'duplicate')
        ) then null else ${ingestionBatches.blockerMessage} end`,
        completedAt: sql`case when not exists (
          select 1 from ingestion_items as remaining_item
          where remaining_item.workspace_id = ${workspaceId}
            and remaining_item.batch_id = ${batch.id}
            and remaining_item.status not in ('accepted', 'rejected', 'duplicate')
        ) then ${now} else null end`,
        updatedAt: now,
      }).where(and(eq(ingestionBatches.workspaceId, workspaceId), eq(ingestionBatches.id, batch.id))),
      db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), eq(mutationGuards.id, guardId))),
    ]);
    return apiJson({
      item: { ...item, status, reviewedByUserId: auth.context.user.id, reviewedAt: now, reviewReason: input.reason, updatedAt: now },
      agreementMutationApplied: false,
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return routeError(error, auth.requestId);
  }
}
