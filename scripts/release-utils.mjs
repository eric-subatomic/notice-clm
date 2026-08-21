import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const secretNamePattern = /^[A-Z][A-Z0-9_]{1,127}$/;
const cloudflareAccountIdPattern = /^[a-f0-9]{32}$/;
const gitRevisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const workerVersionIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const workerNotFoundCodePattern = /\[code:\s*(?:10007|10090)\]/;
const r2BucketNotFoundCodePattern = /\[code:\s*10006\]/;
const MAX_CAPTURED_COMMAND_BYTES = 1_048_576;
const MAX_WRANGLER_ATTESTATION_BYTES = 65_536;
const pinnedWranglerRunner = Symbol("pinnedWranglerRunner");
const pinnedWranglerInputs = new WeakMap();
const guardedReleaseCommandEnvironments = new WeakSet();
const guardedReleaseWranglerEnvironments = new WeakSet();
const EXPECTED_WRANGLER_VERSION = "4.123.0";
const EXPECTED_VINEXT_VERSION = "1.0.0-beta.7";
const releaseRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerCliPath = fileURLToPath(import.meta.resolve("wrangler"));
const wranglerPackageJsonPath = fileURLToPath(import.meta.resolve("wrangler/package.json"));
const vinextPackageJsonPath = resolve(releaseRepositoryRoot, "node_modules/vinext/package.json");
const vinextCliPath = resolve(releaseRepositoryRoot, "node_modules/vinext/dist/cli.js");
const guardedVinextPreloadPath = fileURLToPath(new URL("./guarded-vinext-preload.cjs", import.meta.url));
const pinnedWranglerPreloadPath = fileURLToPath(new URL("./pinned-wrangler-preload.cjs", import.meta.url));
const placeholderPattern = /^(?:change[-_ ]?me|example|password|replace(?:[-_ ]?me)?|secret|todo|tbd|unset|your[-_ ])/i;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const minimumSecretLengths = Object.freeze({
  NOTICE_AUDIT_SIGNING_KEY: 32,
  NOTICE_CRM_CUSTOM_SECRET: 32,
  NOTICE_CRM_GATEWAY_SECRET: 32,
  NOTICE_CRM_HUBSPOT_ACCESS_TOKEN: 20,
  NOTICE_CRM_SALESFORCE_CLIENT_ID: 10,
  NOTICE_CRM_SALESFORCE_CLIENT_SECRET: 16,
  NOTICE_DELIVERY_GATEWAY_SECRET: 32,
  NOTICE_DOCUSEAL_WEBHOOK_SECRET: 32,
  NOTICE_INGRESS_PREVIOUS_SECRET: 32,
  NOTICE_INGRESS_SECRET: 32,
  NOTICE_INBOUND_EMAIL_SECRET: 32,
  NOTICE_JOB_RUNNER_SECRET: 32,
  NOTICE_OPERATIONS_SECRET: 32,
  NOTICE_SCAN_GATEWAY_SECRET: 32,
});
const independentSecretNames = Object.freeze([
  "NOTICE_AUDIT_SIGNING_KEY",
  "NOTICE_CRM_CUSTOM_SECRET",
  "NOTICE_CRM_GATEWAY_SECRET",
  "NOTICE_DELIVERY_GATEWAY_SECRET",
  "NOTICE_DOCUSEAL_API_TOKEN",
  "NOTICE_DOCUSEAL_MCP_TOKEN",
  "NOTICE_DOCUSEAL_WEBHOOK_SECRET",
  "NOTICE_INGRESS_PREVIOUS_SECRET",
  "NOTICE_INGRESS_SECRET",
  "NOTICE_INBOUND_EMAIL_SECRET",
  "NOTICE_JOB_RUNNER_SECRET",
  "NOTICE_OPERATIONS_SECRET",
  "NOTICE_SCAN_GATEWAY_SECRET",
]);

export function rejectInternalReleaseSettings(candidate) {
  if (typeof candidate === "string") {
    if (candidate.startsWith("NOTICE_INTERNAL_")) {
      throw new Error("NOTICE_INTERNAL_* settings are forbidden in release deployment inputs.");
    }
    return;
  }
  if (Array.isArray(candidate)) {
    for (const value of candidate) rejectInternalReleaseSettings(value);
    return;
  }
  if (!candidate || typeof candidate !== "object") return;
  for (const [key, value] of Object.entries(candidate)) {
    if (key.startsWith("NOTICE_INTERNAL_")) {
      throw new Error("NOTICE_INTERNAL_* settings are forbidden in release deployment inputs.");
    }
    rejectInternalReleaseSettings(value);
  }
}

/** @param {Readonly<Record<string, string | undefined>>} [candidate] */
export function rejectInternalReleaseEnvironment(candidate = process.env) {
  if (Object.keys(candidate).some((name) => name.toUpperCase().startsWith("NOTICE_INTERNAL_"))) {
    throw new Error("NOTICE_INTERNAL_* environment settings are forbidden during a release deployment.");
  }
}

const releaseLoaderEnvironmentNames = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
]);
const wranglerEnvironmentPrefixes = Object.freeze([
  "CLOUDFLARE_",
  "CF_",
  "WRANGLER_",
  "WORKERS_",
  "OPEN_NEXT_",
]);
const strippedGitEnvironmentPrefix = "GIT_";
const nativeSubprocessControlPrefixes = Object.freeze(["LD_", "DYLD_"]);
const inheritedSubprocessControlNames = new Set([
  "ESBUILD_BINARY_PATH",
  "NAPI_RS_NATIVE_LIBRARY_PATH",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "VP_RUN_NODE_CLIENT_PATH",
]);
const strippedBuildEnvironmentPrefixes = Object.freeze([
  "CLOUDFLARED_",
  "DOTENV_",
  "MINIFLARE_",
  "NEXT_",
  "__NEXT_",
  "NOTICE_",
  "VINEXT_",
  "__VINEXT_",
  "VERCEL_",
  "VITE_",
]);
const forcedBuildEnvironmentNames = new Set([
  "__VINEXT_SHARED_REVALIDATE_SECRET",
  "NODE_ENV",
  "VITE_USER_NODE_ENV",
]);
const strippedTrustOverrideNames = new Set([
  "NODE_EXTRA_CA_CERTS",
  "OPENSSL_CONF",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
]);
const allowedWranglerCredentialName = "CLOUDFLARE_API_TOKEN";

/**
 * Validate the operator environment once and derive least-privilege child
 * environments. Git and the production build receive no Cloudflare token or
 * Wrangler controls. The pinned Wrangler child receives only the supported
 * API-token credential plus code-forced production, logging, and telemetry
 * settings. Empty Node loader sentinels prevent Vinext dotenv loading from
 * restoring executable loader options before it forks build workers.
 *
 * @param {Readonly<Record<string, string | undefined>>} [candidate]
 * @param {Readonly<Record<string, string | undefined>>} [overrides]
 */
