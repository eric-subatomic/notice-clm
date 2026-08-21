import assert from "node:assert/strict";
import test from "node:test";
import { findReusableSignedArtifact } from "../app/lib/signed-artifact-reuse";

const artifactBytes = new TextEncoder().encode("signed artifact");
const scope = {
  workspaceId: "orchid",
  agreementId: 42,
  sha256: "d47929d2c71abeb96335f7c202caec40c34f2a38699f503fa4adc43c45b383c9",
  providerMessageId: "submission-17",
  parentSha256: "a".repeat(64),
};

const candidate = {
  id: "document-1",
  ...scope,
  objectKey: "workspaces/orchid/signed/42/packet/document-1/signed.pdf",
  size: artifactBytes.byteLength,
  scanStatus: "clean",
  deletedAt: null,
  role: "signed_artifact",
  direction: "inbound",
};

const storedBody = (overrides: Partial<{
  size: number;
  customMetadata: Record<string, string>;
  bytes: Uint8Array;
}> = {}) => {
  const bytes = overrides.bytes ?? artifactBytes;
  return {
    size: overrides.size ?? bytes.byteLength,
    customMetadata: overrides.customMetadata ?? {
      sha256: scope.sha256,
      documentId: candidate.id,
      source: "docuseal-signed-artifact",
      scanStatus: "clean",
    },
    arrayBuffer: async () => bytes.slice().buffer,
  };
};

test("signed artifact reuse requires a live clean row and an existing matching R2 object", async () => {
  const reused = await findReusableSignedArtifact([candidate], scope, async () => storedBody());
  assert.equal(reused?.id, candidate.id);

  assert.equal(await findReusableSignedArtifact([candidate], scope, async () => null), null);
  assert.equal(await findReusableSignedArtifact([candidate], scope, async () => storedBody({ size: candidate.size + 1 })), null);
  assert.equal(await findReusableSignedArtifact([{ ...candidate, size: 0 }], scope, async () => storedBody({ size: 0 })), null);
  assert.equal(await findReusableSignedArtifact([candidate], scope, async () => storedBody({
    customMetadata: { sha256: "b".repeat(64) },
  })), null);
  assert.equal(await findReusableSignedArtifact([candidate], scope, async () => storedBody({
    bytes: new TextEncoder().encode("tampered bytes!"),
  })), null);
});

test("signed artifact reuse rejects cross-scope, wrong-lineage, deleted, unclean, and unsafe rows before R2 access", async () => {
  let getCalls = 0;
  const get = async () => {
    getCalls += 1;
    return storedBody();
  };
  const rejected = [
    { ...candidate, workspaceId: "other" },
    { ...candidate, agreementId: 99 },
    { ...candidate, sha256: "b".repeat(64) },
    { ...candidate, role: "initial_source" },
    { ...candidate, direction: "outbound" },
    { ...candidate, providerMessageId: "submission-other" },
    { ...candidate, parentSha256: "b".repeat(64) },
    { ...candidate, scanStatus: "malicious" },
    { ...candidate, deletedAt: "2026-08-01T12:00:00.000Z" },
    { ...candidate, objectKey: "workspaces/orchid/../other/signed.pdf" },
  ];

  assert.equal(await findReusableSignedArtifact(rejected, scope, get), null);
  assert.equal(getCalls, 0);
});

test("an R2 lookup failure is not treated as proof that an artifact still exists", async () => {
  assert.equal(await findReusableSignedArtifact([candidate], scope, async () => {
    throw new Error("temporary R2 failure");
  }), null);
});
