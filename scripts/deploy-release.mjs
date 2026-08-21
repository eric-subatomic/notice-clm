#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { NOTICE_SCHEMA_MARKER_ID, NOTICE_SCHEMA_VERSION } from "../db/schema-guard.ts";
import {
  parseDeploymentManifest,
  renderWranglerConfiguration,
} from "./deployment-manifest.ts";
import {
  autoProvisionedResourceName,
  createGuardedReleaseEnvironments,
  createPinnedWranglerRunner,
  displayPath,
  isolatedBootstrapTag,
  parseReleaseArguments,
  readStableDeploymentVersion,
  releaseSourceTag,
  rejectInternalReleaseEnvironment,
  rejectInternalReleaseSettings,
  requireSuccessfulCapturedCommand,
  runCapturedReleaseCommand,
  runPinnedReleaseBuild,
  runReleaseCommand,
  loadValidatedGeneratedConfiguration,
  loadValidatedSecretsInput,
  validateConfigurationPromotion,
  validateD1ResourceAbsent,
  validateD1SchemaMarker,
  validateIsolatedBootstrapVersion,
  validateIgnoredGeneratedPath,
  validateReleaseCheckout,
  validateR2ResourceAbsent,
  validateProvisionedD1Identity,
  validateSecretsFileContents,
  validateStableDeployment,
  validateWorkerAbsent,
  validateWranglerAccountIdentity,
} from "./release-utils.mjs";

const usage = `Notice guarded release deployment

Usage:
  npm run deploy -- --config .wrangler/notice-deployment-<environment>.json \\
    --secrets-file .dev.vars.<environment> --confirm-empty-environment \\
    --confirm-workers-paid-plan

  npm run deploy:promote -- --config .wrangler/notice-deployment-<environment>.json \\
    --expected-current-version <uuid> --confirm-configuration-only \\
    --confirm-workers-paid-plan

  npm run deploy:resume -- --config .wrangler/notice-deployment-<environment>.json \\
    --secrets-file .dev.vars.<environment> --expected-bootstrap-version <uuid> \\
    --confirm-stranded-first-install --confirm-workers-paid-plan

The generated config must come from scripts/deployment-kit.mjs. This command
refuses generic upgrades. It validates the ignored config and secret-file keys,
builds and dry-runs the rendered package, creates an isolated first-install
bootstrap, pins its provisioned storage identities,
applies the first schema to the empty environment, and activates the Worker
only after the migration succeeds. See docs/DEPLOYMENT.md for the reviewed
promotion, maintenance-window, and recovery procedures.
`;

const MAIN_ATTESTATION_NAMES = Object.freeze([
  "NOTICE_ESIGN_CONFIGURED",
  "NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED",
  "NOTICE_SCAN_CONFIGURED",
  "NOTICE_MAIL_CONFIGURED",
  "NOTICE_NEGOTIATION_MAIL_ACCEPTED",
  "NOTICE_EMAIL_CAPTURE_CONFIGURED",
  "NOTICE_CRM_CONFIGURED",
]);
const MAIN_RESOURCE_BINDINGS = Object.freeze([
  Object.freeze({ type: "assets", name: "ASSETS" }),
  Object.freeze({ type: "d1", name: "DB", identityField: "id" }),
  Object.freeze({ type: "r2_bucket", name: "DOCUMENTS", identityField: "bucket_name" }),
]);

function requiredString(candidate, field) {
  const value = candidate?.[field];
  if (typeof value !== "string") throw new Error(`The generated deployment config is missing ${field}.`);
  return value;
}

function requiredBoolean(candidate, field) {
  const value = requiredString(candidate, field);
  if (value !== "true" && value !== "false") {
    throw new Error(`The generated deployment config has an invalid ${field} value.`);
  }
  return value === "true";
}

function requiredInteger(candidate, field) {
  const serialized = requiredString(candidate, field);
  if (!/^(?:0|[1-9]\d*)$/.test(serialized)) {
    throw new Error(`The generated deployment config has an invalid ${field} value.`);
  }
  return Number(serialized);
}

