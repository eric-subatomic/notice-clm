import {
  and,
  asc,
  desc,
  eq,
  isNull,
  lte,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { getDb } from "../../../db";
import { ensureStorageSchema } from "../../../db/ensure";
import {
  agreementEvents,
  agreements,
  approvalRequests,
  obligationSchedules,
  obligations,
  signaturePackets,
} from "../../../db/schema";
import { authorizeApiRequest, handleRouteError, type AuthorizedApiRequest } from "../../lib/api";
import { apiError, apiJson } from "../../lib/http";
import { sanitizeSignaturePacket } from "../../lib/signature-evidence";
import {
  boundedWorkItemCount,
  decodeWorkItemCursor,
  encodeWorkItemCursor,
  escapedWorkItemPattern,
  isWorkItemResource,
  parseWorkItemQuery,
  permissionForWorkItemResource,
  statusesForWorkItemResource,
  workItemCursorBinding,
  WorkItemQueryError,
  type WorkItemCursorPayload,
  type WorkItemQuery,
  type WorkItemSort,
} from "../../lib/work-item-pagination";

type Database = ReturnType<typeof getDb>;
type AuthorizedRequest = AuthorizedApiRequest;
type StatusCountRow = Readonly<{ status: string; count: unknown }>;

const agreementProjection = {
  id: agreements.id,
  version: agreements.version,
  party: agreements.party,
  type: agreements.type,
  owner: agreements.owner,
  ownerUserId: agreements.ownerUserId,
  stage: agreements.stage,
  risk: agreements.risk,
  side: agreements.side,
  value: agreements.value,
} as const;

const approvalRowId = sql<number>`approval_requests.rowid`;
const signatureRowId = sql<number>`signature_packets.rowid`;
const obligationRowId = sql<number>`obligations.rowid`;
const scheduleRowId = sql<number>`obligation_schedules.rowid`;
const eventRowId = sql<number>`agreement_events.rowid`;

function activeAgreementJoin(sourceWorkspaceId: SQLWrapper, sourceAgreementId: SQLWrapper) {
  return and(
    sql`${agreements.workspaceId} = ${sourceWorkspaceId}`,
    sql`${agreements.id} = ${sourceAgreementId}`,
    isNull(agreements.deletedAt),
  );
}

function activeAgreementScope(workspaceId: string): SQL[] {
  return [eq(agreements.workspaceId, workspaceId), isNull(agreements.deletedAt)];
}

function textSearch(pattern: string | null, fields: readonly SQLWrapper[]): SQL | undefined {
  if (pattern === null) return undefined;
  return or(...fields.map((field) => sql`lower(${field}) like ${pattern} escape '\\'`));
}

function agreementFilter(query: WorkItemQuery): SQL | undefined {
  return query.agreementId === null ? undefined : eq(agreements.id, query.agreementId);
}

function ownerFilter(
  query: WorkItemQuery,
  auth: AuthorizedRequest,
  ownerUserId: SQLWrapper | null,
  ownerName: SQLWrapper,
): SQL | undefined {
  if (query.owner === null) return undefined;
  if (query.owner === "unassigned") return ownerUserId === null ? sql`0 = 1` : sql`${ownerUserId} is null`;
  const userId = query.owner === "me" ? auth.context.user.id : query.owner;
  const displayName = query.owner === "me" ? auth.context.user.displayName : query.owner;
  return ownerUserId === null
    ? sql`lower(${ownerName}) = ${displayName.toLocaleLowerCase("en-US")}`
    : or(
        sql`${ownerUserId} = ${userId}`,
        and(
          sql`${ownerUserId} is null`,
          sql`lower(${ownerName}) = ${displayName.toLocaleLowerCase("en-US")}`,
        ),
      );
}

function isDescending(sort: WorkItemSort): boolean {
  return sort === "newest" || sort === "due_desc" || sort === "updated_desc" || sort === "next_due_desc";
}

function cursorCondition(
  sortKey: SQLWrapper,
  id: SQLWrapper,
  sort: WorkItemSort,
  cursor: WorkItemCursorPayload | null,
): SQL | undefined {
  if (cursor === null) return undefined;
  return isDescending(sort)
    ? or(
        sql`${sortKey} < ${cursor.k}`,
        and(sql`${sortKey} = ${cursor.k}`, sql`${id} < ${cursor.i}`),
      )
    : or(
        sql`${sortKey} > ${cursor.k}`,
        and(sql`${sortKey} = ${cursor.k}`, sql`${id} > ${cursor.i}`),
      );
}

function workItemOrder(sortKey: SQLWrapper, id: SQLWrapper, sort: WorkItemSort) {
  return isDescending(sort) ? [desc(sortKey), desc(id)] as const : [asc(sortKey), asc(id)] as const;
}

function statusSummary(resource: WorkItemQuery["resource"], rows: readonly StatusCountRow[]) {
  const allowed = statusesForWorkItemResource(resource);
  const byStatus = new Map(rows.map((row) => [row.status, boundedWorkItemCount(row.count)]));
  const known = allowed.map((status) => {
    const value = byStatus.get(status) ?? { count: 0, capped: false };
    return Object.freeze({ status, count: value.count, capped: value.capped });
  });
  let otherCount = 0;
  let otherCapped = false;
  for (const [status, value] of byStatus) {
    if (allowed.includes(status)) continue;
    const combined = boundedWorkItemCount(otherCount + value.count);
    otherCount = combined.count;
    otherCapped ||= value.capped || combined.capped;
  }
  return Object.freeze(otherCount > 0 || otherCapped
    ? [...known, Object.freeze({ status: "__other__", count: otherCount, capped: otherCapped })]
    : known);
}

async function nextCursor(
  binding: string,
  anchor: number,
  snapshotAt: string,
  last: Readonly<{ id: string; sortKey: string }> | undefined,
  hasMore: boolean,
): Promise<string | null> {
  if (!hasMore || !last) return null;
  return encodeWorkItemCursor({
    v: 1,
    b: binding,
    a: anchor,
    s: snapshotAt,
    k: last.sortKey,
    i: last.id,
  });
}

async function pagedResponse(
  auth: AuthorizedRequest,
  query: WorkItemQuery,
  binding: string,
  anchor: number,
  snapshotAt: string,
  rows: readonly Readonly<{ id: string; sortKey: string; item: unknown }>[],
  totalValue: unknown,
  statusRows: readonly StatusCountRow[],
) {
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const total = boundedWorkItemCount(totalValue);
  return apiJson({
    resource: query.resource,
    items: page.map((row) => row.item),
    page: {
      limit: query.limit,
      hasMore,
      nextCursor: await nextCursor(binding, anchor, snapshotAt, page.at(-1), hasMore),
      snapshotAt,
    },
    summary: {
      totalMatched: total.count,
      totalMatchedCapped: total.capped,
      statusCounts: statusSummary(query.resource, statusRows),
    },
    requestId: auth.requestId,
  }, { requestId: auth.requestId, headers: auth.headers });
}

async function approvalPage(
  db: Database,
  auth: AuthorizedRequest,
  query: WorkItemQuery,
  binding: string,
  cursor: WorkItemCursorPayload | null,
) {
  const pattern = query.q === null ? null : escapedWorkItemPattern(query.q);
  const withoutStatus = [
    eq(approvalRequests.workspaceId, auth.context.workspace.id),
    ...activeAgreementScope(auth.context.workspace.id),
    agreementFilter(query),
    ownerFilter(query, auth, approvalRequests.approverUserId, approvalRequests.approver),
    textSearch(pattern, [
      approvalRequests.role,
      approvalRequests.approver,
      approvalRequests.due,
      agreements.party,
      agreements.type,
      agreements.owner,
    ]),
  ];
  const [snapshot] = cursor === null ? await db.select({ anchor: sql<number>`coalesce(max(${approvalRowId}), 0)` })
    .from(approvalRequests)
    .innerJoin(agreements, activeAgreementJoin(approvalRequests.workspaceId, approvalRequests.agreementId))
    .where(and(...withoutStatus)) : [{ anchor: cursor.a }];
  const anchor = Number(snapshot?.anchor ?? 0);
  if (!Number.isSafeInteger(anchor) || anchor < 0) throw new Error("Approval queue snapshot anchor is invalid");
  const snapshotAt = cursor?.s ?? new Date().toISOString();
  const anchored = [...withoutStatus, lte(approvalRequests.createdAt, snapshotAt), lte(approvalRowId, anchor)];
  const filters = [...anchored, query.status === null ? undefined : eq(approvalRequests.status, query.status)];
  const sortKey = query.sort === "due_asc" || query.sort === "due_desc" ? approvalRequests.due : approvalRequests.createdAt;
  const [[total], statusRows, selected] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(approvalRequests)
      .innerJoin(agreements, activeAgreementJoin(approvalRequests.workspaceId, approvalRequests.agreementId)).where(and(...filters)),
    db.select({ status: approvalRequests.status, count: sql<number>`count(*)` }).from(approvalRequests)
      .innerJoin(agreements, activeAgreementJoin(approvalRequests.workspaceId, approvalRequests.agreementId))
      .where(and(...anchored)).groupBy(approvalRequests.status),
    db.select({
      id: approvalRequests.id,
      sortKey,
      approval: {
        id: approvalRequests.id,
        version: approvalRequests.version,
        agreementId: approvalRequests.agreementId,
        basisHash: approvalRequests.basisHash,
        documentVersion: approvalRequests.documentVersion,
        documentSha256: approvalRequests.documentSha256,
        role: approvalRequests.role,
        requestedByUserId: approvalRequests.requestedByUserId,
        approver: approvalRequests.approver,
        approverUserId: approvalRequests.approverUserId,
        status: approvalRequests.status,
        decidedByUserId: approvalRequests.decidedByUserId,
        decidedAt: approvalRequests.decidedAt,
        basisConfirmedAt: approvalRequests.basisConfirmedAt,
        comment: approvalRequests.comment,
        due: approvalRequests.due,
        createdAt: approvalRequests.createdAt,
      },
      agreement: agreementProjection,
    }).from(approvalRequests)
      .innerJoin(agreements, activeAgreementJoin(approvalRequests.workspaceId, approvalRequests.agreementId))
      .where(and(...filters, cursorCondition(sortKey, approvalRequests.id, query.sort, cursor)))
      .orderBy(...workItemOrder(sortKey, approvalRequests.id, query.sort)).limit(query.limit + 1),
  ]);
  return pagedResponse(auth, query, binding, anchor, snapshotAt, selected.map((row) => ({
    id: row.id,
    sortKey: row.sortKey,
    item: { ...row.approval, agreement: row.agreement },
  })), total?.count, statusRows);
}

