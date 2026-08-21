import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CustomerHostedOcrError,
  extractDocumentTextWithCustomerHostedOcr,
  scanDocument,
  SCANNER_RESPONSE_MAX_BYTES,
  sha256Hex,
} from "../app/lib/document-security";
import {
  INTEGRATION_DIAGNOSTIC_MAX_BYTES,
  INTEGRATION_LIVE_TEST_TIMEOUT_MS,
  readBoundedIntegrationDiagnostic,
} from "../app/lib/integration-response";
import { ResponseBoundaryError } from "../app/lib/response-boundary";

const scannerSecret = "scanner-response-boundary-secret-32";

test("CRM live diagnostics use the bounded parser and classify header or body stalls as timeouts", async () => {
  const source = await readFile(new URL("../app/lib/integration-runtime.ts", import.meta.url), "utf8");
  assert.match(source, /readBoundedIntegrationDiagnostic\(response\)/);
  assert.match(source, /error\.code === "header_timeout" \|\| error\.code === "body_timeout"/);
  assert.doesNotMatch(source, /response\.json\(\)/);
});

test("CRM diagnostics cancel declared and chunked oversized response bodies", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const responseKind of ["declared", "chunked"] as const) {
      let cancelled = false;
      let chunks = 0;
      globalThis.fetch = async () => {
        if (responseKind === "declared") {
          return new Response(new ReadableStream<Uint8Array>({
            cancel() { cancelled = true; },
          }), {
            headers: { "content-length": String(INTEGRATION_DIAGNOSTIC_MAX_BYTES + 1) },
          });
        }
        const chunk = new Uint8Array(Math.floor(INTEGRATION_DIAGNOSTIC_MAX_BYTES / 2) + 1);
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            chunks += 1;
            controller.enqueue(chunk);
          },
          cancel() { cancelled = true; },
        }));
      };

      const result = await readBoundedIntegrationDiagnostic(await globalThis.fetch("https://crm.orchid.test/v1/events"));
      assert.equal(result, null);
      if (responseKind === "chunked") assert.ok(chunks >= 2);
      await Promise.resolve();
      assert.equal(cancelled, true, responseKind);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CRM diagnostic bodies retain the ten-second deadline after headers arrive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull() {
      bodyStarted();
      return new Promise<void>(() => undefined);
    },
    cancel() { cancelled = true; },
  }));

  try {
    const diagnostic = readBoundedIntegrationDiagnostic(await globalThis.fetch("https://crm.orchid.test/v1/events"));
    await started;
    t.mock.timers.tick(INTEGRATION_LIVE_TEST_TIMEOUT_MS);
    await assert.rejects(
      diagnostic,
      (error) => error instanceof ResponseBoundaryError && error.code === "body_timeout",
    );
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scanner JSON cancels declared and chunked oversized response bodies", async () => {
  const originalFetch = globalThis.fetch;
  const { bytes, document } = await scannerFixture();
  try {
    for (const responseKind of ["declared", "chunked"] as const) {
      let cancelled = false;
      let chunks = 0;
      globalThis.fetch = async () => {
        if (responseKind === "declared") {
          return new Response(new ReadableStream<Uint8Array>({
            cancel() { cancelled = true; },
          }), {
            headers: { "content-length": String(SCANNER_RESPONSE_MAX_BYTES + 1) },
          });
        }
        const chunk = new Uint8Array(Math.floor(SCANNER_RESPONSE_MAX_BYTES / 2) + 1);
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            chunks += 1;
            controller.enqueue(chunk);
          },
          cancel() { cancelled = true; },
        }));
      };

      const result = await scanDocument(bytes, document, {
        endpoint: "https://scanner.orchid.test/v1/scan",
        secret: scannerSecret,
      });
      assert.equal(result.status, "unavailable");
      assert.equal(result.detail, "Scanner request failed");
      if (responseKind === "chunked") assert.ok(chunks >= 2);
      await Promise.resolve();
      assert.equal(cancelled, true, responseKind);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scanner JSON body stalls time out and cancel after headers arrive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  const { bytes, document } = await scannerFixture();
  let cancelled = false;
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull() {
      bodyStarted();
      return new Promise<void>(() => undefined);
    },
    cancel() { cancelled = true; },
  }));

  try {
    const scan = scanDocument(bytes, document, {
      endpoint: "https://scanner.orchid.test/v1/scan",
      secret: scannerSecret,
      timeoutMs: 5_000,
    });
    await started;
    t.mock.timers.tick(5_000);
    const result = await scan;
    assert.equal(result.status, "unavailable");
    assert.equal(result.detail, "Scanner timed out");
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scanner headers and body share one end-to-end deadline", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const { bytes, document } = await scannerFixture();
  let now = 1_000_000;
  let cancelled = false;
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
  Date.now = () => now;
  globalThis.fetch = async () => {
    now += 40;
    return new Response(new ReadableStream<Uint8Array>({
      pull() { bodyStarted(); return new Promise<void>(() => undefined); },
      cancel() { cancelled = true; },
    }));
  };
  try {
    const pending = scanDocument(bytes, document, {
      endpoint: "https://scanner.orchid.test/v1/scan",
      secret: scannerSecret,
      timeoutMs: 50,
    });
    await started;
    const result = await pending;
    assert.equal(result.status, "unavailable");
    assert.equal(result.detail, "Scanner timed out");
    assert.equal(cancelled, true);
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test("customer-hosted OCR shares one deadline and treats an incomplete accepted body as untrusted", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const bytes = new TextEncoder().encode("%PDF-1.4\n% deadline test\n");
  const document = {
    id: "7507c8ac-fad8-4c88-9b4d-a7ef85025d0b",
    fileName: "deadline-test.pdf",
    contentType: "application/pdf",
    sha256: await sha256Hex(bytes),
  };
  let now = 2_000_000;
  let cancelled = false;
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
  Date.now = () => now;
  globalThis.fetch = async () => {
    now += 40;
    return new Response(new ReadableStream<Uint8Array>({
      pull() { bodyStarted(); return new Promise<void>(() => undefined); },
      cancel() { cancelled = true; },
    }));
  };
  try {
    const pending = extractDocumentTextWithCustomerHostedOcr(bytes, document, {
      endpoint: "https://scanner.orchid.test/v1/scan",
      secret: scannerSecret,
      timeoutMs: 50,
      ocr: { modelId: "customer-vision-v1", profileId: "contracts-en-v1" },
    });
    await started;
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof CustomerHostedOcrError && error.code === "invalid_response",
    );
    assert.equal(cancelled, true);
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

async function scannerFixture() {
  const bytes = new TextEncoder().encode("synthetic scanner response boundary test");
  return {
    bytes,
    document: {
      id: "5507c8ac-fad8-4c88-9b4d-a7ef85025d0b",
      fileName: "boundary-test.txt",
      contentType: "text/plain",
      sha256: await sha256Hex(bytes),
    },
  };
}
