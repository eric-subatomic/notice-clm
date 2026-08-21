import { and, desc, eq, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { agreementDocumentVersions, agreements, repositoryFragments } from "../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import {
  decodeRepositorySearchCursor,
  encodeRepositorySearchCursor,
  REPOSITORY_SEARCH_MAX_LIMIT,
  repositorySearchBinding,
  repositorySearchTerms,
  RepositoryIntelligenceError,
} from "../../../lib/repository-intelligence";
import { apiError, apiJson } from "../../../lib/http";

function routeError(error: unknown, requestId: string): Response {
  if (error instanceof RepositoryIntelligenceError) return apiError(error.code, error.message, { status: error.status, requestId });
  return handleRouteError(error, requestId, "Repository search could not be completed.");
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "document:read");
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(request.url);
    const allowed = new Set(["q", "agreementId", "documentVersionId", "limit", "cursor"]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key)) || [...allowed].some((key) => url.searchParams.getAll(key).length > 1)) {
      throw new RepositoryIntelligenceError(400, "invalid_query", "Repository search query is invalid.");
    }
    const terms = repositorySearchTerms(url.searchParams.get("q") ?? "");
    const agreementRaw = url.searchParams.get("agreementId");
    const agreementId = agreementRaw === null ? null : Number(agreementRaw);
    if (agreementRaw !== null && (!/^[1-9][0-9]*$/.test(agreementRaw) || !Number.isSafeInteger(agreementId))) throw new RepositoryIntelligenceError(400, "invalid_query", "Agreement ID is invalid.");
    const documentVersionId = url.searchParams.get("documentVersionId");
    if (documentVersionId !== null && !/^[0-9a-f-]{36}$/i.test(documentVersionId)) throw new RepositoryIntelligenceError(400, "invalid_query", "Document version ID is invalid.");
    const limitRaw = url.searchParams.get("limit") ?? "20";
    if (!/^[1-9][0-9]?$/.test(limitRaw) || Number(limitRaw) > REPOSITORY_SEARCH_MAX_LIMIT) throw new RepositoryIntelligenceError(400, "invalid_query", `Limit must be between 1 and ${REPOSITORY_SEARCH_MAX_LIMIT}.`);
    const limit = Number(limitRaw);
    const workspaceId = auth.context.workspace.id;
    const binding = await repositorySearchBinding({ workspaceId, terms, agreementId, documentVersionId, limit });
    const cursor = await decodeRepositorySearchCursor(url.searchParams.get("cursor"), binding);
    const snapshotAt = cursor?.s ?? new Date().toISOString();

    await ensureStorageSchema();
    const db = getDb();
    const conditions: Array<SQL | undefined> = [
      eq(repositoryFragments.workspaceId, workspaceId),
      eq(agreementDocumentVersions.workspaceId, workspaceId),
      eq(agreementDocumentVersions.id, repositoryFragments.documentVersionId),
      eq(agreementDocumentVersions.agreementId, repositoryFragments.agreementId),
      eq(agreementDocumentVersions.version, repositoryFragments.documentVersion),
      eq(agreementDocumentVersions.sha256, repositoryFragments.documentSha256),
      eq(agreements.workspaceId, workspaceId),
      eq(agreements.id, repositoryFragments.agreementId),
      isNull(agreements.deletedAt),
      lte(repositoryFragments.createdAt, snapshotAt),
      agreementId === null ? undefined : eq(repositoryFragments.agreementId, agreementId),
      documentVersionId === null ? undefined : eq(repositoryFragments.documentVersionId, documentVersionId),
      cursor === null ? undefined : or(
        lt(repositoryFragments.createdAt, cursor.t),
        and(eq(repositoryFragments.createdAt, cursor.t), lt(repositoryFragments.id, cursor.i)),
      ),
      ...terms.map((term) => sql`instr(lower(${repositoryFragments.content}), ${term}) > 0`),
    ];
    const rows = await db.select({
      fragmentId: repositoryFragments.id,
      documentVersionId: repositoryFragments.documentVersionId,
      agreementId: repositoryFragments.agreementId,
      agreementParty: agreements.party,
      documentVersion: repositoryFragments.documentVersion,
      documentSha256: repositoryFragments.documentSha256,
      sourceTextSha256: repositoryFragments.sourceTextSha256,
      ordinal: repositoryFragments.ordinal,
      startOffset: repositoryFragments.startOffset,
      endOffset: repositoryFragments.endOffset,
      quote: repositoryFragments.content,
      quoteSha256: repositoryFragments.contentSha256,
      createdAt: repositoryFragments.createdAt,
    }).from(repositoryFragments)
      .innerJoin(agreementDocumentVersions, eq(agreementDocumentVersions.id, repositoryFragments.documentVersionId))
      .innerJoin(agreements, eq(agreements.id, repositoryFragments.agreementId))
      .where(and(...conditions)).orderBy(desc(repositoryFragments.createdAt), desc(repositoryFragments.id)).limit(limit + 1);
    const hasMore = rows.length > limit;
    const results = rows.slice(0, limit);
    const last = results.at(-1);
    const nextCursor = hasMore && last ? await encodeRepositorySearchCursor({
      v: 1, b: binding, s: snapshotAt, t: last.createdAt, i: last.fragmentId,
    }) : null;
    return apiJson({
      query: { terms, agreementId, documentVersionId },
      results: results.map((result) => ({
        agreement: { id: result.agreementId, party: result.agreementParty },
        citation: {
          fragmentId: result.fragmentId, documentVersionId: result.documentVersionId,
          documentVersion: result.documentVersion, documentSha256: result.documentSha256,
          sourceTextSha256: result.sourceTextSha256, ordinal: result.ordinal,
          startOffset: result.startOffset, endOffset: result.endOffset,
          quote: result.quote, quoteSha256: result.quoteSha256,
        },
      })),
      page: { limit, snapshotAt, hasMore, nextCursor },
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return routeError(error, auth.requestId);
  }
}
