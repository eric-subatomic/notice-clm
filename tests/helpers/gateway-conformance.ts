import {
  CUSTOMER_HOSTED_OCR_MAX_CHARACTERS,
  CUSTOMER_HOSTED_OCR_PROTOCOL_VERSION,
  isValidCustomerHostedOcrIdentifier,
} from "../../app/lib/document-security";

const DEFAULT_FRESHNESS_MS = 5 * 60_000;

export type ScannerRequestEvidence = Readonly<{
  documentId: string;
  declaredSha256: string;
  actualSha256: string;
  timestamp: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  ocr: Readonly<{
    requestId: string;
    operation: "extract-text";
    modelId: string;
    profileId: string;
    maximumCharacters: number;
  }> | null;
}>;

export type DeliveryEvent = Readonly<{
  id: string;
  workspaceId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}>;

export type DeliveryRequestEvidence = Readonly<{
  schemaVersion: "1.0";
  event: DeliveryEvent;
  rawBody: string;
  timestamp: string;
  connectionTest: boolean;
}>;

export class GatewayConformanceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GatewayConformanceError";
    this.code = code;
  }
}

/**
 * Reference gateway-side verifier for Notice scanner requests. It deliberately
 * recomputes the file hash: the multipart boundary, filename, and MIME metadata
 * are not part of the HMAC input.
 */
