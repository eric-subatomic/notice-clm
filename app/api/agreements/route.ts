import { env } from "cloudflare:workers";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, notExists, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../db";
import { ensureStorageSchema } from "../../../db/ensure";
import { agreementCreationReceipts, agreementDocumentVersions, agreementEvents, agreements, agreementVersions, approvalRequests, counterparties, documents, documentUploadReceipts, governedTemplates, governedTemplateVersions, legalEntities, mutationGuards, negotiationRounds, outboxEvents, signaturePackets, users, workflowDefinitions, workspaceMemberships } from "../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../lib/api";
import { sha256Hex } from "../../lib/document-security";
import { documentUploadKeyDigest } from "../../lib/document-upload-idempotency";
import { apiError, apiJson } from "../../lib/http";
import {
  crmAgreementProjection,
  prepareAgreementDeletedIntegrationEvent,
  prepareIntegrationOutboxEvent,
} from "../../lib/integration-events";
import {
  findActiveAgreement,
  isMutationGuardConflict,
  prepareAgreementEvent,
  prepareAgreementSnapshot,
  prepareOutboxEvent,
} from "../../lib/persistence";
import { configuredCrmSelectionError } from "../../lib/crm-selection";
import { cleanupStagedWorkingVersionObject, type StagedObjectIdentity } from "../../lib/staged-object-cleanup";
import { validateAgreementDatePair } from "../../lib/iso-date";
import { minorUnitsFromWholeUnits, wholeUnitProjection } from "../../lib/money";
import { GovernedTemplateRuntimeError, renderGovernedTemplate } from "../../lib/governed-template-runtime";
import { assembleStarterDraft } from "../../lib/starter-draft";
import { agreementDetailsPatchSchema, agreementMutationSchema, parseJson } from "../../lib/validation";
import { EnterpriseError } from "../../lib/enterprise-domain";
import { governedWorkflowSnapshot } from "../../lib/workflow-policy";

type AgreementEnv = { DOCUMENTS: R2Bucket };

const deleteSchema = z.object({ id: z.coerce.number().int().positive(), version: z.number().int().positive() });
const creationIdempotencyKeySchema = z.string().uuid();
const MATERIAL_APPROVAL_FIELDS = new Set(["party", "side", "type", "value", "valueMinor", "currencyCode", "primaryCounterpartyId", "legalEntityId", "governedTemplateVersionId", "workflowDefinitionId", "department", "effectiveDate", "expirationDate"]);
const AGREEMENT_LIST_DEFAULT_LIMIT = 200;
const AGREEMENT_LIST_MAX_LIMIT = 200;
const AGREEMENT_LIST_CURSOR_VERSION = 2;
const AGREEMENT_LIST_QUERY_PARAMETERS = new Set(["q", "side", "stage", "risk", "sort", "limit", "cursor"]);
const AGREEMENT_LIST_SIDES = new Set(["Sell-side", "Buy-side", "Corporate"]);
const AGREEMENT_LIST_STAGES = new Set(["Intake", "Draft", "Review", "Negotiation", "Signature", "Active"]);
const AGREEMENT_LIST_RISKS = new Set(["Unassessed", "Low", "Medium", "High"]);
const AGREEMENT_LIST_SORTS = new Set(["Updated", "Value", "Risk"]);
type AgreementDetailsChanges = Omit<z.infer<typeof agreementDetailsPatchSchema>, "id" | "version">;

type AgreementListSort = "Updated" | "Value" | "Risk";
type AgreementListQuery = Readonly<{
  q: string | null;
  side: string | null;
  stage: string | null;
  risk: string | null;
  sort: AgreementListSort;
  limit: number;
}>;
type AgreementListCursorPayload = Readonly<{
  v: typeof AGREEMENT_LIST_CURSOR_VERSION;
  b: string;
  a: number;
  s: string;
  k: string | number;
  u: string | null;
  i: number;
}>;
type AgreementListCursorEnvelope = AgreementListCursorPayload & Readonly<{ c: string }>;

class AgreementListQueryError extends TypeError {
  readonly code: "invalid_query" | "invalid_cursor";

  constructor(code: "invalid_query" | "invalid_cursor") {
    super(code === "invalid_cursor" ? "Agreement list cursor is invalid" : "Agreement list query is invalid");
    this.name = "AgreementListQueryError";
    this.code = code;
  }
}

function normalizedAgreementListFilter(
  candidate: string | null,
  allowed: ReadonlySet<string>,
): string | null {
  if (candidate === null || candidate === "All") return null;
  if (!allowed.has(candidate)) throw new AgreementListQueryError("invalid_query");
  return candidate;
}

function parseAgreementListQuery(url: URL): AgreementListQuery {
  const parameters = [...url.searchParams.keys()];
  if (url.searchParams.getAll("cursor").length > 1) {
    throw new AgreementListQueryError("invalid_cursor");
  }
  if (
    parameters.some((name) => !AGREEMENT_LIST_QUERY_PARAMETERS.has(name))
    || [...AGREEMENT_LIST_QUERY_PARAMETERS].some((name) => name !== "cursor" && url.searchParams.getAll(name).length > 1)
  ) {
    throw new AgreementListQueryError("invalid_query");
  }
  const rawQuery = url.searchParams.get("q");
  if (rawQuery !== null && rawQuery.length > 500) throw new AgreementListQueryError("invalid_query");
  const q = rawQuery?.normalize("NFKC").trim() || null;
  if (q !== null && q.length > 200) throw new AgreementListQueryError("invalid_query");
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && !/^[1-9][0-9]{0,2}$/.test(rawLimit)) {
    throw new AgreementListQueryError("invalid_query");
  }
  const limit = rawLimit === null ? AGREEMENT_LIST_DEFAULT_LIMIT : Number(rawLimit);
  if (limit > AGREEMENT_LIST_MAX_LIMIT) throw new AgreementListQueryError("invalid_query");
  const rawSort = url.searchParams.get("sort") ?? "Updated";
  if (!AGREEMENT_LIST_SORTS.has(rawSort)) throw new AgreementListQueryError("invalid_query");
  return Object.freeze({
    q,
    side: normalizedAgreementListFilter(url.searchParams.get("side"), AGREEMENT_LIST_SIDES),
    stage: normalizedAgreementListFilter(url.searchParams.get("stage"), AGREEMENT_LIST_STAGES),
    risk: normalizedAgreementListFilter(url.searchParams.get("risk"), AGREEMENT_LIST_RISKS),
    sort: rawSort as AgreementListSort,
    limit,
  });
}

function base64UrlEncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecodeUtf8(candidate: string): string {
  const base64 = candidate.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function agreementListBinding(workspaceId: string, query: AgreementListQuery): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify({
    v: AGREEMENT_LIST_CURSOR_VERSION,
    workspaceId,
    q: query.q,
    side: query.side,
    stage: query.stage,
    risk: query.risk,
    sort: query.sort,
    limit: query.limit,
  })));
}

function agreementListCursorPayloadJson(payload: AgreementListCursorPayload): string {
  return JSON.stringify({ v: payload.v, b: payload.b, a: payload.a, s: payload.s, k: payload.k, u: payload.u, i: payload.i });
}

async function encodeAgreementListCursor(payload: AgreementListCursorPayload): Promise<string> {
  const c = await sha256Hex(new TextEncoder().encode(agreementListCursorPayloadJson(payload)));
  return base64UrlEncodeUtf8(JSON.stringify({ ...payload, c } satisfies AgreementListCursorEnvelope));
}

