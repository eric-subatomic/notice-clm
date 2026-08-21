import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyStoredDocumentSource } from "../app/lib/stored-document-integrity";

const original = new TextEncoder().encode("governed source text");
const sha256 = createHash("sha256").update(original).digest("hex");
const expected = {
  fileName: "source.txt",
  size: original.byteLength,
  contentType: "text/plain",
  sha256,
};

function objectFor(bytes: Uint8Array, overrides: Partial<{ size: number; contentType: string }> = {}) {
  let reads = 0;
  return {
    object: {
      size: overrides.size ?? bytes.byteLength,
      httpMetadata: { contentType: overrides.contentType ?? "text/plain" },
      arrayBuffer: async () => {
        reads += 1;
        return Uint8Array.from(bytes).buffer;
      },
    },
    reads: () => reads,
  };
}

test("stored source metadata mismatches fail before untrusted bytes are buffered", async () => {
  const candidate = objectFor(original, { size: original.byteLength + 1 });
  assert.deepEqual(await verifyStoredDocumentSource(candidate.object, expected), { ok: false, reason: "metadata" });
  assert.equal(candidate.reads(), 0);
});

test("same-size R2 replacement fails the exact D1 SHA-256 boundary", async () => {
  const changed = Uint8Array.from(original);
  changed[0] ^= 1;
  const candidate = objectFor(changed);
  assert.deepEqual(await verifyStoredDocumentSource(candidate.object, expected), { ok: false, reason: "digest" });
  assert.equal(candidate.reads(), 1);
});

test("only exact stored bytes and type are returned for working-paper extraction", async () => {
  const candidate = objectFor(original);
  const result = await verifyStoredDocumentSource(candidate.object, expected);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.bytes, original);
  assert.equal(result.inspected.contentType, "text/plain");
  assert.equal(candidate.reads(), 1);
});