export async function verifyNoticeScannerRequest(
  request: Request,
  options: { secret: string; now?: Date; freshnessMs?: number; acceptedOcrRequestIds?: Set<string> },
): Promise<ScannerRequestEvidence> {
  validateSecret(options.secret);
  if (request.method !== "POST") fail("method", "Scanner requests must use POST.");
  if (!mediaType(request.headers.get("content-type")).startsWith("multipart/form-data")) {
    fail("content_type", "Scanner requests must use multipart/form-data.");
  }
  if (!acceptsJson(request.headers.get("accept"))) {
    fail("accept", "Scanner requests must accept application/json responses.");
  }

  const timestamp = request.headers.get("x-notice-timestamp") ?? "";
  const timestampMs = Date.parse(timestamp);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
    || !Number.isFinite(timestampMs)
    || new Date(timestampMs).toISOString() !== timestamp) {
    fail("timestamp", "Scanner timestamps must be canonical UTC ISO-8601 values.");
  }
  assertFresh(timestampMs, options.now?.getTime() ?? Date.now(), options.freshnessMs ?? DEFAULT_FRESHNESS_MS);

  const form = await request.formData();
  const files = form.getAll("file");
  const documentIds = form.getAll("documentId");
  const declaredHashes = form.getAll("sha256");
  if (files.length !== 1 || !(files[0] instanceof Blob)) {
    fail("file", "Scanner requests must contain exactly one binary file field.");
  }
  if (documentIds.length !== 1 || typeof documentIds[0] !== "string") {
    fail("document_id", "Scanner requests must contain exactly one documentId field.");
  }
  if (declaredHashes.length !== 1 || typeof declaredHashes[0] !== "string") {
    fail("sha256", "Scanner requests must contain exactly one sha256 field.");
  }

  const file = files[0];
  const documentId = documentIds[0];
  const declaredSha256 = declaredHashes[0];
  if (!documentId || documentId.length > 128 || /[\u0000-\u001f\u007f]/.test(documentId)) {
    fail("document_id", "documentId must be a non-empty opaque identifier of at most 128 characters.");
  }
  if (!/^[0-9a-f]{64}$/.test(declaredSha256)) {
    fail("sha256", "sha256 must be 64 lowercase hexadecimal characters.");
  }

  const protocol = request.headers.get("x-notice-scanner-protocol");
  if (protocol !== null && protocol !== CUSTOMER_HOSTED_OCR_PROTOCOL_VERSION) {
    fail("protocol", "The scanner protocol version is unsupported.");
  }
  const ocr = protocol === CUSTOMER_HOSTED_OCR_PROTOCOL_VERSION
    ? parseCustomerHostedOcrFields(form)
    : null;
  const expectedFields = new Set(ocr
    ? ["file", "requestId", "documentId", "sha256", "operation", "modelId", "profileId", "maximumCharacters"]
    : ["file", "documentId", "sha256"]);
  if (Array.from(form.keys()).some((key) => !expectedFields.has(key))) {
    fail("fields", "Scanner requests contain an unexpected multipart field.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const actualSha256 = await sha256Hex(bytes);
  if (!constantTimeEqual(actualSha256, declaredSha256)) {
    fail("hash_mismatch", "The uploaded file bytes do not match the declared SHA-256.");
  }

  await verifyHmacHeader(
    request.headers.get("x-notice-signature"),
    options.secret,
    ocr
      ? [
          `notice-scanner/${CUSTOMER_HOSTED_OCR_PROTOCOL_VERSION}`,
          timestamp,
          ocr.requestId,
          documentId,
          declaredSha256,
          "extract-text",
          ocr.modelId,
          ocr.profileId,
          String(CUSTOMER_HOSTED_OCR_MAX_CHARACTERS),
        ].join("\n")
      : `${timestamp}.${documentId}.${declaredSha256}`,
  );
  if (ocr && options.acceptedOcrRequestIds) {
    if (options.acceptedOcrRequestIds.has(ocr.requestId)) {
      fail("replay", "An OCR requestId may be accepted only once within the gateway replay-retention window.");
    }
    options.acceptedOcrRequestIds.add(ocr.requestId);
  }

  return Object.freeze({
    documentId,
    declaredSha256,
    actualSha256,
    timestamp,
    fileName: "name" in file && typeof file.name === "string" ? file.name : "document",
    contentType: file.type,
    bytes,
    ocr,
  });
}

function parseCustomerHostedOcrFields(form: FormData): NonNullable<ScannerRequestEvidence["ocr"]> {
  const requestIds = form.getAll("requestId");
  const operation = form.getAll("operation");
  const modelIds = form.getAll("modelId");
  const profileIds = form.getAll("profileId");
  const maximumCharacters = form.getAll("maximumCharacters");
  if (
    requestIds.length !== 1
    || typeof requestIds[0] !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestIds[0])
    || operation.length !== 1
    || operation[0] !== "extract-text"
    || modelIds.length !== 1
    || typeof modelIds[0] !== "string"
    || profileIds.length !== 1
    || typeof profileIds[0] !== "string"
    || maximumCharacters.length !== 1
    || maximumCharacters[0] !== String(CUSTOMER_HOSTED_OCR_MAX_CHARACTERS)
    || !isValidCustomerHostedOcrIdentifier(modelIds[0])
    || !isValidCustomerHostedOcrIdentifier(profileIds[0])
  ) {
    fail("ocr_profile", "OCR requests must contain one exact bounded operation, model, profile, and output limit.");
  }
  return Object.freeze({
    requestId: requestIds[0],
    operation: "extract-text",
    modelId: modelIds[0],
    profileId: profileIds[0],
    maximumCharacters: CUSTOMER_HOSTED_OCR_MAX_CHARACTERS,
  });
}

/**
 * Reference gateway-side verifier for ordinary outbox delivery and harmless
 * connection diagnostics. The HMAC is checked against the exact raw JSON bytes
 * before the body is parsed.
 */