export function createGuardedReleaseEnvironments(candidate = process.env, overrides = {}) {
  const credentialEntries = [];
  /** @type {Record<string, string | undefined>} */
  const command = {};
  for (const [name, value] of Object.entries(candidate)) {
    const normalized = name.toUpperCase().replaceAll("-", "_");
    if (inheritedSubprocessControlNames.has(normalized)
      || nativeSubprocessControlPrefixes.some((prefix) => normalized.startsWith(prefix))) {
      throw new Error(`Release deployment forbids inherited subprocess control setting ${name}.`);
    }
    if (normalized.startsWith(strippedGitEnvironmentPrefix)) continue;
    const wranglerSetting = wranglerEnvironmentPrefixes.some((prefix) => normalized.startsWith(prefix));
    if (wranglerSetting) {
      if (normalized !== allowedWranglerCredentialName) {
        throw new Error(`Release deployment forbids inherited Wrangler control setting ${name}.`);
      }
      credentialEntries.push([name, value]);
      continue;
    }
    if (normalized.startsWith("NPM_CONFIG_")
      || strippedBuildEnvironmentPrefixes.some((prefix) => normalized.startsWith(prefix))
      || forcedBuildEnvironmentNames.has(normalized)
      || strippedTrustOverrideNames.has(normalized)
      || releaseLoaderEnvironmentNames.has(normalized)) continue;
    command[name] = value;
  }
  if (credentialEntries.length > 1) {
    throw new Error("Release deployment accepts only one unambiguous CLOUDFLARE_API_TOKEN setting.");
  }
  const credential = credentialEntries[0]?.[1];
  if (credentialEntries.length === 1
    && (typeof credential !== "string" || !/^[\x21-\x7e]{20,4096}$/.test(credential))) {
    throw new Error("CLOUDFLARE_API_TOKEN must be a bounded visible-ASCII token when supplied for a release deployment.");
  }
  let wranglerLogPath;
  for (const [name, value] of Object.entries(overrides)) {
    const normalized = name.toUpperCase().replaceAll("-", "_");
    if (inheritedSubprocessControlNames.has(normalized)
      || nativeSubprocessControlPrefixes.some((prefix) => normalized.startsWith(prefix))) {
      throw new Error(`The guarded release cannot override subprocess control setting ${name}.`);
    }
    if (normalized.startsWith(strippedGitEnvironmentPrefix)) continue;
    if (normalized.startsWith("NPM_CONFIG_")
      || strippedBuildEnvironmentPrefixes.some((prefix) => normalized.startsWith(prefix))
      || forcedBuildEnvironmentNames.has(normalized)
      || strippedTrustOverrideNames.has(normalized)
      || releaseLoaderEnvironmentNames.has(normalized)) continue;
    const allowedOverride = normalized === "WRANGLER_LOG_PATH";
    if (wranglerEnvironmentPrefixes.some((prefix) => normalized.startsWith(prefix)) && !allowedOverride) {
      throw new Error(`The guarded release cannot override Wrangler control setting ${name}.`);
    }
    if (allowedOverride) {
      if (typeof value !== "string" || !isAbsolute(value)) {
        throw new Error("The guarded Wrangler log path must be absolute.");
      }
      wranglerLogPath = value;
      continue;
    }
    command[name] = value;
  }
  Object.assign(command, {
    DYLD_FALLBACK_FRAMEWORK_PATH: "",
    DYLD_FALLBACK_LIBRARY_PATH: "",
    DYLD_FRAMEWORK_PATH: "",
    DYLD_IMAGE_SUFFIX: "",
    DYLD_INSERT_LIBRARIES: "",
    DYLD_LIBRARY_PATH: "",
    DYLD_ROOT_PATH: "",
    ESBUILD_BINARY_PATH: "",
    LD_AUDIT: "",
    LD_LIBRARY_PATH: "",
    LD_PRELOAD: "",
    NAPI_RS_NATIVE_LIBRARY_PATH: "",
    NODE_ENV: "production",
    NODE_EXTRA_CA_CERTS: "",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    NODE_REPL_EXTERNAL_MODULE: "",
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
    NPM_CONFIG_NODE_OPTIONS: "",
    npm_config_node_options: "",
    OPENSSL_CONF: "",
    SSL_CERT_DIR: "",
    SSL_CERT_FILE: "",
    VITE_USER_NODE_ENV: "",
    VP_RUN_NODE_CLIENT_PATH: "",
    __VINEXT_SHARED_REVALIDATE_SECRET: "",
  });
  const commandEnvironment = Object.freeze(command);
  /** @type {Readonly<Record<string, string | undefined>>} */
  const wranglerEnvironment = Object.freeze({
    ...command,
    ...(credential === undefined ? {} : { CLOUDFLARE_API_TOKEN: credential }),
    ...(wranglerLogPath === undefined ? {} : { WRANGLER_LOG_PATH: wranglerLogPath }),
    WRANGLER_API_ENVIRONMENT: "production",
    CLOUDFLARE_COMPLIANCE_REGION: "public",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    ...(credential === undefined ? {} : { CLOUDFLARE_AUTH_USE_KEYRING: "false" }),
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false",
  });
  guardedReleaseCommandEnvironments.add(commandEnvironment);
  guardedReleaseWranglerEnvironments.add(wranglerEnvironment);
  return Object.freeze({
    authentication: credential === undefined ? "stored-login" : "api-token",
    command: commandEnvironment,
    wrangler: wranglerEnvironment,
  });
}

function normalizedRequiredNames(candidate) {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw new Error("The generated deployment config must declare at least one required secret name.");
  }
  const names = candidate.map((name) => {
    if (typeof name !== "string" || !secretNamePattern.test(name)) {
      throw new Error("The generated deployment config contains an invalid required secret name.");
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new Error("The generated deployment config contains duplicate required secret names.");
  }
  return names.sort();
}

export function validateRequiredSecretDeclaration(candidate, expectedNames) {
  const actual = normalizedRequiredNames(candidate);
  const expected = normalizedRequiredNames([...expectedNames]);
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("The generated deployment config does not declare the exact required secret-name set.");
  }
  return Object.freeze(actual);
}

export function parseFirstInstallArguments(args) {
  if (args[0] !== "first-install") {
    throw new Error("This release command supports only the explicit first-install mode.");
  }

  let config = null;
  let secretsFile = null;
  let confirmedEmptyEnvironment = false;
  let confirmedWorkersPaidPlan = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config" && config === null && args[index + 1]) {
      config = args[index + 1];
      index += 1;
    } else if (argument === "--secrets-file" && secretsFile === null && args[index + 1]) {
      secretsFile = args[index + 1];
      index += 1;
    } else if (argument === "--confirm-empty-environment" && !confirmedEmptyEnvironment) {
      confirmedEmptyEnvironment = true;
    } else if (argument === "--confirm-workers-paid-plan" && !confirmedWorkersPaidPlan) {
      confirmedWorkersPaidPlan = true;
    } else {
      throw new Error("Only first-install, one --config, one --secrets-file, --confirm-empty-environment, and --confirm-workers-paid-plan are accepted.");
    }
  }

  if (!config) throw new Error("A generated deployment config is required.");
  if (!secretsFile) throw new Error("A secrets file is required for every first installation.");
  if (!confirmedEmptyEnvironment) {
    throw new Error("Refusing to continue without --confirm-empty-environment; upgrades are not supported by this command.");
  }
  if (!confirmedWorkersPaidPlan) {
    throw new Error("Refusing production deployment without --confirm-workers-paid-plan; Workers Free is unsupported.");
  }
  return Object.freeze({
    mode: "first-install",
    config,
    secretsFile,
    confirmedEmptyEnvironment: true,
    confirmedWorkersPaidPlan: true,
  });
}

