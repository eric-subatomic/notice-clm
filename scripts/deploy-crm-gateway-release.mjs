#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { CRM_GATEWAY_SCHEMA_VERSION } from "../integrations/crm-gateway/src/receipt-store.ts";
import {
  parseCrmGatewayManifest,
  renderCrmGatewayWranglerConfiguration,
} from "./crm-gateway-manifest.ts";
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
  runReleaseCommand,
  loadValidatedGeneratedConfiguration,
  loadValidatedSecretsInput,
  validateConfigurationPromotion,
  validateD1ResourceAbsent,
  validateD1SchemaMarker,
  validateIsolatedBootstrapVersion,
  validateIgnoredGeneratedPath,
  validateProvisionedD1Identity,
  validateReleaseCheckout,
  validateStableDeployment,
  validateWorkerAbsent,
  validateWranglerAccountIdentity,
} from "./release-utils.mjs";

const usage = `Notice CRM gateway guarded release deployment

Usage:
  npm run crm:gateway:deploy -- \\
    --config .wrangler/notice-crm-gateway-<environment>.json \\
    --secrets-file .dev.vars.crm-<environment> --confirm-empty-environment \\
    --confirm-workers-paid-plan

  npm run crm:gateway:promote -- \\
    --config .wrangler/notice-crm-gateway-<environment>.json \\
    --expected-current-version <uuid> --confirm-configuration-only \\
    --confirm-workers-paid-plan

  npm run crm:gateway:resume -- \\
    --config .wrangler/notice-crm-gateway-<environment>.json \\
    --secrets-file .dev.vars.crm-<environment> --expected-bootstrap-version <uuid> \\
    --confirm-stranded-first-install --confirm-workers-paid-plan

The generated config must come from scripts/crm-gateway-kit.mjs. This command
refuses generic upgrades. See docs/DEPLOYMENT.md for the coordinated
maintenance-window upgrade and recovery procedure.
`;

const CRM_RESOURCE_BINDINGS = Object.freeze([
  Object.freeze({ type: "d1", name: "CRM_DB", identityField: "id" }),
]);

function requiredString(candidate, field) {
  const value = candidate?.[field];
  if (typeof value !== "string") throw new Error(`The generated CRM gateway config is missing ${field}.`);
  return value;
}

function requiredInteger(candidate, field) {
  const serialized = requiredString(candidate, field);
  if (!/^(?:0|[1-9]\d*)$/.test(serialized)) {
    throw new Error(`The generated CRM gateway config has an invalid ${field} value.`);
  }
  return Number(serialized);
}

