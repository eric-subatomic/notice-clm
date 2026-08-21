import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import {
  agreementDocumentVersions,
  agreementEvents,
  agreements,
  customFieldDefinitions,
  documents,
  extractionProposalCitations,
  extractionProposals,
  ingestionBatches,
  ingestionItems,
  mutationGuards,
  repositoryFragments,
} from "../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import { sha256Hex } from "../../../lib/document-security";
import {
  canonicalRepositoryJson,
  codePointSlice,
  ingestionIdempotencyKey,
  proposalPostSchema,
  proposalReviewSchema,
  RepositoryIntelligenceError,
} from "../../../lib/repository-intelligence";
import { apiError, apiJson } from "../../../lib/http";
import { prepareAgreementEvent } from "../../../lib/persistence";
import { parseJson } from "../../../lib/validation";

function routeError(error: unknown, requestId: string): Response {
  if (error instanceof RepositoryIntelligenceError) return apiError(error.code, error.message, { status: error.status, requestId });
  return handleRouteError(error, requestId, "Extraction proposals could not be processed.");
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "document:read");
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !["id", "agreementId", "status", "limit"].includes(key))) {
      throw new RepositoryIntelligenceError(400, "invalid_query", "Unsupported proposal query parameter.");
    }
    const id = url.searchParams.get("id");
    const agreementRaw = url.searchParams.get("agreementId");
    const status = url.searchParams.get("status");
    const limitRaw = url.searchParams.get("limit") ?? "50";
    if (id !== null && !/^[0-9a-f-]{36}$/i.test(id)) throw new RepositoryIntelligenceError(400, "invalid_query", "Proposal ID is invalid.");
    if (agreementRaw !== null && !/^[1-9][0-9]*$/.test(agreementRaw)) throw new RepositoryIntelligenceError(400, "invalid_query", "Agreement ID is invalid.");
    if (status !== null && !["pending_review", "accepted", "rejected", "superseded"].includes(status)) throw new RepositoryIntelligenceError(400, "invalid_query", "Proposal status is invalid.");
    if (!/^[1-9][0-9]?$|^100$/.test(limitRaw)) throw new RepositoryIntelligenceError(400, "invalid_query", "Limit must be between 1 and 100.");
    await ensureStorageSchema();
    const db = getDb();
    const conditions = [
      eq(extractionProposals.workspaceId, auth.context.workspace.id),
      eq(agreements.workspaceId, auth.context.workspace.id),
      isNull(agreements.deletedAt),
    ];
    if (id) conditions.push(eq(extractionProposals.id, id));
    if (agreementRaw) conditions.push(eq(extractionProposals.agreementId, Number(agreementRaw)));
    if (status) conditions.push(eq(extractionProposals.status, status as typeof extractionProposals.$inferSelect.status));
    const proposals = await db.select({ proposal: extractionProposals }).from(extractionProposals).innerJoin(agreements, and(
      eq(agreements.workspaceId, extractionProposals.workspaceId), eq(agreements.id, extractionProposals.agreementId),
    )).where(and(...conditions)).orderBy(desc(extractionProposals.updatedAt), desc(extractionProposals.id)).limit(Number(limitRaw));
    const proposalIds = proposals.map(({ proposal }) => proposal.id);
    const citations = proposalIds.length === 0 ? [] : await db.select().from(extractionProposalCitations).where(and(
      eq(extractionProposalCitations.workspaceId, auth.context.workspace.id), inArray(extractionProposalCitations.proposalId, proposalIds),
    )).limit(Math.min(2_000, proposalIds.length * 20));
    return apiJson({ proposals: proposals.map(({ proposal }) => proposal), citations, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return routeError(error, auth.requestId);
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "document:manage", { limit: 40 });
  if (!auth.ok) return auth.response;
  try {
    const idempotencyKey = ingestionIdempotencyKey(request);
    const input = await parseJson(request, proposalPostSchema, 300_000);
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    const confidencePpm = Math.round(input.confidence * 1_000_000);
    const normalizedCitations = [...input.citations].sort((left, right) => (
      left.fragmentId.localeCompare(right.fragmentId)
      || left.startOffset - right.startOffset
      || left.endOffset - right.endOffset
      || left.quote.localeCompare(right.quote)
    ));
    const expectedMaterial = canonicalRepositoryJson({
      documentVersionId: input.documentVersionId,
      agreementId: input.agreementId,
      ingestionItemId: input.ingestionItemId ?? null,
      documentVersion: input.documentVersion,
      documentSha256: input.documentSha256,
      sourceTextSha256: input.sourceTextSha256,
      target: input.target,
      proposedValue: input.proposedValue,
      confidencePpm,
      extractor: input.extractor,
      extractorVersion: input.extractorVersion,
      citations: normalizedCitations,
    });
    const loadReplay = async () => {
      const [existing] = await db.select().from(extractionProposals).where(and(
        eq(extractionProposals.workspaceId, workspaceId), eq(extractionProposals.id, idempotencyKey),
        eq(extractionProposals.createdByUserId, auth.context.user.id),
      )).limit(1);
      if (!existing) return null;
      const existingCitations = await db.select().from(extractionProposalCitations).where(and(
        eq(extractionProposalCitations.workspaceId, workspaceId), eq(extractionProposalCitations.proposalId, existing.id),
      )).limit(20);
      const actualMaterial = canonicalRepositoryJson({
        documentVersionId: existing.documentVersionId,
        agreementId: existing.agreementId,
        ingestionItemId: existing.ingestionItemId,
        documentVersion: existing.documentVersion,
        documentSha256: existing.documentSha256,
        sourceTextSha256: existing.sourceTextSha256,
        target: existing.targetType === "custom_field"
          ? { type: "custom_field", field: existing.targetField, definitionId: existing.customFieldDefinitionId }
          : { type: "agreement_field", field: existing.targetField },
        proposedValue: existing.proposedValue,
        confidencePpm: existing.confidencePpm,
        extractor: existing.extractor,
        extractorVersion: existing.extractorVersion,
        citations: existingCitations.map((citation) => ({
          fragmentId: citation.fragmentId,
          startOffset: citation.startOffset,
          endOffset: citation.endOffset,
          quote: citation.quote,
        })).sort((left, right) => (
          left.fragmentId.localeCompare(right.fragmentId)
          || left.startOffset - right.startOffset
          || left.endOffset - right.endOffset
          || left.quote.localeCompare(right.quote)
        )),
      });
      if (actualMaterial !== expectedMaterial) {
        throw new RepositoryIntelligenceError(409, "idempotency_conflict", "This Idempotency-Key was already used for a different extraction proposal.");
      }
      return { proposal: existing, citations: existingCitations };
    };
    const existingReplay = await loadReplay();
    if (existingReplay) {
      const replayHeaders = new Headers(auth.headers);
      replayHeaders.set("Idempotency-Replayed", "true");
      return apiJson({ ...existingReplay, idempotentReplay: true, requestId: auth.requestId }, { requestId: auth.requestId, headers: replayHeaders });
    }
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
      eq(agreementDocumentVersions.agreementId, input.agreementId),
      eq(agreementDocumentVersions.version, input.documentVersion),
      eq(agreementDocumentVersions.sha256, input.documentSha256),
    )).limit(1);
    if (!source) throw new RepositoryIntelligenceError(422, "source_version_mismatch", "The immutable agreement document version is unavailable or no longer matches this proposal.");
    if (input.target.type === "custom_field") {
      const [definition] = await db.select({ id: customFieldDefinitions.id, key: customFieldDefinitions.key }).from(customFieldDefinitions).where(and(
        eq(customFieldDefinitions.workspaceId, workspaceId), eq(customFieldDefinitions.id, input.target.definitionId),
        eq(customFieldDefinitions.resourceType, "agreement"), eq(customFieldDefinitions.status, "active"),
      )).limit(1);
      if (!definition || definition.key !== input.target.field) throw new RepositoryIntelligenceError(422, "custom_field_mismatch", "The active agreement custom-field definition does not match this proposal target.");
    }
    const [ingestionItem] = input.ingestionItemId ? await db.select({ item: ingestionItems }).from(ingestionItems)
      .innerJoin(documents, and(
        eq(documents.workspaceId, ingestionItems.workspaceId), eq(documents.id, ingestionItems.documentId),
        eq(documents.agreementId, source.agreementId), isNull(documents.deletedAt),
      )).where(and(
        eq(ingestionItems.workspaceId, workspaceId), eq(ingestionItems.id, input.ingestionItemId),
        inArray(ingestionItems.status, ["pending_extraction", "review_required"]),
      )).limit(1) : [];
    if (input.ingestionItemId && !ingestionItem) {
      throw new RepositoryIntelligenceError(422, "ingestion_item_mismatch", "The ingestion item is unavailable, is not awaiting registered extraction evidence, or is not linked to this agreement.");
    }

    const citationIds = input.citations.map((citation) => citation.fragmentId);
    if (new Set(citationIds).size !== citationIds.length) throw new RepositoryIntelligenceError(400, "duplicate_citation", "Each cited fragment may appear only once.");
    const fragments = await db.select().from(repositoryFragments).where(and(
      eq(repositoryFragments.workspaceId, workspaceId),
      eq(repositoryFragments.documentVersionId, source.id),
      eq(repositoryFragments.documentVersion, source.version),
      eq(repositoryFragments.documentSha256, source.sha256),
      eq(repositoryFragments.sourceTextSha256, input.sourceTextSha256),
      inArray(repositoryFragments.id, citationIds),
    )).limit(input.citations.length);
    const byId = new Map(fragments.map((fragment) => [fragment.id, fragment]));
    const citationDigests: string[] = [];
    for (const citation of input.citations) {
      const fragment = byId.get(citation.fragmentId);
      if (!fragment || citation.startOffset < fragment.startOffset || citation.endOffset > fragment.endOffset) {
        throw new RepositoryIntelligenceError(422, "citation_mismatch", "Every citation must be inside a registered fragment for this source version.");
      }
      const exactQuote = codePointSlice(fragment.content, citation.startOffset - fragment.startOffset, citation.endOffset - fragment.startOffset);
      if (exactQuote !== citation.quote) throw new RepositoryIntelligenceError(422, "citation_quote_mismatch", "Citation text does not match the registered fragment offsets.");
      citationDigests.push(await sha256Hex(citation.quote));
    }

    const now = new Date().toISOString();
    const proposal = {
      id: idempotencyKey, workspaceId, documentVersionId: source.id, agreementId: source.agreementId,
      ingestionItemId: input.ingestionItemId ?? null, documentVersion: source.version, documentSha256: source.sha256,
      sourceTextSha256: input.sourceTextSha256, targetType: input.target.type,
      targetField: input.target.field, customFieldDefinitionId: input.target.type === "custom_field" ? input.target.definitionId : null,
      proposedValue: input.proposedValue, confidencePpm,
      extractor: input.extractor, extractorVersion: input.extractorVersion, status: "pending_review" as const,
      applicationStatus: "not_reviewed" as const, blockerCode: "human_review_required",
      blockerMessage: "A human reviewer must accept or reject this proposal.",
      reviewedByUserId: null, reviewedAt: null, reviewReason: null,
      createdByUserId: auth.context.user.id, createdAt: now, updatedAt: now,
    };
    const citations = input.citations.map((citation, index) => ({
      id: crypto.randomUUID(), workspaceId, proposalId: proposal.id, fragmentId: citation.fragmentId,
      documentVersionId: source.id, documentVersion: source.version, documentSha256: source.sha256,
      sourceTextSha256: input.sourceTextSha256, startOffset: citation.startOffset, endOffset: citation.endOffset,
      quote: citation.quote, quoteSha256: citationDigests[index]!,
    }));
    const guardId = ingestionItem ? crypto.randomUUID() : null;
    try {
      await db.batch([
        db.insert(extractionProposals).values(proposal),
        ...citations.map((citation) => db.insert(extractionProposalCitations).values(citation)),
        ...(ingestionItem && guardId ? [
        db.update(ingestionItems).set({
          status: "review_required", blockerCode: "human_review_required",
          blockerMessage: "Registered extraction evidence is ready for a human review decision.", updatedAt: now,
        }).where(and(
          eq(ingestionItems.workspaceId, workspaceId), eq(ingestionItems.id, ingestionItem.item.id),
          inArray(ingestionItems.status, ["pending_extraction", "review_required"]),
        )),
        db.insert(mutationGuards).values({
          id: guardId, workspaceId, operation: "ingestion-item.extraction-registered",
          guardChanges: sql<number>`changes()`, createdAt: now,
        }),
        db.update(ingestionBatches).set({
          status: "review", blockerCode: "human_review_required",
          blockerMessage: "One or more registered extraction results require human review.", updatedAt: now,
        }).where(and(eq(ingestionBatches.workspaceId, workspaceId), eq(ingestionBatches.id, ingestionItem.item.batchId))),
        db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), eq(mutationGuards.id, guardId))),
        ] : []),
      ] as unknown as Parameters<typeof db.batch>[0]);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
      if (!message.includes("unique constraint failed")) throw error;
      const winner = await loadReplay();
      if (!winner) throw new RepositoryIntelligenceError(409, "idempotency_conflict", "This Idempotency-Key is unavailable for this extraction proposal.");
      const replayHeaders = new Headers(auth.headers);
      replayHeaders.set("Idempotency-Replayed", "true");
      return apiJson({ ...winner, idempotentReplay: true, requestId: auth.requestId }, { requestId: auth.requestId, headers: replayHeaders });
    }
    return apiJson({
      proposal,
      citations,
      mutationReadiness: { status: "blocked", blocker: { code: "human_review_required", message: proposal.blockerMessage } },
      requestId: auth.requestId,
    }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return routeError(error, auth.requestId);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "document:manage", { limit: 50 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, proposalReviewSchema, 12_000);
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    const [proposal] = await db.select().from(extractionProposals).innerJoin(agreements, and(
      eq(agreements.workspaceId, extractionProposals.workspaceId), eq(agreements.id, extractionProposals.agreementId), isNull(agreements.deletedAt),
    )).where(and(eq(extractionProposals.workspaceId, workspaceId), eq(extractionProposals.id, input.id))).limit(1).then((rows) => rows.map((row) => row.extraction_proposals));
    if (!proposal) throw new RepositoryIntelligenceError(404, "proposal_not_found", "Extraction proposal was not found or its agreement is unavailable.");
    if (proposal.status !== "pending_review") throw new RepositoryIntelligenceError(409, "proposal_already_reviewed", "This proposal already has a final review decision.");
    const [source] = await db.select({ id: agreementDocumentVersions.id }).from(agreementDocumentVersions).where(and(
      eq(agreementDocumentVersions.workspaceId, workspaceId), eq(agreementDocumentVersions.id, proposal.documentVersionId),
      eq(agreementDocumentVersions.agreementId, proposal.agreementId), eq(agreementDocumentVersions.version, proposal.documentVersion),
      eq(agreementDocumentVersions.sha256, proposal.documentSha256),
    )).limit(1);
    if (!source) throw new RepositoryIntelligenceError(409, "proposal_source_stale", "The exact immutable source version is no longer available for review.");
    const status = input.decision === "accept" ? "accepted" as const : "rejected" as const;
    const blockerCode = input.decision === "accept" ? "governed_executor_required" : "proposal_rejected";
    const blockerMessage = input.decision === "accept"
      ? "The proposal was accepted, but no governed application executor is configured; agreement and custom-field data are unchanged."
      : "The proposal was rejected and cannot be applied.";
    const now = new Date().toISOString();
    const event = await prepareAgreementEvent(db, {
      workspaceId, agreementId: proposal.agreementId, type: "ExtractionProposalReviewed",
      detail: `${status === "accepted" ? "Accepted" : "Rejected"} extraction proposal ${proposal.id} for ${proposal.targetType}:${proposal.targetField}. No agreement data was mutated.`,
      actor: auth.context.user, createdAt: now,
    });
    const guardId = crypto.randomUUID();
    await db.batch([
      db.update(extractionProposals).set({
        status, applicationStatus: "blocked", blockerCode, blockerMessage,
        reviewedByUserId: auth.context.user.id, reviewedAt: now, reviewReason: input.reason, updatedAt: now,
      }).where(and(
        eq(extractionProposals.workspaceId, workspaceId), eq(extractionProposals.id, proposal.id), eq(extractionProposals.status, "pending_review"),
      )),
      db.insert(mutationGuards).values({ id: guardId, workspaceId, operation: "extraction-proposal.review", guardChanges: sql<number>`changes()`, createdAt: now }),
      db.insert(agreementEvents).values(event),
      db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), eq(mutationGuards.id, guardId))),
    ]);
    return apiJson({
      proposal: { ...proposal, status, applicationStatus: "blocked", blockerCode, blockerMessage, reviewedByUserId: auth.context.user.id, reviewedAt: now, reviewReason: input.reason, updatedAt: now },
      mutationApplied: false,
      mutationReadiness: { status: "blocked", blocker: { code: blockerCode, message: blockerMessage } },
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return routeError(error, auth.requestId);
  }
}
