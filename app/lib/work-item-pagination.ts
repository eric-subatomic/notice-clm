import type { Permission } from "./authorization";

export const WORK_ITEM_RESOURCES = [
  "approvals",
  "signatures",
  "obligations",
  "obligation_schedules",
  "events",
] as const;

export type WorkItemResource = (typeof WORK_ITEM_RESOURCES)[number];
export type WorkItemSort =
  | "newest"
  | "oldest"
  | "due_asc"
  | "due_desc"
  | "updated_desc"
  | "updated_asc"
  | "next_due_asc"
  | "next_due_desc";

export type WorkItemQuery = Readonly<{
  resource: WorkItemResource;
  status: string | null;
  owner: string | null;
  agreementId: number | null;
  q: string | null;
  sort: WorkItemSort;
  limit: number;
}>;

export type WorkItemCursorPayload = Readonly<{
  v: 1;
  b: string;
  a: number;
  s: string;
  k: string;
  i: string;
}>;

type WorkItemCursorEnvelope = WorkItemCursorPayload & Readonly<{ c: string }>;

const WORK_ITEM_QUERY_PARAMETERS = new Set([
  "resource",
  "status",
  "owner",
  "agreement",
  "q",
  "sort",
  "limit",
  "cursor",
]);
const WORK_ITEM_DEFAULT_LIMIT = 100;
export const WORK_ITEM_MAX_LIMIT = 200;
export const WORK_ITEM_SUMMARY_COUNT_CAP = 100_000;

const resourceConfiguration: Readonly<Record<WorkItemResource, Readonly<{
  permission: Permission;
  statuses: readonly string[];
  sorts: readonly WorkItemSort[];
  defaultSort: WorkItemSort;
}>>> = Object.freeze({
  approvals: Object.freeze({
    permission: "approval:read",
    statuses: Object.freeze(["Pending", "Approved", "Changes requested", "Superseded"]),
    sorts: Object.freeze(["newest", "oldest", "due_asc", "due_desc"]) as readonly WorkItemSort[],
    defaultSort: "newest",
  }),
  signatures: Object.freeze({
    permission: "agreement:read",
    statuses: Object.freeze([
      "creating",
      "pending",
      "partially_signed",
      "reconciling",
      "archived",
      "completed_review_required",
      "completed",
      "completed_superseded",
      "declined",
      "expired",
      "error",
      "superseded",
    ]),
    sorts: Object.freeze(["updated_desc", "updated_asc", "newest", "oldest"]) as readonly WorkItemSort[],
    defaultSort: "updated_desc",
  }),
  obligations: Object.freeze({
    permission: "obligation:read",
    statuses: Object.freeze(["Open", "Complete"]),
    sorts: Object.freeze(["due_asc", "due_desc", "newest", "oldest"]) as readonly WorkItemSort[],
    defaultSort: "due_asc",
  }),
  obligation_schedules: Object.freeze({
    permission: "obligation:read",
    statuses: Object.freeze(["active", "paused", "ended"]),
    sorts: Object.freeze(["next_due_asc", "next_due_desc", "updated_desc", "updated_asc", "newest", "oldest"]) as readonly WorkItemSort[],
    defaultSort: "next_due_asc",
  }),
  events: Object.freeze({
    permission: "audit:read",
    statuses: Object.freeze([]),
    sorts: Object.freeze(["newest", "oldest"]) as readonly WorkItemSort[],
    defaultSort: "newest",
  }),
});

export class WorkItemQueryError extends TypeError {
  constructor(readonly code: "invalid_query" | "invalid_cursor") {
    super(code === "invalid_cursor" ? "Work-item cursor is invalid" : "Work-item query is invalid");
    this.name = "WorkItemQueryError";
  }
}

export function isWorkItemResource(candidate: string | null): candidate is WorkItemResource {
  return candidate !== null && (WORK_ITEM_RESOURCES as readonly string[]).includes(candidate);
}

export function permissionForWorkItemResource(resource: WorkItemResource): Permission {
  return resourceConfiguration[resource].permission;
}

export function statusesForWorkItemResource(resource: WorkItemResource): readonly string[] {
  return resourceConfiguration[resource].statuses;
}

function normalizedBoundedText(candidate: string | null, rawMaximum: number, normalizedMaximum: number): string | null {
  if (candidate === null) return null;
  if (candidate.length > rawMaximum) throw new WorkItemQueryError("invalid_query");
  const normalized = candidate.normalize("NFKC").trim();
  if (!normalized) return null;
  if (normalized.length > normalizedMaximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new WorkItemQueryError("invalid_query");
  }
  return normalized;
}