function reconstructManifest(config, environment) {
  const vars = config.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
    throw new Error("The generated deployment config must contain a vars object.");
  }
  if (Object.keys(vars).some((name) => name.startsWith("NOTICE_INTERNAL_"))) {
    throw new Error("NOTICE_INTERNAL_* settings are forbidden in release deployment configs.");
  }

  const bootstrapEnabled = requiredBoolean(vars, "NOTICE_BOOTSTRAP_ENABLED");
  const bootstrapEmails = requiredString(vars, "NOTICE_BOOTSTRAP_ADMIN_EMAILS");
  const identityMode = requiredString(vars, "NOTICE_AUTH_MODE");
  const docuSealEnabled = requiredBoolean(vars, "NOTICE_ESIGN_ENABLED");
  const docuSealMcpEnabled = docuSealEnabled
    ? requiredBoolean(vars, "NOTICE_DOCUSEAL_MCP_ENABLED")
    : false;
  const scannerEnabled = requiredBoolean(vars, "NOTICE_SCAN_ENABLED");
  const scannerOcrEnabled = requiredBoolean(vars, "NOTICE_SCAN_OCR_ENABLED");
  const mailEnabled = requiredBoolean(vars, "NOTICE_MAIL_ENABLED");
  const emailCaptureEnabled = requiredBoolean(vars, "NOTICE_EMAIL_CAPTURE_ENABLED");
  const crmProvider = requiredString(vars, "NOTICE_CRM_PROVIDER");
  const crmEnabled = requiredBoolean(vars, "NOTICE_CRM_ENABLED");

  return parseDeploymentManifest({
    schemaVersion: "1.0",
    accountId: config.account_id,
    sourceRevision: requiredString(vars, "NOTICE_RELEASE_REVISION"),
    environment,
    deploymentModel: requiredString(vars, "NOTICE_DEPLOYMENT_MODEL"),
    workerName: config.name,
    customDomain: config.routes?.[0]?.pattern,
    workspace: {
      id: requiredString(vars, "NOTICE_WORKSPACE_ID"),
      name: requiredString(vars, "NOTICE_WORKSPACE_NAME"),
      bootstrap: {
        enabled: bootstrapEnabled,
        adminEmails: bootstrapEmails === "" ? [] : bootstrapEmails.split(","),
      },
    },
    identity: identityMode === "cloudflare-access"
      ? {
          mode: identityMode,
          teamDomain: requiredString(vars, "NOTICE_ACCESS_TEAM_DOMAIN"),
          audience: requiredString(vars, "NOTICE_ACCESS_AUDIENCE"),
        }
      : { mode: identityMode },
    docuseal: docuSealEnabled
      ? {
          enabled: true,
          configured: requiredBoolean(vars, "NOTICE_ESIGN_CONFIGURED"),
          deployment: requiredString(vars, "NOTICE_DOCUSEAL_DEPLOYMENT"),
          apiBaseUrl: requiredString(vars, "NOTICE_DOCUSEAL_API_BASE_URL"),
          templateId: requiredInteger(vars, "NOTICE_DOCUSEAL_TEMPLATE_ID"),
          validatedRelease: requiredString(vars, "NOTICE_DOCUSEAL_VALIDATED_RELEASE"),
          apiClientContract: requiredString(vars, "NOTICE_DOCUSEAL_API_CLIENT_CONTRACT"),
          htmlSubmissionsEntitled: requiredBoolean(vars, "NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED"),
          expirationHours: requiredInteger(vars, "NOTICE_DOCUSEAL_EXPIRATION_HOURS"),
          email2faRequired: requiredBoolean(vars, "NOTICE_DOCUSEAL_EMAIL_2FA_REQUIRED"),
          mcp: docuSealMcpEnabled
            ? {
                enabled: true,
                protocolVersion: requiredString(vars, "NOTICE_DOCUSEAL_MCP_PROTOCOL_VERSION"),
                serverVersion: requiredString(vars, "NOTICE_DOCUSEAL_MCP_SERVER_VERSION"),
              }
            : { enabled: false },
        }
      : { enabled: false, configured: false },
    scanner: scannerEnabled
      ? {
          enabled: true,
          configured: requiredBoolean(vars, "NOTICE_SCAN_CONFIGURED"),
          gatewayUrl: requiredString(vars, "NOTICE_SCAN_GATEWAY_URL"),
          ocr: scannerOcrEnabled
            ? {
                enabled: true,
                modelId: requiredString(vars, "NOTICE_SCAN_OCR_MODEL_ID"),
                profileId: requiredString(vars, "NOTICE_SCAN_OCR_PROFILE_ID"),
              }
            : { enabled: false },
        }
      : { enabled: false, configured: false },
    mail: mailEnabled
      ? {
          enabled: true,
          configured: requiredBoolean(vars, "NOTICE_MAIL_CONFIGURED"),
          gatewayUrl: requiredString(vars, "NOTICE_DELIVERY_GATEWAY_URL"),
        }
      : { enabled: false, configured: false },
    counterpartyExchange: {
      automatedDeliveryAccepted: requiredBoolean(vars, "NOTICE_NEGOTIATION_MAIL_ACCEPTED"),
      portal: {
        enabled: requiredBoolean(vars, "NOTICE_COUNTERPARTY_PORTAL_ENABLED"),
        ttlHours: requiredInteger(vars, "NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS"),
      },
      emailCapture: emailCaptureEnabled
        ? {
            enabled: true,
            configured: requiredBoolean(vars, "NOTICE_EMAIL_CAPTURE_CONFIGURED"),
            provider: requiredString(vars, "NOTICE_EMAIL_CAPTURE_PROVIDER"),
            inboundDomain: requiredString(vars, "NOTICE_INBOUND_EMAIL_DOMAIN"),
          }
        : {
            enabled: false,
            configured: false,
            provider: requiredString(vars, "NOTICE_EMAIL_CAPTURE_PROVIDER"),
          },
    },
    crm: crmEnabled
      ? {
          provider: crmProvider,
          mappingVersion: requiredString(vars, "NOTICE_CRM_MAPPING_VERSION"),
          configured: requiredBoolean(vars, "NOTICE_CRM_CONFIGURED"),
          gatewayUrl: requiredString(vars, "NOTICE_CRM_GATEWAY_URL"),
        }
      : { provider: crmProvider },
    retention: { purgeGraceDays: requiredInteger(vars, "NOTICE_RETENTION_PURGE_GRACE_DAYS") },
    schedules: {
      outbox: requiredString(vars, "NOTICE_OUTBOX_CRON"),
      retention: requiredString(vars, "NOTICE_RETENTION_CRON"),
    },
  });
}