async function signaturePage(
  db: Database,
  auth: AuthorizedRequest,
  query: WorkItemQuery,
  binding: string,
  cursor: WorkItemCursorPayload | null,
) {
  const pattern = query.q === null ? null : escapedWorkItemPattern(query.q);
  const withoutStatus = [
    eq(signaturePackets.workspaceId, auth.context.workspace.id),
    ...activeAgreementScope(auth.context.workspace.id),
    agreementFilter(query),
    ownerFilter(query, auth, agreements.ownerUserId, agreements.owner),
    textSearch(pattern, [
      signaturePackets.provider,
      agreements.party,
      agreements.type,
      agreements.owner,
    ]),
  ];
  const [snapshot] = cursor === null ? await db.select({ anchor: sql<number>`coalesce(max(${signatureRowId}), 0)` })
    .from(signaturePackets)
    .innerJoin(agreements, activeAgreementJoin(signaturePackets.workspaceId, signaturePackets.agreementId))
    .where(and(...withoutStatus)) : [{ anchor: cursor.a }];
  const anchor = Number(snapshot?.anchor ?? 0);
  if (!Number.isSafeInteger(anchor) || anchor < 0) throw new Error("Signature queue snapshot anchor is invalid");
  const snapshotAt = cursor?.s ?? new Date().toISOString();
  const anchored = [...withoutStatus, lte(signaturePackets.createdAt, snapshotAt), lte(signatureRowId, anchor)];
  const filters = [...anchored, query.status === null ? undefined : eq(signaturePackets.status, query.status)];
  const sortKey = query.sort === "newest" || query.sort === "oldest" ? signaturePackets.createdAt : signaturePackets.updatedAt;
  const [[total], statusRows, selected] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(signaturePackets)
      .innerJoin(agreements, activeAgreementJoin(signaturePackets.workspaceId, signaturePackets.agreementId)).where(and(...filters)),
    db.select({ status: signaturePackets.status, count: sql<number>`count(*)` }).from(signaturePackets)
      .innerJoin(agreements, activeAgreementJoin(signaturePackets.workspaceId, signaturePackets.agreementId))
      .where(and(...anchored)).groupBy(signaturePackets.status),
    db.select({
      id: signaturePackets.id,
      sortKey,
      packet: {
        id: signaturePackets.id,
        agreementId: signaturePackets.agreementId,
        basisHash: signaturePackets.basisHash,
        documentVersion: signaturePackets.documentVersion,
        documentSha256: signaturePackets.documentSha256,
        provider: signaturePackets.provider,
        status: signaturePackets.status,
        signers: signaturePackets.signers,
        evidenceDocumentId: signaturePackets.evidenceDocumentId,
        version: signaturePackets.version,
        createdAt: signaturePackets.createdAt,
        updatedAt: signaturePackets.updatedAt,
        completedAt: signaturePackets.completedAt,
      },
      agreement: agreementProjection,
    }).from(signaturePackets)
      .innerJoin(agreements, activeAgreementJoin(signaturePackets.workspaceId, signaturePackets.agreementId))
      .where(and(...filters, cursorCondition(sortKey, signaturePackets.id, query.sort, cursor)))
      .orderBy(...workItemOrder(sortKey, signaturePackets.id, query.sort)).limit(query.limit + 1),
  ]);
  return pagedResponse(auth, query, binding, anchor, snapshotAt, selected.map((row) => ({
    id: row.id,
    sortKey: row.sortKey,
    item: { ...sanitizeSignaturePacket(row.packet), agreement: row.agreement },
  })), total?.count, statusRows);
}

