import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSbom, SBOM_IDENTITY, validateSbom } from "../scripts/sbom.mjs";

const revision = "1".repeat(40);
const commitTimestamp = "2026-08-03T00:07:06+02:00";
const repositoryWebUrl = SBOM_IDENTITY.repositoryUrl.replace(/^git\+/, "").replace(/\.git$/, "");

function rawSbom(overrides: Record<string, unknown> = {}) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    version: 1,
    metadata: {
      timestamp: "2099-01-01T00:00:00.000Z",
      component: {
        "bom-ref": "checkout-folder@0.1.0",
        type: "library",
        name: "checkout-folder",
        version: "0.1.0",
        purl: SBOM_IDENTITY.purl,
        properties: [{ name: "cdx:npm:package:private", value: "true" }],
        externalReferences: [
          { type: "vcs", url: SBOM_IDENTITY.repositoryUrl },
          { type: "website", url: repositoryWebUrl },
        ],
      },
    },
    components: [{
      "bom-ref": "jose@6.2.9",
      type: "library",
      name: "jose",
      version: "6.2.9",
      purl: "pkg:npm/jose@6.2.9",
    }],
    dependencies: [
      { ref: "checkout-folder@0.1.0", dependsOn: ["jose@6.2.9"] },
      { ref: "jose@6.2.9", dependsOn: [] },
    ],
    ...overrides,
  };
}

test("SBOM normalization fixes root identity and binds the exact source revision", () => {
  const artifact = normalizeSbom(rawSbom(), { revision, commitTimestamp, dirty: false });
  const root = artifact.metadata.component;

  assert.equal(root.name, "notice-clm");
  assert.equal(root.version, "0.1.0");
  assert.equal(root.purl, "pkg:npm/notice-clm@0.1.0");
  assert.equal(root["bom-ref"], "notice-clm@0.1.0");
  assert.equal(root.type, "application");
  assert.equal(artifact.metadata.timestamp, commitTimestamp);
  assert.ok(root.properties.some((property: { name: string; value: string }) => (
    property.name === "notice:source:git-revision" && property.value === revision
  )));
  assert.ok(root.externalReferences.some((reference: { type: string; url: string }) => (
    reference.type === "vcs" && reference.url === `${SBOM_IDENTITY.repositoryUrl}#${revision}`
  )));
  assert.ok(artifact.dependencies.some((dependency: { ref: string }) => (
    dependency.ref === "notice-clm@0.1.0"
  )));
  assert.equal(validateSbom(artifact, { revision, commitTimestamp, requireClean: true }), artifact);
});

test("SBOM normalization is deterministic for one source revision", () => {
  const first = normalizeSbom(rawSbom(), { revision, commitTimestamp, dirty: false });
  const secondRaw = rawSbom({
    serialNumber: "urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  secondRaw.metadata.timestamp = "2100-01-01T00:00:00.000Z";
  const second = normalizeSbom(secondRaw, { revision, commitTimestamp, dirty: false });

  assert.deepEqual(second, first);
  assert.match(first.serialNumber, /^urn:uuid:[a-f0-9-]{36}$/);
});

test("SBOM validation rejects empty inventories and spoofed project identities", () => {
  assert.throws(
    () => normalizeSbom(rawSbom({ components: [] }), { revision, commitTimestamp }),
    /at least one dependency component/,
  );

  const artifact = normalizeSbom(rawSbom(), { revision, commitTimestamp });
  artifact.metadata.component.name = "different-project";
  assert.throws(
    () => validateSbom(artifact, { revision, commitTimestamp }),
    /root must identify notice-clm@0.1.0/,
  );
});

test("SBOM normalization refuses npm 10 graphs with ambiguous duplicate component references", () => {
  const duplicateReference = "debug@3.2.7";
  const npm10Artifact = rawSbom({
    components: [
      {
        "bom-ref": duplicateReference,
        type: "library",
        name: "debug",
        version: "3.2.7",
        purl: "pkg:npm/debug@3.2.7",
        properties: [{
          name: "cdx:npm:package:path",
          value: "node_modules/eslint-import-resolver-node/node_modules/debug",
        }],
      },
      {
        "bom-ref": duplicateReference,
        type: "library",
        name: "debug",
        version: "3.2.7",
        purl: "pkg:npm/debug@3.2.7",
        properties: [{
          name: "cdx:npm:package:path",
          value: "node_modules/eslint-plugin-import/node_modules/debug",
        }],
      },
    ],
    dependencies: [
      { ref: "checkout-folder@0.1.0", dependsOn: [duplicateReference] },
      { ref: duplicateReference, dependsOn: ["ms@2.1.3"] },
      { ref: duplicateReference, dependsOn: ["ms@2.1.3"] },
    ],
  });

  assert.equal(npm10Artifact.components.length, 2);
  assert.throws(
    () => normalizeSbom(npm10Artifact, { revision, commitTimestamp, dirty: false }),
    /ambiguous duplicate component bom-ref values \(debug@3\.2\.7\).*npm 11\.3\.0.*without guessing dependency edges/,
  );
  assert.equal(npm10Artifact.components.length, 2, "normalization must not silently discard duplicate installs");
});

test("SBOM validation rejects revision mismatches, dirty releases, and local paths", () => {
  const artifact = normalizeSbom(rawSbom(), { revision, commitTimestamp, dirty: true });
  assert.throws(
    () => validateSbom(artifact, { revision: "2".repeat(40), commitTimestamp }),
    /serial number is not deterministic|not bound to the expected exact Git revision/,
  );
  assert.throws(
    () => validateSbom(artifact, { revision, commitTimestamp, requireClean: true }),
    /clean source checkout/,
  );

  const cleanArtifact = normalizeSbom(rawSbom(), { revision, commitTimestamp, dirty: false });
  cleanArtifact.components[0].evidence = { notes: "/Users/example/private-checkout/package.json" };
  assert.throws(
    () => validateSbom(cleanArtifact, { revision, commitTimestamp }),
    /local filesystem path/,
  );
});
