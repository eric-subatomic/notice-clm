import {
  deliverySignatureInput,
  type CrmDeliveryProfile,
} from "../../../app/lib/delivery";

const MAX_BODY_BYTES = 128 * 1_024;
const DEFAULT_FRESHNESS_MS = 5 * 60_000;

export type VerifiedNoticeRequest = Readonly<{
  rawBody: string;
  bodyDigest: string;
  event: Record<string, unknown>;
  connectionTest: boolean;
  profile: CrmDeliveryProfile;
}>;

export class NoticeRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "NoticeRequestError";
    this.code = code;
    this.status = status;
  }
}

export async function verifyNoticeRequest(
  request: Request,
  options: { secrets: readonly string[]; now?: Date; freshnessMs?: number },
): Promise<VerifiedNoticeRequest> {
  const secrets = options.secrets.filter(Boolean);
  if (secrets.length === 0 || secrets.some((secret) => secret.length < 32)) {
    throw new NoticeRequestError("gateway_configuration", "Ingress signing secrets must contain at least 32 characters.", 503);
  }
  if (request.method !== "POST") throw new NoticeRequestError("method", "Only POST is supported.", 405);
  if ((request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new NoticeRequestError("content_type", "Requests must use application/json.", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) {
    throw new NoticeRequestError("body_too_large", "Request body exceeds 128 KiB.", 413);
  }

  const timestamp = request.headers.get("x-notice-timestamp") ?? "";
  if (!/^(0|[1-9]\d*)$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))) {
    throw new NoticeRequestError("timestamp", "x-notice-timestamp must be Unix seconds.", 401);
  }
  const timestampMs = Number(timestamp) * 1_000;
  const freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0 || Math.abs((options.now ?? new Date()).getTime() - timestampMs) > freshnessMs) {
    throw new NoticeRequestError("stale", "Request timestamp is outside the accepted freshness window.", 401);
  }

  const rawBody = await readBoundedUtf8Body(request, MAX_BODY_BYTES);
  const provider = request.headers.get("x-notice-crm-provider") ?? "";
  const mappingVersion = request.headers.get("x-notice-crm-mapping-version") ?? "";
  if (
    !["hubspot", "salesforce", "custom"].includes(provider)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(mappingVersion)
  ) {
    throw new NoticeRequestError("profile", "A valid signed CRM delivery profile is required.", 401);
  }
  const profile = Object.freeze({
    provider: provider as CrmDeliveryProfile["provider"],
    mappingVersion,
  });
  const signature = /^sha256=([0-9a-f]{64})$/.exec(request.headers.get("x-notice-signature") ?? "")?.[1];
  if (!signature) throw new NoticeRequestError("signature", "Request signature is malformed.", 401);
  let signatureValid = false;
  for (const secret of secrets) {
    const expected = await hmacSha256Hex(secret, deliverySignatureInput(timestamp, rawBody, profile));
    signatureValid = constantTimeEqual(expected, signature) || signatureValid;
  }
  if (!signatureValid) throw new NoticeRequestError("signature", "Request signature is invalid.", 401);

  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    throw new NoticeRequestError("json", "Request body must be valid JSON.");
  }
  if (!isRecord(envelope) || envelope.schemaVersion !== "1.0" || !isRecord(envelope.event)) {
    throw new NoticeRequestError("schema", "Envelope schemaVersion must be 1.0 and event must be an object.");
  }
  const event = envelope.event;
  const eventId = boundedString(event.id, 128);
  if (!eventId || !constantTimeEqual(request.headers.get("x-notice-event-id") ?? "", eventId)) {
    throw new NoticeRequestError("event_id", "x-notice-event-id must exactly match event.id.");
  }

  const headerDryRun = request.headers.get("x-notice-test") === "connection";
  const payloadDryRun = isRecord(event.payload) && event.payload.dryRun === true;
  if (headerDryRun !== payloadDryRun) throw new NoticeRequestError("dry_run", "Both connection-test markers are required.");
  if (headerDryRun && (
    event.workspaceId !== "__connection_test__"
    || event.topic !== "integration.crm.connection_test"
    || event.aggregateType !== "system"
    || event.aggregateId !== event.id
    || !isRecord(event.payload)
    || event.payload.channel !== "crm"
  )) throw new NoticeRequestError("dry_run", "Connection-test fields are invalid.");

  return Object.freeze({
    rawBody,
    bodyDigest: await sha256Hex(rawBody),
    event,
    connectionTest: headerDryRun,
    profile,
  });
}

async function readBoundedUtf8Body(request: Request, maximumBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new NoticeRequestError("body_too_large", "Request body exceeds 128 KiB.", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof NoticeRequestError) throw error;
    throw new NoticeRequestError("body_unreadable", "Request body could not be read.");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new NoticeRequestError("body_encoding", "Request body must be valid UTF-8.");
  }
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