function reconstructManifest(config, environment) {
  const vars = config.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
    throw new Error("The generated CRM gateway config must contain a vars object.");
  }
  if (Object.keys(vars).some((name) => name.startsWith("NOTICE_INTERNAL_"))) {
    throw new Error("NOTICE_INTERNAL_* settings are forbidden in release deployment configs.");
  }
  const provider = requiredString(vars, "NOTICE_CRM_PROVIDER");
  const sharedProvider = {
    type: provider,
    mappingVersion: requiredString(vars, "NOTICE_CRM_MAPPING_VERSION"),
    fieldMapping: vars.NOTICE_CRM_FIELD_MAPPING_JSON === undefined
      ? {}
      : JSON.parse(requiredString(vars, "NOTICE_CRM_FIELD_MAPPING_JSON")),
  };
  let providerManifest;
  if (provider === "hubspot") {
    providerManifest = {
      ...sharedProvider,
      apiBaseUrl: requiredString(vars, "NOTICE_CRM_HUBSPOT_API_BASE_URL"),
      objectType: requiredString(vars, "NOTICE_CRM_HUBSPOT_OBJECT_TYPE"),
      idProperty: requiredString(vars, "NOTICE_CRM_HUBSPOT_ID_PROPERTY"),
    };
  } else if (provider === "salesforce") {
    providerManifest = {
      ...sharedProvider,
      loginUrl: requiredString(vars, "NOTICE_CRM_SALESFORCE_LOGIN_URL"),
      object: requiredString(vars, "NOTICE_CRM_SALESFORCE_OBJECT"),
      externalIdField: requiredString(vars, "NOTICE_CRM_SALESFORCE_EXTERNAL_ID_FIELD"),
      apiVersion: requiredString(vars, "NOTICE_CRM_SALESFORCE_API_VERSION"),
    };
  } else if (provider === "custom") {
    providerManifest = {
      ...sharedProvider,
      url: requiredString(vars, "NOTICE_CRM_CUSTOM_URL"),
      externalIdField: requiredString(vars, "NOTICE_CRM_CUSTOM_EXTERNAL_ID_FIELD"),
    };
  } else {
    throw new Error("The generated CRM gateway config selects an unsupported provider.");
  }

  return parseCrmGatewayManifest({
    schemaVersion: "1.0",
    accountId: config.account_id,
    sourceRevision: requiredString(vars, "NOTICE_RELEASE_REVISION"),
    environment,
    workerName: config.name,
    customDomain: config.routes?.[0]?.pattern,
    provider: providerManifest,
    schedules: { recovery: config.triggers?.crons?.[0] },
    retention: {
      terminalPayloadDays: requiredInteger(vars, "NOTICE_CRM_TERMINAL_PAYLOAD_RETENTION_DAYS"),
      terminalMetadataDays: requiredInteger(vars, "NOTICE_CRM_TERMINAL_METADATA_RETENTION_DAYS"),
    },
  });
}

export function parseCrmGatewayDeployArguments(args) {
  return parseReleaseArguments(args);
}

export function validateCrmGatewayGeneratedConfigPath(candidate, cwd = process.cwd()) {
  return validateIgnoredGeneratedPath(
    candidate,
    /^notice-crm-gateway-[a-z][a-z0-9-]{1,31}\.json$/,
    cwd,
  );
}

export function validateCrmGatewayGeneratedConfiguration(candidate, environment) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("The generated CRM gateway config must be a JSON object.");
  }
  rejectInternalReleaseSettings(candidate);
  if (typeof environment !== "string") {
    throw new Error("The generated CRM gateway environment is required for exact validation.");
  }
  let manifest;
  try {
    manifest = reconstructManifest(candidate, environment);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("The generated CRM field mapping is not valid JSON.");
    }
    throw error;
  }
  const rendered = renderCrmGatewayWranglerConfiguration(manifest);
  if (!isDeepStrictEqual(candidate, rendered)) {
    throw new Error("The deployment config is not the exact fail-closed output of the CRM gateway renderer.");
  }
  return Object.freeze({
    workerName: manifest.workerName,
    provider: manifest.provider.type,
    accountId: manifest.accountId,
    sourceRevision: manifest.sourceRevision,
    requiredSecretNames: Object.freeze([...rendered.secrets.required]),
  });
}

export function isolatedCrmBootstrapConfiguration(candidate) {
  const bootstrap = structuredClone(candidate);
  bootstrap.routes = [];
  bootstrap.triggers = { crons: [] };
  return bootstrap;
}

