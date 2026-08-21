import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

function manifestRepositoryUrl(manifest) {
  const value = typeof manifest?.repository === "string"
    ? manifest.repository
    : manifest?.repository?.url;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("package.json must declare the exact source repository URL used by release provenance.");
  }
  const url = new URL(value);
  if (
    !["https:", "git+https:"].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("package.json repository.url must be an absolute credential-free HTTPS Git URL without query or fragment data.");
  }
  return value;
}

const packageManifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));

export const SBOM_IDENTITY = Object.freeze({
  name: "notice-clm",
  version: "0.1.0",
  purl: "pkg:npm/notice-clm@0.1.0",
  bomRef: "notice-clm@0.1.0",
  repositoryUrl: manifestRepositoryUrl(packageManifest),
});

const supportedNpmVersion = "11.3.0";

const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const uuidUrlNamespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireRevision(value) {
  if (typeof value !== "string" || !revisionPattern.test(value)) {
    throw new Error("The SBOM source revision must be an exact lowercase 40- or 64-character Git object ID.");
  }
  return value;
}

function commandOutput(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`${command} ${arguments_.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

function gitOutput(arguments_) {
  return commandOutput("git", arguments_).trim();
}

function deterministicUuid(seed) {
  // UUIDv5 mandates SHA-1 for name-based identifiers; this value is not used as an integrity digest.
  const bytes = createHash("sha1").update(uuidUrlNamespace).update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function sortedProperties(properties) {
  return [...properties].sort((left, right) => {
    const nameOrder = compareText(left.name, right.name);
    return nameOrder || compareText(left.value, right.value);
  });
}

function replaceRootReference(dependencies, previousRootReference) {
  if (!Array.isArray(dependencies)) return [];
  return dependencies.map((entry) => {
    if (!isRecord(entry)) return entry;
    return {
      ...entry,
      ref: entry.ref === previousRootReference ? SBOM_IDENTITY.bomRef : entry.ref,
      ...(Array.isArray(entry.dependsOn)
        ? {
            dependsOn: entry.dependsOn.map((reference) => (
              reference === previousRootReference ? SBOM_IDENTITY.bomRef : reference
            )),
          }
        : {}),
    };
  });
}

function sourceProperties(component, revision, dirty) {
  const retained = Array.isArray(component.properties)
    ? component.properties.filter((property) => (
        isRecord(property)
        && typeof property.name === "string"
        && !property.name.startsWith("notice:source:")
      ))
    : [];
  return sortedProperties([
    ...retained,
    { name: "notice:source:git-dirty", value: dirty ? "true" : "false" },
    { name: "notice:source:git-revision", value: revision },
  ]);
}

function sourceReferences(component, revision) {
  const retained = Array.isArray(component.externalReferences)
    ? component.externalReferences.filter((reference) => isRecord(reference) && reference.type !== "vcs")
    : [];
  return [...retained, {
    type: "vcs",
    url: `${SBOM_IDENTITY.repositoryUrl}#${revision}`,
  }].sort((left, right) => {
    const typeOrder = compareText(left.type, right.type);
    return typeOrder || compareText(left.url, right.url);
  });
}