async function decodeAgreementListCursor(
  candidate: string | null,
  expectedBinding: string,
  sort: AgreementListSort,
): Promise<AgreementListCursorPayload | null> {
  if (candidate === null) return null;
  if (candidate.length < 1 || candidate.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(candidate)) {
    throw new AgreementListQueryError("invalid_cursor");
  }
  try {
    const decoded = base64UrlDecodeUtf8(candidate);
    const value: unknown = JSON.parse(decoded);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "a,b,c,i,k,s,u,v"
      || record.v !== AGREEMENT_LIST_CURSOR_VERSION
      || typeof record.b !== "string"
      || !/^[a-f0-9]{64}$/.test(record.b)
      || typeof record.c !== "string"
      || !/^[a-f0-9]{64}$/.test(record.c)
      || !Number.isSafeInteger(record.a)
      || (record.a as number) <= 0
      || !Number.isSafeInteger(record.i)
      || (record.i as number) <= 0
      || (record.i as number) > (record.a as number)
      || typeof record.s !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.s)
      || new Date(record.s).toISOString() !== record.s
      || (sort === "Updated" && (typeof record.k !== "string" || record.k.length > 128 || record.u !== null))
      || (sort === "Value" && (!Number.isSafeInteger(record.k) || (record.k as number) < 0 || typeof record.u !== "string" || !/^[A-Z]{3}$/.test(record.u)))
      || (sort === "Risk" && (!Number.isInteger(record.k) || (record.k as number) < -1 || (record.k as number) > 3 || record.u !== null))
    ) throw new TypeError();
    const payload: AgreementListCursorPayload = Object.freeze({
      v: AGREEMENT_LIST_CURSOR_VERSION,
      b: record.b,
      a: record.a as number,
      s: record.s,
      k: record.k as string | number,
      u: record.u as string | null,
      i: record.i as number,
    });
    const expectedChecksum = await sha256Hex(new TextEncoder().encode(agreementListCursorPayloadJson(payload)));
    if (
      record.b !== expectedBinding
      || record.c !== expectedChecksum
      || decoded !== JSON.stringify({ ...payload, c: record.c } satisfies AgreementListCursorEnvelope)
      || candidate !== base64UrlEncodeUtf8(decoded)
    ) throw new TypeError();
    return payload;
  } catch {
    throw new AgreementListQueryError("invalid_cursor");
  }
}