export async function verifyNoticeDeliveryRequest(
  request: Request,
  options: { secret: string; now?: Date; freshnessMs?: number },
): Promise<DeliveryRequestEvidence> {
  validateSecret(options.secret);
  if (request.method !== "POST") fail("method", "Delivery requests must use POST.");
  if (mediaType(request.headers.get("content-type")) !== "application/json") {
    fail("content_type", "Delivery requests must use application/json.");
  }

  const timestamp = request.headers.get("x-notice-timestamp") ?? "";
  if (!/^(0|[1-9]\d*)$/.test(timestamp)) {
    fail("timestamp", "Delivery timestamps must be Unix seconds using decimal digits.");
  }
  const timestampMs = Number(timestamp) * 1_000;
  if (!Number.isSafeInteger(Number(timestamp)) || !Number.isFinite(timestampMs)) {
    fail("timestamp", "Delivery timestamp is outside the supported numeric range.");
  }
  assertFresh(timestampMs, options.now?.getTime() ?? Date.now(), options.freshnessMs ?? DEFAULT_FRESHNESS_MS);

  const rawBody = await request.text();
  await verifyHmacHeader(
    request.headers.get("x-notice-signature"),
    options.secret,
    `${timestamp}.${rawBody}`,
  );

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    fail("json", "Delivery body must be valid JSON.");
  }
  if (!isRecord(body) || body.schemaVersion !== "1.0" || !isRecord(body.event)) {
    fail("schema", "Delivery envelope must contain schemaVersion 1.0 and an event object.");
  }

  const candidate = body.event;
  for (const field of ["id", "workspaceId", "topic", "aggregateType", "aggregateId", "createdAt"] as const) {
    if (typeof candidate[field] !== "string" || candidate[field].length === 0 || candidate[field].length > 256) {
      fail("schema", `Delivery event ${field} must be a non-empty bounded string.`);
    }
  }
  if (!isRecord(candidate.payload)) fail("schema", "Delivery event payload must be a JSON object.");
  const createdAtMs = Date.parse(candidate.createdAt as string);
  if (!Number.isFinite(createdAtMs)) fail("schema", "Delivery event createdAt must be an ISO-8601 timestamp.");

  const eventId = request.headers.get("x-notice-event-id") ?? "";
  if (!constantTimeEqual(eventId, candidate.id as string)) {
    fail("event_id", "x-notice-event-id must exactly match event.id.");
  }

  const headerMarksConnection = request.headers.get("x-notice-test") === "connection";
  const payloadMarksDryRun = candidate.payload.dryRun === true;
  if (headerMarksConnection !== payloadMarksDryRun) {
    fail("dry_run", "Connection diagnostics must include both dry-run markers or neither marker.");
  }
  if (headerMarksConnection) validateConnectionTest(candidate as Record<string, unknown>);

  const event: DeliveryEvent = Object.freeze({
    id: candidate.id as string,
    workspaceId: candidate.workspaceId as string,
    topic: candidate.topic as string,
    aggregateType: candidate.aggregateType as string,
    aggregateId: candidate.aggregateId as string,
    payload: candidate.payload,
    createdAt: candidate.createdAt as string,
  });
  return Object.freeze({ schemaVersion: "1.0", event, rawBody, timestamp, connectionTest: headerMarksConnection });
}

function validateConnectionTest(event: Record<string, unknown>): void {
  const payload = event.payload;
  if (!isRecord(payload)
    || event.workspaceId !== "__connection_test__"
    || event.aggregateType !== "system"
    || event.aggregateId !== event.id
    || !["integration.delivery.connection_test", "integration.crm.connection_test"].includes(String(event.topic))
    || !["delivery", "crm"].includes(String(payload.channel))) {
    fail("dry_run", "Connection diagnostic fields do not match the Notice dry-run contract.");
  }
}

function validateSecret(secret: string): void {
  if (secret.length < 32) fail("secret", "Gateway HMAC secrets must contain at least 32 characters.");
}

function mediaType(value: string | null): string {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function acceptsJson(value: string | null): boolean {
  return (value ?? "").split(",").some((part) => ["application/json", "*/*"].includes(mediaType(part)));
}

function assertFresh(timestampMs: number, nowMs: number, freshnessMs: number): void {
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0) fail("freshness", "Freshness window must be non-negative.");
  if (Math.abs(nowMs - timestampMs) > freshnessMs) {
    fail("stale", "Gateway request timestamp is outside the allowed freshness window.");
  }
}

async function verifyHmacHeader(header: string | null, secret: string, canonicalInput: string): Promise<void> {
  const match = /^sha256=([0-9a-f]{64})$/.exec(header ?? "");
  if (!match) fail("signature", "x-notice-signature must use sha256=<lowercase-hex> syntax.");
  const expected = await hmacSha256Hex(secret, canonicalInput);
  if (!constantTimeEqual(expected, match[1])) fail("signature", "Gateway request signature is invalid.");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return hex(new Uint8Array(digest));
}

async function hmacSha256Hex(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
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

function fail(code: string, message: string): never {
  throw new GatewayConformanceError(code, message);
}
