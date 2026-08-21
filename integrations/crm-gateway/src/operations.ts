import {
  receiptStatuses,
  type ReceiptStatus,
  type ReceiptStore,
} from "./receipt-store";

const MAX_OPERATIONS_BODY_BYTES = 4_096;
const DEFAULT_LIST_LIMIT = 50;
const operationsStatusSet = new Set<string>(receiptStatuses);

export type CrmGatewayOperationsOptions = Readonly<{
  secret: string;
  provider: string;
  mappingVersion: string;
  store: ReceiptStore;
  now?: () => Date;
}>;

export class CrmGatewayOperations {
  private readonly secret: string;
  private readonly provider: string;
  private readonly mappingVersion: string;
  private readonly store: ReceiptStore;
  private readonly clock: () => Date;

  constructor(options: CrmGatewayOperationsOptions) {
    this.secret = validateOperationsSecret(options.secret);
    this.provider = options.provider;
    this.mappingVersion = options.mappingVersion;
    this.store = options.store;
    this.clock = options.now ?? (() => new Date());
  }

  async handle(request: Request): Promise<Response> {
    if (!isAuthorized(request.headers.get("authorization"), this.secret)) {
      return operationsError(401, "operations_unauthorized", {
        "www-authenticate": "Bearer",
      });
    }

    const url = new URL(request.url);
    if (url.pathname === "/v1/operations/receipts") {
      return this.listReceipts(request, url);
    }
    if (url.pathname === "/v1/operations/requeue") {
      return this.requeue(request, url);
    }
    return operationsError(404, "not_found");
  }

  private async listReceipts(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET") return operationsError(405, "method_not_allowed");
    if (hasUnexpectedOrRepeatedQuery(url, new Set(["status", "limit"]))) {
      return operationsError(400, "invalid_query");
    }
    const rawStatus = url.searchParams.get("status") ?? "dead";
    if (!operationsStatusSet.has(rawStatus)) return operationsError(400, "invalid_status");
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? DEFAULT_LIST_LIMIT : parseLimit(rawLimit);
    if (limit === null) return operationsError(400, "invalid_limit");

    try {
      const receipts = await this.store.listOperationalReceipts(rawStatus as ReceiptStatus, limit, {
        provider: this.provider,
        mappingVersion: this.mappingVersion,
      });
      return operationsJson(200, { receipts });
    } catch {
      return operationsError(503, "operations_unavailable");
    }
  }

  private async requeue(request: Request, url: URL): Promise<Response> {
    if (request.method !== "POST") return operationsError(405, "method_not_allowed");
    if (url.search !== "") return operationsError(400, "invalid_query");
    if ((request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return operationsError(415, "content_type");
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBoundedBody(request, MAX_OPERATIONS_BODY_BYTES));
    } catch (error) {
      return operationsError(error instanceof OperationsRequestTooLarge ? 413 : 400, error instanceof OperationsRequestTooLarge
        ? "body_too_large"
        : "invalid_body");
    }
    if (!isRecord(body) || !hasExactKeys(body, ["workspaceId", "eventId"])) {
      return operationsError(400, "invalid_body");
    }
    const workspaceId = boundedIdentifier(body.workspaceId);
    const eventId = boundedIdentifier(body.eventId);
    if (!workspaceId || !eventId) return operationsError(400, "invalid_body");

    try {
      const result = await this.store.requeueDead({
        workspaceId,
        eventId,
        provider: this.provider,
        mappingVersion: this.mappingVersion,
        now: this.clock().toISOString(),
      });
      if (result.kind === "requeued") return operationsJson(202, { status: "requeued" });
      if (result.kind === "not_found") return operationsError(404, "receipt_not_found");
      if (result.kind === "not_dead") return operationsError(409, "receipt_not_dead");
      if (result.kind === "payload_redacted") return operationsError(409, "receipt_payload_redacted");
      return operationsError(409, "receipt_profile_mismatch");
    } catch {
      return operationsError(503, "operations_unavailable");
    }
  }
}

export function validateOperationsSecret(candidate: unknown): string {
  if (typeof candidate !== "string") throw new Error("CRM operations secret is missing");
  if (!/^[\x21-\x7e]{32,4096}$/.test(candidate)) {
    throw new Error("CRM operations secret is invalid");
  }
  return candidate;
}

function isAuthorized(header: string | null, expected: string): boolean {
  const match = /^Bearer ([^\s]{32,4096})$/.exec(header ?? "");
  return match !== null && constantTimeEqual(match[1], expected);
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function parseLimit(value: string): number | null {
  if (!/^[1-9]\d{0,2}$/.test(value)) return null;
  const limit = Number(value);
  return limit <= 100 ? limit : null;
}

function hasUnexpectedOrRepeatedQuery(url: URL, allowed: ReadonlySet<string>): boolean {
  const counts = new Map<string, number>();
  for (const key of url.searchParams.keys()) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts].some(([key, count]) => !allowed.has(key) || count !== 1);
}

function boundedIdentifier(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

class OperationsRequestTooLarge extends Error {}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    throw new OperationsRequestTooLarge();
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new OperationsRequestTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function operationsError(status: number, code: string, headers: Record<string, string> = {}): Response {
  return operationsJson(status, { error: { code } }, headers);
}

function operationsJson(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
