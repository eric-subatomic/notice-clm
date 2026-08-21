import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NEGOTIATION_PORTAL_TTL_MS,
  NEGOTIATION_ALIAS_BYTES,
  NEGOTIATION_INBOUND_FRESHNESS_MS,
  NEGOTIATION_TOKEN_BYTES,
  NegotiationExchangeError,
  assertNegotiationAttachmentSize,
  buildNegotiationAliasAddress,
  decideNegotiationSubmissionStatus,
  decodeBoundedBase64,
  generateNegotiationAliasCode,
  generateNegotiationToken,
  generateSecureHex,
  hashNegotiationToken,
  negotiationPortalExpiresAt,
  normalizeNegotiationEmail,
  parseNegotiationAliasAddress,
  signNegotiationInboundPayload,
  verifyNegotiationInboundPayload,
} from "../app/lib/negotiation-exchange";

test("negotiation tokens and aliases are secure fixed-width hexadecimal values", () => {
  const tokens = new Set(Array.from({ length: 32 }, () => generateNegotiationToken()));
  assert.equal(tokens.size, 32);
  for (const token of tokens) assert.match(token, new RegExp(`^[0-9a-f]{${NEGOTIATION_TOKEN_BYTES * 2}}$`));

  const alias = generateNegotiationAliasCode();
  assert.match(alias, new RegExp(`^[0-9a-f]{${NEGOTIATION_ALIAS_BYTES * 2}}$`));
  assert.equal(generateSecureHex(16).length, 32);
  assert.throws(() => generateSecureHex(11), RangeError);
});

test("negotiation tokens are stored as deterministic one-way hashes", async () => {
  const token = "ab".repeat(NEGOTIATION_TOKEN_BYTES);
  const first = await hashNegotiationToken(token);
  const second = await hashNegotiationToken(token.toUpperCase());
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, token);
  await assert.rejects(() => hashNegotiationToken("not-a-token"), (error) => (
    error instanceof NegotiationExchangeError && error.code === "invalid_token"
  ));
});

test("counterparty email normalization is strict and alias parsing is domain-bound", () => {
  assert.equal(normalizeNegotiationEmail("  Counsel.Team+Round@EXAMPLE.COM  "), "counsel.team+round@example.com");
  for (const invalid of [
    "Counsel <counsel@example.com>",
    "counsel@example.com\r\nBcc: attacker@example.com",
    "a@b",
    '"counsel"@example.com',
    "one@example.com,two@example.com",
    "counsel..team@example.com",
    "counsel@localhost",
    "counsel@-example.com",
    `a${"b".repeat(64)}@example.com`,
  ]) assert.throws(() => normalizeNegotiationEmail(invalid), NegotiationExchangeError);

  const alias = "a1".repeat(NEGOTIATION_ALIAS_BYTES);
  const address = buildNegotiationAliasAddress(alias.toUpperCase(), "Inbound.Contracts.Example");
  assert.equal(address, `reply-${alias}@inbound.contracts.example`);
  assert.equal(parseNegotiationAliasAddress(address.toUpperCase(), "inbound.contracts.example"), alias);
  assert.equal(parseNegotiationAliasAddress(address, "other.example"), null);
  assert.equal(parseNegotiationAliasAddress(`reply-${"f".repeat(23)}@inbound.contracts.example`, "inbound.contracts.example"), null);
});

test("inbound signatures bind the exact timestamp and canonical raw-body digest and expire after five minutes", async () => {
  const secret = "s".repeat(32);
  const timestampSeconds = 1_800_000_000;
  const rawBodySha256 = "a".repeat(64);
  const signature = await signNegotiationInboundPayload(secret, timestampSeconds, rawBodySha256);
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);

  const verify = (overrides: Partial<Parameters<typeof verifyNegotiationInboundPayload>[0]> = {}) => (
    verifyNegotiationInboundPayload({
      secret,
      timestampSeconds,
      rawBodySha256,
      signature,
      now: new Date(timestampSeconds * 1_000),
      ...overrides,
    })
  );
  assert.equal(await verify(), true);
  assert.equal(await verify({ rawBodySha256: "b".repeat(64) }), false);
  const tamperedSignature = `sha256=${signature[7] === "a" ? "b" : "a"}${signature.slice(8)}`;
  assert.equal(await verify({ signature: tamperedSignature }), false);
  assert.equal(await verify({ signature: "sha256=short" }), false);
  assert.equal(await verify({ signature: signature.toUpperCase() }), false);
  assert.equal(await verify({ signature: ` ${signature}` }), false);
  assert.equal(await verify({ timestampSeconds: timestampSeconds + 1 }), false);
  assert.equal(await verify({ now: new Date(timestampSeconds * 1_000 + NEGOTIATION_INBOUND_FRESHNESS_MS) }), true);
  assert.equal(await verify({ now: new Date(timestampSeconds * 1_000 + NEGOTIATION_INBOUND_FRESHNESS_MS + 1) }), false);
  assert.equal(await verify({ now: new Date(timestampSeconds * 1_000 - NEGOTIATION_INBOUND_FRESHNESS_MS - 1) }), false);
  assert.equal(await verify({ timestampSeconds: "not-seconds" }), false);
  await assert.rejects(
    () => signNegotiationInboundPayload("weak", timestampSeconds, rawBodySha256),
    (error) => error instanceof NegotiationExchangeError && error.code === "invalid_secret",
  );
  await assert.rejects(
    () => signNegotiationInboundPayload(secret, timestampSeconds, "A".repeat(64)),
    (error) => error instanceof NegotiationExchangeError && error.code === "invalid_body_digest",
  );
  assert.equal(await verify({ rawBodySha256: "not-a-digest" }), false);
});

