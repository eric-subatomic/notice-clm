import assert from "node:assert/strict";
import test from "node:test";
import { deliverOutboxEvent, GatewayDeliveryError, prepareDeliveryGatewayRequest, type DeliveryGatewayEvent } from "../app/lib/delivery";
import {
  CUSTOMER_HOSTED_OCR_MAX_CHARACTERS,
  CUSTOMER_HOSTED_OCR_RESPONSE_MAX_BYTES,
  CustomerHostedOcrError,
  customerHostedOcrSignaturePayload,
  extractDocumentTextWithCustomerHostedOcr,
  hmacSha256Hex,
  scanDocument,
  sha256Hex,
} from "../app/lib/document-security";
import {
  GatewayConformanceError,
  verifyNoticeDeliveryRequest,
  verifyNoticeScannerRequest,
} from "./helpers/gateway-conformance";

const scannerSecret = "scanner-conformance-secret-32-characters";
const deliverySecret = "delivery-conformance-secret-32-characters";
const credentialedHttpsUrl = (host: string, path = "") =>
  `https://${["user", "password"].join(":")}@${host}${path}`;

test("Notice scanner requests pass the gateway-side signature, freshness, and file-hash contract", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = new TextEncoder().encode("Notice harmless scanner conformance file.\n");
  const sha256 = await sha256Hex(bytes);
  let gatewayCalls = 0;

  globalThis.fetch = async (input, init) => {
    gatewayCalls += 1;
    const request = new Request(input, init);
    assert.equal(request.redirect, "manual");
    const evidence = await verifyNoticeScannerRequest(request, { secret: scannerSecret });
    assert.equal(evidence.documentId, "792f3b9a-f523-4db5-a189-8ab73691ddac");
    assert.equal(evidence.declaredSha256, sha256);
    assert.equal(evidence.actualSha256, sha256);
    assert.equal(evidence.fileName, "notice-conformance.txt");
    assert.equal(evidence.contentType, "text/plain");
    assert.deepEqual(evidence.bytes, bytes);
    return Response.json({ verdict: "clean", provider: "conformance-scanner", detail: "No malware detected" });
  };

  try {
    const result = await scanDocument(bytes, {
      id: "792f3b9a-f523-4db5-a189-8ab73691ddac",
      fileName: "notice-conformance.txt",
      contentType: "text/plain",
      sha256,
    }, {
      endpoint: "https://scanner.test.invalid/v1/scan",
      secret: scannerSecret,
    });
    assert.equal(gatewayCalls, 1);
    assert.deepEqual(result, {
      status: "clean",
      provider: "conformance-scanner",
      detail: "No malware detected",
      scannedAt: result.scannedAt,
    });
    assert.match(result.scannedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("customer-hosted OCR uses the signed scanner boundary and requires an exact bounded model/profile result", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = new TextEncoder().encode("%PDF-1.4\n% synthetic OCR conformance source\n");
  const document = {
    id: "74416733-4d1c-486e-a989-acc039013467",
    fileName: "notice-ocr-conformance.pdf",
    contentType: "application/pdf",
    sha256: await sha256Hex(bytes),
  };
  const configuration = {
    endpoint: "https://scanner.test.invalid/v1/scan",
    secret: scannerSecret,
    ocr: { modelId: "acme-vision-v2", profileId: "contracts-en-v1" },
  };
  let responseProfileId = configuration.ocr.profileId;
  let responseText = "Notice OCR conformance source";
  let responseProvider = "customer-isolated-ocr";
  let responseDetail = "Synthetic bounded extraction completed";
  let gatewayCalls = 0;
  const acceptedOcrRequestIds = new Set<string>();

  globalThis.fetch = async (input, init) => {
    gatewayCalls += 1;
    const request = new Request(input, init);
    const capturedReplay = request.clone();
    const evidence = await verifyNoticeScannerRequest(request, { secret: scannerSecret, acceptedOcrRequestIds });
    if (gatewayCalls === 1) {
      await assert.rejects(
        verifyNoticeScannerRequest(capturedReplay as unknown as Parameters<typeof verifyNoticeScannerRequest>[0], { secret: scannerSecret, acceptedOcrRequestIds }),
        (error: unknown) => error instanceof GatewayConformanceError && error.code === "replay",
      );
    }
    assert.match(evidence.ocr?.requestId ?? "", /^[0-9a-f-]{36}$/);
    assert.deepEqual(evidence.ocr && {
      operation: evidence.ocr.operation,
      modelId: evidence.ocr.modelId,
      profileId: evidence.ocr.profileId,
      maximumCharacters: evidence.ocr.maximumCharacters,
    }, {
      operation: "extract-text",
      modelId: configuration.ocr.modelId,
      profileId: configuration.ocr.profileId,
      maximumCharacters: CUSTOMER_HOSTED_OCR_MAX_CHARACTERS,
    });
    assert.equal(evidence.declaredSha256, document.sha256);
    return Response.json({
      verdict: "clean",
      requestId: evidence.ocr?.requestId,
      provider: responseProvider,
      detail: responseDetail,
      extraction: {
        status: "complete",
        modelId: configuration.ocr.modelId,
        profileId: responseProfileId,
        sourceSha256: document.sha256,
        text: responseText,
      },
    });
  };

  try {
    const extracted = await extractDocumentTextWithCustomerHostedOcr(bytes, document, configuration);
    assert.equal(gatewayCalls, 1);
    assert.equal(extracted.text, "Notice OCR conformance source");
    assert.match(extracted.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(extracted.modelId, "acme-vision-v2");
    assert.equal(extracted.profileId, "contracts-en-v1");

    responseProfileId = "unapproved-fallback";
    await assert.rejects(
      extractDocumentTextWithCustomerHostedOcr(bytes, document, configuration),
      (error: unknown) => error instanceof CustomerHostedOcrError && error.code === "invalid_response",
    );

    responseProfileId = configuration.ocr.profileId;
    responseText = "x".repeat(CUSTOMER_HOSTED_OCR_MAX_CHARACTERS + 1);
    await assert.rejects(
      extractDocumentTextWithCustomerHostedOcr(bytes, document, configuration),
      (error: unknown) => error instanceof CustomerHostedOcrError && error.code === "invalid_response",
    );

    responseText = "\ud800";
    await assert.rejects(
      extractDocumentTextWithCustomerHostedOcr(bytes, document, configuration),
      (error: unknown) => error instanceof CustomerHostedOcrError && error.code === "invalid_response",
    );

    responseText = "Notice OCR conformance source";
    responseProvider = "x".repeat(121);
    await assert.rejects(
      extractDocumentTextWithCustomerHostedOcr(bytes, document, configuration),
      (error: unknown) => error instanceof CustomerHostedOcrError && error.code === "invalid_response",
    );

    responseProvider = "customer-isolated-ocr";
    responseDetail = "\ud800";
    await assert.rejects(
      extractDocumentTextWithCustomerHostedOcr(bytes, document, configuration),
      (error: unknown) => error instanceof CustomerHostedOcrError && error.code === "invalid_response",
    );

    responseDetail = "Synthetic bounded extraction completed";
    responseText = "  Clause 😀 remains exact.  \n";
    const unicode = await extractDocumentTextWithCustomerHostedOcr(bytes, document, configuration);
    assert.equal(unicode.text, responseText);
    assert.equal(await sha256Hex(new TextEncoder().encode(unicode.text)), await sha256Hex(new TextEncoder().encode(responseText)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("customer-hosted OCR v2 canonicalization has an independent fixed golden vector", async () => {
  const input = {
    timestamp: "2026-08-01T12:00:00.000Z",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    documentId: "bc707ff1-dd31-4e56-9466-bfd1a858c40d",
    sha256: "89a51c27f6905ba4c9a1e284cc4b9c3678fa6660a953c65475d036e7dddd639b",
    modelId: "customer-vision-v1",
    profileId: "contracts-en-v1",
  };
  const canonical = [
    "notice-scanner/2.0",
    input.timestamp,
    input.requestId,
    input.documentId,
    input.sha256,
    "extract-text",
    input.modelId,
    input.profileId,
    "400000",
  ].join("\n");
  assert.equal(customerHostedOcrSignaturePayload(input), canonical);
  assert.equal(
    await hmacSha256Hex(scannerSecret, canonical),
    "c18870557542d9c3c6d7d111ee89ab1d92d4ee5043295764bf5916787019288b",
  );
});

test("a malicious v2 response retains exact bounded rejection evidence", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = new TextEncoder().encode("%PDF-1.4\n% malicious verdict fixture\n");
  const document = {
    id: "54416733-4d1c-486e-a989-acc039013467",
    fileName: "malicious-verdict.pdf",
    contentType: "application/pdf",
    sha256: await sha256Hex(bytes),
  };
  globalThis.fetch = async (input, init) => {
    const evidence = await verifyNoticeScannerRequest(new Request(input, init), { secret: scannerSecret });
    return Response.json({
      verdict: "malicious",
      requestId: evidence.ocr?.requestId,
      provider: "customer-isolated-ocr",
      detail: "Fresh malware verdict",
    });
  };
  try {
    await assert.rejects(
      extractDocumentTextWithCustomerHostedOcr(bytes, document, {
        endpoint: "https://scanner.test.invalid/v1/scan",
        secret: scannerSecret,
        ocr: { modelId: "customer-vision-v1", profileId: "contracts-en-v1" },
      }),
      (error: unknown) => error instanceof CustomerHostedOcrError
        && error.code === "malicious_source"
        && error.verdictEvidence?.provider === "customer-isolated-ocr"
        && error.verdictEvidence.detail === "Fresh malware verdict"
        && /^[0-9a-f-]{36}$/.test(error.verdictEvidence.requestId),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an exact-request malicious verdict dominates malformed ancillary fields while untrusted responses stay invalid", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = new TextEncoder().encode("%PDF-1.4\n% malformed malicious evidence fixture\n");
  const document = {
    id: "64416733-4d1c-486e-a989-acc039013467",
    fileName: "malformed-malicious-verdict.pdf",
    contentType: "application/pdf",
    sha256: await sha256Hex(bytes),
  };
  const configuration = {
    endpoint: "https://scanner.test.invalid/v1/scan",
    secret: scannerSecret,
    ocr: { modelId: "customer-vision-v1", profileId: "contracts-en-v1" },
  };
  let variant: "extra" | "extraction" | "provider" | "detail" | "wrong-request" = "extra";
  globalThis.fetch = async (input, init) => {
    const evidence = await verifyNoticeScannerRequest(new Request(input, init), { secret: scannerSecret });
    const requestId = variant === "wrong-request"
      ? "77777777-7777-4777-8777-777777777777"
      : evidence.ocr?.requestId;
    const base: Record<string, unknown> = {
      verdict: "malicious",
      requestId,
      provider: "customer-isolated-ocr",
      detail: "Fresh malware verdict",
    };
    if (variant === "extra") base.unexpected = true;
    if (variant === "extraction") base.extraction = { status: "complete", text: "must be ignored" };
    if (variant === "provider") base.provider = "x".repeat(121);
    if (variant === "detail") base.detail = "\ud800";
    return Response.json(base);
  };
  try {
    for (variant of ["extra", "extraction", "provider", "detail"] as const) {
      await assert.rejects(
        extractDocumentTextWithCustomerHostedOcr(bytes, document, configuration),
        (error: unknown) => error instanceof CustomerHostedOcrError
          && error.code === "malicious_source"
          && error.verdictEvidence !== null
          && error.verdictEvidence.requestId.length === 36
          && error.verdictEvidence.provider.length <= 120
          && error.verdictEvidence.detail.length <= 500,
      );
    }
    variant = "wrong-request";
    await assert.rejects(
      extractDocumentTextWithCustomerHostedOcr(bytes, document, configuration),
      (error: unknown) => error instanceof CustomerHostedOcrError
        && error.code === "invalid_response"
        && error.verdictEvidence === null,
    );
    globalThis.fetch = async () => new Response("{}", {
      headers: { "content-length": String(CUSTOMER_HOSTED_OCR_RESPONSE_MAX_BYTES + 1) },
    });
    await assert.rejects(
      extractDocumentTextWithCustomerHostedOcr(bytes, document, configuration),
      (error: unknown) => error instanceof CustomerHostedOcrError
        && error.code === "invalid_response"
        && error.verdictEvidence === null,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the scanner verifier rejects stale requests and a file that does not match its signed declared hash", async () => {
  const now = new Date("2026-08-01T12:00:00.000Z");
  const documentId = "bc707ff1-dd31-4e56-9466-bfd1a858c40d";
  const safeBytes = new TextEncoder().encode("expected bytes");
  const changedBytes = new TextEncoder().encode("changed bytes");
  const declaredSha256 = await sha256Hex(safeBytes);
  const timestamp = now.toISOString();
  const signature = await hmacSha256Hex(scannerSecret, `${timestamp}.${documentId}.${declaredSha256}`);
  assert.equal(declaredSha256, "89a51c27f6905ba4c9a1e284cc4b9c3678fa6660a953c65475d036e7dddd639b");
  assert.equal(signature, "94555c458c9d3cdad6bab4b866f88fedde74dd357182522301305658f83cb53c");
  const tampered = scannerRequest({
    bytes: changedBytes,
    documentId,
    declaredSha256,
    timestamp,
    signature,
  });

  await assert.rejects(
    verifyNoticeScannerRequest(tampered, { secret: scannerSecret, now }),
    (error: unknown) => error instanceof GatewayConformanceError && error.code === "hash_mismatch",
  );

  const staleTimestamp = "2026-08-01T11:54:59.000Z";
  const staleSignature = await hmacSha256Hex(scannerSecret, `${staleTimestamp}.${documentId}.${declaredSha256}`);
  const stale = scannerRequest({
    bytes: safeBytes,
    documentId,
    declaredSha256,
    timestamp: staleTimestamp,
    signature: staleSignature,
  });
  await assert.rejects(
    verifyNoticeScannerRequest(stale, { secret: scannerSecret, now }),
    (error: unknown) => error instanceof GatewayConformanceError && error.code === "stale",
  );
});

test("scanner response semantics distinguish a conclusive malicious verdict from gateway unavailability", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = new TextEncoder().encode("synthetic scanner response test");
  const document = {
    id: "27687782-00e0-44f4-8078-e2ab7a8919b8",
    fileName: "response-test.txt",
    contentType: "text/plain",
    sha256: await sha256Hex(bytes),
  };
  let response: Response = Response.json({ verdict: "malicious", provider: "conformance-scanner", detail: "Synthetic test verdict" });
  globalThis.fetch = async () => response;

  try {
    const malicious = await scanDocument(bytes, document, {
      endpoint: "https://scanner.test.invalid/v1/scan",
      secret: scannerSecret,
    });
    assert.equal(malicious.status, "malicious");
    assert.equal(malicious.detail, "Synthetic test verdict");

    response = Response.json({ verdict: "unknown" });
    const unsupported = await scanDocument(bytes, document, {
      endpoint: "https://scanner.test.invalid/v1/scan",
      secret: scannerSecret,
    });
    assert.equal(unsupported.status, "unavailable");

    response = new Response(null, { status: 503 });
    const unavailable = await scanDocument(bytes, document, {
      endpoint: "https://scanner.test.invalid/v1/scan",
      secret: scannerSecret,
    });
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.detail, "Scanner returned HTTP 503");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Notice delivery requests verify at the gateway and stable event IDs prevent duplicate effects", async () => {
  const originalFetch = globalThis.fetch;
  const accepted = new Set<string>();
  const effects: string[] = [];
  const event: DeliveryGatewayEvent = {
    id: "45f6d30d-6dad-420a-832c-613f54b34b67",
    workspaceId: "orchid-firm",
    topic: "notification.approval_reminder",
    aggregateType: "approval",
    aggregateId: "18d22f9f-f50a-4df5-824a-13684de80ad2",
    payload: {
      approvalId: "18d22f9f-f50a-4df5-824a-13684de80ad2",
      agreementId: 4102,
      role: "Legal",
      due: "2026-08-15",
      recipient: { userId: "user-9", email: "approver@example.invalid", displayName: "Approval Owner" },
    },
    createdAt: "2026-08-01T12:00:00.000Z",
  };

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.redirect, "manual");
    const evidence = await verifyNoticeDeliveryRequest(request, { secret: deliverySecret });
    if (accepted.has(evidence.event.id)) return new Response(null, { status: 200 });

    // A real gateway persists this idempotency decision before producing an
    // external effect. The in-memory set represents that durable transaction.
    accepted.add(evidence.event.id);
    effects.push(evidence.event.id);
    return new Response(null, { status: 202 });
  };

  try {
    await deliverOutboxEvent({ endpoint: "https://delivery.test.invalid/v1/events", secret: deliverySecret }, event);
    await deliverOutboxEvent({ endpoint: "https://delivery.test.invalid/v1/events", secret: deliverySecret }, event);
    assert.deepEqual(effects, [event.id]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the shared Notice builder produces a verifiable, side-effect-free connection diagnostic", async () => {
  const now = new Date("2026-08-01T12:00:00.000Z");
  const eventId = "5eb479d4-f747-4b6e-9a8d-5ef31f155f0e";
  const event: DeliveryGatewayEvent = {
    id: eventId,
    workspaceId: "__connection_test__",
    topic: "integration.delivery.connection_test",
    aggregateType: "system",
    aggregateId: eventId,
    payload: { dryRun: true, channel: "delivery" },
    createdAt: now.toISOString(),
  };
  const prepared = await prepareDeliveryGatewayRequest(
    { endpoint: "https://delivery.test.invalid/v1/events", secret: deliverySecret },
    event,
    { connectionTest: true, now },
  );
  assert.equal(prepared.headers["x-notice-timestamp"], "1785585600");
  assert.equal(
    prepared.headers["x-notice-signature"],
    "sha256=2a588e799aa6c5bad69dfe28baddfb059710fbc8bb31bcf9c5f1df86f6af58f1",
  );
  const request = new Request(prepared.endpoint, {
    method: prepared.method,
    headers: prepared.headers,
    body: prepared.body,
  });
  const evidence = await verifyNoticeDeliveryRequest(request, { secret: deliverySecret, now });

  assert.equal(evidence.connectionTest, true);
  assert.equal(evidence.event.id, eventId);
  assert.deepEqual(evidence.event.payload, { dryRun: true, channel: "delivery" });
});

test("delivery marks only 2xx gateway responses as accepted", async () => {
  const originalFetch = globalThis.fetch;
  const event: DeliveryGatewayEvent = {
    id: "1889768f-374d-47e3-be06-513dd252b990",
    workspaceId: "orchid-firm",
    topic: "agreement.created",
    aggregateType: "agreement",
    aggregateId: "4102",
    payload: { agreementId: 4102, version: 1 },
    createdAt: "2026-08-01T12:00:00.000Z",
  };
  globalThis.fetch = async () => new Response(null, { status: 503 });
  try {
    await assert.rejects(
      deliverOutboxEvent({ endpoint: "https://delivery.test.invalid/v1/events", secret: deliverySecret }, event),
      /returned HTTP 503/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("delivery retries only transient gateway statuses", async () => {
  const originalFetch = globalThis.fetch;
  const event: DeliveryGatewayEvent = {
    id: "b9b80636-ad4d-4a99-8e60-456a7b6f3c9a",
    workspaceId: "orchid-firm",
    topic: "agreement.updated",
    aggregateType: "agreement",
    aggregateId: "4102",
    payload: { agreementId: 4102, version: 2 },
    createdAt: "2026-08-01T12:00:00.000Z",
  };
  try {
    for (const [status, retryable] of [[307, false], [400, false], [401, false], [408, true], [425, true], [429, true], [500, true]] as const) {
      globalThis.fetch = async () => new Response(null, { status });
      await assert.rejects(
        deliverOutboxEvent({ endpoint: "https://delivery.test.invalid/v1/events", secret: deliverySecret }, event),
        (error) => error instanceof GatewayDeliveryError && error.retryable === retryable && error.code === `gateway_http_${status}`,
        `HTTP ${status}`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the delivery verifier rejects raw-body tampering and incomplete dry-run markers", async () => {
  const now = new Date("2026-08-01T12:00:00.000Z");
  const eventId = "bb29640b-dae3-48e7-be27-fd295124717a";
  const event: DeliveryGatewayEvent = {
    id: eventId,
    workspaceId: "__connection_test__",
    topic: "integration.crm.connection_test",
    aggregateType: "system",
    aggregateId: eventId,
    payload: { dryRun: true, channel: "crm" },
    createdAt: now.toISOString(),
  };
  const prepared = await prepareDeliveryGatewayRequest(
    { endpoint: "https://delivery.test.invalid/v1/events", secret: deliverySecret },
    event,
    { connectionTest: true, now },
  );
  const tampered = new Request(prepared.endpoint, {
    method: prepared.method,
    headers: prepared.headers,
    body: `${prepared.body} `,
  });
  await assert.rejects(
    verifyNoticeDeliveryRequest(tampered, { secret: deliverySecret, now }),
    (error: unknown) => error instanceof GatewayConformanceError && error.code === "signature",
  );

  const missingHeader = await prepareDeliveryGatewayRequest(
    { endpoint: "https://delivery.test.invalid/v1/events", secret: deliverySecret },
    event,
    { now },
  );
  const partialDryRun = new Request(missingHeader.endpoint, {
    method: missingHeader.method,
    headers: missingHeader.headers,
    body: missingHeader.body,
  });
  await assert.rejects(
    verifyNoticeDeliveryRequest(partialDryRun, { secret: deliverySecret, now }),
    (error: unknown) => error instanceof GatewayConformanceError && error.code === "dry_run",
  );
});

test("gateway request builders reject insecure remote endpoints, redirects, and embedded credentials", async () => {
  const event: DeliveryGatewayEvent = {
    id: "3f0ba405-a060-41f5-9974-1988395a3e83",
    workspaceId: "orchid-firm",
    topic: "agreement.created",
    aggregateType: "agreement",
    aggregateId: "4102",
    payload: { agreementId: 4102, version: 1 },
    createdAt: "2026-08-01T12:00:00.000Z",
  };
  for (const endpoint of [
    "http://delivery.test.invalid/events",
    "ftp://localhost/events",
    credentialedHttpsUrl("delivery.test.invalid", "/events"),
  ]) {
    await assert.rejects(
      prepareDeliveryGatewayRequest({ endpoint, secret: deliverySecret }, event),
      /HTTPS without embedded credentials/,
    );
  }

  const originalFetch = globalThis.fetch;
  let scannerCalls = 0;
  globalThis.fetch = async () => {
    scannerCalls += 1;
    return Response.json({ verdict: "clean" });
  };
  try {
    const bytes = new TextEncoder().encode("safe");
    const result = await scanDocument(bytes, {
      id: "ee119bec-2750-4c75-b820-e3b8ee7a116b",
      fileName: "safe.txt",
      contentType: "text/plain",
      sha256: await sha256Hex(bytes),
    }, {
      endpoint: credentialedHttpsUrl("scanner.test.invalid", "/scan"),
      secret: scannerSecret,
    });
    assert.equal(result.status, "unavailable");
    assert.equal(result.detail, "Scanner endpoint is invalid");
    assert.equal(scannerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function scannerRequest(input: {
  bytes: Uint8Array;
  documentId: string;
  declaredSha256: string;
  timestamp: string;
  signature: string;
}): Request {
  const body = new FormData();
  body.set("file", new Blob([Uint8Array.from(input.bytes).buffer], { type: "text/plain" }), "conformance.txt");
  body.set("documentId", input.documentId);
  body.set("sha256", input.declaredSha256);
  return new Request("https://scanner.test.invalid/v1/scan", {
    method: "POST",
    headers: {
      accept: "application/json",
      "x-notice-timestamp": input.timestamp,
      "x-notice-signature": `sha256=${input.signature}`,
    },
    body,
  });
}