export function parseDeployArguments(args) {
  return parseReleaseArguments(args);
}

export function validateGeneratedConfigPath(candidate, cwd = process.cwd()) {
  return validateIgnoredGeneratedPath(
    candidate,
    /^notice-deployment-[a-z][a-z0-9-]{1,31}\.json$/,
    cwd,
  );
}

export function validateGeneratedConfiguration(candidate, environment) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("The generated deployment config must be a JSON object.");
  }
  rejectInternalReleaseSettings(candidate);
  if (typeof environment !== "string") {
    throw new Error("The generated deployment environment is required for exact validation.");
  }
  const manifest = reconstructManifest(candidate, environment);
  const rendered = renderWranglerConfiguration(manifest);
  if (!isDeepStrictEqual(candidate, rendered)) {
    throw new Error("The deployment config is not the exact fail-closed output of the Notice deployment renderer.");
  }
  return Object.freeze({
    workerName: manifest.workerName,
    workspaceId: manifest.workspace.id,
    bootstrapEnabled: manifest.workspace.bootstrap.enabled,
    accountId: manifest.accountId,
    sourceRevision: manifest.sourceRevision,
    requiredSecretNames: Object.freeze([...rendered.secrets.required]),
  });
}

export function requireBootstrapForEmptyMainRelease(mode, bootstrapEnabled) {
  if ((mode === "first-install" || mode === "first-install-resume") && bootstrapEnabled !== true) {
    throw new Error(
      "An empty Notice first installation requires workspace bootstrap with at least two verified administrators; bootstrap can be retired only after durable administrator continuity is proven.",
    );
  }
}

export function validateBootstrapAdminContinuity(source, expectedWorkspaceId) {
  if (
    typeof expectedWorkspaceId !== "string"
    || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(expectedWorkspaceId)
  ) {
    throw new Error("Bootstrap retirement requires an exact valid Notice workspace identifier.");
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Bootstrap retirement administrator verification did not return valid JSON.");
  }
  if (
    !Array.isArray(parsed)
    || parsed.length !== 1
    || !Array.isArray(parsed[0]?.results)
    || parsed[0].results.length !== 1
  ) {
    throw new Error("Bootstrap retirement requires one exact administrator-continuity result from the pinned Notice database.");
  }
  const [row] = parsed[0].results;
  if (
    !row
    || row.workspace_id !== expectedWorkspaceId
    || !Number.isSafeInteger(row.active_admin_count)
    || row.active_admin_count < 2
  ) {
    throw new Error(
      "Bootstrap retirement requires at least two distinct active administrator memberships backed by active users in the exact Notice workspace.",
    );
  }
  return Object.freeze({ workspaceId: expectedWorkspaceId, activeAdministratorCount: row.active_admin_count });
}