test("documented inbound multipart golden fixture retains its exact digest and HMAC", async () => {
  const secret = "inbound-email-conformance-secret-32-characters";
  const timestampSeconds = 1_785_585_600;
  const manifest = JSON.stringify({
    schemaVersion: "1.0",
    providerEventId: "evt-conformance-001",
    providerMessageId: "provider-message-001",
    internetMessageId: "<message-001@example.invalid>",
    from: { email: "counsel@counterparty.invalid", name: "Counterparty counsel" },
    to: "reply-0123456789abcdef01234567@redlines.customer.invalid",
    authentication: { aligned: true, spf: "pass", dkim: "pass", dmarc: "pass" },
    attachments: [],
  });
  const rawBody = `--notice-email-boundary\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${manifest}\r\n--notice-email-boundary--\r\n`;
  const digestBytes = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rawBody),
  ));
  const rawBodySha256 = Array.from(
    digestBytes,
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  assert.equal(new TextEncoder().encode(rawBody).byteLength, 530);
  assert.equal(rawBodySha256, "4eb3b778b574041d4fd4e9e7a9e9e6e67a1e2bbff4ebeb7ed74d3b4f128f332e");
  assert.equal(
    await signNegotiationInboundPayload(secret, timestampSeconds, rawBodySha256),
    "sha256=bc2653e9a657c76a9cd4ea84ddde55aca3058656d792830b0470b6c8f78ef88a",
  );
});

test("portal expiry is bounded and deterministic", () => {
  const now = new Date("2026-08-03T12:00:00.000Z");
  assert.equal(
    negotiationPortalExpiresAt(now),
    new Date(now.getTime() + DEFAULT_NEGOTIATION_PORTAL_TTL_MS).toISOString(),
  );
  assert.throws(() => negotiationPortalExpiresAt(now, NEGOTIATION_INBOUND_FRESHNESS_MS - 1), NegotiationExchangeError);
  assert.throws(() => negotiationPortalExpiresAt(new Date("invalid")), NegotiationExchangeError);
});

test("submission status decisions fail closed around attachment, scanning, sender, and round state", () => {
  const ready = {
    source: "email" as const,
    hasAttachment: true,
    scanStatus: "clean" as const,
    roundAcceptingSubmissions: true,
    senderMatchesExpected: true,
  };
  assert.equal(decideNegotiationSubmissionStatus({ ...ready, hasAttachment: false }), "no_attachment");
  assert.equal(decideNegotiationSubmissionStatus({ ...ready, scanStatus: "malicious" }), "rejected");
  assert.equal(decideNegotiationSubmissionStatus({ ...ready, scanStatus: "rejected" }), "rejected");
  assert.equal(decideNegotiationSubmissionStatus({ ...ready, scanStatus: "scanner-unavailable" }), "quarantined");
  assert.equal(decideNegotiationSubmissionStatus({ ...ready, scanStatus: "evaluation-bypassed" }), "quarantined");
  assert.equal(decideNegotiationSubmissionStatus({ ...ready, roundAcceptingSubmissions: false }), "late");
  assert.equal(decideNegotiationSubmissionStatus({ ...ready, senderMatchesExpected: false }), "sender_review");
  assert.equal(decideNegotiationSubmissionStatus({ ...ready, senderMatchesExpected: null }), "sender_review");
  assert.equal(decideNegotiationSubmissionStatus(ready), "ready");
  assert.equal(decideNegotiationSubmissionStatus({ ...ready, promoted: true }), "promoted");
  assert.equal(decideNegotiationSubmissionStatus({ ...ready, source: "portal", senderMatchesExpected: null }), "ready");
});

test("base64 attachment decoding rejects non-canonical and oversized input before use", () => {
  assert.deepEqual(decodeBoundedBase64("bm90aWNl", 16), new TextEncoder().encode("notice"));
  assert.equal(assertNegotiationAttachmentSize(16, 16), 16);
  for (const invalid of ["", "bm90aWNl\n", "bm90aWNl===", "not_base64"]) {
    assert.throws(() => decodeBoundedBase64(invalid, 16), NegotiationExchangeError);
  }
  assert.throws(() => decodeBoundedBase64("bm90aWNl", 5), (error) => (
    error instanceof NegotiationExchangeError && error.code === "invalid_size"
  ));
  assert.throws(() => decodeBoundedBase64("YWFhYWFhYWFh", 4), (error) => (
    error instanceof NegotiationExchangeError && error.code === "invalid_size"
  ));
  assert.throws(() => assertNegotiationAttachmentSize(0), NegotiationExchangeError);
});