export function parseWorkItemQuery(url: URL): WorkItemQuery {
  const names = [...url.searchParams.keys()];
  if (
    names.some((name) => !WORK_ITEM_QUERY_PARAMETERS.has(name))
    || [...WORK_ITEM_QUERY_PARAMETERS].some((name) => url.searchParams.getAll(name).length > 1)
  ) {
    throw new WorkItemQueryError(url.searchParams.getAll("cursor").length > 1 ? "invalid_cursor" : "invalid_query");
  }

  const resourceCandidate = url.searchParams.get("resource");
  if (!isWorkItemResource(resourceCandidate)) throw new WorkItemQueryError("invalid_query");
  const configuration = resourceConfiguration[resourceCandidate];
  const status = normalizedBoundedText(url.searchParams.get("status"), 128, 64);
  if (status !== null && !configuration.statuses.includes(status)) throw new WorkItemQueryError("invalid_query");
  const owner = normalizedBoundedText(url.searchParams.get("owner"), 512, 200);
  const q = normalizedBoundedText(url.searchParams.get("q"), 500, 200);

  const agreementCandidate = url.searchParams.get("agreement");
  if (agreementCandidate !== null && !/^[1-9][0-9]{0,15}$/.test(agreementCandidate)) {
    throw new WorkItemQueryError("invalid_query");
  }
  const agreementId = agreementCandidate === null ? null : Number(agreementCandidate);
  if (agreementId !== null && !Number.isSafeInteger(agreementId)) throw new WorkItemQueryError("invalid_query");

  const limitCandidate = url.searchParams.get("limit");
  if (limitCandidate !== null && !/^[1-9][0-9]{0,2}$/.test(limitCandidate)) {
    throw new WorkItemQueryError("invalid_query");
  }
  const limit = limitCandidate === null ? WORK_ITEM_DEFAULT_LIMIT : Number(limitCandidate);
  if (limit > WORK_ITEM_MAX_LIMIT) throw new WorkItemQueryError("invalid_query");

  const sortCandidate = url.searchParams.get("sort") ?? configuration.defaultSort;
  if (!configuration.sorts.includes(sortCandidate as WorkItemSort)) throw new WorkItemQueryError("invalid_query");

  return Object.freeze({
    resource: resourceCandidate,
    status,
    owner,
    agreementId,
    q,
    sort: sortCandidate as WorkItemSort,
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

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function workItemCursorBinding(
  workspaceId: string,
  userId: string,
  query: WorkItemQuery,
): Promise<string> {
  return sha256Hex(JSON.stringify({
    v: 1,
    workspaceId,
    userId,
    resource: query.resource,
    status: query.status,
    owner: query.owner,
    agreementId: query.agreementId,
    q: query.q,
    sort: query.sort,
    limit: query.limit,
  }));
}

function cursorPayloadJson(payload: WorkItemCursorPayload): string {
  return JSON.stringify({
    v: payload.v,
    b: payload.b,
    a: payload.a,
    s: payload.s,
    k: payload.k,
    i: payload.i,
  });
}

async function cursorChecksum(payload: WorkItemCursorPayload): Promise<string> {
  return sha256Hex(`${payload.b}.${cursorPayloadJson(payload)}`);
}

export async function encodeWorkItemCursor(payload: WorkItemCursorPayload): Promise<string> {
  const c = await cursorChecksum(payload);
  return base64UrlEncodeUtf8(JSON.stringify({ ...payload, c } satisfies WorkItemCursorEnvelope));
}

export async function decodeWorkItemCursor(
  candidate: string | null,
  expectedBinding: string,
): Promise<WorkItemCursorPayload | null> {
  if (candidate === null) return null;
  if (candidate.length < 1 || candidate.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(candidate)) {
    throw new WorkItemQueryError("invalid_cursor");
  }
  try {
    const decoded = base64UrlDecodeUtf8(candidate);
    const value: unknown = JSON.parse(decoded);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "a,b,c,i,k,s,v"
      || record.v !== 1
      || typeof record.b !== "string"
      || !/^[a-f0-9]{64}$/.test(record.b)
      || typeof record.c !== "string"
      || !/^[a-f0-9]{64}$/.test(record.c)
      || !Number.isSafeInteger(record.a)
      || (record.a as number) <= 0
      || typeof record.s !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.s)
      || new Date(record.s).toISOString() !== record.s
      || typeof record.k !== "string"
      || record.k.length < 1
      || record.k.length > 512
      || typeof record.i !== "string"
      || record.i.length < 1
      || record.i.length > 256
    ) throw new TypeError();
    const payload: WorkItemCursorPayload = Object.freeze({
      v: 1,
      b: record.b,
      a: record.a as number,
      s: record.s,
      k: record.k,
      i: record.i,
    });
    const checksum = await cursorChecksum(payload);
    if (
      record.b !== expectedBinding
      || record.c !== checksum
      || decoded !== JSON.stringify({ ...payload, c: record.c } satisfies WorkItemCursorEnvelope)
      || candidate !== base64UrlEncodeUtf8(decoded)
    ) throw new TypeError();
    return payload;
  } catch {
    throw new WorkItemQueryError("invalid_cursor");
  }
}

export function escapedWorkItemPattern(query: string): string {
  return `%${query.toLocaleLowerCase("en-US").replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export function boundedWorkItemCount(value: unknown): Readonly<{ count: number; capped: boolean }> {
  const count = Number(value ?? 0);
  if (!Number.isFinite(count) || count <= 0) return Object.freeze({ count: 0, capped: false });
  if (count > WORK_ITEM_SUMMARY_COUNT_CAP) {
    return Object.freeze({ count: WORK_ITEM_SUMMARY_COUNT_CAP, capped: true });
  }
  return Object.freeze({ count: Math.floor(count), capped: false });
}
