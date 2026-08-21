import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { agreementDocumentVersions, agreements, repositoryFragments } from "../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import { sha256Hex } from "../../../lib/document-security";
import { fragmentPostSchema, REPOSITORY_FRAGMENT_MAX_TOTAL, RepositoryIntelligenceError } from "../../../lib/repository-intelligence";
import { apiError, apiJson } from "../../../lib/http";
import { parseJson } from "../../../lib/validation";

function routeError(error: unknown, requestId: string): Response {
  if (error instanceof RepositoryIntelligenceError) return apiError(error.code, error.message, { status: error.status, requestId });
  return handleRouteError(error, requestId, "Repository fragments could not be processed.");
}

function uniqueConflict(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).toLowerCase().includes("unique constraint failed");
}

function fragmentWriteConflict(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return uniqueConflict(error)
    || message.includes("repository_fragment_overlap")
    || message.includes("repository_fragment_limit");
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "document:read");
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !["documentVersionId", "agreementId"].includes(key))) {
      throw new RepositoryIntelligenceError(400, "invalid_query", "Unsupported fragment query parameter.");
    }
    const documentVersionId = url.searchParams.get("documentVersionId");
    const agreementRaw = url.searchParams.get("agreementId");
    if (documentVersionId === null && agreementRaw === null) throw new RepositoryIntelligenceError(400, "invalid_query", "Document version ID or agreement ID is required.");
    if (documentVersionId !== null && !/^[0-9a-f-]{36}$/i.test(documentVersionId)) throw new RepositoryIntelligenceError(400, "invalid_query", "Document version ID is invalid.");
    const agreementId = agreementRaw === null ? null : Number(agreementRaw);
    if (agreementRaw !== null && (!/^[1-9][0-9]*$/.test(agreementRaw) || !Number.isSafeInteger(agreementId))) throw new RepositoryIntelligenceError(400, "invalid_query", "Agreement ID is invalid.");
    await ensureStorageSchema();
    const db = getDb();
    const conditions = [
      eq(repositoryFragments.workspaceId, auth.context.workspace.id),
      eq(agreements.workspaceId, auth.context.workspace.id),
      isNull(agreements.deletedAt),
    ];
    if (documentVersionId) conditions.push(eq(repositoryFragments.documentVersionId, documentVersionId));
    if (agreementId !== null) conditions.push(eq(repositoryFragments.agreementId, agreementId));
    const fragments = await db.select({
      id: repositoryFragments.id,
      documentVersionId: repositoryFragments.documentVersionId,
      agreementId: repositoryFragments.agreementId,
      documentVersion: repositoryFragments.documentVersion,
      documentSha256: repositoryFragments.documentSha256,
      sourceTextSha256: repositoryFragments.sourceTextSha256,
      ordinal: repositoryFragments.ordinal,
      startOffset: repositoryFragments.startOffset,
      endOffset: repositoryFragments.endOffset,
      content: repositoryFragments.content,
      contentSha256: repositoryFragments.contentSha256,
      extractor: repositoryFragments.extractor,
      extractorVersion: repositoryFragments.extractorVersion,
      createdAt: repositoryFragments.createdAt,
    }).from(repositoryFragments).innerJoin(agreements, and(
      eq(agreements.id, repositoryFragments.agreementId), eq(agreements.workspaceId, repositoryFragments.workspaceId),
    )).where(and(...conditions)).orderBy(asc(repositoryFragments.ordinal)).limit(500);
    return apiJson({ fragments, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return routeError(error, auth.requestId);
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "document:manage", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, fragmentPostSchema, 700_000);
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    const [source] = await db.select({
      id: agreementDocumentVersions.id,
      agreementId: agreementDocumentVersions.agreementId,
      version: agreementDocumentVersions.version,
      sha256: agreementDocumentVersions.sha256,
    }).from(agreementDocumentVersions).innerJoin(agreements, and(
      eq(agreements.workspaceId, agreementDocumentVersions.workspaceId),
      eq(agreements.id, agreementDocumentVersions.agreementId),
      isNull(agreements.deletedAt),
    )).where(and(
      eq(agreementDocumentVersions.workspaceId, workspaceId),
      eq(agreementDocumentVersions.id, input.documentVersionId),
      eq(agreementDocumentVersions.version, input.documentVersion),
      eq(agreementDocumentVersions.sha256, input.documentSha256),
    )).limit(1);
    if (!source) throw new RepositoryIntelligenceError(422, "source_version_mismatch", "The immutable agreement document version is unavailable or no longer matches this extraction.");

    const fragments = [...input.fragments].sort((left, right) => left.ordinal - right.ordinal);
    const existing = await db.select().from(repositoryFragments).where(and(
      eq(repositoryFragments.workspaceId, workspaceId),
      eq(repositoryFragments.documentVersionId, source.id),
      eq(repositoryFragments.sourceTextSha256, input.sourceTextSha256),
    )).orderBy(asc(repositoryFragments.ordinal)).limit(REPOSITORY_FRAGMENT_MAX_TOTAL + 1);
    if (existing.length > REPOSITORY_FRAGMENT_MAX_TOTAL) {
      throw new RepositoryIntelligenceError(409, "fragment_source_conflict", "This registered source text exceeds the supported fragment limit and requires operator review.");
    }
    const contentDigests = await Promise.all(fragments.map((fragment) => sha256Hex(fragment.content)));
    const requestedDigestByOrdinal = new Map(fragments.map((fragment, index) => [fragment.ordinal, contentDigests[index]! as string]));
    const rowMatches = (row: typeof existing[number], candidate: typeof fragments[number]) => (
      row.startOffset === candidate.startOffset && row.endOffset === candidate.endOffset
      && row.contentSha256 === requestedDigestByOrdinal.get(candidate.ordinal)
      && row.extractor === input.extractor && row.extractorVersion === input.extractorVersion
    );
    const exactRequestedRows = (rows: typeof existing) => {
      const byOrdinal = new Map(rows.map((row) => [row.ordinal, row]));
      const requested = fragments.map((candidate) => {
        const row = byOrdinal.get(candidate.ordinal);
        return row && rowMatches(row, candidate) ? row : null;
      });
      return requested.every((row) => row !== null) ? requested as typeof existing : null;
    };
    if (existing.some((row) => row.extractor !== input.extractor || row.extractorVersion !== input.extractorVersion)) {
      throw new RepositoryIntelligenceError(409, "fragment_source_conflict", "A registered source-text digest cannot mix extractor identities or versions.");
    }
    const existingByOrdinal = new Map(existing.map((row) => [row.ordinal, row]));
    const missing = fragments.filter((candidate) => !existingByOrdinal.has(candidate.ordinal));
    for (const candidate of fragments) {
      const row = existingByOrdinal.get(candidate.ordinal);
      if (row && !rowMatches(row, candidate)) {
        throw new RepositoryIntelligenceError(409, "fragment_source_conflict", "A fragment ordinal already exists with different immutable evidence.");
      }
    }
    if (existing.length + missing.length > REPOSITORY_FRAGMENT_MAX_TOTAL) {
      throw new RepositoryIntelligenceError(409, "fragment_source_limit", `A registered source text may contain at most ${REPOSITORY_FRAGMENT_MAX_TOTAL} fragments.`);
    }
    if (missing.some((candidate) => existing.some((row) => candidate.startOffset < row.endOffset && candidate.endOffset > row.startOffset))) {
      throw new RepositoryIntelligenceError(409, "fragment_source_conflict", "Appended fragment offsets cannot overlap existing immutable evidence.");
    }
    if (missing.length === 0) {
      return apiJson({ fragments: exactRequestedRows(existing), idempotentReplay: true, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }

    const now = new Date().toISOString();
    const rows = missing.map((fragment) => ({
      id: crypto.randomUUID(), workspaceId, documentVersionId: source.id, agreementId: source.agreementId,
      documentVersion: source.version, documentSha256: source.sha256, sourceTextSha256: input.sourceTextSha256,
      ordinal: fragment.ordinal, startOffset: fragment.startOffset, endOffset: fragment.endOffset,
      content: fragment.content, contentSha256: requestedDigestByOrdinal.get(fragment.ordinal)!, extractor: input.extractor,
      extractorVersion: input.extractorVersion, createdByUserId: auth.context.user.id, createdAt: now,
    }));
    try {
      await db.batch(rows.map((row) => db.insert(repositoryFragments).values(row)) as unknown as Parameters<typeof db.batch>[0]);
    } catch (error) {
      if (!fragmentWriteConflict(error)) throw error;
      const winner = await db.select().from(repositoryFragments).where(and(
        eq(repositoryFragments.workspaceId, workspaceId),
        eq(repositoryFragments.documentVersionId, source.id),
        eq(repositoryFragments.sourceTextSha256, input.sourceTextSha256),
      )).orderBy(asc(repositoryFragments.ordinal)).limit(REPOSITORY_FRAGMENT_MAX_TOTAL + 1);
      const replay = exactRequestedRows(winner);
      if (!replay) throw new RepositoryIntelligenceError(409, "fragment_source_conflict", "Concurrent fragment registration committed different or overlapping immutable evidence.");
      return apiJson({ fragments: replay, idempotentReplay: true, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }
    const insertedByOrdinal = new Map(rows.map((row) => [row.ordinal, row]));
    return apiJson({
      fragments: fragments.map((fragment) => existingByOrdinal.get(fragment.ordinal) ?? insertedByOrdinal.get(fragment.ordinal)!),
      indexing: { status: "ready", provider: "provider-neutral", blocker: null },
      requestId: auth.requestId,
    }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return routeError(error, auth.requestId);
  }
}