export function parseConfigurationPromotionArguments(args) {
  if (args[0] !== "configuration-promotion") {
    throw new Error("This release command requires the explicit configuration-promotion mode.");
  }

  let config = null;
  let expectedCurrentVersion = null;
  let confirmedConfigurationOnly = false;
  let confirmedWorkersPaidPlan = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config" && config === null && args[index + 1]) {
      config = args[index + 1];
      index += 1;
    } else if (argument === "--expected-current-version" && expectedCurrentVersion === null && args[index + 1]) {
      expectedCurrentVersion = args[index + 1].toLowerCase();
      index += 1;
    } else if (argument === "--confirm-configuration-only" && !confirmedConfigurationOnly) {
      confirmedConfigurationOnly = true;
    } else if (argument === "--confirm-workers-paid-plan" && !confirmedWorkersPaidPlan) {
      confirmedWorkersPaidPlan = true;
    } else {
      throw new Error("Only configuration-promotion, one --config, one --expected-current-version, --confirm-configuration-only, and --confirm-workers-paid-plan are accepted; secret files are forbidden.");
    }
  }

  if (!config) throw new Error("A generated deployment config is required.");
  if (!expectedCurrentVersion || !workerVersionIdPattern.test(expectedCurrentVersion)) {
    throw new Error("A valid --expected-current-version Worker UUID is required.");
  }
  if (!confirmedConfigurationOnly) {
    throw new Error("Refusing to continue without --confirm-configuration-only.");
  }
  if (!confirmedWorkersPaidPlan) {
    throw new Error("Refusing production deployment without --confirm-workers-paid-plan; Workers Free is unsupported.");
  }
  return Object.freeze({
    mode: "configuration-promotion",
    config,
    expectedCurrentVersion,
    confirmedConfigurationOnly: true,
    confirmedWorkersPaidPlan: true,
  });
}

export function parseFirstInstallResumeArguments(args) {
  if (args[0] !== "first-install-resume") {
    throw new Error("This release command requires the explicit first-install-resume mode.");
  }

  let config = null;
  let secretsFile = null;
  let expectedBootstrapVersion = null;
  let confirmedStrandedFirstInstall = false;
  let confirmedWorkersPaidPlan = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config" && config === null && args[index + 1]) {
      config = args[index + 1];
      index += 1;
    } else if (argument === "--secrets-file" && secretsFile === null && args[index + 1]) {
      secretsFile = args[index + 1];
      index += 1;
    } else if (argument === "--expected-bootstrap-version" && expectedBootstrapVersion === null && args[index + 1]) {
      expectedBootstrapVersion = args[index + 1].toLowerCase();
      index += 1;
    } else if (argument === "--confirm-stranded-first-install" && !confirmedStrandedFirstInstall) {
      confirmedStrandedFirstInstall = true;
    } else if (argument === "--confirm-workers-paid-plan" && !confirmedWorkersPaidPlan) {
      confirmedWorkersPaidPlan = true;
    } else {
      throw new Error("Only first-install-resume, one --config, one --secrets-file, one --expected-bootstrap-version, --confirm-stranded-first-install, and --confirm-workers-paid-plan are accepted.");
    }
  }

  if (!config) throw new Error("A generated deployment config is required.");
  if (!secretsFile) throw new Error("The original first-install secrets file is required for resume.");
  if (!expectedBootstrapVersion || !workerVersionIdPattern.test(expectedBootstrapVersion)) {
    throw new Error("A valid --expected-bootstrap-version Worker UUID is required.");
  }
  if (!confirmedStrandedFirstInstall) {
    throw new Error("Refusing to resume without --confirm-stranded-first-install.");
  }
  if (!confirmedWorkersPaidPlan) {
    throw new Error("Refusing production deployment without --confirm-workers-paid-plan; Workers Free is unsupported.");
  }
  return Object.freeze({
    mode: "first-install-resume",
    config,
    secretsFile,
    expectedBootstrapVersion,
    confirmedStrandedFirstInstall: true,
    confirmedWorkersPaidPlan: true,
  });
}

export function parseReleaseArguments(args) {
  if (args[0] === "first-install") return parseFirstInstallArguments(args);
  if (args[0] === "first-install-resume") return parseFirstInstallResumeArguments(args);
  if (args[0] === "configuration-promotion") return parseConfigurationPromotionArguments(args);
  throw new Error("Choose the explicit first-install, first-install-resume, or configuration-promotion release mode.");
}

export function validateCloudflareAccountId(candidate) {
  if (typeof candidate !== "string" || candidate !== candidate.toLowerCase() || !cloudflareAccountIdPattern.test(candidate)) {
    throw new Error("The deployment config must pin a lowercase 32-character hexadecimal Cloudflare account ID.");
  }
  return candidate;
}

export function validateSourceRevision(candidate) {
  if (typeof candidate !== "string" || candidate !== candidate.toLowerCase() || !gitRevisionPattern.test(candidate)) {
    throw new Error("The deployment config must pin the exact lowercase 40- or 64-character Git source revision.");
  }
  return candidate;
}

export function releaseSourceTag(candidate) {
  return `notice-source-${validateSourceRevision(candidate)}`.slice(0, 64);
}

export function autoProvisionedResourceName(workerName, bindingName) {
  if (typeof workerName !== "string" || typeof bindingName !== "string") {
    throw new Error("A Worker and binding name are required for resource preflight.");
  }
  return `${workerName}-${bindingName.toLowerCase().replaceAll("_", "-")}`;
}