export function resolvedCrmConfiguration(candidate, resourceIdentities) {
  const databaseId = resourceIdentities?.CRM_DB?.value;
  const expectedDatabaseName = autoProvisionedResourceName(candidate.name, "CRM_DB");
  if (typeof databaseId !== "string" || databaseId.length === 0) {
    throw new Error("The isolated bootstrap did not prove the expected CRM storage identity.");
  }
  const resolved = structuredClone(candidate);
  resolved.d1_databases = resolved.d1_databases.map((database) => (
    database.binding === "CRM_DB"
      ? { ...database, database_name: expectedDatabaseName, database_id: databaseId }
      : database
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
    "notice-crm-isolated-bootstrap", isolatedCrmBootstrapConfiguration(candidate),
  );
  return Object.freeze({
    bootstrapPath,
    activationPath: pinPrivateInternalConfiguration(runner, "notice-crm-resolved-activation", candidate),
  });
}

function updateFirstInstallConfigurationVariants(runner, candidate, paths, resourceIdentities) {
  const resolved = resolvedCrmConfiguration(candidate, resourceIdentities);
  runner.pinConfiguration(paths.bootstrapPath, isolatedCrmBootstrapConfiguration(resolved));
  runner.pinConfiguration(paths.activationPath, resolved);
}

export function crmFirstInstallMutationCommands(
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
        "--message", `Notice CRM isolated first-install bootstrap source ${sourceRevision}`,
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
      args: ["wrangler", "d1", "migrations", "list", "CRM_DB", "--remote", "--config", bootstrapConfigArgument],
    }),
    Object.freeze({
      id: "migration-apply",
      command: npx,
      args: ["wrangler", "d1", "migrations", "apply", "CRM_DB", "--remote", "--config", bootstrapConfigArgument],
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
        "--message", `Notice CRM source ${sourceRevision}`,
        "--config", activationConfigArgument,
        ...secretArguments,
      ],
    }),
  ]);
}

export function crmPromotionMutationCommands(npx, configArgument, sourceRevision) {
  return Object.freeze([
    Object.freeze({ id: "schema-marker", capture: true }),
    Object.freeze({ id: "stable-deployment", capture: true }),
    Object.freeze({
      id: "activate",
      command: npx,
      args: [
        "wrangler", "deploy", "--strict", "--tag", releaseSourceTag(sourceRevision),
        "--message", `Notice CRM configuration promotion source ${sourceRevision}`,
        "--config", configArgument,
      ],
    }),
  ]);
}

export function crmFirstInstallResumeMutationCommands(
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
      args: ["wrangler", "d1", "migrations", "list", "CRM_DB", "--remote", "--config", bootstrapConfigArgument],
    }),
    Object.freeze({
      id: "migration-apply",
      command: npx,
      args: ["wrangler", "d1", "migrations", "apply", "CRM_DB", "--remote", "--config", bootstrapConfigArgument],
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
        "--message", `Notice CRM source ${sourceRevision}`,
        "--config", activationConfigArgument,
        ...secretArguments,
      ],
    }),
  ]);
}

export function crmReleaseModePlan(
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
      mutations: crmFirstInstallMutationCommands(
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
      mutations: crmFirstInstallResumeMutationCommands(
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
      mutations: crmPromotionMutationCommands(
        npx, configArgument, sourceRevision,
      ),
    });
  }
  throw new Error("Unsupported CRM gateway release mode.");
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

async function verifyCrmResourceIdentity(
  npx, configArgument, workerName, resourceIdentities, environment,
) {
  const d1Inventory = await requireSuccessfulCapturedCommand(
    npx,
    ["wrangler", "d1", "list", "--json", "--config", configArgument],
    environment,
    "Provisioned CRM D1 identity verification",
  );
  validateProvisionedD1Identity(
    d1Inventory,
    autoProvisionedResourceName(workerName, "CRM_DB"),
    resourceIdentities.CRM_DB?.value,
  );
}

async function currentDeploymentSource(npx, configArgument, workerName, expectedVersion, environment) {
  const status = await requireSuccessfulCapturedCommand(
    npx,
    ["wrangler", "deployments", "status", "--name", workerName, "--json", "--config", configArgument],
    environment,
    "Current CRM gateway deployment verification",
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
    "Isolated CRM bootstrap deployment verification",
  );
  const version = expectedVersion === null
    ? readStableDeploymentVersion(status)
    : validateStableDeployment(status, expectedVersion);
  const inspected = await requireSuccessfulCapturedCommand(
    npx,
    ["wrangler", "versions", "view", version, "--name", workerName, "--json", "--config", configArgument],
    environment,
    "Isolated CRM bootstrap version inspection",
  );
  const evidence = validateIsolatedBootstrapVersion(inspected, source, {
    expectedVersion: version,
    workerName,
    sourceRevision,
    resourceBindings: CRM_RESOURCE_BINDINGS,
  });
  await verifyCrmResourceIdentity(
    npx, configArgument, workerName, evidence.resourceIdentities, environment,
  );
  return Object.freeze({ version, resourceIdentities: evidence.resourceIdentities });
}