export function isolatedMainBootstrapConfiguration(candidate) {
  const bootstrap = structuredClone(candidate);
  bootstrap.routes = [];
  bootstrap.triggers = { crons: [] };
  return bootstrap;
}

export function resolvedMainConfiguration(candidate, resourceIdentities) {
  const databaseId = resourceIdentities?.DB?.value;
  const bucketName = resourceIdentities?.DOCUMENTS?.value;
  const expectedDatabaseName = autoProvisionedResourceName(candidate.name, "DB");
  const expectedBucketName = autoProvisionedResourceName(candidate.name, "DOCUMENTS");
  if (typeof databaseId !== "string" || databaseId.length === 0 || bucketName !== expectedBucketName) {
    throw new Error("The isolated bootstrap did not prove the expected main storage identities.");
  }
  const resolved = structuredClone(candidate);
  resolved.d1_databases = resolved.d1_databases.map((database) => (
    database.binding === "DB"
      ? { ...database, database_name: expectedDatabaseName, database_id: databaseId }
      : database
  ));
  resolved.r2_buckets = resolved.r2_buckets.map((bucket) => (
    bucket.binding === "DOCUMENTS" ? { ...bucket, bucket_name: bucketName } : bucket
  ));
  return resolved;
}

function pinPrivateInternalConfiguration(runner, prefix, candidate) {
  const path = resolve(process.cwd(), `.wrangler/${prefix}-${randomUUID()}.json`);
  runner.pinConfiguration(path, candidate);
  return path;
}

function pinFirstInstallConfigurationVariants(runner, candidate) {
  const bootstrapPath = pinPrivateInternalConfiguration(
    runner,
    "notice-isolated-bootstrap", isolatedMainBootstrapConfiguration(candidate),
  );
  return Object.freeze({
    bootstrapPath,
    activationPath: pinPrivateInternalConfiguration(runner, "notice-resolved-activation", candidate),
  });
}

function updateFirstInstallConfigurationVariants(runner, candidate, paths, resourceIdentities) {
  const resolved = resolvedMainConfiguration(candidate, resourceIdentities);
  runner.pinConfiguration(paths.bootstrapPath, isolatedMainBootstrapConfiguration(resolved));
  runner.pinConfiguration(paths.activationPath, resolved);
}

export { validateSecretsFileContents };

export function mainFirstInstallMutationCommands(
  npx,
  configArgument,
  secretArguments,
  workerName,
  sourceRevision,
  bootstrapConfigArgument = configArgument,
  activationConfigArgument = configArgument,
) {
  return Object.freeze([
    Object.freeze({
      id: "isolated-bootstrap-deploy",
      command: npx,
      args: [
        "wrangler", "deploy", "--strict", "--x-provision", "--tag",
        isolatedBootstrapTag(workerName, sourceRevision),
        "--message", `Notice isolated first-install bootstrap source ${sourceRevision}`,
        "--config", bootstrapConfigArgument,
        ...secretArguments,
      ],
    }),
    Object.freeze({ id: "bootstrap-proof", capture: true }),
    Object.freeze({
      id: "isolation-reset",
      command: npx,
      args: ["wrangler", "triggers", "deploy", "--config", bootstrapConfigArgument],
    }),
    Object.freeze({
      id: "migration-list",
      command: npx,
      args: ["wrangler", "d1", "migrations", "list", "DB", "--remote", "--config", bootstrapConfigArgument],
    }),
    Object.freeze({
      id: "migration-apply",
      command: npx,
      args: ["wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", bootstrapConfigArgument],
    }),
    Object.freeze({
      id: "schema-marker",
      command: npx,
      args: [
        "wrangler", "d1", "execute", "DB", "--remote",
        "--command", `SELECT version FROM notice_schema_state WHERE id = '${NOTICE_SCHEMA_MARKER_ID}'`,
        "--json", "--config", bootstrapConfigArgument,
      ],
      capture: true,
    }),
    Object.freeze({
      id: "isolation-final-reset",
      command: npx,
      args: ["wrangler", "triggers", "deploy", "--config", bootstrapConfigArgument],
    }),
    Object.freeze({ id: "bootstrap-stable", capture: true }),
    Object.freeze({
      id: "activate",
      command: npx,
      args: [
        "wrangler", "deploy", "--strict", "--tag", releaseSourceTag(sourceRevision),
        "--message", `Notice source ${sourceRevision}`,
        "--config", activationConfigArgument,
        ...secretArguments,
      ],
    }),
  ]);
}