function parsedJson(source, description) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${description} did not return valid JSON.`);
  }
}

export function validateWranglerAccountIdentity(source, expectedAccountId) {
  const accountId = validateCloudflareAccountId(expectedAccountId);
  const candidate = parsedJson(source, "Wrangler account verification");
  const accounts = Array.isArray(candidate?.accounts) ? candidate.accounts : [];
  if (candidate?.loggedIn !== true || !accounts.some((account) => account?.id === accountId)) {
    throw new Error("The active Wrangler credential is not authorized for the pinned Cloudflare account.");
  }
  return Object.freeze({ accountIdSuffix: accountId.slice(-6) });
}

export function validateReleaseCheckout(statusOutput, revisionOutput, expectedRevision) {
  const revision = validateSourceRevision(expectedRevision);
  if (typeof statusOutput !== "string" || statusOutput.trim() !== "") {
    throw new Error("Release deployment requires a clean checkout with no tracked or untracked source changes.");
  }
  if (typeof revisionOutput !== "string" || revisionOutput.trim().toLowerCase() !== revision) {
    throw new Error("The checked-out Git revision does not match the deployment manifest sourceRevision.");
  }
  return revision;
}

export function validateWorkerAbsent(result) {
  if (result?.code === 0) {
    throw new Error("First installation requires an absent Worker target; the pinned Worker already exists.");
  }
  const diagnostic = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  if (!workerNotFoundCodePattern.test(diagnostic)) {
    throw new Error("Worker absence could not be proven; refusing every first-install mutation.");
  }
  return true;
}

export function validateD1ResourceAbsent(source, expectedName) {
  const databases = parsedJson(source, "Remote D1 resource preflight");
  if (!Array.isArray(databases)
    || databases.some((database) => typeof database?.name !== "string")) {
    throw new Error("Remote D1 resource preflight returned malformed inventory.");
  }
  if (databases.some((database) => database.name === expectedName)) {
    throw new Error(`First installation requires absent auto-provision target ${expectedName}.`);
  }
  return true;
}

export function validateProvisionedD1Identity(source, expectedName, expectedId) {
  const databases = parsedJson(source, "Provisioned D1 identity verification");
  if (!Array.isArray(databases)
    || databases.some((database) => typeof database?.name !== "string" || typeof database?.uuid !== "string")) {
    throw new Error("Provisioned D1 identity verification returned malformed inventory.");
  }
  if (!databases.some((database) => database.name === expectedName && database.uuid === expectedId)) {
    throw new Error("The bootstrap D1 binding is not pinned to the expected newly provisioned database.");
  }
  return expectedId;
}

export function validateR2ResourceAbsent(result, expectedName) {
  if (result?.code === 0) {
    throw new Error(`First installation requires absent auto-provision target ${expectedName}.`);
  }
  const diagnostic = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  if (!r2BucketNotFoundCodePattern.test(diagnostic)) {
    throw new Error("R2 resource absence could not be proven; refusing every first-install mutation.");
  }
  return true;
}

function stableDeploymentVersion(candidate) {
  const versions = Array.isArray(candidate?.versions) ? candidate.versions : [];
  if (versions.length !== 1 || versions[0]?.percentage !== 100 || typeof versions[0]?.version_id !== "string") {
    throw new Error("Configuration promotion requires one stable Worker version receiving 100% of traffic.");
  }
  const version = versions[0].version_id.toLowerCase();
  if (!workerVersionIdPattern.test(version)) {
    throw new Error("The stable Worker deployment returned an invalid version UUID.");
  }
  return version;
}

export function readStableDeploymentVersion(source) {
  return stableDeploymentVersion(parsedJson(source, "Wrangler deployment status"));
}

export function validateStableDeployment(source, expectedVersionId) {
  const expected = typeof expectedVersionId === "string" ? expectedVersionId.toLowerCase() : "";
  if (!workerVersionIdPattern.test(expected)) throw new Error("The expected current Worker version is invalid.");
  const actual = readStableDeploymentVersion(source);
  if (actual !== expected) {
    throw new Error("The deployed Worker version changed or does not match --expected-current-version.");
  }
  return actual;
}

function stringMap(entries, type, field) {
  const selected = entries.filter((entry) => entry?.type === type);
  if (selected.some((entry) => typeof entry?.name !== "string" || typeof entry?.[field] !== "string")) {
    throw new Error("The deployed Worker version contains malformed bindings.");
  }
  if (new Set(selected.map((entry) => entry.name)).size !== selected.length) {
    throw new Error("The deployed Worker version contains duplicate bindings.");
  }
  return new Map(selected.map((entry) => [entry.name, entry[field]]));
}

function sameSortedStrings(left, right) {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function exactVersionBindingState(currentVersion, desiredConfig, resourceBindings, operation) {
  const bindings = Array.isArray(currentVersion?.resources?.bindings)
    ? currentVersion.resources.bindings
    : [];
  const remoteVars = stringMap(bindings, "plain_text", "text");
  const desiredVars = desiredConfig?.vars;
  if (!desiredVars || typeof desiredVars !== "object" || Array.isArray(desiredVars)) {
    throw new Error("The desired deployment config has no vars object.");
  }
  if (!sameSortedStrings(remoteVars.keys(), Object.keys(desiredVars))) {
    throw new Error(`${operation} cannot add or remove non-secret Worker variables.`);
  }
  const remoteSecretNames = bindings
    .filter((binding) => binding?.type === "secret_text" && typeof binding?.name === "string")
    .map((binding) => binding.name);
  const requiredSecretNames = desiredConfig?.secrets?.required;
  if (!Array.isArray(requiredSecretNames) || !sameSortedStrings(remoteSecretNames, requiredSecretNames)) {
    throw new Error(`${operation} requires the exact existing secret-name set.`);
  }
  const expectedBindingKeys = [
    ...Object.keys(desiredVars).map((name) => `plain_text:${name}`),
    ...requiredSecretNames.map((name) => `secret_text:${name}`),
    ...resourceBindings.map((binding) => `${binding.type}:${binding.name}`),
  ];
  const actualBindingKeys = bindings.map((binding) => {
    if (typeof binding?.type !== "string" || typeof binding?.name !== "string") {
      throw new Error("The deployed Worker version contains malformed bindings.");
    }
    return `${binding.type}:${binding.name}`;
  });
  if (!sameSortedStrings(actualBindingKeys, expectedBindingKeys)) {
    throw new Error(`${operation} requires the exact existing variable, secret, and resource binding set.`);
  }
  return { bindings, remoteVars, desiredVars };
}

function exactResourceIdentities(bindings, requirements, operation) {
  const resourceIdentities = {};
  for (const requirement of requirements) {
    if (requirement.identityField === undefined) continue;
    const binding = bindings.find((candidate) => (
      candidate.type === requirement.type && candidate.name === requirement.name
    ));
    const identity = binding?.[requirement.identityField];
    if (typeof identity !== "string" || identity.length === 0) {
      throw new Error(`${operation} is missing the ${requirement.name} resource identity.`);
    }
    if (requirement.expectedIdentity !== undefined && identity !== requirement.expectedIdentity) {
      throw new Error(`${operation} ${requirement.name} identity is not the expected target.`);
    }
    resourceIdentities[requirement.name] = Object.freeze({
      type: requirement.type,
      field: requirement.identityField,
      value: identity,
    });
  }
  return Object.freeze(resourceIdentities);
}

export function isolatedBootstrapTag(workerName, sourceRevision) {
  return `${workerName}-isolated-${validateSourceRevision(sourceRevision).slice(0, 12)}`.slice(0, 64);
}

export function validateIsolatedBootstrapVersion(currentVersionSource, desiredConfig, options) {
  const currentVersion = parsedJson(currentVersionSource, "Wrangler isolated bootstrap inspection");
  const expectedVersion = typeof options?.expectedVersion === "string"
    ? options.expectedVersion.toLowerCase()
    : "";
  if (!workerVersionIdPattern.test(expectedVersion)
    || typeof currentVersion?.id !== "string"
    || currentVersion.id.toLowerCase() !== expectedVersion) {
    throw new Error("The isolated bootstrap deployment does not match --expected-bootstrap-version.");
  }
  const expectedTag = isolatedBootstrapTag(options?.workerName, options?.sourceRevision);
  if (currentVersion?.annotations?.["workers/tag"] !== expectedTag) {
    throw new Error("The deployed Worker version is not the exact isolated bootstrap for this source.");
  }
  const { bindings, remoteVars, desiredVars } = exactVersionBindingState(
    currentVersion,
    desiredConfig,
    options?.resourceBindings ?? [],
    "Isolated bootstrap validation",
  );
  for (const [name, desired] of Object.entries(desiredVars)) {
    if (remoteVars.get(name) !== desired) {
      throw new Error(`Isolated bootstrap validation cannot change ${name}.`);
    }
  }
  const resourceIdentities = exactResourceIdentities(
    bindings,
    options?.resourceBindings ?? [],
    "The isolated bootstrap",
  );
  return Object.freeze({
    expectedVersion,
    sourceRevision: validateSourceRevision(options?.sourceRevision),
    resourceIdentities,
  });
}

export function validateConfigurationPromotion(currentVersionSource, desiredConfig, options) {
  const currentVersion = parsedJson(currentVersionSource, "Wrangler version inspection");
  const revision = validateSourceRevision(options?.sourceRevision);
  if (currentVersion?.annotations?.["workers/tag"] !== releaseSourceTag(revision)) {
    throw new Error("The deployed Worker version is not tagged with the manifest's exact source revision.");
  }
  const { bindings, remoteVars, desiredVars } = exactVersionBindingState(
    currentVersion,
    desiredConfig,
    options?.resourceBindings ?? [],
    "Configuration promotion",
  );

  if (desiredVars.NOTICE_NEGOTIATION_MAIL_ACCEPTED === "true" && (
    desiredVars.NOTICE_MAIL_ENABLED !== "true"
    || desiredVars.NOTICE_MAIL_PROVIDER !== "delivery-gateway"
    || desiredVars.NOTICE_MAIL_CONFIGURED !== "true"
    || desiredVars.NOTICE_COUNTERPARTY_PORTAL_ENABLED !== "true"
  )) {
    throw new Error(
      "Configuration promotion cannot accept automated negotiation delivery until the delivery gateway is enabled and attested and the scoped counterparty portal is enabled.",
    );
  }

  if (
    remoteVars.get("NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED") === "false"
    && desiredVars.NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED === "true"
    && remoteVars.get("NOTICE_ESIGN_CONFIGURED") === "false"
    && desiredVars.NOTICE_ESIGN_CONFIGURED === "true"
  ) {
    throw new Error(
      "Configuration promotion must attest DocuSeal /submissions/html entitlement before a separate promotion records the live-tested e-signature configuration.",
    );
  }

  const attestationNames = new Set(options?.attestationNames ?? []);
  for (const [name, desired] of Object.entries(desiredVars)) {
    const current = remoteVars.get(name);
    if (current === desired) continue;
    if (attestationNames.has(name) && current === "false" && desired === "true") continue;
    if (name === "NOTICE_BOOTSTRAP_ENABLED" && current === "true" && desired === "false") continue;
    if (name === "NOTICE_BOOTSTRAP_ADMIN_EMAILS"
      && remoteVars.get("NOTICE_BOOTSTRAP_ENABLED") === "true"
      && desiredVars.NOTICE_BOOTSTRAP_ENABLED === "false"
      && desired === "") continue;
    throw new Error(`Configuration promotion cannot change ${name}.`);
  }

  if (desiredVars.NOTICE_RELEASE_REVISION !== revision) {
    throw new Error("The desired Worker configuration does not bind the exact source revision.");
  }
  if (desiredVars.NOTICE_BOOTSTRAP_ENABLED === "true"
    && remoteVars.get("NOTICE_BOOTSTRAP_ADMIN_EMAILS") !== desiredVars.NOTICE_BOOTSTRAP_ADMIN_EMAILS) {
    throw new Error("Configuration promotion cannot change bootstrap administrators while bootstrap remains enabled.");
  }

  const bootstrapRetirement = remoteVars.get("NOTICE_BOOTSTRAP_ENABLED") === "true"
    && desiredVars.NOTICE_BOOTSTRAP_ENABLED === "false";

  return Object.freeze({
    sourceRevision: revision,
    bootstrapRetirement,
    resourceIdentities: exactResourceIdentities(
      bindings,
      options?.resourceBindings ?? [],
      "Configuration promotion",
    ),
  });
}

export function validateD1SchemaMarker(source, field, expectedVersion) {
  const parsed = parsedJson(source, "Remote D1 schema verification");
  const rows = Array.isArray(parsed) ? parsed.flatMap((entry) => entry?.results ?? []) : [];
  if (rows.length !== 1 || rows[0]?.[field] !== expectedVersion) {
    throw new Error(`Remote D1 schema marker mismatch; required ${field}=${expectedVersion}.`);
  }
  return expectedVersion;
}

export function validateIgnoredGeneratedPath(candidate, filenamePattern, cwd = process.cwd()) {
  if (typeof candidate !== "string" || candidate.trim() !== candidate || candidate.length === 0) {
    throw new Error("A generated deployment config path is required.");
  }
  const generatedRoot = resolve(cwd, ".wrangler");
  const resolved = resolve(cwd, candidate);
  const nestedPath = relative(generatedRoot, resolved);
  if (nestedPath === "" || nestedPath.startsWith(`..${sep}`) || nestedPath === ".." || isAbsolute(nestedPath)) {
    throw new Error("The deployment config must be inside the ignored .wrangler directory.");
  }
  const filename = nestedPath.split(sep).at(-1) ?? "";
  if (nestedPath.includes(sep) || !filenamePattern.test(filename)) {
    throw new Error("The deployment config filename is not a generated Notice environment config.");
  }
  return resolved;
}

function parseJsonSecrets(source) {
  let candidate;
  try {
    candidate = JSON.parse(source);
  } catch {
    throw new Error("The secrets file is not valid JSON.");
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("A JSON secrets file must contain one object of secret-name/string-value pairs.");
  }
  const entries = Object.entries(candidate);
  if (entries.some(([, value]) => typeof value !== "string")) {
    throw new Error("Every JSON secrets-file entry must have a string value.");
  }
  return entries;
}

function parseDotEnvSecrets(source) {
  const seen = new Set();
  for (const [index, line] of source.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) throw new Error(`The secrets file has an invalid assignment on line ${index + 1}.`);
    const name = match[1];
    if (seen.has(name)) throw new Error(`The secrets file declares ${name} more than once.`);
    seen.add(name);

    const serializedValue = line.slice(match[0].length).trimStart();
    const quote = serializedValue[0];
    if (quote === "\"" || quote === "'") {
      let closingQuote = -1;
      for (let offset = 1; offset < serializedValue.length; offset += 1) {
        if (serializedValue[offset] !== quote) continue;
        let backslashes = 0;
        for (let previous = offset - 1; previous >= 0 && serializedValue[previous] === "\\"; previous -= 1) {
          backslashes += 1;
        }
        if (quote === "'" || backslashes % 2 === 0) {
          closingQuote = offset;
          break;
        }
      }
      const remainder = closingQuote < 0 ? "invalid" : serializedValue.slice(closingQuote + 1).trim();
      if (closingQuote < 0 || (remainder !== "" && !remainder.startsWith("#"))) {
        throw new Error("The secrets file is not valid dotenv syntax.");
      }
    }
  }

  let values;
  try {
    values = parseEnv(source);
  } catch {
    throw new Error("The secrets file is not valid dotenv syntax.");
  }
  if ([...seen].some((name) => !(name in values))) {
    throw new Error("The secrets file is not valid dotenv syntax.");
  }
  return Object.entries(values);
}

function secretEntries(source) {
  if (typeof source !== "string") throw new Error("The secrets file must be text.");
  const trimmed = source.trimStart();
  return trimmed.startsWith("{") ? parseJsonSecrets(source) : parseDotEnvSecrets(source);
}

function validateSecretValue(name, value) {
  if (!secretNamePattern.test(name)) {
    throw new Error("The secrets file contains an invalid secret name.");
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Secret ${name} must have a non-empty valid value.`);
  }
  const normalized = value.trim();
  if (value !== normalized || controlCharacters.test(value)) {
    throw new Error(`Secret ${name} must not contain leading/trailing whitespace or control characters.`);
  }
  if (name === "NOTICE_OPERATIONS_SECRET" && !/^[\x21-\x7e]+$/.test(normalized)) {
    throw new Error("Secret NOTICE_OPERATIONS_SECRET must contain visible ASCII characters only.");
  }
  if (normalized.length === 0 || placeholderPattern.test(normalized) || normalized.includes("<") || normalized.includes(">")) {
    throw new Error(`Secret ${name} must not use a placeholder value.`);
  }
  const minimum = minimumSecretLengths[name];
  if (minimum !== undefined && normalized.length < minimum) {
    throw new Error(`Secret ${name} does not meet its required minimum length.`);
  }
  if (name === "NOTICE_DOCUSEAL_WEBHOOK_SECRET" && !/^whsec_[A-Za-z0-9+/_=-]+$/.test(normalized)) {
    throw new Error("Secret NOTICE_DOCUSEAL_WEBHOOK_SECRET must be the whsec_ value from DocuSeal's webhook HMAC tab.");
  }
  if (name === "NOTICE_INBOUND_EMAIL_SECRET" && new TextEncoder().encode(normalized).byteLength > 4_096) {
    throw new Error("Secret NOTICE_INBOUND_EMAIL_SECRET exceeds its supported maximum byte length.");
  }
  if (normalized.length > 4_096) throw new Error(`Secret ${name} exceeds its supported maximum length.`);
}