function escapedAgreementListPattern(query: string): string {
  return `%${query.toLocaleLowerCase("en-US").replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function agreementListFilters(query: AgreementListQuery): Array<SQL | undefined> {
  const pattern = query.q === null ? null : escapedAgreementListPattern(query.q);
  return [
    query.side === null ? undefined : eq(agreements.side, query.side),
    query.stage === null ? undefined : eq(agreements.stage, query.stage),
    query.risk === null ? undefined : eq(agreements.risk, query.risk),
    pattern === null ? undefined : or(
      sql`lower(${agreements.party}) like ${pattern} escape '\\'`,
      sql`lower(${agreements.type}) like ${pattern} escape '\\'`,
      sql`lower(${agreements.owner}) like ${pattern} escape '\\'`,
      sql`exists (
        select 1
        from json_each(case when json_valid(${agreements.tags}) then ${agreements.tags} else '[]' end) as agreement_tag
        where lower(cast(agreement_tag.value as text)) like ${pattern} escape '\\'
      )`,
    ),
  ];
}

const agreementRiskRank = sql<number>`case ${agreements.risk}
  when 'High' then 3
  when 'Medium' then 2
  when 'Low' then 1
  when 'Unassessed' then 0
  else -1
end`;

function agreementListCursorCondition(
  sort: AgreementListSort,
  cursor: AgreementListCursorPayload | null,
): SQL | undefined {
  if (cursor === null) return undefined;
  if (sort === "Updated") {
    const key = cursor.k as string;
    return or(
      lt(agreements.updatedAt, key),
      and(eq(agreements.updatedAt, key), lt(agreements.id, cursor.i)),
    );
  }
  if (sort === "Value") {
    const key = cursor.k as number;
    const currency = cursor.u as string;
    return or(
      gt(agreements.currencyCode, currency),
      and(eq(agreements.currencyCode, currency), lt(agreements.valueMinor, key)),
      and(eq(agreements.currencyCode, currency), eq(agreements.valueMinor, key), lt(agreements.id, cursor.i)),
    );
  }
  const key = cursor.k as number;
  return or(
    sql`${agreementRiskRank} < ${key}`,
    and(sql`${agreementRiskRank} = ${key}`, lt(agreements.id, cursor.i)),
  );
}

function agreementListOrder(sort: AgreementListSort) {
  // There is no implicit FX conversion. Value sorting groups by canonical ISO
  // currency code, then orders exact minor-unit amounts within each currency.
  if (sort === "Value") return [asc(agreements.currencyCode), desc(agreements.valueMinor), desc(agreements.id)] as const;
  if (sort === "Risk") return [desc(agreementRiskRank), desc(agreements.id)] as const;
  return [desc(agreements.updatedAt), desc(agreements.id)] as const;
}

function agreementListCursorKey(
  sort: AgreementListSort,
  agreement: typeof agreements.$inferSelect,
): string | number {
  if (sort === "Value") return agreement.valueMinor;
  if (sort === "Risk") {
    return agreement.risk === "High" ? 3 : agreement.risk === "Medium" ? 2 : agreement.risk === "Low" ? 1 : agreement.risk === "Unassessed" ? 0 : -1;
  }
  return agreement.updatedAt;
}

function agreementValuesEqual(current: unknown, proposed: unknown): boolean {
  if (Array.isArray(current) || Array.isArray(proposed)) {
    return Array.isArray(current)
      && Array.isArray(proposed)
      && current.length === proposed.length
      && current.every((value, index) => value === proposed[index]);
  }
  return current === proposed;
}

function effectiveAgreementChanges(
  current: typeof agreements.$inferSelect,
  requested: AgreementDetailsChanges,
): AgreementDetailsChanges {
  const normalized: AgreementDetailsChanges = {
    ...requested,
    ...(requested.tags === undefined ? {} : { tags: Array.from(new Set(requested.tags)) }),
  };
  const effective: Record<string, unknown> = {};
  for (const [field, proposed] of Object.entries(normalized)) {
    if (proposed === undefined) continue;
    const persisted = (current as unknown as Record<string, unknown>)[field];
    if (!agreementValuesEqual(persisted, proposed)) effective[field] = proposed;
  }
  return effective as AgreementDetailsChanges;
}

function serverAgreementId(): number {
  const random = crypto.getRandomValues(new Uint16Array(1))[0] % 1_000;
  return Date.now() * 1_000 + random;
}
function initials(party: string): string {
  return party.split(/\s+/).filter(Boolean).map((word) => word[0]).join("").slice(0, 3).toUpperCase() || "NA";
}

async function replayAgreementCreation(
  db: ReturnType<typeof getDb>,
  input: Readonly<{
    workspaceId: string;
    userId: string;
    idempotencyKey: string;
    requestSha256: string;
    requestId: string;
    headers: HeadersInit;
  }>,
): Promise<Response | null> {
  const [receipt] = await db.select().from(agreementCreationReceipts).where(and(
    eq(agreementCreationReceipts.workspaceId, input.workspaceId),
    eq(agreementCreationReceipts.userId, input.userId),
    eq(agreementCreationReceipts.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (!receipt) return null;
  if (receipt.requestSha256 !== input.requestSha256) {
    return apiError(
      "idempotency_key_conflict",
      "This agreement-creation key was already used with different intake data. Start a new intake before trying again.",
      { status: 409, requestId: input.requestId, headers: input.headers },
    );
  }

  const [[agreement], documentVersions, [event]] = await Promise.all([
    db.select().from(agreements).where(and(
      eq(agreements.workspaceId, input.workspaceId),
      eq(agreements.id, receipt.agreementId),
      isNull(agreements.deletedAt),
    )).limit(1),
    receipt.creationMode === "generated" ? db.select({
      id: agreementDocumentVersions.id,
      agreementId: agreementDocumentVersions.agreementId,
      version: agreementDocumentVersions.version,
      label: agreementDocumentVersions.label,
      contentType: agreementDocumentVersions.contentType,
      size: agreementDocumentVersions.size,
      sha256: agreementDocumentVersions.sha256,
      sourceDocumentId: agreementDocumentVersions.sourceDocumentId,
      createdByUserId: agreementDocumentVersions.createdByUserId,
      createdAt: agreementDocumentVersions.createdAt,
    }).from(agreementDocumentVersions).where(and(
      eq(agreementDocumentVersions.workspaceId, input.workspaceId),
      eq(agreementDocumentVersions.agreementId, receipt.agreementId),
      eq(agreementDocumentVersions.version, 1),
    )).limit(1) : Promise.resolve([]),
    db.select().from(agreementEvents).where(and(
      eq(agreementEvents.workspaceId, input.workspaceId),
      eq(agreementEvents.agreementId, receipt.agreementId),
      eq(agreementEvents.sequence, 1),
      eq(agreementEvents.type, "Created"),
    )).limit(1),
  ]);
  if (!agreement || !event || (receipt.creationMode === "generated" && !documentVersions[0])) {
    return apiError(
      "idempotency_target_unavailable",
      "The prior agreement-creation receipt no longer has an active target. Start a new intake with a new key.",
      { status: 409, requestId: input.requestId, headers: input.headers },
    );
  }
  const replayHeaders = new Headers(input.headers);
  replayHeaders.set("Idempotency-Replayed", "true");
  return apiJson(
    { agreement, documentVersion: documentVersions[0] ?? null, event, replay: true, requestId: input.requestId },
    { requestId: input.requestId, headers: replayHeaders },
  );
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:read");
  if (!auth.ok) return auth.response;
  try {
    let query: AgreementListQuery;
    try {
      query = parseAgreementListQuery(new URL(request.url));
    } catch (error) {
      const invalidCursor = error instanceof AgreementListQueryError && error.code === "invalid_cursor";
      return apiError(invalidCursor ? "invalid_cursor" : "invalid_query", invalidCursor
        ? "The agreement list page cursor is invalid for this workspace and query."
        : "Agreement list filters, sort, and page size are invalid.", {
        status: 400,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }
    const binding = await agreementListBinding(auth.context.workspace.id, query);
    let cursor: AgreementListCursorPayload | null;
    try {
      cursor = await decodeAgreementListCursor(new URL(request.url).searchParams.get("cursor"), binding, query.sort);
    } catch {
      return apiError("invalid_cursor", "The agreement list page cursor is invalid for this workspace and query.", {
        status: 400,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }
    await ensureStorageSchema();
    const db = getDb();
    const snapshotAt = cursor?.s ?? new Date().toISOString();
    const scope = [
      eq(agreements.workspaceId, auth.context.workspace.id),
      isNull(agreements.deletedAt),
      lte(agreements.createdAt, snapshotAt),
      ...agreementListFilters(query),
    ];
    let anchorId: number;
    let totalMatched: number;
    if (cursor === null) {
      const [snapshot] = await db.select({
        anchorId: sql<number | null>`max(${agreements.id})`,
        totalMatched: sql<number>`count(*)`,
      }).from(agreements).where(and(...scope));
      anchorId = Number(snapshot?.anchorId ?? 0);
      totalMatched = Number(snapshot?.totalMatched ?? 0);
    } else {
      anchorId = cursor.a;
      const [snapshot] = await db.select({
        totalMatched: sql<number>`count(*)`,
      }).from(agreements).where(and(...scope, lte(agreements.id, anchorId)));
      totalMatched = Number(snapshot?.totalMatched ?? 0);
    }
    const rows = anchorId <= 0 ? [] : await db.select().from(agreements).where(and(
      ...scope,
      lte(agreements.id, anchorId),
      agreementListCursorCondition(query.sort, cursor),
    )).orderBy(...agreementListOrder(query.sort)).limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    const last = page.at(-1);
    const nextCursor = hasMore && last
      ? await encodeAgreementListCursor({
        v: AGREEMENT_LIST_CURSOR_VERSION,
        b: binding,
        a: anchorId,
        s: snapshotAt,
        k: agreementListCursorKey(query.sort, last),
        u: query.sort === "Value" ? last.currencyCode : null,
        i: last.id,
      })
      : null;
    return apiJson({
      agreements: page,
      totalMatched,
      nextCursor,
      hasMore,
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Agreements could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:create", { limit: 30 });
  if (!auth.ok) return auth.response;
  let generatedObjectKey: string | null = null;
  let stagedGeneratedVersion: StagedObjectIdentity | null = null;
  let creationDb: ReturnType<typeof getDb> | null = null;
  let creationIdempotencyKey: string | null = null;
  let creationRequestSha256: string | null = null;
  try {
    await ensureStorageSchema();
    const input = await parseJson(request, agreementMutationSchema);
    const rawIdempotencyKey = request.headers.get("idempotency-key");
    if (rawIdempotencyKey === null) {
      return apiError(
        "idempotency_key_required",
        "Idempotency-Key is required for agreement creation and must be retained for every retry of the same intake.",
        { status: 400, requestId: auth.requestId, headers: auth.headers },
      );
    }
    const parsedIdempotencyKey = creationIdempotencyKeySchema.safeParse(rawIdempotencyKey);
    if (!parsedIdempotencyKey.success) {
      return apiError(
        "invalid_idempotency_key",
        "Idempotency-Key must be one canonical UUID.",
        { status: 400, requestId: auth.requestId, headers: auth.headers },
      );
    }
    creationIdempotencyKey = parsedIdempotencyKey.data.toLowerCase();
    creationRequestSha256 = await sha256Hex(new TextEncoder().encode(JSON.stringify(input)));
    const db = getDb();
    creationDb = db;
    const replay = await replayAgreementCreation(db, {
      workspaceId: auth.context.workspace.id,
      userId: auth.context.user.id,
      idempotencyKey: creationIdempotencyKey,
      requestSha256: creationRequestSha256,
      requestId: auth.requestId,
      headers: auth.headers,
    });
    if (replay) return replay;
    let importUploadKeyDigest: string | null = null;
    let importUploadDocumentId: string | null = null;
    let importUploadExpiresAt: string | null = null;
    if (input.creationMode === "imported") {
      importUploadKeyDigest = await documentUploadKeyDigest({
        workspaceId: auth.context.workspace.id,
        userId: auth.context.user.id,
        idempotencyKey: creationIdempotencyKey,
      });
      const [uploadReceipt] = await db.select({
        documentId: documentUploadReceipts.documentId,
        expiresAt: documentUploadReceipts.expiresAt,
        linkedAt: documentUploadReceipts.linkedAt,
        documentVersion: documents.version,
        documentAgreementId: documents.agreementId,
        documentLegalHold: documents.legalHold,
        documentRetentionUntil: documents.retentionUntil,
        documentDeletedAt: documents.deletedAt,
      }).from(documentUploadReceipts).innerJoin(documents, and(
        eq(documents.workspaceId, documentUploadReceipts.workspaceId),
        eq(documents.id, documentUploadReceipts.documentId),
      )).where(and(
        eq(documentUploadReceipts.workspaceId, auth.context.workspace.id),
        eq(documentUploadReceipts.userId, auth.context.user.id),
        eq(documentUploadReceipts.keyDigest, importUploadKeyDigest),
      )).limit(1);
      if (!uploadReceipt) {
        return apiError("document_upload_receipt_required", "Imported agreement creation requires the same protected intake UUID used for its committed source upload.", { status: 409, requestId: auth.requestId, headers: auth.headers });
      }
      if (uploadReceipt.linkedAt !== null) {
        return apiError("document_upload_already_linked", "This protected intake source is already attached to an agreement.", { status: 409, requestId: auth.requestId, headers: auth.headers });
      }
      if (uploadReceipt.documentAgreementId !== null || uploadReceipt.documentDeletedAt !== null) {
        return apiError("document_upload_unavailable", "The protected intake source is no longer an unlinked live document.", { status: 409, requestId: auth.requestId, headers: auth.headers });
      }
      if (uploadReceipt.expiresAt <= new Date().toISOString()) {
        return apiError("document_upload_expired", "The unlinked source upload expired before agreement creation. Start a new import.", { status: 410, requestId: auth.requestId, headers: auth.headers });
      }
      if (uploadReceipt.documentLegalHold || uploadReceipt.documentRetentionUntil !== uploadReceipt.expiresAt) {
        return apiError("document_upload_policy_changed", "The staged source records policy changed. Review it before starting a new imported agreement.", { status: 409, requestId: auth.requestId, headers: auth.headers });
      }
      importUploadDocumentId = uploadReceipt.documentId;
      importUploadExpiresAt = uploadReceipt.expiresAt;
    }
    const crmSelectionError = configuredCrmSelectionError(input.crm, auth.requestId, auth.headers);
    if (crmSelectionError) return crmSelectionError;
    const ownerUserId = input.ownerUserId ?? auth.context.user.id;
    const [ownerMember] = await db.select({
      userId: workspaceMemberships.userId,
      displayName: users.displayName,
    }).from(workspaceMemberships).innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
      eq(workspaceMemberships.workspaceId, auth.context.workspace.id),
      eq(workspaceMemberships.userId, ownerUserId),
      eq(workspaceMemberships.status, "active"),
      eq(users.status, "active"),
    )).limit(1);
    if (!ownerMember) {
      return apiError("agreement_owner_ineligible", "Select an active workspace member as agreement owner.", { status: 400, requestId: auth.requestId, headers: auth.headers });
    }
    const [[counterparty], [legalEntity], [templateVersion], [workflowDefinition]] = await Promise.all([
      input.primaryCounterpartyId
        ? db.select({ id: counterparties.id }).from(counterparties).where(and(
            eq(counterparties.workspaceId, auth.context.workspace.id),
            eq(counterparties.id, input.primaryCounterpartyId),
            eq(counterparties.status, "active"),
          )).limit(1)
        : Promise.resolve([]),
      input.legalEntityId
        ? db.select({ id: legalEntities.id }).from(legalEntities).where(and(
            eq(legalEntities.workspaceId, auth.context.workspace.id),
            eq(legalEntities.id, input.legalEntityId),
            eq(legalEntities.status, "active"),
          )).limit(1)
        : Promise.resolve([]),
      input.governedTemplateVersionId
        ? db.select({
            id: governedTemplateVersions.id,
            templateId: governedTemplateVersions.templateId,
            version: governedTemplateVersions.version,
            body: governedTemplateVersions.body,
            variableSchema: governedTemplateVersions.variableSchema,
            languageBlockIds: governedTemplateVersions.languageBlockIds,
            contentSha256: governedTemplateVersions.contentSha256,
            agreementType: governedTemplates.agreementType,
            side: governedTemplates.side,
          }).from(governedTemplateVersions).innerJoin(governedTemplates, and(
            eq(governedTemplates.workspaceId, governedTemplateVersions.workspaceId),
            eq(governedTemplates.id, governedTemplateVersions.templateId),
            eq(governedTemplates.status, "published"),
            eq(governedTemplates.currentPublishedVersion, governedTemplateVersions.version),
          )).where(and(
            eq(governedTemplateVersions.workspaceId, auth.context.workspace.id),
            eq(governedTemplateVersions.id, input.governedTemplateVersionId),
            eq(governedTemplateVersions.status, "published"),
          )).limit(1)
        : Promise.resolve([]),
      input.workflowDefinitionId
        ? db.select({
            id: workflowDefinitions.id,
            definition: workflowDefinitions.definition,
            definitionSha256: workflowDefinitions.definitionSha256,
          }).from(workflowDefinitions).where(and(
            eq(workflowDefinitions.workspaceId, auth.context.workspace.id),
            eq(workflowDefinitions.id, input.workflowDefinitionId),
            eq(workflowDefinitions.status, "published"),
          )).limit(1)
        : Promise.resolve([]),
    ]);
    if (input.primaryCounterpartyId && !counterparty) return apiError("counterparty_not_found", "Select an active counterparty from this workspace.", { status: 400, requestId: auth.requestId, headers: auth.headers });
    if (input.legalEntityId && !legalEntity) return apiError("legal_entity_not_found", "Select an active legal entity from this workspace.", { status: 400, requestId: auth.requestId, headers: auth.headers });
    if (input.governedTemplateVersionId && !templateVersion) return apiError("template_version_not_published", "Select a published governed template version from this workspace.", { status: 400, requestId: auth.requestId, headers: auth.headers });
    if (templateVersion && (templateVersion.side !== input.side || templateVersion.agreementType !== input.type)) {
      return apiError("template_agreement_mismatch", "The governed template must exactly match the selected agreement type and side.", { status: 400, requestId: auth.requestId, headers: auth.headers });
    }
    if (input.workflowDefinitionId && !workflowDefinition) return apiError("workflow_not_published", "Select a published workflow definition from this workspace.", { status: 400, requestId: auth.requestId, headers: auth.headers });
    const valueMinor = input.valueMinor ?? minorUnitsFromWholeUnits(input.value, input.currencyCode);
    const legacyValue = input.valueMinor === undefined ? input.value : wholeUnitProjection(input.valueMinor, input.currencyCode);
    let workflowPolicySnapshot: Awaited<ReturnType<typeof governedWorkflowSnapshot>> | null = null;
    if (workflowDefinition) {
      try {
        workflowPolicySnapshot = await governedWorkflowSnapshot(workflowDefinition.definition, {
          side: input.side,
          type: input.type,
          department: input.department,
          risk: "Unassessed",
          riskDisposition: null,
          value: legacyValue,
          valueMinor,
          currencyCode: input.currencyCode,
        });
      } catch (error) {
        if (error instanceof EnterpriseError) {
          return apiError(error.code, error.message, { status: error.status, requestId: auth.requestId, headers: auth.headers });
        }
        throw error;
      }
      if (workflowPolicySnapshot.policySha256 !== workflowDefinition.definitionSha256) {
        return apiError("workflow_digest_mismatch", "The published workflow no longer matches its immutable digest.", { status: 409, requestId: auth.requestId, headers: auth.headers });
      }
    }
    const now = new Date().toISOString();
    const id = serverAgreementId();
    const stage = input.creationMode === "generated" ? "Draft" : input.creationMode === "imported" ? "Review" : "Intake";
    // Pending means a durable approval request exists. Customer thresholds can
    // prompt the UI to request approval, but record creation never fabricates a
    // routed request or leaves a requester in an unowned pending state.
    // Approval requirements cannot be known until a human records a governed
    // risk decision against the immutable current paper.
    const approvalStatus = "Required";
    const nextAction = input.creationMode === "generated"
      ? "Review the generated working draft"
      : input.creationMode === "imported"
        ? "Review the imported source and prepare the working paper"
        : "Add a source document or create a working paper";
    const record: typeof agreements.$inferSelect = {
      id,
      workspaceId: auth.context.workspace.id,
      version: 1,
      party: input.party,
      initials: initials(input.party),
      side: input.side,
      type: input.type,
      value: legacyValue,
      valueMinor,
      currencyCode: input.currencyCode,
      stage,
      owner: ownerMember.displayName,
      ownerUserId,
      primaryCounterpartyId: input.primaryCounterpartyId ?? null,
      legalEntityId: input.legalEntityId ?? null,
      governedTemplateVersionId: input.governedTemplateVersionId ?? null,
      workflowDefinitionId: input.workflowDefinitionId ?? null,
      workflowPolicySha256: workflowPolicySnapshot?.policySha256 ?? null,
      workflowApprovalLanes: workflowPolicySnapshot?.approvalLanes ?? null,
      nextAction,
      due: input.due,
      crm: input.crm,
      crmRecord: input.crmRecord,
      tags: Array.from(new Set(input.tags)),
      updated: now,
      createdAt: now,
      updatedAt: now,
      createdByUserId: auth.context.user.id,
      updatedByUserId: auth.context.user.id,
      legalHold: false,
      retentionUntil: null,
      deletedAt: null,
      department: input.department,
      risk: "Unassessed",
      riskDisposition: null,
      riskBasisHash: null,
      riskDocumentVersion: null,
      riskDocumentSha256: null,
      riskDecisionReason: null,
      riskDecidedByUserId: null,
      riskDecidedAt: null,
      approvalStatus,
      signatureStatus: "Not sent",
      effectiveDate: input.effectiveDate,
      expirationDate: input.expirationDate,
    };
    const event = await prepareAgreementEvent(db, {
      workspaceId: auth.context.workspace.id,
      agreementId: id,
      type: "Created",
      detail: input.creationMode === "generated"
        ? templateVersion
          ? "Generated agreement record and durable governed-template working version 1 created."
          : "Generated agreement record and durable starter working version 1 created."
        : `${input.creationMode[0].toUpperCase()}${input.creationMode.slice(1)} agreement record created.`,
      actor: auth.context.user,
      createdAt: now,
    });
    const snapshot = await prepareAgreementSnapshot(record, auth.context.user.id, event.id);
    const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
      workspaceId: auth.context.workspace.id,
      topic: "agreement.created",
      aggregateType: "agreement",
      aggregateId: String(id),
      payload: {
        agreementId: id,
        version: record.version,
        aggregateVersion: record.version,
        causationId: auth.requestId,
        crmAgreement: crmAgreementProjection(record),
        ...(input.creationMode === "generated" ? { documentVersion: 1 } : {}),
      },
    }));
    const importReceiptGuardId = importUploadKeyDigest ? crypto.randomUUID() : null;
    const importDocumentGuardId = importUploadDocumentId ? crypto.randomUUID() : null;
    const importReservationWrites = importUploadKeyDigest && importUploadDocumentId && importUploadExpiresAt && importReceiptGuardId && importDocumentGuardId ? [
      // linkedAt first records a durable agreement-creation reservation. The
      // document-link route later binds agreementId and retains this timestamp
      // as the saga boundary for lost-response recovery.
      db.update(documentUploadReceipts).set({ linkedAt: now }).where(and(
        eq(documentUploadReceipts.workspaceId, auth.context.workspace.id),
        eq(documentUploadReceipts.userId, auth.context.user.id),
        eq(documentUploadReceipts.keyDigest, importUploadKeyDigest),
        eq(documentUploadReceipts.documentId, importUploadDocumentId),
        eq(documentUploadReceipts.expiresAt, importUploadExpiresAt),
        isNull(documentUploadReceipts.linkedAt),
        gt(documentUploadReceipts.expiresAt, now),
      )),
      db.insert(mutationGuards).values({
        id: importReceiptGuardId,
        workspaceId: auth.context.workspace.id,
        operation: "agreement.create.import_receipt_reservation",
        guardChanges: sql<number>`changes()`,
        createdAt: now,
      }),
      db.update(documents).set({
        version: sql`${documents.version} + 1`,
        legalHold: record.legalHold,
        retentionUntil: record.retentionUntil,
      }).where(and(
        eq(documents.workspaceId, auth.context.workspace.id),
        eq(documents.id, importUploadDocumentId),
        isNull(documents.agreementId),
        eq(documents.legalHold, false),
        eq(documents.retentionUntil, importUploadExpiresAt),
        isNull(documents.deletedAt),
      )),
      db.insert(mutationGuards).values({
        id: importDocumentGuardId,
        workspaceId: auth.context.workspace.id,
        operation: "agreement.create.import_document_reservation",
        guardChanges: sql<number>`changes()`,
        createdAt: now,
      }),
    ] : [];
    const importReservationRelease = importReceiptGuardId && importDocumentGuardId ? [
      db.delete(mutationGuards).where(and(
        eq(mutationGuards.workspaceId, auth.context.workspace.id),
        inArray(mutationGuards.id, [importReceiptGuardId, importDocumentGuardId]),
      )),
    ] : [];
    let documentVersion: typeof agreementDocumentVersions.$inferInsert | null = null;
    if (input.creationMode === "generated") {
      let content: string;
      try {
        content = templateVersion
          ? await renderGovernedTemplate({
              body: templateVersion.body,
              variableSchema: templateVersion.variableSchema,
              languageBlockIds: templateVersion.languageBlockIds,
              contentSha256: templateVersion.contentSha256,
              organization: auth.context.workspace.name,
              agreementVariables: {
                party: input.party,
                side: input.side,
                type: input.type,
                effectiveDate: input.effectiveDate,
                expirationDate: input.expirationDate,
                governingLaw: input.governingLaw,
                due: input.due,
                department: input.department,
                currencyCode: input.currencyCode,
              },
              templateVariables: input.templateVariables,
            })
          : assembleStarterDraft({
              organization: auth.context.workspace.name,
              party: input.party,
              side: input.side,
              type: input.type,
              effectiveDate: input.effectiveDate,
              governingLaw: input.governingLaw,
            });
      } catch (error) {
        if (error instanceof GovernedTemplateRuntimeError) {
          return apiError(error.code, error.message, { status: error.status, requestId: auth.requestId, headers: auth.headers });
        }
        throw error;
      }
      const bytes = new TextEncoder().encode(content);
      const versionId = crypto.randomUUID();
      const sha256 = await sha256Hex(bytes);
      generatedObjectKey = `workspaces/${auth.context.workspace.id}/agreements/${id}/versions/1/${versionId}.txt`;
      stagedGeneratedVersion = { workspaceId: auth.context.workspace.id, id: versionId, objectKey: generatedObjectKey, sha256 };
      await (env as unknown as AgreementEnv).DOCUMENTS.put(generatedObjectKey, bytes, {
        httpMetadata: { contentType: "text/plain" },
        customMetadata: templateVersion
          ? { agreementId: String(id), version: "1", sha256, source: "governed-template", governedTemplateVersionId: templateVersion.id }
          : { agreementId: String(id), version: "1", sha256, source: "repository-starter" },
      });
      documentVersion = {
        id: versionId,
        workspaceId: auth.context.workspace.id,
        agreementId: id,
        version: 1,
        label: templateVersion ? `Generated governed template v${templateVersion.version}` : "Generated starter working draft",
        objectKey: generatedObjectKey,
        contentType: "text/plain",
        size: bytes.byteLength,
        sha256,
        sourceDocumentId: null,
        createdByUserId: auth.context.user.id,
        createdAt: now,
      };
    }
    if (documentVersion) {
      await db.batch([
        db.insert(agreements).values(record),
        ...importReservationWrites,
        db.insert(agreementCreationReceipts).values({
          workspaceId: auth.context.workspace.id,
          userId: auth.context.user.id,
          idempotencyKey: creationIdempotencyKey,
          requestSha256: creationRequestSha256,
          creationMode: input.creationMode,
          agreementId: id,
          createdAt: now,
        }),
        db.insert(agreementDocumentVersions).values(documentVersion),
        db.insert(agreementEvents).values(event),
        db.insert(agreementVersions).values(snapshot),
        db.insert(outboxEvents).values(outbox),
        ...importReservationRelease,
      ]);
    } else {
      await db.batch([
        db.insert(agreements).values(record),
        ...importReservationWrites,
        db.insert(agreementCreationReceipts).values({
          workspaceId: auth.context.workspace.id,
          userId: auth.context.user.id,
          idempotencyKey: creationIdempotencyKey,
          requestSha256: creationRequestSha256,
          creationMode: input.creationMode,
          agreementId: id,
          createdAt: now,
        }),
        db.insert(agreementEvents).values(event),
        db.insert(agreementVersions).values(snapshot),
        db.insert(outboxEvents).values(outbox),
        ...importReservationRelease,
      ]);
    }
    stagedGeneratedVersion = null;
    generatedObjectKey = null;
    const safeDocumentVersion = documentVersion ? {
      id: documentVersion.id,
      agreementId: documentVersion.agreementId,
      version: documentVersion.version,
      label: documentVersion.label,
      contentType: documentVersion.contentType,
      size: documentVersion.size,
      sha256: documentVersion.sha256,
      sourceDocumentId: documentVersion.sourceDocumentId,
      createdByUserId: documentVersion.createdByUserId,
      createdAt: documentVersion.createdAt,
    } : null;
    const creationHeaders = new Headers(auth.headers);
    creationHeaders.set("Idempotency-Replayed", "false");
    return apiJson({ agreement: record, documentVersion: safeDocumentVersion, event, replay: false, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: creationHeaders });
  } catch (error) {
    if (stagedGeneratedVersion) {
      try {
        await cleanupStagedWorkingVersionObject(getDb(), (env as unknown as AgreementEnv).DOCUMENTS, stagedGeneratedVersion);
      } catch {
        // An unavailable D1 binding is an unknown commit state. Retain R2 for reconciliation.
      }
    }
    if (creationDb && creationIdempotencyKey && creationRequestSha256) {
      try {
        const replay = await replayAgreementCreation(creationDb, {
          workspaceId: auth.context.workspace.id,
          userId: auth.context.user.id,
          idempotencyKey: creationIdempotencyKey,
          requestSha256: creationRequestSha256,
          requestId: auth.requestId,
          headers: auth.headers,
        });
        if (replay) return replay;
      } catch {
        // Preserve the original creation failure when receipt reconciliation is unavailable.
      }
    }
    return handleRouteError(error, auth.requestId, "Agreement could not be created.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:update", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    await ensureStorageSchema();
    const input = await parseJson(request, agreementDetailsPatchSchema);
    const db = getDb();
    const current = await findActiveAgreement(db, auth.context.workspace.id, input.id);
    if (!current) return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId: auth.requestId });
    if (current.version !== input.version) {
      return apiError("version_conflict", "This agreement changed after it was opened. Reload it before saving.", { status: 409, requestId: auth.requestId });
    }

    const { id, version, ...requestedChanges } = input;
    let changes = effectiveAgreementChanges(current, requestedChanges);
    if (changes.owner !== undefined && changes.ownerUserId === undefined) {
      return apiError("owner_user_id_required", "Select an eligible workspace member instead of entering an owner name.", { status: 400, requestId: auth.requestId });
    }
    if (changes.ownerUserId !== undefined) {
      if (changes.ownerUserId === null) {
        changes = { ...changes, owner: "Unassigned" };
      } else {
        const [ownerMember] = await db.select({ displayName: users.displayName }).from(workspaceMemberships)
          .innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
            eq(workspaceMemberships.workspaceId, auth.context.workspace.id),
            eq(workspaceMemberships.userId, changes.ownerUserId),
            eq(workspaceMemberships.status, "active"),
            eq(users.status, "active"),
          )).limit(1);
        if (!ownerMember) return apiError("agreement_owner_ineligible", "Select an active workspace member as agreement owner.", { status: 400, requestId: auth.requestId });
        changes = { ...changes, owner: ownerMember.displayName };
      }
    }
    const nextCurrencyCode = changes.currencyCode ?? current.currencyCode;
    if (changes.valueMinor !== undefined) {
      changes = { ...changes, value: wholeUnitProjection(changes.valueMinor, nextCurrencyCode) };
    } else if (changes.value !== undefined) {
      changes = { ...changes, valueMinor: minorUnitsFromWholeUnits(changes.value, nextCurrencyCode) };
    } else if (changes.currencyCode !== undefined) {
      changes = { ...changes, value: wholeUnitProjection(current.valueMinor, nextCurrencyCode) };
    }
    const nextWorkflowDefinitionId = changes.workflowDefinitionId === undefined
      ? current.workflowDefinitionId
      : changes.workflowDefinitionId;
    const nextGovernedTemplateVersionId = changes.governedTemplateVersionId === undefined
      ? current.governedTemplateVersionId
      : changes.governedTemplateVersionId;
    const referenceChecks = await Promise.all([
      changes.primaryCounterpartyId
        ? db.select({ id: counterparties.id }).from(counterparties).where(and(
            eq(counterparties.workspaceId, auth.context.workspace.id),
            eq(counterparties.id, changes.primaryCounterpartyId),
            eq(counterparties.status, "active"),
          )).limit(1)
        : Promise.resolve(changes.primaryCounterpartyId === undefined || changes.primaryCounterpartyId === null ? [{ id: "none" }] : []),
      changes.legalEntityId
        ? db.select({ id: legalEntities.id }).from(legalEntities).where(and(
            eq(legalEntities.workspaceId, auth.context.workspace.id),
            eq(legalEntities.id, changes.legalEntityId),
            eq(legalEntities.status, "active"),
          )).limit(1)
        : Promise.resolve(changes.legalEntityId === undefined || changes.legalEntityId === null ? [{ id: "none" }] : []),
      nextGovernedTemplateVersionId
        ? db.select({
            id: governedTemplateVersions.id,
            version: governedTemplateVersions.version,
            agreementType: governedTemplates.agreementType,
            side: governedTemplates.side,
          }).from(governedTemplateVersions).innerJoin(governedTemplates, and(
            eq(governedTemplates.workspaceId, governedTemplateVersions.workspaceId),
            eq(governedTemplates.id, governedTemplateVersions.templateId),
            changes.governedTemplateVersionId !== undefined
              ? and(
                  eq(governedTemplates.status, "published"),
                  eq(governedTemplates.currentPublishedVersion, governedTemplateVersions.version),
                )
              : inArray(governedTemplates.status, ["published", "retired"]),
          )).where(and(
            eq(governedTemplateVersions.workspaceId, auth.context.workspace.id),
            eq(governedTemplateVersions.id, nextGovernedTemplateVersionId),
            changes.governedTemplateVersionId !== undefined
              ? eq(governedTemplateVersions.status, "published")
              : inArray(governedTemplateVersions.status, ["published", "retired"]),
          )).limit(1)
        : Promise.resolve([{ id: "none", version: 0, agreementType: "", side: "" }]),
      nextWorkflowDefinitionId
        ? db.select({
            id: workflowDefinitions.id,
            definition: workflowDefinitions.definition,
            definitionSha256: workflowDefinitions.definitionSha256,
          }).from(workflowDefinitions).where(and(
            eq(workflowDefinitions.workspaceId, auth.context.workspace.id),
            eq(workflowDefinitions.id, nextWorkflowDefinitionId),
            changes.workflowDefinitionId !== undefined
              ? eq(workflowDefinitions.status, "published")
              : inArray(workflowDefinitions.status, ["published", "retired"]),
          )).limit(1)
        : Promise.resolve([{ id: "none", definition: null, definitionSha256: null }]),
    ]);
    if (referenceChecks.some((rows) => rows.length === 0)) {
      return apiError("agreement_reference_invalid", "One or more selected enterprise records are not active in this workspace.", { status: 400, requestId: auth.requestId });
    }
    const nextTemplateVersion = nextGovernedTemplateVersionId
      ? referenceChecks[2]?.[0] as { agreementType: string; side: string } | undefined
      : undefined;
    if (
      nextTemplateVersion
      && (
        nextTemplateVersion.side !== (changes.side ?? current.side)
        || nextTemplateVersion.agreementType !== (changes.type ?? current.type)
      )
    ) {
      return apiError("template_agreement_mismatch", "The governed template must exactly match the selected agreement type and side.", { status: 400, requestId: auth.requestId });
    }
    const changedFields = Object.keys(changes).sort();
    if (changedFields.length === 0) {
      return apiJson(
        { agreement: current, event: null, unchanged: true, requestId: auth.requestId },
        { requestId: auth.requestId, headers: auth.headers },
      );
    }
    if (changes.crm !== undefined) {
      const crmSelectionError = configuredCrmSelectionError(changes.crm, auth.requestId, auth.headers);
      if (crmSelectionError) return crmSelectionError;
    }
    const dateTerm = validateAgreementDatePair({
      effectiveDate: changes.effectiveDate ?? current.effectiveDate,
      expirationDate: changes.expirationDate ?? current.expirationDate,
    }, { allowEmpty: true });
    if (!dateTerm.valid) {
      return apiError("invalid_agreement_term", dateTerm.issues[0]?.message ?? "Agreement dates are invalid.", { status: 400, requestId: auth.requestId });
    }
    const now = new Date().toISOString();
    const materialChange = changedFields.some((field) => MATERIAL_APPROVAL_FIELDS.has(field));
    if (materialChange && (current.stage === "Active" || current.signatureStatus === "Completed")) {
      return apiError("executed_agreement_immutable", "Material fields on an executed agreement are immutable. Create an amendment or replacement agreement.", { status: 409, requestId: auth.requestId });
    }
    if (materialChange) {
      const [[activePacket], [activeNegotiationRound]] = await Promise.all([
        db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
          eq(signaturePackets.workspaceId, auth.context.workspace.id),
          eq(signaturePackets.agreementId, id),
          inArray(signaturePackets.status, ["creating", "pending", "partially_signed", "reconciling", "archived", "completed_review_required"]),
        )).limit(1),
        db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
          eq(negotiationRounds.workspaceId, auth.context.workspace.id),
          eq(negotiationRounds.agreementId, id),
          isNotNull(negotiationRounds.activeKey),
        )).limit(1),
      ]);
      if (activePacket) return apiError("signature_packet_active", "Cancel or resolve the active signature packet before changing material agreement fields.", { status: 409, requestId: auth.requestId });
      if (activeNegotiationRound) return apiError("negotiation_round_unresolved", "Resolve or close the current counterparty review round before changing material agreement fields.", { status: 409, requestId: auth.requestId });
    }
    const invalidatesApprovals = materialChange;
    let workflowPolicyPatch: Readonly<{ workflowPolicySha256: string | null; workflowApprovalLanes: string[] | null }> | null = null;
    if (materialChange) {
      const workflowDefinition = nextWorkflowDefinitionId
        ? referenceChecks[3]?.[0] as { id: string; definition: unknown; definitionSha256: string } | undefined
        : undefined;
      if (workflowDefinition) {
        try {
          const snapshot = await governedWorkflowSnapshot(workflowDefinition.definition, {
            ...current,
            ...changes,
            risk: "Unassessed",
            riskDisposition: null,
          });
          if (snapshot.policySha256 !== workflowDefinition.definitionSha256) {
            return apiError("workflow_digest_mismatch", "The governed workflow no longer matches its immutable digest.", { status: 409, requestId: auth.requestId, headers: auth.headers });
          }
          workflowPolicyPatch = { workflowPolicySha256: snapshot.policySha256, workflowApprovalLanes: snapshot.approvalLanes };
        } catch (error) {
          if (error instanceof EnterpriseError) {
            return apiError(error.code, error.message, { status: error.status, requestId: auth.requestId, headers: auth.headers });
          }
          throw error;
        }
      } else {
        workflowPolicyPatch = { workflowPolicySha256: null, workflowApprovalLanes: null };
      }
    }
    const patch = {
      ...changes,
      ...(workflowPolicyPatch ?? {}),
      ...(changes.party ? { initials: initials(changes.party) } : {}),
      ...(invalidatesApprovals ? {
        approvalStatus: "Required",
        stage: current.stage === "Signature" ? "Negotiation" : current.stage,
        signatureStatus: "Not sent",
        nextAction: "Assess risk for the updated agreement",
        risk: "Unassessed",
        riskDisposition: null,
        riskBasisHash: null,
        riskDocumentVersion: null,
        riskDocumentSha256: null,
        riskDecisionReason: null,
        riskDecidedByUserId: null,
        riskDecidedAt: null,
      } : {}),
      version: version + 1,
      updated: now,
      updatedAt: now,
      updatedByUserId: auth.context.user.id,
    };
    const saved: typeof agreements.$inferSelect = { ...current, ...patch };
    const event = await prepareAgreementEvent(db, {
      workspaceId: auth.context.workspace.id,
      agreementId: id,
      type: "Updated",
      detail: `Updated ${changedFields.join(", ")}.${invalidatesApprovals ? " Prior approvals were superseded because material agreement terms changed." : ""}`,
      actor: auth.context.user,
      createdAt: now,
    });
    const snapshot = await prepareAgreementSnapshot(saved, auth.context.user.id, event.id);
    const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
      workspaceId: auth.context.workspace.id,
      topic: "agreement.updated",
      aggregateType: "agreement",
      aggregateId: String(id),
      payload: {
        agreementId: id,
        version: saved.version,
        changedFields,
        aggregateVersion: saved.version,
        causationId: auth.requestId,
        crmAgreement: crmAgreementProjection(saved),
      },
    }));
    const outboxRows: Array<typeof outboxEvents.$inferInsert> = [outbox];
    if (current.crm !== saved.crm && current.crm !== "None") {
      outboxRows.push(prepareOutboxEvent(prepareAgreementDeletedIntegrationEvent({
        agreement: { ...saved, crm: current.crm, crmRecord: current.crmRecord },
        deletedAt: now,
        causationId: auth.requestId,
      })));
    }
    const guardId = crypto.randomUUID();
    const [result] = await db.batch([db.update(agreements).set(patch).where(and(
      eq(agreements.workspaceId, auth.context.workspace.id),
      eq(agreements.id, id),
      eq(agreements.version, version),
      // Negotiation projects nextAction without advancing the governed content
      // version. Fence that server-owned projection too, otherwise this PATCH
      // could snapshot and return the stale queue value it read before a
      // concurrent round update.
      eq(agreements.nextAction, current.nextAction),
      isNull(agreements.deletedAt),
      ...(materialChange ? [
        notExists(db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
          eq(signaturePackets.workspaceId, auth.context.workspace.id),
          eq(signaturePackets.agreementId, id),
          inArray(signaturePackets.status, ["creating", "pending", "partially_signed", "reconciling", "archived", "completed_review_required"]),
        ))),
        notExists(db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
          eq(negotiationRounds.workspaceId, auth.context.workspace.id),
          eq(negotiationRounds.agreementId, id),
          isNotNull(negotiationRounds.activeKey),
        ))),
      ] : []),
    )), db.insert(mutationGuards).values({ id: guardId, workspaceId: auth.context.workspace.id, operation: "agreement.update", guardChanges: sql<number>`changes()`, createdAt: now }), db.update(approvalRequests).set({ status: "Superseded", version: sql`${approvalRequests.version} + 1` }).where(and(
      eq(approvalRequests.workspaceId, auth.context.workspace.id),
      eq(approvalRequests.agreementId, id),
      inArray(approvalRequests.status, ["Pending", "Approved", "Changes requested"]),
      ...(invalidatesApprovals ? [] : [sql`0 = 1`]),
    )), db.insert(agreementEvents).values(event), db.insert(agreementVersions).values(snapshot), db.insert(outboxEvents).values(outboxRows), db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, auth.context.workspace.id), eq(mutationGuards.id, guardId)))]);
    if (!result.meta.changes) return apiError("version_conflict", "This agreement changed after it was opened. Reload it before saving.", { status: 409, requestId: auth.requestId });
    return apiJson({ agreement: saved, event, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    if (isMutationGuardConflict(error)) {
      return apiError("version_conflict", "This agreement or its active workflow changed while it was being saved. Reload before retrying.", { status: 409, requestId: auth.requestId });
    }
    return handleRouteError(error, auth.requestId, "Agreement could not be saved.");
  }
}

export async function DELETE(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:update", { limit: 20 });
  if (!auth.ok) return auth.response;
  try {
    await ensureStorageSchema();
    const input = await parseJson(request, deleteSchema, 16_000);
    const db = getDb();
    const current = await findActiveAgreement(db, auth.context.workspace.id, input.id);
    if (!current) return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId: auth.requestId });
    if (current.legalHold) return apiError("legal_hold", "This agreement is under legal hold and cannot be deleted.", { status: 409, requestId: auth.requestId });
    if (current.version !== input.version) return apiError("version_conflict", "Reload the agreement before deleting it.", { status: 409, requestId: auth.requestId });
    const [[activeNegotiation], [activeSignaturePacket]] = await Promise.all([
      db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
        eq(negotiationRounds.workspaceId, auth.context.workspace.id),
        eq(negotiationRounds.agreementId, input.id),
        isNotNull(negotiationRounds.activeKey),
      )).limit(1),
      db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
        eq(signaturePackets.workspaceId, auth.context.workspace.id),
        eq(signaturePackets.agreementId, input.id),
        inArray(signaturePackets.status, ["creating", "pending", "partially_signed", "reconciling", "archived", "completed_review_required"]),
      )).limit(1),
    ]);
    if (activeNegotiation) {
      return apiError(
        "negotiation_round_unresolved",
        "Close or resolve the active counterparty negotiation round before deleting this agreement.",
        { status: 409, requestId: auth.requestId, headers: auth.headers },
      );
    }
    if (activeSignaturePacket) {
      return apiError(
        "signature_packet_active",
        "Resolve or cancel the active signature packet before deleting this agreement.",
        { status: 409, requestId: auth.requestId, headers: auth.headers },
      );
    }

    const now = new Date().toISOString();
    const event = await prepareAgreementEvent(db, {
      workspaceId: auth.context.workspace.id,
      agreementId: input.id,
      type: "Deleted",
      detail: "Agreement record was soft-deleted under the configured retention policy.",
      actor: auth.context.user,
      createdAt: now,
    });
    const deletedAgreement: typeof agreements.$inferSelect = {
      ...current,
      deletedAt: now,
      updatedAt: now,
      updatedByUserId: auth.context.user.id,
      version: input.version + 1,
    };
    const snapshot = await prepareAgreementSnapshot(deletedAgreement, auth.context.user.id, event.id);
    const outbox = prepareOutboxEvent(prepareAgreementDeletedIntegrationEvent({
      agreement: deletedAgreement,
      deletedAt: now,
      causationId: auth.requestId,
    }));
    const guardId = crypto.randomUUID();
    const [result] = await db.batch([db.update(agreements).set({ deletedAt: now, updatedAt: now, updatedByUserId: auth.context.user.id, version: input.version + 1 }).where(and(
      eq(agreements.workspaceId, auth.context.workspace.id),
      eq(agreements.id, input.id),
      eq(agreements.version, input.version),
      eq(agreements.nextAction, current.nextAction),
      isNull(agreements.deletedAt),
      notExists(db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
        eq(negotiationRounds.workspaceId, auth.context.workspace.id),
        eq(negotiationRounds.agreementId, input.id),
        isNotNull(negotiationRounds.activeKey),
      ))),
      notExists(db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
        eq(signaturePackets.workspaceId, auth.context.workspace.id),
        eq(signaturePackets.agreementId, input.id),
        inArray(signaturePackets.status, ["creating", "pending", "partially_signed", "reconciling", "archived", "completed_review_required"]),
      ))),
    )), db.insert(mutationGuards).values({ id: guardId, workspaceId: auth.context.workspace.id, operation: "agreement.delete", guardChanges: sql<number>`changes()`, createdAt: now }), db.insert(agreementEvents).values(event), db.insert(agreementVersions).values(snapshot), db.insert(outboxEvents).values(outbox), db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, auth.context.workspace.id), eq(mutationGuards.id, guardId)))]);
    if (!result.meta.changes) return apiError("version_conflict", "Reload the agreement before deleting it.", { status: 409, requestId: auth.requestId });
    return apiJson({ deleted: true, agreement: deletedAgreement, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    if (isMutationGuardConflict(error)) {
      return apiError("version_conflict", "The agreement or an active workflow changed before deletion. Reload before retrying.", { status: 409, requestId: auth.requestId });
    }
    return handleRouteError(error, auth.requestId, "Agreement could not be deleted.");
  }
}