async function obligationPage(
  db: Database,
  auth: AuthorizedRequest,
  query: WorkItemQuery,
  binding: string,
  cursor: WorkItemCursorPayload | null,
) {
  const pattern = query.q === null ? null : escapedWorkItemPattern(query.q);
  const withoutStatus = [
    eq(obligations.workspaceId, auth.context.workspace.id),
    ...activeAgreementScope(auth.context.workspace.id),
    agreementFilter(query),
    ownerFilter(query, auth, obligations.ownerUserId, obligations.owner),
    textSearch(pattern, [
      obligations.title,
      obligations.source,
      obligations.owner,
      agreements.party,
      agreements.type,
      agreements.owner,
    ]),
  ];
  const [snapshot] = cursor === null ? await db.select({ anchor: sql<number>`coalesce(max(${obligationRowId}), 0)` })
    .from(obligations)
    .innerJoin(agreements, activeAgreementJoin(obligations.workspaceId, obligations.agreementId))
    .where(and(...withoutStatus)) : [{ anchor: cursor.a }];
  const anchor = Number(snapshot?.anchor ?? 0);
  if (!Number.isSafeInteger(anchor) || anchor < 0) throw new Error("Obligation queue snapshot anchor is invalid");
  const snapshotAt = cursor?.s ?? new Date().toISOString();
  const anchored = [...withoutStatus, lte(obligations.createdAt, snapshotAt), lte(obligationRowId, anchor)];
  const filters = [...anchored, query.status === null ? undefined : eq(obligations.status, query.status)];
  const sortKey = query.sort === "newest" || query.sort === "oldest" ? obligations.createdAt : obligations.dueDate;
  const [[total], statusRows, selected] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(obligations)
      .innerJoin(agreements, activeAgreementJoin(obligations.workspaceId, obligations.agreementId)).where(and(...filters)),
    db.select({ status: obligations.status, count: sql<number>`count(*)` }).from(obligations)
      .innerJoin(agreements, activeAgreementJoin(obligations.workspaceId, obligations.agreementId))
      .where(and(...anchored)).groupBy(obligations.status),
    db.select({
      id: obligations.id,
      sortKey,
      obligation: {
        id: obligations.id,
        version: obligations.version,
        agreementId: obligations.agreementId,
        scheduleId: obligations.scheduleId,
        occurrenceNumber: obligations.occurrenceNumber,
        title: obligations.title,
        dueDate: obligations.dueDate,
        owner: obligations.owner,
        ownerUserId: obligations.ownerUserId,
        status: obligations.status,
        completedByUserId: obligations.completedByUserId,
        completedAt: obligations.completedAt,
        completionEvidence: obligations.completionEvidence,
        cadence: obligations.cadence,
        source: obligations.source,
        timezone: obligations.timezone,
        reminderLeadDays: obligations.reminderLeadDays,
        nextReminderDate: obligations.nextReminderDate,
        createdByUserId: obligations.createdByUserId,
        createdAt: obligations.createdAt,
      },
      agreement: agreementProjection,
    }).from(obligations)
      .innerJoin(agreements, activeAgreementJoin(obligations.workspaceId, obligations.agreementId))
      .where(and(...filters, cursorCondition(sortKey, obligations.id, query.sort, cursor)))
      .orderBy(...workItemOrder(sortKey, obligations.id, query.sort)).limit(query.limit + 1),
  ]);
  return pagedResponse(auth, query, binding, anchor, snapshotAt, selected.map((row) => ({
    id: row.id,
    sortKey: row.sortKey,
    item: { ...row.obligation, agreement: row.agreement },
  })), total?.count, statusRows);
}

