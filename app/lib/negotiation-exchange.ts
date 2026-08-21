import type { NegotiationSubmissionSource, NegotiationSubmissionStatus } from "../../db/schema";

export const NEGOTIATION_TOKEN_BYTES = 32;
export const NEGOTIATION_ALIAS_BYTES = 12;
export const NEGOTIATION_INBOUND_FRESHNESS_MS = 5 * 60 * 1_000;
export const DEFAULT_NEGOTIATION_PORTAL_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_NEGOTIATION_PORTAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_NEGOTIATION_ATTACHMENT_BYTES = 20 * 1_024 * 1_024;

export type NegotiationExchangeErrorCode =
  | "invalid_alias"
  | "invalid_base64"
  | "invalid_body_digest"
  | "invalid_email"
  | "invalid_expiry"
  | "invalid_secret"
  | "invalid_size"
  | "invalid_token"
  | "invalid_timestamp";

export class NegotiationExchangeError extends Error {
  constructor(readonly code: NegotiationExchangeErrorCode, message: string) {
    super(message);
    this.name = "NegotiationExchangeError";
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function strictTimestampSeconds(value: number | string): number {
  if (typeof value === "string" && !/^[1-9][0-9]{0,12}$/.test(value)) {
    throw new NegotiationExchangeError("invalid_timestamp", "The inbound timestamp must be whole Unix seconds.");
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new NegotiationExchangeError("invalid_timestamp", "The inbound timestamp must be whole Unix seconds.");
  }
  return parsed;
}

function hmacSecretBytes(secret: string | Uint8Array): Uint8Array {
  const bytes = typeof secret === "string" ? new TextEncoder().encode(secret) : Uint8Array.from(secret);
  if (bytes.byteLength < 32 || bytes.byteLength > 4_096) {
    throw new NegotiationExchangeError("invalid_secret", "The inbound signing secret must contain between 32 and 4096 bytes.");
  }
  return bytes;
}

function canonicalInboundPayload(timestampSeconds: number, rawBodySha256: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(rawBodySha256)) {
    throw new NegotiationExchangeError("invalid_body_digest", "The canonical inbound body material must be a lowercase SHA-256 digest.");
  }
  return new TextEncoder().encode(`${timestampSeconds}.${rawBodySha256}`);
}

async function hmacSha256(secret: string | Uint8Array, payload: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    exactArrayBuffer(hmacSecretBytes(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, exactArrayBuffer(payload))));
}

function constantTimeSignatureMatch(expectedHex: string, candidate: string): boolean {
  const match = /^sha256=([0-9a-f]{64})$/.exec(candidate);
  const suppliedHex = match?.[1] ?? "0".repeat(64);
  let difference = 0;
  for (let index = 0; index < 64; index += 1) {
    difference |= expectedHex.charCodeAt(index) ^ suppliedHex.charCodeAt(index);
  }
  return Boolean(match) && difference === 0;
}

export function generateSecureHex(byteLength: number): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 12 || byteLength > 128) {
    throw new RangeError("Secure identifiers must contain between 12 and 128 random bytes.");
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

export function generateNegotiationToken(): string {
  return generateSecureHex(NEGOTIATION_TOKEN_BYTES);
}

export function generateNegotiationAliasCode(): string {
  return generateSecureHex(NEGOTIATION_ALIAS_BYTES);
}

export async function hashNegotiationToken(token: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    throw new NegotiationExchangeError("invalid_token", "Negotiation tokens must be 32-byte hexadecimal values.");
  }
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", exactArrayBuffer(new TextEncoder().encode(token.toLowerCase())))));
}

export function normalizeNegotiationEmail(value: string): string {
  const normalized = value.trim().normalize("NFKC").toLowerCase();
  if (normalized.length === 0 || normalized.length > 320 || /[\r\n\u0000-\u001f\u007f]/.test(normalized)) {
    throw new NegotiationExchangeError("invalid_email", "Provide one normalized email address without control characters.");
  }
  const at = normalized.indexOf("@");
  if (at <= 0 || at !== normalized.lastIndexOf("@")) {
    throw new NegotiationExchangeError("invalid_email", "Provide one normalized email address.");
  }
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const atom = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
  if (
    local.length > 64
    || domain.length === 0
    || domain.length > 253
    || !atom.test(local)
    || local.startsWith(".")
    || local.endsWith(".")
    || local.includes("..")
  ) {
    throw new NegotiationExchangeError("invalid_email", "Provide a valid unquoted email address.");
  }
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => (
    label.length === 0
    || label.length > 63
    || !/^[a-z0-9-]+$/.test(label)
    || label.startsWith("-")
    || label.endsWith("-")
  ))) {
    throw new NegotiationExchangeError("invalid_email", "Provide an email address with a valid DNS domain.");
  }
  return normalized;
}