export function mainPromotionMutationCommands(npx, configArgument, sourceRevision) {
  return Object.freeze([
    Object.freeze({ id: "schema-marker", capture: true }),
    Object.freeze({ id: "stable-deployment", capture: true }),
    Object.freeze({
      id: "activate",
      command: npx,
      args: [
        "wrangler", "deploy", "--strict", "--tag", releaseSourceTag(sourceRevision),
        "--message", `Notice configuration promotion source ${sourceRevision}`,
        "--config", configArgument,
      ],
    }),
  ]);
}

export function mainFirstInstallResumeMutationCommands(
  npx,
  configArgument,
  secretArguments,
  sourceRevision,
  bootstrapConfigArgument = configArgument,
  activationConfigArgument = configArgument,
) {
  return Object.freeze([
    Object.freeze({
      id: "isolation-reset",
      command: npx,
      args: ["wrangler", "triggers", "deploy", "--config", bootstrapConfigArgument],
    }),
    Object.freeze({
      id: "migration-list",
      command: npx,
      args: ["wrangler", "d1", "migrations", "list", "DB", "--remote", "--config", bootstrapConfigArgument],
    }),
    Object.freeze({
      id: "migration-apply",
      command: npx,
      args: ["wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", bootstrapConfigArgument],
    }),
    Object.freeze({ id: "schema-marker", capture: true }),
    Object.freeze({
      id: "isolation-final-reset",
      command: npx,
      args: ["wrangler", "triggers", "deploy", "--config", bootstrapConfigArgument],
    }),
    Object.freeze({ id: "bootstrap-stable", capture: true }),
    Object.freeze({
      id: "activate",
      command: npx,
      args: [
        "wrangler", "deploy", "--strict", "--tag", releaseSourceTag(sourceRevision),
        "--message", `Notice source ${sourceRevision}`,
        "--config", activationConfigArgument,
        ...secretArguments,
      ],
    }),
  ]);
}

export function mainReleaseModePlan(
  mode,
  npx,
  configArgument,
  secretArguments,
  workerName,
  sourceRevision,
  bootstrapConfigArgument,
  activationConfigArgument,
) {
  if (mode === "first-install") {
    return Object.freeze({
      preflight: "absent-target",
      mutations: mainFirstInstallMutationCommands(
        npx,
        configArgument,
        secretArguments,
        workerName,
        sourceRevision,
        bootstrapConfigArgument,
        activationConfigArgument,
      ),
    });
  }
  if (mode === "first-install-resume") {
    return Object.freeze({
      preflight: "isolated-bootstrap",
      mutations: mainFirstInstallResumeMutationCommands(
        npx,
        configArgument,
        secretArguments,
        sourceRevision,
        bootstrapConfigArgument,
        activationConfigArgument,
      ),
    });
  }
  if (mode === "configuration-promotion") {
    return Object.freeze({
      preflight: "configuration-promotion",
      mutations: mainPromotionMutationCommands(
        npx, configArgument, sourceRevision,
      ),
    });
  }
  throw new Error("Unsupported main release mode.");
}

async function verifyCheckoutAndAccount(
  npx,
  configArgument,
  accountId,
  sourceRevision,
  environment,
  wranglerEnvironment,
) {
  const status = await requireSuccessfulCapturedCommand(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    environment,
    "Git checkout verification",
  );
  const revision = await requireSuccessfulCapturedCommand(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    environment,
    "Git source revision verification",
  );
  validateReleaseCheckout(status, revision, sourceRevision);
  const whoami = await requireSuccessfulCapturedCommand(
    npx,
    ["wrangler", "whoami", "--json", "--config", configArgument],
    wranglerEnvironment,
    "Cloudflare account verification",
  );
  validateWranglerAccountIdentity(whoami, accountId);
}

async function verifyCheckoutSource(sourceRevision, environment) {
  const status = await requireSuccessfulCapturedCommand(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    environment,
    "Git checkout re-verification",
  );
  const revision = await requireSuccessfulCapturedCommand(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    environment,
    "Git source revision re-verification",
  );
  validateReleaseCheckout(status, revision, sourceRevision);
}