function validatedSecretsFile(source, requiredNames, optionalNames = [], canonicalize = false) {
  const required = normalizedRequiredNames([...requiredNames]);
  const optional = optionalNames.length === 0 ? [] : normalizedRequiredNames([...optionalNames]);
  const allowed = new Set([...required, ...optional]);
  const entries = secretEntries(source);
  const values = new Map();
  for (const [name, value] of entries) {
    if (name.startsWith("NOTICE_INTERNAL_")) {
      throw new Error("NOTICE_INTERNAL_* settings are forbidden in release secret files.");
    }
    if (!allowed.has(name)) {
      throw new Error(`The secrets file contains undeclared key ${name}.`);
    }
    validateSecretValue(name, value);
    values.set(name, value);
  }
  const missing = required.filter((name) => !values.has(name));
  if (missing.length > 0) {
    throw new Error(`The secrets file is missing required key${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`);
  }
  const purposeByValue = new Map();
  for (const name of independentSecretNames) {
    const value = values.get(name);
    if (value === undefined) continue;
    const existingName = purposeByValue.get(value);
    if (existingName !== undefined) {
      throw new Error(`${existingName} and ${name} must contain distinct values.`);
    }
    purposeByValue.set(value, name);
  }
  const validation = Object.freeze({
    requiredSecretNames: Object.freeze(required),
    suppliedSecretNames: Object.freeze([...values.keys()].sort()),
  });
  return Object.freeze({
    validation,
    canonicalSource: canonicalize
      ? `${JSON.stringify(Object.fromEntries(
          [...values.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
        ))}\n`
      : null,
  });
}