function normalizeAliasCode(aliasCode: string): string {
  const normalized = aliasCode.trim().toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${NEGOTIATION_ALIAS_BYTES * 2}}$`).test(normalized)) {
    throw new NegotiationExchangeError("invalid_alias", "Negotiation alias codes must be 12-byte hexadecimal values.");
  }
  return normalized;
}

function normalizeInboundDomain(domain: string): string {
  return normalizeNegotiationEmail(`probe@${domain}`).split("@")[1]!;
}

export function buildNegotiationAliasAddress(aliasCode: string, inboundDomain: string): string {
  return `reply-${normalizeAliasCode(aliasCode)}@${normalizeInboundDomain(inboundDomain)}`;
}

export function parseNegotiationAliasAddress(address: string, inboundDomain: string): string | null {
  let normalizedAddress: string;
  let normalizedDomain: string;
  try {
    normalizedAddress = normalizeNegotiationEmail(address);
    normalizedDomain = normalizeInboundDomain(inboundDomain);
  } catch {
    return null;
  }
  const [local, domain] = normalizedAddress.split("@");
  if (domain !== normalizedDomain) return null;
  const match = new RegExp(`^reply-([0-9a-f]{${NEGOTIATION_ALIAS_BYTES * 2}})$`).exec(local!);
  return match?.[1] ?? null;
}

export async function signNegotiationInboundPayload(
  secret: string | Uint8Array,
  timestampSeconds: number | string,
  rawBodySha256: string,
): Promise<string> {
  const timestamp = strictTimestampSeconds(timestampSeconds);
  const signature = await hmacSha256(secret, canonicalInboundPayload(timestamp, rawBodySha256));
  return `sha256=${signature}`;
}

export async function verifyNegotiationInboundPayload(input: Readonly<{
  secret: string | Uint8Array;
  timestampSeconds: number | string;
  /** Lowercase SHA-256 of the canonical raw request body. */
  rawBodySha256: string;
  signature: string;
  now?: Date;
}>): Promise<boolean> {
  let timestamp: number;
  try {
    timestamp = strictTimestampSeconds(input.timestampSeconds);
  } catch {
    return false;
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime()) || Math.abs(now.getTime() - timestamp * 1_000) > NEGOTIATION_INBOUND_FRESHNESS_MS) {
    return false;
  }
  let payload: Uint8Array;
  try {
    payload = canonicalInboundPayload(timestamp, input.rawBodySha256);
  } catch {
    return false;
  }
  const expected = await hmacSha256(input.secret, payload);
  return constantTimeSignatureMatch(expected, input.signature);
}

export function negotiationPortalExpiresAt(
  now: Date = new Date(),
  ttlMs: number = DEFAULT_NEGOTIATION_PORTAL_TTL_MS,
): string {
  if (
    !Number.isFinite(now.getTime())
    || !Number.isSafeInteger(ttlMs)
    || ttlMs < NEGOTIATION_INBOUND_FRESHNESS_MS
    || ttlMs > MAX_NEGOTIATION_PORTAL_TTL_MS
  ) {
    throw new NegotiationExchangeError("invalid_expiry", "Portal expiry must be between five minutes and thirty days.");
  }
  return new Date(now.getTime() + ttlMs).toISOString();
}

export type NegotiationSubmissionScanStatus =
  | "clean"
  | "evaluation-bypassed"
  | "malicious"
  | "quarantined"
  | "rejected"
  | "scanner-unavailable"
  | "unscanned";

export function decideNegotiationSubmissionStatus(input: Readonly<{
  source: NegotiationSubmissionSource;
  hasAttachment: boolean;
  scanStatus?: NegotiationSubmissionScanStatus | null;
  roundAcceptingSubmissions: boolean;
  senderMatchesExpected?: boolean | null;
  promoted?: boolean;
}>): NegotiationSubmissionStatus {
  if (!input.hasAttachment) return "no_attachment";
  if (input.scanStatus === "malicious" || input.scanStatus === "rejected") return "rejected";
  if (input.scanStatus !== "clean") return "quarantined";
  if (!input.roundAcceptingSubmissions) return "late";
  if (input.source === "email" && input.senderMatchesExpected !== true) return "sender_review";
  if (input.promoted) return "promoted";
  return "ready";
}

export function assertNegotiationAttachmentSize(
  size: number,
  maximumBytes: number = MAX_NEGOTIATION_ATTACHMENT_BYTES,
): number {
  validateAttachmentMaximum(maximumBytes);
  if (!Number.isSafeInteger(size) || size <= 0 || size > maximumBytes) {
    throw new NegotiationExchangeError("invalid_size", `Attachments must contain between 1 and ${maximumBytes} bytes.`);
  }
  return size;
}

function validateAttachmentMaximum(maximumBytes: number): number {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > MAX_NEGOTIATION_ATTACHMENT_BYTES) {
    throw new NegotiationExchangeError("invalid_size", "The attachment limit is invalid.");
  }
  return maximumBytes;
}

export function decodeBoundedBase64(
  encoded: string,
  maximumBytes: number = MAX_NEGOTIATION_ATTACHMENT_BYTES,
): Uint8Array {
  const maximumEncodedLength = Math.ceil(validateAttachmentMaximum(maximumBytes) / 3) * 4;
  if (encoded.length > maximumEncodedLength) {
    throw new NegotiationExchangeError("invalid_size", `Attachments must contain no more than ${maximumBytes} decoded bytes.`);
  }
  if (
    encoded.length === 0
    || encoded.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new NegotiationExchangeError("invalid_base64", "Attachment content must be canonical base64 without whitespace.");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const predictedSize = (encoded.length / 4) * 3 - padding;
  assertNegotiationAttachmentSize(predictedSize, maximumBytes);
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new NegotiationExchangeError("invalid_base64", "Attachment content is not valid base64.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  assertNegotiationAttachmentSize(bytes.byteLength, maximumBytes);
  return bytes;
}