function duplicateComponentReferences(components) {
  const counts = new Map();
  for (const component of components) {
    if (!isRecord(component) || typeof component["bom-ref"] !== "string") continue;
    counts.set(component["bom-ref"], (counts.get(component["bom-ref"]) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([reference]) => reference)
    .sort(compareText);
}

function requireUnambiguousComponentReferences(components) {
  const duplicates = duplicateComponentReferences(components);
  if (duplicates.length === 0) return;
  const examples = duplicates.slice(0, 3).join(", ");
  throw new Error(
    `npm produced ambiguous duplicate component bom-ref values (${examples}). `
    + `Generate this SBOM with the repository-pinned npm ${supportedNpmVersion} toolchain; `
    + "the duplicate graph cannot be rewritten without guessing dependency edges.",
  );
}

/**
 * @param {any} rawSbom
 * @param {{ revision: string; commitTimestamp: string; dirty?: boolean }} options
 */
export function normalizeSbom(rawSbom, { revision, commitTimestamp, dirty = false }) {
  const exactRevision = requireRevision(revision);
  if (!isRecord(rawSbom) || rawSbom.bomFormat !== "CycloneDX") {
    throw new Error("npm did not produce a CycloneDX SBOM.");
  }
  if (!isRecord(rawSbom.metadata) || !isRecord(rawSbom.metadata.component)) {
    throw new Error("The CycloneDX SBOM is missing its root component.");
  }
  if (!Array.isArray(rawSbom.components) || rawSbom.components.length === 0) {
    throw new Error("The CycloneDX SBOM must contain at least one dependency component.");
  }
  requireUnambiguousComponentReferences(rawSbom.components);
  if (typeof commitTimestamp !== "string" || !Number.isFinite(Date.parse(commitTimestamp))) {
    throw new Error("The SBOM requires the exact source revision's commit timestamp.");
  }

  const previousRootReference = rawSbom.metadata.component["bom-ref"];
  const component = {
    ...rawSbom.metadata.component,
    "bom-ref": SBOM_IDENTITY.bomRef,
    type: "application",
    name: SBOM_IDENTITY.name,
    version: SBOM_IDENTITY.version,
    purl: SBOM_IDENTITY.purl,
    properties: sourceProperties(rawSbom.metadata.component, exactRevision, dirty),
    externalReferences: sourceReferences(rawSbom.metadata.component, exactRevision),
  };

  const normalized = {
    ...rawSbom,
    serialNumber: `urn:uuid:${deterministicUuid(`${SBOM_IDENTITY.purl}@${exactRevision}`)}`,
    metadata: {
      ...rawSbom.metadata,
      timestamp: commitTimestamp,
      component,
    },
    dependencies: replaceRootReference(rawSbom.dependencies, previousRootReference),
  };
  return stableValue(normalized);
}

function propertyValue(component, name) {
  if (!Array.isArray(component.properties)) return null;
  const matches = component.properties.filter((property) => isRecord(property) && property.name === name);
  if (matches.length !== 1 || typeof matches[0].value !== "string") return null;
  return matches[0].value;
}

function containsLocalPath(value, forbiddenPaths) {
  if (typeof value === "string") {
    if (/^file:/iu.test(value) || /^\//u.test(value)) return true;
    if (/^[a-z]:[\\/]/iu.test(value)) return true;
    return forbiddenPaths.some((path) => path && value.includes(path));
  }
  if (Array.isArray(value)) return value.some((item) => containsLocalPath(item, forbiddenPaths));
  if (isRecord(value)) {
    return Object.entries(value).some(([key, item]) => (
      containsLocalPath(key, forbiddenPaths) || containsLocalPath(item, forbiddenPaths)
    ));
  }
  return false;
}

/**
 * @param {any} sbom
 * @param {{ revision: string; commitTimestamp: string; requireClean?: boolean; forbiddenPaths?: string[] }} options
 */
export function validateSbom(sbom, {
  revision,
  commitTimestamp,
  requireClean = false,
  forbiddenPaths = [repositoryRoot, process.cwd()],
}) {
  const exactRevision = requireRevision(revision);
  if (!isRecord(sbom) || sbom.bomFormat !== "CycloneDX" || typeof sbom.specVersion !== "string") {
    throw new Error("The artifact is not a supported CycloneDX SBOM.");
  }
  if (!isRecord(sbom.metadata) || !isRecord(sbom.metadata.component)) {
    throw new Error("The CycloneDX artifact is missing its root component.");
  }
  if (sbom.metadata.timestamp !== commitTimestamp) {
    throw new Error("The SBOM timestamp must equal the exact source revision's commit timestamp.");
  }
  const expectedSerialNumber = `urn:uuid:${deterministicUuid(`${SBOM_IDENTITY.purl}@${exactRevision}`)}`;
  if (sbom.serialNumber !== expectedSerialNumber) {
    throw new Error("The SBOM serial number is not deterministic for the expected source revision.");
  }
  const root = sbom.metadata.component;
  if (
    root.name !== SBOM_IDENTITY.name
    || root.version !== SBOM_IDENTITY.version
    || root.purl !== SBOM_IDENTITY.purl
    || root["bom-ref"] !== SBOM_IDENTITY.bomRef
  ) {
    throw new Error("The SBOM root must identify notice-clm@0.1.0 by name, version, purl, and bom-ref.");
  }
  if (propertyValue(root, "notice:source:git-revision") !== exactRevision) {
    throw new Error("The SBOM is not bound to the expected exact Git revision.");
  }
  const dirty = propertyValue(root, "notice:source:git-dirty");
  if (dirty !== "true" && dirty !== "false") {
    throw new Error("The SBOM must record whether its source checkout was dirty.");
  }
  if (requireClean && dirty !== "false") {
    throw new Error("Release SBOMs must be generated from a clean source checkout.");
  }
  if (!Array.isArray(root.externalReferences) || !root.externalReferences.some((reference) => (
    isRecord(reference)
    && reference.type === "vcs"
    && reference.url === `${SBOM_IDENTITY.repositoryUrl}#${exactRevision}`
  ))) {
    throw new Error("The SBOM root is missing its revision-bound VCS reference.");
  }
  if (!Array.isArray(sbom.components) || sbom.components.length === 0) {
    throw new Error("The CycloneDX SBOM must contain at least one dependency component.");
  }
  const componentReferences = sbom.components.map((component) => (
    isRecord(component) ? component["bom-ref"] : null
  ));
  if (componentReferences.some((reference) => typeof reference !== "string" || reference.length === 0)) {
    throw new Error("Every SBOM dependency component must have a nonempty bom-ref.");
  }
  if (new Set(componentReferences).size !== componentReferences.length) {
    throw new Error("SBOM dependency component bom-ref values must be unique.");
  }
  const rootGraphEntries = Array.isArray(sbom.dependencies)
    ? sbom.dependencies.filter((entry) => isRecord(entry) && entry.ref === SBOM_IDENTITY.bomRef)
    : [];
  if (rootGraphEntries.length !== 1) {
    throw new Error("The SBOM dependency graph is missing the notice-clm root.");
  }
  if (!Array.isArray(rootGraphEntries[0].dependsOn) || rootGraphEntries[0].dependsOn.length === 0) {
    throw new Error("The notice-clm SBOM root must reference at least one dependency component.");
  }
  if (containsLocalPath(sbom, [...new Set(forbiddenPaths)])) {
    throw new Error("The SBOM contains a local filesystem path.");
  }
  return sbom;
}

function parseArguments(arguments_) {
  const options = {
    command: "generate",
    input: null,
    output: null,
    revision: null,
    requireClean: false,
  };
  let index = 0;
  if (arguments_[0] === "generate" || arguments_[0] === "validate") {
    options.command = arguments_[0];
    index = 1;
  }
  for (; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--input" && options.input === null && arguments_[index + 1]) {
      options.input = arguments_[index + 1];
      index += 1;
    } else if (argument === "--output" && options.output === null && arguments_[index + 1]) {
      options.output = arguments_[index + 1];
      index += 1;
    } else if (argument === "--revision" && options.revision === null && arguments_[index + 1]) {
      options.revision = arguments_[index + 1];
      index += 1;
    } else if (argument === "--require-clean" && !options.requireClean) {
      options.requireClean = true;
    } else {
      throw new Error(`Unsupported SBOM argument: ${argument}`);
    }
  }
  if (options.command === "validate" && !options.input) {
    throw new Error("SBOM validation requires --input <path>.");
  }
  if (options.command === "validate" && options.output) {
    throw new Error("SBOM validation does not accept --output.");
  }
  if (options.command === "generate" && options.input) {
    throw new Error("SBOM generation does not accept --input.");
  }
  return options;
}

async function assertProjectIdentity() {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
  if (manifest.name !== SBOM_IDENTITY.name || manifest.version !== SBOM_IDENTITY.version) {
    throw new Error("package.json must identify notice-clm@0.1.0 before an SBOM can be generated.");
  }
  if (manifestRepositoryUrl(manifest) !== SBOM_IDENTITY.repositoryUrl) {
    throw new Error("package.json repository provenance changed after the SBOM tool was loaded.");
  }
  const lockfile = JSON.parse(await readFile(resolve(repositoryRoot, "package-lock.json"), "utf8"));
  if (
    lockfile.name !== SBOM_IDENTITY.name
    || lockfile.version !== SBOM_IDENTITY.version
    || lockfile.packages?.[""]?.name !== SBOM_IDENTITY.name
    || lockfile.packages?.[""]?.version !== SBOM_IDENTITY.version
  ) {
    throw new Error("package-lock.json must identify notice-clm@0.1.0 before an SBOM can be generated.");
  }
}

function resolveSourceRevision(requestedRevision) {
  const head = requireRevision(gitOutput(["rev-parse", "HEAD"]));
  if (requestedRevision !== null && requireRevision(requestedRevision) !== head) {
    throw new Error(`The requested SBOM revision ${requestedRevision} does not match checked-out HEAD ${head}.`);
  }
  return head;
}

function isDirtyCheckout() {
  return gitOutput(["status", "--porcelain", "--untracked-files=normal"]).length > 0;
}

function generateRawSbom() {
  const npmExecutable = process.env.npm_execpath;
  const command = npmExecutable ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
  const prefix = npmExecutable ? [npmExecutable] : [];
  const detectedVersion = commandOutput(command, [...prefix, "--version"]).trim();
  if (detectedVersion !== supportedNpmVersion) {
    throw new Error(
      `SBOM generation requires the repository-pinned npm ${supportedNpmVersion}; found ${detectedVersion || "an unknown version"}. `
      + `Install npm ${supportedNpmVersion} and run npm run sbom so npm_execpath selects the supported generator.`,
    );
  }
  return commandOutput(command, [
    ...prefix,
    "sbom",
    "--sbom-format",
    "cyclonedx",
    "--package-lock-only",
  ]);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await assertProjectIdentity();
  const revision = resolveSourceRevision(options.revision);
  const commitTimestamp = gitOutput(["show", "-s", "--format=%cI", revision]);

  if (options.command === "validate") {
    const artifact = JSON.parse(await readFile(resolve(process.cwd(), options.input), "utf8"));
    validateSbom(artifact, { revision, commitTimestamp, requireClean: options.requireClean });
    process.stdout.write(`Validated CycloneDX SBOM for ${SBOM_IDENTITY.name}@${SBOM_IDENTITY.version} at ${revision}.\n`);
    return;
  }

  const dirty = isDirtyCheckout();
  if (options.requireClean && dirty) {
    throw new Error("Refusing to generate a release SBOM from a dirty source checkout.");
  }
  const rawSbom = JSON.parse(generateRawSbom());
  const artifact = normalizeSbom(rawSbom, {
    revision,
    commitTimestamp,
    dirty,
  });
  validateSbom(artifact, { revision, commitTimestamp, requireClean: options.requireClean });
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  if (options.output) {
    await writeFile(resolve(process.cwd(), options.output), serialized, { encoding: "utf8", flag: "w" });
    return;
  }
  process.stdout.write(serialized);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