export function validateSecretsFileContents(source, requiredNames, optionalNames = []) {
  return validatedSecretsFile(source, requiredNames, optionalNames).validation;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function hasErrorCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function lstatIfPresent(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function openPrivateInput(candidate, description, permissionMessage) {
  let handle;
  try {
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    const metadata = await lstatIfPresent(candidate);
    if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${description} must be a regular file, not a symlink or special file.`);
    }
    throw new Error(`${description} could not be opened without following symbolic links.`);
  }
  try {
    const metadata = await handle.stat();
    const lexicalMetadata = await lstatIfPresent(candidate);
    if (!metadata.isFile()
      || !lexicalMetadata
      || lexicalMetadata.isSymbolicLink()
      || !lexicalMetadata.isFile()) {
      throw new Error(`${description} must be a regular file, not a symlink or special file.`);
    }
    if (!sameFile(lexicalMetadata, metadata)) {
      throw new Error(`${description} changed while it was being opened.`);
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error(permissionMessage);
    }
    return Object.freeze({ handle, metadata });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function logicalPinnedPath(prefix, extension, cwd) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(prefix) || !/^\.[a-z]+$/.test(extension)) {
    throw new Error("The internal release-input virtual name is invalid.");
  }
  return resolve(cwd, `.wrangler/.notice-release-${prefix}-${process.pid}-${randomUUID()}${extension}`);
}

function parsedTrustedJson(path, description) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${description} is unavailable or invalid; restore the clean pinned release checkout.`);
  }
}

function verifyPinnedWranglerInstallation() {
  const expectedPackagePath = resolve(releaseRepositoryRoot, "node_modules/wrangler/package.json");
  const expectedCliPath = resolve(releaseRepositoryRoot, "node_modules/wrangler/wrangler-dist/cli.js");
  if (resolve(wranglerPackageJsonPath) !== expectedPackagePath || resolve(wranglerCliPath) !== expectedCliPath) {
    throw new Error("The guarded release requires the repository-local pinned Wrangler CLI.");
  }
  const manifest = parsedTrustedJson(resolve(releaseRepositoryRoot, "package.json"), "The release package manifest");
  const lock = parsedTrustedJson(resolve(releaseRepositoryRoot, "package-lock.json"), "The release dependency lock");
  const installed = parsedTrustedJson(wranglerPackageJsonPath, "The installed Wrangler package manifest");
  if (manifest?.devDependencies?.wrangler !== EXPECTED_WRANGLER_VERSION
    || lock?.packages?.[""]?.devDependencies?.wrangler !== EXPECTED_WRANGLER_VERSION
    || lock?.packages?.["node_modules/wrangler"]?.version !== EXPECTED_WRANGLER_VERSION
    || installed?.name !== "wrangler"
    || installed?.version !== EXPECTED_WRANGLER_VERSION) {
    throw new Error(`The guarded release requires exact Wrangler ${EXPECTED_WRANGLER_VERSION} manifest, lock, and installation pins.`);
  }
}

function verifyPinnedVinextInstallation() {
  const manifest = parsedTrustedJson(resolve(releaseRepositoryRoot, "package.json"), "The release package manifest");
  const lock = parsedTrustedJson(resolve(releaseRepositoryRoot, "package-lock.json"), "The release dependency lock");
  const installed = parsedTrustedJson(vinextPackageJsonPath, "The installed Vinext package manifest");
  if (manifest?.devDependencies?.vinext !== EXPECTED_VINEXT_VERSION
    || lock?.packages?.[""]?.devDependencies?.vinext !== EXPECTED_VINEXT_VERSION
    || lock?.packages?.["node_modules/vinext"]?.version !== EXPECTED_VINEXT_VERSION
    || installed?.name !== "vinext"
    || installed?.version !== EXPECTED_VINEXT_VERSION
    || installed?.bin?.vinext !== "dist/cli.js") {
    throw new Error(`The guarded release requires exact Vinext ${EXPECTED_VINEXT_VERSION} manifest, lock, and installation pins.`);
  }
}

function exactFlagValue(args, flag, required) {
  const indexes = args.flatMap((argument, index) => argument === flag ? [index] : []);
  if (indexes.length > 1 || args.some((argument) => argument.startsWith(`${flag}=`))) {
    throw new Error(`The guarded release runner requires at most one separate ${flag} argument.`);
  }
  if (indexes.length === 0) {
    if (required) throw new Error(`The guarded release runner requires one ${flag} argument.`);
    return null;
  }
  const valueIndex = indexes[0] + 1;
  if (!args[valueIndex] || args[valueIndex].startsWith("--")) {
    throw new Error(`The guarded release runner received an invalid ${flag} value.`);
  }
  return Object.freeze({ value: args[valueIndex], valueIndex });
}

function pinnedEntry(path, source, kind) {
  if (typeof source !== "string" && !Buffer.isBuffer(source)) {
    throw new Error(`Pinned Wrangler ${kind} input must be text or a byte buffer.`);
  }
  const content = Buffer.from(source);
  if (content.length === 0 || content.length > MAX_CAPTURED_COMMAND_BYTES) {
    content.fill(0);
    throw new Error(`Pinned Wrangler ${kind} input must contain at most 1 MiB of non-empty text.`);
  }
  return Object.freeze({
    path,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
    kind,
  });
}

function appendBoundedOutput(current, chunk, limit, description) {
  const next = current + String(chunk);
  if (Buffer.byteLength(next) > limit) throw new Error(`${description} exceeded its bounded output limit.`);
  return next;
}

function parseWranglerAttestation(source, capsule, expectsSecrets) {
  let candidate;
  try {
    candidate = JSON.parse(source);
  } catch {
    throw new Error("The pinned Wrangler child did not return a valid input-read attestation.");
  }
  const config = candidate?.configuration;
  const secrets = candidate?.secrets;
  const configMatches = Number.isSafeInteger(config?.reads)
    && config.reads > 0
    && config.sha256 === capsule.configuration.sha256;
  const secretsMatch = expectsSecrets
    ? Number.isSafeInteger(secrets?.reads)
      && secrets.reads > 0
      && secrets.sha256 === capsule.secrets.sha256
    : secrets === null;
  if (candidate?.schemaVersion !== "1.0"
    || candidate?.nonce !== capsule.nonce
    || candidate?.complete !== true
    || !configMatches
    || !secretsMatch) {
    throw new Error("The pinned Wrangler child did not consume the exact validated configuration and secrets.");
  }
}

async function executePinnedWrangler(runner, args, environment, capture) {
  if (args[0] !== "wrangler") {
    throw new Error("The pinned Wrangler runner accepts only explicit Wrangler commands.");
  }
  if (!guardedReleaseWranglerEnvironments.has(environment)) {
    throw new Error("The pinned Wrangler runner requires its guarded least-privilege environment.");
  }
  const rewritten = [...args.slice(1)];
  const configFlag = exactFlagValue(rewritten, "--config", true);
  const secretsFlag = exactFlagValue(rewritten, "--secrets-file", false);
  const state = pinnedWranglerInputs.get(runner);
  if (!state || state.destroyed) throw new Error("The pinned Wrangler runner identity is invalid or destroyed.");
  const selectedEntry = (flag, expectedKind) => {
    const key = resolve(runner.cwd, flag.value);
    const entry = state.inputs.get(key);
    if (!entry || entry.kind !== expectedKind) {
      throw new Error(`Wrangler ${expectedKind} input is not pinned to validated in-memory content.`);
    }
    return entry;
  };
  const configuration = selectedEntry(configFlag, "configuration");
  const secrets = secretsFlag === null ? null : selectedEntry(secretsFlag, "secrets");
  rewritten[configFlag.valueIndex] = configuration.path;
  if (secretsFlag !== null) rewritten[secretsFlag.valueIndex] = secrets.path;
  const capsule = {
    schemaVersion: "1.0",
    nonce: randomUUID(),
    configuration: {
      path: configuration.path,
      bytes: configuration.content.length,
      data: configuration.content.toString("base64"),
      sha256: configuration.sha256,
    },
    secrets: secrets === null
      ? null
      : {
          path: secrets.path,
          bytes: secrets.content.length,
          data: secrets.content.toString("base64"),
          sha256: secrets.sha256,
        },
  };
  const serializedCapsule = Buffer.from(`${JSON.stringify(capsule)}\n`, "utf8");
  capsule.configuration.data = "";
  if (capsule.secrets) capsule.secrets.data = "";
  if (serializedCapsule.length > 2_097_152) {
    serializedCapsule.fill(0);
    throw new Error("The pinned Wrangler input capsule exceeds its 2 MiB transport limit.");
  }

  const baseStdio = capture ? ["ignore", "pipe", "pipe"] : ["inherit", "inherit", "inherit"];
  const child = spawn(
    process.execPath,
    ["--require", pinnedWranglerPreloadPath, wranglerCliPath, ...rewritten],
    {
      cwd: runner.cwd,
      env: environment,
      stdio: [...baseStdio, "pipe", "pipe"],
      shell: false,
    },
  );
  let stdout = "";
  let stderr = "";
  let attestation = "";
  let outputError = null;
  const append = (field, chunk) => {
    if (outputError) return;
    try {
      if (field === "stdout") stdout = appendBoundedOutput(
        stdout, chunk, MAX_CAPTURED_COMMAND_BYTES, "A release preflight command",
      );
      else if (field === "stderr") stderr = appendBoundedOutput(
        stderr, chunk, MAX_CAPTURED_COMMAND_BYTES, "A release preflight command",
      );
      else attestation = appendBoundedOutput(
        attestation, chunk, MAX_WRANGLER_ATTESTATION_BYTES, "The pinned Wrangler attestation",
      );
    } catch (error) {
      outputError = error;
      child.kill("SIGTERM");
    }
  };
  if (capture) {
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
  }
  child.stdio[4].on("data", (chunk) => append("attestation", chunk));
  child.stdio[4].on("error", (error) => {
    outputError ??= error;
    child.kill("SIGTERM");
  });
  const capsuleWrite = new Promise((resolveWrite, rejectWrite) => {
    const stream = child.stdio[3];
    const failed = (error) => rejectWrite(error);
    stream.once("error", failed);
    stream.end(serializedCapsule, (error) => {
      stream.off("error", failed);
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
  const childResult = new Promise((resolveRun, rejectRun) => {
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({ code: code ?? 1, signal }));
  });
  const [resultOutcome, writeOutcome] = await Promise.allSettled([childResult, capsuleWrite]);
  serializedCapsule.fill(0);
  if (resultOutcome.status === "rejected") throw resultOutcome.reason;
  if (writeOutcome.status === "rejected") {
    throw new Error(`The pinned Wrangler input capsule could not be delivered: ${writeOutcome.reason instanceof Error ? writeOutcome.reason.message : "unknown error"}.`);
  }
  if (outputError) throw outputError;
  parseWranglerAttestation(attestation, capsule, secrets !== null);
  return Object.freeze({ ...resultOutcome.value, stdout, stderr });
}

export function createPinnedWranglerRunner(cwd = process.cwd()) {
  verifyPinnedWranglerInstallation();
  const workspace = resolve(cwd);
  const inputs = new Map();
  const state = { destroyed: false, inputs };
  const assertActive = () => {
    if (state.destroyed) throw new Error("The pinned Wrangler runner has been destroyed.");
  };
  const replaceEntry = (key, entry) => {
    inputs.get(key)?.content.fill(0);
    inputs.set(key, entry);
  };
  const runner = {
    [pinnedWranglerRunner]: true,
    cwd: workspace,
    pinConfiguration(path, candidate) {
      assertActive();
      const key = resolve(workspace, path);
      const serialized = JSON.stringify(structuredClone(candidate), null, 2);
      if (typeof serialized !== "string") {
        throw new Error("Pinned Wrangler configuration must be JSON-serializable.");
      }
      replaceEntry(key, pinnedEntry(
        key,
        `${serialized}\n`,
        "configuration",
      ));
      return key;
    },
    pinSecrets(path, source) {
      assertActive();
      const key = resolve(workspace, path);
      replaceEntry(key, pinnedEntry(key, source, "secrets"));
      return key;
    },
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      for (const entry of inputs.values()) entry.content.fill(0);
      inputs.clear();
    },
  };
  pinnedWranglerInputs.set(runner, state);
  return Object.freeze(runner);
}

function isPinnedWranglerRunner(candidate) {
  return Boolean(candidate?.[pinnedWranglerRunner]);
}

export async function loadValidatedSecretsInput(
  candidate,
  requiredNames,
  optionalNames = [],
  cwd = process.cwd(),
  environment = createGuardedReleaseEnvironments().command,
) {
  const resolved = resolve(cwd, candidate);
  const opened = await openPrivateInput(
    resolved,
    "The secrets file",
    "The secrets file permissions are too broad; restrict it to its owner (for example, chmod 600).",
  );
  try {
    // Classify the exact opened inode by canonical location so a symlinked
    // parent cannot disguise a tracked in-checkout file as an external source.
    const [canonicalCheckout, canonicalSecretsFile] = await Promise.all([
      realpath(cwd),
      realpath(resolved),
    ]);
    const canonicalMetadata = await lstat(canonicalSecretsFile);
    if (!canonicalMetadata.isFile() || !sameFile(canonicalMetadata, opened.metadata)) {
      throw new Error("The secrets file changed while its canonical location was being verified.");
    }
    const checkoutRelativePath = relative(canonicalCheckout, canonicalSecretsFile);
    const insideCheckout = checkoutRelativePath !== ""
      && checkoutRelativePath !== ".."
      && !checkoutRelativePath.startsWith(`..${sep}`)
      && !isAbsolute(checkoutRelativePath);
    if (insideCheckout) {
      const tracked = await runCapturedReleaseCommand(
        "git", ["ls-files", "--error-unmatch", "--", checkoutRelativePath], environment,
      );
      if (tracked.code === 0) {
        throw new Error("A release secrets file inside the checkout must not be tracked by Git.");
      }
      const ignored = await runCapturedReleaseCommand(
        "git", ["check-ignore", "--quiet", "--", checkoutRelativePath], environment,
      );
      if (ignored.code !== 0) {
        throw new Error("A release secrets file inside the checkout must be covered by a Git ignore rule.");
      }
    }
    const sourceBytes = await opened.handle.readFile();
    try {
      const validated = validatedSecretsFile(
        sourceBytes.toString("utf8"), requiredNames, optionalNames, true,
      );
      if (typeof validated.canonicalSource !== "string") {
        throw new Error("The validated secrets could not be canonicalized.");
      }
      return Object.freeze({
        path: logicalPinnedPath("validated-secrets", ".json", cwd),
        canonicalBytes: Buffer.from(validated.canonicalSource, "utf8"),
        validation: validated.validation,
      });
    } finally {
      sourceBytes.fill(0);
    }
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

export async function loadValidatedGeneratedConfiguration(candidate, prefix, validate, cwd = process.cwd()) {
  if (typeof validate !== "function") {
    throw new Error("A generated deployment config validator is required before in-memory pinning.");
  }
  const resolved = resolve(cwd, candidate);
  const opened = await openPrivateInput(
    resolved,
    "The generated deployment config",
    "The generated deployment config permissions are too broad; rerender it with the deployment kit.",
  );
  let parsed;
  try {
    parsed = JSON.parse(await opened.handle.readFile({ encoding: "utf8" }));
  } catch {
    throw new Error("The generated deployment config is not valid JSON.");
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
  const validation = await validate(parsed);
  const path = logicalPinnedPath(prefix, ".json", cwd);
  return Object.freeze({ configuration: parsed, path, validation });
}

export function displayPath(candidate, cwd = process.cwd()) {
  return (relative(cwd, candidate) || ".").split(sep).join("/");
}

export async function runReleaseCommand(
  command,
  args,
  /** @type {Readonly<Record<string, string | undefined>>} */ environment = createGuardedReleaseEnvironments().command,
) {
  if (isPinnedWranglerRunner(command)) {
    const result = await executePinnedWrangler(command, args, environment, false);
    if (result.signal) throw new Error(`wrangler exited after signal ${result.signal}.`);
    if (result.code !== 0) throw new Error(`wrangler exited with status ${result.code}.`);
    return;
  }
  if (!guardedReleaseCommandEnvironments.has(environment)) {
    throw new Error("A release subprocess requires its guarded least-privilege environment.");
  }
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (signal) rejectRun(new Error(`${command} exited after signal ${signal}.`));
      else if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with status ${code ?? "unknown"}.`));
    });
  });
}

export async function runPinnedReleaseBuild(
  environment = createGuardedReleaseEnvironments().command,
  cwd = process.cwd(),
) {
  if (!guardedReleaseCommandEnvironments.has(environment)) {
    throw new Error("The pinned production build requires its guarded least-privilege environment.");
  }
  verifyPinnedVinextInstallation();
  return await new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(
      process.execPath,
      ["--require", guardedVinextPreloadPath, vinextCliPath, "build"],
      {
        cwd,
        env: environment,
        stdio: "inherit",
        shell: false,
      },
    );
    child.once("error", rejectBuild);
    child.once("exit", (code, signal) => {
      if (signal) rejectBuild(new Error(`vinext build exited after signal ${signal}.`));
      else if (code === 0) resolveBuild();
      else rejectBuild(new Error(`vinext build exited with status ${code ?? "unknown"}.`));
    });
  });
}

export async function runCapturedReleaseCommand(
  command,
  args,
  /** @type {Readonly<Record<string, string | undefined>>} */ environment = createGuardedReleaseEnvironments().command,
) {
  if (isPinnedWranglerRunner(command)) {
    return await executePinnedWrangler(command, args, environment, true);
  }
  if (!guardedReleaseCommandEnvironments.has(environment)) {
    throw new Error("A release subprocess requires its guarded least-privilege environment.");
  }
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let exceededLimit = false;
    const append = (field, chunk) => {
      if (exceededLimit) return;
      const next = field === "stdout" ? stdout + String(chunk) : stderr + String(chunk);
      if (Buffer.byteLength(next) > MAX_CAPTURED_COMMAND_BYTES) {
        exceededLimit = true;
        child.kill("SIGTERM");
        return;
      }
      if (field === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (exceededLimit) {
        rejectRun(new Error("A release preflight command exceeded its bounded output limit."));
      } else {
        resolveRun(Object.freeze({ code: code ?? 1, signal, stdout, stderr }));
      }
    });
  });
}

export async function requireSuccessfulCapturedCommand(
  command,
  args,
  environment = createGuardedReleaseEnvironments().command,
  description = "Release preflight",
) {
  const result = await runCapturedReleaseCommand(command, args, environment);
  if (result.signal || result.code !== 0) {
    throw new Error(`${description} failed without changing the remote release target.`);
  }
  return result.stdout;
}