async function verifyCrmSchema(npx, configArgument, environment) {
  const output = await requireSuccessfulCapturedCommand(
    npx,
    [
      "wrangler", "d1", "execute", "CRM_DB", "--remote",
      "--command", "SELECT schema_version FROM crm_gateway_schema_state WHERE singleton = 1",
      "--json", "--config", configArgument,
    ],
    environment,
    "Remote CRM gateway schema verification",
  );
  validateD1SchemaMarker(output, "schema_version", CRM_GATEWAY_SCHEMA_VERSION);
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
    const parsed = parseCrmGatewayDeployArguments(process.argv.slice(2));
    const configPath = validateCrmGatewayGeneratedConfigPath(parsed.config);
    const environmentName = /^notice-crm-gateway-([a-z][a-z0-9-]{1,31})\.json$/.exec(basename(configPath))?.[1];
    const validatedConfig = await loadValidatedGeneratedConfiguration(
      configPath,
      "validated-crm-config",
      (candidate) => validateCrmGatewayGeneratedConfiguration(candidate, environmentName),
    );
    wrangler.pinConfiguration(validatedConfig.path, validatedConfig.configuration);
    const source = validatedConfig.configuration;
    const {
      workerName,
      accountId,
      sourceRevision,
      requiredSecretNames,
    } = validatedConfig.validation;
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
      ? pinPrivateInternalConfiguration(wrangler, "notice-crm-resolved-promotion", source)
      : null;
    const bootstrapConfigArgument = firstInstallConfigurations === null
      ? displayPath(promotionConfigPath)
      : displayPath(firstInstallConfigurations.bootstrapPath);
    const activationConfigArgument = firstInstallConfigurations === null
      ? displayPath(promotionConfigPath)
      : displayPath(firstInstallConfigurations.activationPath);
    const releasePlan = crmReleaseModePlan(
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
      const d1Name = autoProvisionedResourceName(workerName, "CRM_DB");
      const d1Inventory = await requireSuccessfulCapturedCommand(
        npx,
        ["wrangler", "d1", "list", "--json", "--config", configArgument],
        wranglerEnvironment,
        "Remote CRM D1 resource preflight",
      );
      validateD1ResourceAbsent(d1Inventory, d1Name);
      process.stdout.write(`Verified the pinned Cloudflare account and absent Worker and D1 auto-provision targets for ${workerName}.\n`);
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
      process.stdout.write(`Verified isolated CRM bootstrap deployment ${bootstrapVersion}; resume remains bounded to its exact source and bindings.\n`);
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
        "Current CRM gateway version inspection",
      );
      const promotion = validateConfigurationPromotion(currentVersion, source, {
        sourceRevision,
        attestationNames: [],
        resourceBindings: CRM_RESOURCE_BINDINGS,
      });
      await verifyCrmResourceIdentity(
        npx, configArgument, workerName, promotion.resourceIdentities, wranglerEnvironment,
      );
      wrangler.pinConfiguration(
        promotionConfigPath,
        resolvedCrmConfiguration(source, promotion.resourceIdentities),
      );
      await verifyCrmSchema(npx, activationConfigArgument, wranglerEnvironment);
      process.stdout.write(`Verified configuration-only promotion from CRM gateway version ${parsed.expectedCurrentVersion}.\n`);
    }
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
        await verifyCrmSchema(npx, bootstrapConfigArgument, wranglerEnvironment);
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
        if (bootstrapVersion === null) throw new Error("The isolated CRM bootstrap version was not recorded.");
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
        await runReleaseCommand(step.command, step.args, wranglerEnvironment);
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "CRM gateway first-install deployment failed."}\n\n${usage}`);
    process.exitCode = 1;
  } finally {
    wrangler?.destroy();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) await main();