async function schedulePage(
  db: Database,
  auth: AuthorizedRequest,
  query: WorkItemQuery,
  binding: string,
  cursor: WorkItemCursorPayload | null,
) {
  const pattern = query.q === null ? null : escapedWorkItemPattern(query.q);
  const withoutStatus = [
    eq(obligationSchedules.workspaceId, auth.context.workspace.id),
    ...activeAgreementScope(auth.context.workspace.id),
    agreementFilter(query),
    ownerFilter(query, auth, obligationSchedules.ownerUserId, obligationSchedules.owner),
    textSearch(pattern, [
      obligationSchedules.title,
      obligationSchedules.source,
      obligationSchedules.owner,
      agreements.party,
      agreements.type,
      agreements.owner,
    ]),
  ];
  const [snapshot] = cursor === null ? await db.select({ anchor: sql<number>`coalesce(max(${scheduleRowId}), 0)` })
    .from(obligationSchedules)
    .innerJoin(agreements, activeAgreementJoin(obligationSchedules.workspaceId, obligationSchedules.agreementId))
    .where(and(...withoutStatus)) : [{ anchor: cursor.a }];
  const anchor = Number(snapshot?.anchor ?? 0);
  if (!Number.isSafeInteger(anchor) || anchor < 0) throw new Error("Obligation-schedule snapshot anchor is invalid");
  const snapshotAt = cursor?.s ?? new Date().toISOString();
  const anchored = [...withoutStatus, lte(obligationSchedules.createdAt, snapshotAt), lte(scheduleRowId, anchor)];
  const filters = [...anchored, query.status === null ? undefined : sql`${obligationSchedules.status} = ${query.status}`];
  const sortKey = query.sort === "newest" || query.sort === "oldest"
    ? obligationSchedules.createdAt
    : query.sort === "updated_desc" || query.sort === "updated_asc"
      ? obligationSchedules.updatedAt
      : query.sort === "next_due_desc"
        ? sql<string>`coalesce(${obligationSchedules.nextOccurrenceDate}, '')`
        : sql<string>`coalesce(${obligationSchedules.nextOccurrenceDate}, '9999-12-31')`;
  const [[total], statusRows, selected] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(obligationSchedules)
      .innerJoin(agreements, activeAgreementJoin(obligationSchedules.workspaceId, obligationSchedules.agreementId)).where(and(...filters)),
    db.select({ status: obligationSchedules.status, count: sql<number>`count(*)` }).from(obligationSchedules)
      .innerJoin(agreements, activeAgreementJoin(obligationSchedules.workspaceId, obligationSchedules.agreementId))
      .where(and(...anchored)).groupBy(obligationSchedules.status),
    db.select({
      id: obligationSchedules.id,
      sortKey,
      schedule: {
        id: obligationSchedules.id,
        agreementId: obligationSchedules.agreementId,
        version: obligationSchedules.version,
        title: obligationSchedules.title,
        source: obligationSchedules.source,
        ownerUserId: obligationSchedules.ownerUserId,
        owner: obligationSchedules.owner,
        timezone: obligationSchedules.timezone,
        recurrenceUnit: obligationSchedules.recurrenceUnit,
        recurrenceInterval: obligationSchedules.recurrenceInterval,
        anchorDate: obligationSchedules.anchorDate,
        endDate: obligationSchedules.endDate,
        reminderLeadDays: obligationSchedules.reminderLeadDays,
        status: obligationSchedules.status,
        nextOccurrenceNumber: obligationSchedules.nextOccurrenceNumber,
        nextOccurrenceDate: obligationSchedules.nextOccurrenceDate,
        nextMaterializationDate: obligationSchedules.nextMaterializationDate,
        supersedesScheduleId: obligationSchedules.supersedesScheduleId,
        createdByUserId: obligationSchedules.createdByUserId,
        createdAt: obligationSchedules.createdAt,
        updatedByUserId: obligationSchedules.updatedByUserId,
        updatedAt: obligationSchedules.updatedAt,
      },
      agreement: agreementProjection,
    }).from(obligationSchedules)
      .innerJoin(agreements, activeAgreementJoin(obligationSchedules.workspaceId, obligationSchedules.agreementId))
      .where(and(...filters, cursorCondition(sortKey, obligationSchedules.id, query.sort, cursor)))
      .orderBy(...workItemOrder(sortKey, obligationSchedules.id, query.sort)).limit(query.limit + 1),
  ]);
  return pagedResponse(auth, query, binding, anchor, snapshotAt, selected.map((row) => ({
    id: row.id,
    sortKey: row.sortKey,
    item: { ...row.schedule, agreement: row.agreement },
  })), total?.count, statusRows);
}