async function verifyMainResourceIdentities(
  npx, configArgument, workerName, resourceIdentities, environment,
) {
  const d1Inventory = await requireSuccessfulCapturedCommand(
    npx,
    ["wrangler", "d1", "list", "--json", "--config", configArgument],
    environment,
    "Provisioned main D1 identity verification",
  );
  validateProvisionedD1Identity(
    d1Inventory,
    autoProvisionedResourceName(workerName, "DB"),
    resourceIdentities.DB?.value,
  );
  if (resourceIdentities.DOCUMENTS?.value !== autoProvisionedResourceName(workerName, "DOCUMENTS")) {
    throw new Error("The main R2 binding is not the expected auto-named bucket.");
  }
}

async function currentDeploymentSource(npx, configArgument, workerName, expectedVersion, environment) {
  const status = await requireSuccessfulCapturedCommand(
    npx,
    ["wrangler", "deployments", "status", "--name", workerName, "--json", "--config", configArgument],
    environment,
    "Current Worker deployment verification",
  );
  validateStableDeployment(status, expectedVersion);
  return status;
}

async function verifyIsolatedBootstrap(
  npx, configArgument, workerName, expectedVersion, sourceRevision, source, environment,
) {
  const status = await requireSuccessfulCapturedCommand(
    npx,
    ["wrangler", "deployments", "status", "--name", workerName, "--json", "--config", configArgument],
    environment,
    "Isolated bootstrap deployment verification",
  );
  const version = expectedVersion === null
    ? readStableDeploymentVersion(status)
    : validateStableDeployment(status, expectedVersion);
  const inspected = await requireSuccessfulCapturedCommand(
    npx,
    ["wrangler", "versions", "view", version, "--name", workerName, "--json", "--config", configArgument],
    environment,
    "Isolated bootstrap version inspection",
  );
  const evidence = validateIsolatedBootstrapVersion(inspected, source, {
    expectedVersion: version,
    workerName,
    sourceRevision,
    resourceBindings: MAIN_RESOURCE_BINDINGS,
  });
  await verifyMainResourceIdentities(
    npx, configArgument, workerName, evidence.resourceIdentities, environment,
  );
  return Object.freeze({ version, resourceIdentities: evidence.resourceIdentities });
}

async function verifyMainSchema(npx, configArgument, environment) {
  const output = await requireSuccessfulCapturedCommand(
    npx,
    [
      "wrangler", "d1", "execute", "DB", "--remote",
      "--command", `SELECT version FROM notice_schema_state WHERE id = '${NOTICE_SCHEMA_MARKER_ID}'`,
      "--json", "--config", configArgument,
    ],
    environment,
    "Remote Notice schema verification",
  );
  validateD1SchemaMarker(output, "version", NOTICE_SCHEMA_VERSION);
}

async function verifyBootstrapAdminContinuity(
  npx, configArgument, workspaceId, environment,
) {
  const output = await requireSuccessfulCapturedCommand(
    npx,
    [
      "wrangler", "d1", "execute", "DB", "--remote",
      "--command", `SELECT '${workspaceId}' AS workspace_id, COUNT(DISTINCT memberships.user_id) AS active_admin_count FROM workspace_memberships AS memberships INNER JOIN users ON users.id = memberships.user_id INNER JOIN workspaces ON workspaces.id = memberships.workspace_id AND workspaces.status = 'active' WHERE memberships.workspace_id = '${workspaceId}' AND memberships.role = 'admin' AND memberships.status = 'active' AND users.status = 'active'`,
      "--json", "--config", configArgument,
    ],
    environment,
    "Bootstrap retirement administrator continuity verification",
  );
  return validateBootstrapAdminContinuity(output, workspaceId);
}