async function eventPage(
  db: Database,
  auth: AuthorizedRequest,
  query: WorkItemQuery,
  binding: string,
  cursor: WorkItemCursorPayload | null,
) {
  const pattern = query.q === null ? null : escapedWorkItemPattern(query.q);
  const filters = [
    eq(agreementEvents.workspaceId, auth.context.workspace.id),
    ...activeAgreementScope(auth.context.workspace.id),
    agreementFilter(query),
    ownerFilter(query, auth, agreementEvents.actorUserId, agreementEvents.actor),
    textSearch(pattern, [
      agreementEvents.type,
      agreementEvents.actor,
      agreementEvents.actorEmail,
      agreementEvents.detail,
      agreements.party,
      agreements.type,
      agreements.owner,
    ]),
  ];
  const [snapshot] = cursor === null ? await db.select({ anchor: sql<number>`coalesce(max(${eventRowId}), 0)` })
    .from(agreementEvents)
    .innerJoin(agreements, activeAgreementJoin(agreementEvents.workspaceId, agreementEvents.agreementId))
    .where(and(...filters)) : [{ anchor: cursor.a }];
  const anchor = Number(snapshot?.anchor ?? 0);
  if (!Number.isSafeInteger(anchor) || anchor < 0) throw new Error("Agreement-event snapshot anchor is invalid");
  const snapshotAt = cursor?.s ?? new Date().toISOString();
  const anchored = [...filters, lte(agreementEvents.createdAt, snapshotAt), lte(eventRowId, anchor)];
  const sortKey = agreementEvents.createdAt;
  const [[total], selected] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(agreementEvents)
      .innerJoin(agreements, activeAgreementJoin(agreementEvents.workspaceId, agreementEvents.agreementId)).where(and(...anchored)),
    db.select({
      id: agreementEvents.id,
      sortKey,
      event: {
        id: agreementEvents.id,
        agreementId: agreementEvents.agreementId,
        type: agreementEvents.type,
        actorUserId: agreementEvents.actorUserId,
        actorEmail: agreementEvents.actorEmail,
        actor: agreementEvents.actor,
        detail: agreementEvents.detail,
        sequence: agreementEvents.sequence,
        sourceAgentPlanId: agreementEvents.sourceAgentPlanId,
        createdAt: agreementEvents.createdAt,
      },
      agreement: agreementProjection,
    }).from(agreementEvents)
      .innerJoin(agreements, activeAgreementJoin(agreementEvents.workspaceId, agreementEvents.agreementId))
      .where(and(...anchored, cursorCondition(sortKey, agreementEvents.id, query.sort, cursor)))
      .orderBy(...workItemOrder(sortKey, agreementEvents.id, query.sort)).limit(query.limit + 1),
  ]);
  return pagedResponse(auth, query, binding, anchor, snapshotAt, selected.map((row) => ({
    id: row.id,
    sortKey: row.sortKey,
    item: { ...row.event, agreement: row.agreement },
  })), total?.count, []);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const resourceCandidate = url.searchParams.getAll("resource").length === 1 ? url.searchParams.get("resource") : null;
  const permission = isWorkItemResource(resourceCandidate)
    ? permissionForWorkItemResource(resourceCandidate)
    : "agreement:read";
  const auth = await authorizeApiRequest(request, permission);
  if (!auth.ok) return auth.response;

  try {
    let query: WorkItemQuery;
    try {
      query = parseWorkItemQuery(url);
    } catch (error) {
      const invalidCursor = error instanceof WorkItemQueryError && error.code === "invalid_cursor";
      return apiError(invalidCursor ? "invalid_cursor" : "invalid_query", invalidCursor
        ? "The work-item page cursor is invalid for this workspace, resource, and query."
        : "Work-item resource, filters, sort, and page size are invalid.", {
        status: 400,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }

    const binding = await workItemCursorBinding(
      auth.context.workspace.id,
      auth.context.user.id,
      query,
    );
    let cursor: WorkItemCursorPayload | null;
    try {
      cursor = await decodeWorkItemCursor(url.searchParams.get("cursor"), binding);
    } catch {
      return apiError("invalid_cursor", "The work-item page cursor is invalid for this workspace, resource, and query.", {
        status: 400,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }

    await ensureStorageSchema();
    const db = getDb();
    if (query.resource === "approvals") return approvalPage(db, auth, query, binding, cursor);
    if (query.resource === "signatures") return signaturePage(db, auth, query, binding, cursor);
    if (query.resource === "obligations") return obligationPage(db, auth, query, binding, cursor);
    if (query.resource === "obligation_schedules") return schedulePage(db, auth, query, binding, cursor);
    return eventPage(db, auth, query, binding, cursor);
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Work items could not be loaded.");
  }
}