async function main() {
  let wrangler = null;
  try {
    rejectInternalReleaseEnvironment();
    const environments = createGuardedReleaseEnvironments(process.env, {
      WRANGLER_LOG_PATH: resolve(process.cwd(), ".wrangler/wrangler.log"),
    });
    const environment = environments.command;
    const wranglerEnvironment = environments.wrangler;
    wrangler = createPinnedWranglerRunner();
    const parsed = parseDeployArguments(process.argv.slice(2));
    const configPath = validateGeneratedConfigPath(parsed.config);
    const environmentName = /^notice-deployment-([a-z][a-z0-9-]{1,31})\.json$/.exec(basename(configPath))?.[1];
    const validatedConfig = await loadValidatedGeneratedConfiguration(
      configPath,
      "validated-main-config",
      (candidate) => validateGeneratedConfiguration(candidate, environmentName),
    );
    wrangler.pinConfiguration(validatedConfig.path, validatedConfig.configuration);
    const source = validatedConfig.configuration;
    const {
      workerName,
      workspaceId,
      bootstrapEnabled,
      accountId,
      sourceRevision,
      requiredSecretNames,
    } = validatedConfig.validation;
    requireBootstrapForEmptyMainRelease(parsed.mode, bootstrapEnabled);
    const validatedSecrets = parsed.mode === "configuration-promotion"
      ? null
      : await loadValidatedSecretsInput(
          parsed.secretsFile,
          requiredSecretNames,
          [],
          process.cwd(),
          environment,
        );
    if (validatedSecrets !== null) {
      try {
        wrangler.pinSecrets(validatedSecrets.path, validatedSecrets.canonicalBytes);
      } finally {
        validatedSecrets.canonicalBytes.fill(0);
      }
    }

    const npx = wrangler;
    const configArgument = displayPath(validatedConfig.path);
    const secretArguments = validatedSecrets === null
      ? []
      : ["--secrets-file", displayPath(validatedSecrets.path)];
    const firstInstallConfigurations = parsed.mode === "configuration-promotion"
      ? null
      : pinFirstInstallConfigurationVariants(wrangler, source);
    const promotionConfigPath = parsed.mode === "configuration-promotion"
      ? pinPrivateInternalConfiguration(wrangler, "notice-resolved-promotion", source)
      : null;
    const bootstrapConfigArgument = firstInstallConfigurations === null
      ? displayPath(promotionConfigPath)
      : displayPath(firstInstallConfigurations.bootstrapPath);
    const activationConfigArgument = firstInstallConfigurations === null
      ? displayPath(promotionConfigPath)
      : displayPath(firstInstallConfigurations.activationPath);
    const releasePlan = mainReleaseModePlan(
      parsed.mode,
      npx,
      parsed.mode === "configuration-promotion" ? activationConfigArgument : configArgument,
      secretArguments,
      workerName,
      sourceRevision,
      bootstrapConfigArgument,
      activationConfigArgument,
    );
    let bootstrapVersion = parsed.mode === "first-install-resume"
      ? parsed.expectedBootstrapVersion
      : null;
    let bootstrapRetirement = false;

    if (validatedSecrets === null) {
      process.stdout.write(`Validated the exact existing ${requiredSecretNames.length}-secret binding set; promotion will retain values without accepting a secret file.\n`);
    } else {
      process.stdout.write(`Validated ${requiredSecretNames.length} required secret keys in ${basename(parsed.secretsFile)}; values were not printed.\n`);
    }
    await verifyCheckoutAndAccount(
      npx, configArgument, accountId, sourceRevision, environment, wranglerEnvironment,
    );
    if (releasePlan.preflight === "absent-target") {
      const workerState = await runCapturedReleaseCommand(npx, [
        "wrangler", "versions", "list", "--name", workerName, "--json", "--config", configArgument,
      ], wranglerEnvironment);
      validateWorkerAbsent(workerState);
      const d1Name = autoProvisionedResourceName(workerName, "DB");
      const d1Inventory = await requireSuccessfulCapturedCommand(
        npx,
        ["wrangler", "d1", "list", "--json", "--config", configArgument],
        wranglerEnvironment,
        "Remote D1 resource preflight",
      );
      validateD1ResourceAbsent(d1Inventory, d1Name);
      const r2Name = autoProvisionedResourceName(workerName, "DOCUMENTS");
      const r2State = await runCapturedReleaseCommand(npx, [
        "wrangler", "r2", "bucket", "info", r2Name, "--json", "--config", configArgument,
      ], wranglerEnvironment);
      validateR2ResourceAbsent(r2State, r2Name);
      process.stdout.write(`Verified the pinned Cloudflare account and absent Worker, D1, and R2 auto-provision targets for ${workerName}.\n`);
    } else if (releasePlan.preflight === "isolated-bootstrap") {
      const bootstrap = await verifyIsolatedBootstrap(
        npx,
        configArgument,
        workerName,
        parsed.expectedBootstrapVersion,
        sourceRevision,
        source,
        wranglerEnvironment,
      );
      bootstrapVersion = bootstrap.version;
      updateFirstInstallConfigurationVariants(
        wrangler, source, firstInstallConfigurations, bootstrap.resourceIdentities,
      );
      process.stdout.write(`Verified isolated bootstrap deployment ${bootstrapVersion}; resume remains bounded to its exact source and bindings.\n`);
    } else {
      await currentDeploymentSource(
        npx,
        configArgument,
        workerName,
        parsed.expectedCurrentVersion,
        wranglerEnvironment,
      );
      const currentVersion = await requireSuccessfulCapturedCommand(
        npx,
        [
          "wrangler", "versions", "view", parsed.expectedCurrentVersion,
          "--name", workerName, "--json", "--config", configArgument,
        ],
        wranglerEnvironment,
        "Current Worker version inspection",
      );
      const promotion = validateConfigurationPromotion(currentVersion, source, {
        sourceRevision,
        attestationNames: MAIN_ATTESTATION_NAMES,
        resourceBindings: MAIN_RESOURCE_BINDINGS,
      });
      await verifyMainResourceIdentities(
        npx, configArgument, workerName, promotion.resourceIdentities, wranglerEnvironment,
      );
      wrangler.pinConfiguration(
        promotionConfigPath,
        resolvedMainConfiguration(source, promotion.resourceIdentities),
      );
      await verifyMainSchema(npx, activationConfigArgument, wranglerEnvironment);
      bootstrapRetirement = promotion.bootstrapRetirement;
      if (bootstrapRetirement) {
        const continuity = await verifyBootstrapAdminContinuity(
          npx, activationConfigArgument, workspaceId, wranglerEnvironment,
        );
        process.stdout.write(`Verified ${continuity.activeAdministratorCount} durable active administrators before bootstrap retirement.\n`);
      }
      process.stdout.write(`Verified configuration-only promotion from Worker version ${parsed.expectedCurrentVersion}.\n`);
    }
    await runPinnedReleaseBuild(environment);
    const dryRunConfigArgument = parsed.mode === "first-install"
      ? configArgument
      : activationConfigArgument;
    const dryRunProvisionArguments = parsed.mode === "first-install" ? ["--x-provision"] : [];
    await runReleaseCommand(npx, [
      "wrangler", "versions", "upload", "--dry-run", "--strict", ...dryRunProvisionArguments,
      "--config", dryRunConfigArgument,
    ], wranglerEnvironment);
    await runReleaseCommand(npx, [
      "wrangler", "deploy", "--dry-run", "--strict", ...dryRunProvisionArguments,
      "--config", dryRunConfigArgument,
    ], wranglerEnvironment);
    for (const step of releasePlan.mutations) {
      if (step.id === "schema-marker") {
        await verifyMainSchema(npx, bootstrapConfigArgument, wranglerEnvironment);
      } else if (step.id === "bootstrap-proof") {
        const bootstrap = await verifyIsolatedBootstrap(
          npx, configArgument, workerName, null, sourceRevision, source, wranglerEnvironment,
        );
        bootstrapVersion = bootstrap.version;
        updateFirstInstallConfigurationVariants(
          wrangler, source, firstInstallConfigurations, bootstrap.resourceIdentities,
        );
      } else if (step.id === "stable-deployment") {
        await currentDeploymentSource(
          npx,
          configArgument,
          workerName,
          parsed.expectedCurrentVersion,
          wranglerEnvironment,
        );
      } else if (step.id === "bootstrap-stable") {
        if (bootstrapVersion === null) throw new Error("The isolated bootstrap version was not recorded.");
        await verifyIsolatedBootstrap(
          npx, configArgument, workerName, bootstrapVersion, sourceRevision, source, wranglerEnvironment,
        );
      } else {
        if ([
          "isolated-bootstrap-deploy", "isolation-reset", "isolation-final-reset",
          "migration-apply", "activate",
        ].includes(step.id)) {
          await verifyCheckoutSource(sourceRevision, environment);
        }
        if (step.id === "activate" && bootstrapRetirement) {
          await verifyBootstrapAdminContinuity(
            npx, activationConfigArgument, workspaceId, wranglerEnvironment,
          );
        }
        await runReleaseCommand(step.command, step.args, wranglerEnvironment);
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "First-install deployment failed."}\n\n${usage}`);
    process.exitCode = 1;
  } finally {
    wrangler?.destroy();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) await main();
