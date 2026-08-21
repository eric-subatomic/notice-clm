import assert from "node:assert/strict";
import test from "node:test";
import {
  attachCurrentIntegrationDiagnostics,
  integrationConfigurationFingerprint,
  isCurrentIntegrationDiagnostic,
} from "../app/lib/integration-diagnostic-policy";
import { getIntegrationSummaries, getIntegrationSummary } from "../app/lib/integration-status";
import { scannerConfigurationFromSource } from "../app/lib/scanner-configuration";
import { createOcrReadinessChallenge, ocrReadinessResultMatches, syntheticOcrReadinessPdf } from "../app/lib/ocr-readiness";

test("integration status reports requirements without exposing configuration values", () => {
  const source = {
    NOTICE_ESIGN_ENABLED: "true",
    NOTICE_ESIGN_PROVIDER: "docuseal",
    NOTICE_ESIGN_CONFIGURED: "true",
    NOTICE_DOCUSEAL_DEPLOYMENT: "self-hosted",
    NOTICE_DOCUSEAL_API_BASE_URL: "https://signatures.orchid.test/api",
    NOTICE_DOCUSEAL_API_TOKEN: "docuseal-unit-test-token",
    NOTICE_DOCUSEAL_WEBHOOK_SECRET: `whsec_${"a".repeat(32)}`,
    NOTICE_DOCUSEAL_TEMPLATE_ID: "42",
    NOTICE_DOCUSEAL_VALIDATED_RELEASE: "3.2.1",
    NOTICE_DOCUSEAL_API_CLIENT_CONTRACT: "1.0.24",
    NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED: "true",
    NOTICE_DOCUSEAL_EXPIRATION_HOURS: "168",
    NOTICE_DOCUSEAL_EMAIL_2FA_REQUIRED: "true",
    NOTICE_DOCUSEAL_MCP_ENABLED: "false",
    NOTICE_SCAN_ENABLED: "true",
    NOTICE_SCAN_PROVIDER: "scan-gateway",
    NOTICE_SCAN_CONFIGURED: "true",
    NOTICE_SCAN_GATEWAY_URL: "https://scanner.orchid.test/scan",
    NOTICE_SCAN_GATEWAY_SECRET: "scanner-unit-test-signing-secret-32",
    NOTICE_SCAN_OCR_ENABLED: "false",
    NOTICE_MAIL_ENABLED: "true",
    NOTICE_MAIL_PROVIDER: "delivery-gateway",
    NOTICE_MAIL_CONFIGURED: "true",
    NOTICE_DELIVERY_GATEWAY_URL: "https://delivery.orchid.test/events",
    NOTICE_DELIVERY_GATEWAY_SECRET: "delivery-unit-test-signing-secret-32",
    NOTICE_CRM_ENABLED: "false",
    NOTICE_CRM_PROVIDER: "none",
    NOTICE_CRM_CONFIGURED: "false",
  };

  const summaries = getIntegrationSummaries(source);
  assert.equal(getIntegrationSummary(source, "docuseal").configured, true);
  assert.equal(getIntegrationSummary(source, "scanner").configured, true);
  assert.equal(getIntegrationSummary(source, "delivery").configured, true);
  assert.equal(getIntegrationSummary(source, "crm").required, false);

  const serialized = JSON.stringify(summaries);
  assert.doesNotMatch(serialized, /unit-test-token|unit-test-secret|orchid\.test|template.?42/i);
  assert.deepEqual(summaries.map((summary) => summary.lastTest), [null, null, null, null]);
});

test("scanner status exposes only the explicit non-secret customer-hosted OCR selection and fingerprints every change", async () => {
  const source = {
    NOTICE_SCAN_ENABLED: "true",
    NOTICE_SCAN_PROVIDER: "scan-gateway",
    NOTICE_SCAN_CONFIGURED: "true",
    NOTICE_SCAN_GATEWAY_URL: "https://scanner.orchid.test/scan",
    NOTICE_SCAN_GATEWAY_SECRET: "scanner-unit-test-signing-secret-32",
    NOTICE_SCAN_OCR_ENABLED: "true",
    NOTICE_SCAN_OCR_MODEL_ID: "acme-vision-v2",
    NOTICE_SCAN_OCR_PROFILE_ID: "contracts-en-v1",
  };
  const summary = getIntegrationSummary(source, "scanner");
  assert.equal(summary.configured, true);
  assert.deepEqual(summary.selectedOcrProfile, {
    execution: "customer-hosted-scanner-gateway",
    modelId: "acme-vision-v2",
    profileId: "contracts-en-v1",
  });
  assert.match(summary.detail, /acme-vision-v2.*contracts-en-v1.*signed gateway/i);
  assert.doesNotMatch(JSON.stringify(summary), /scanner\.orchid\.test|signing-secret/);

  const original = await integrationConfigurationFingerprint(source, "scanner");
  assert.notEqual(original, await integrationConfigurationFingerprint({
    ...source,
    NOTICE_SCAN_OCR_PROFILE_ID: "contracts-en-v2",
  }, "scanner"));

  const unsafe = getIntegrationSummary({
    ...source,
    NOTICE_SCAN_OCR_MODEL_ID: "https://external-model.invalid",
  }, "scanner");
  assert.equal(unsafe.testable, false);
  assert.equal(unsafe.selectedOcrProfile, null);
  assert.match(unsafe.detail, /bounded OCR model\/profile identifiers/i);

  const disabledWithStaleIds = getIntegrationSummary({
    ...source,
    NOTICE_SCAN_OCR_ENABLED: "false",
  }, "scanner");
  assert.equal(disabledWithStaleIds.testable, false);
  assert.match(disabledWithStaleIds.detail, /no stale identifiers/i);

  const unreadySelection = scannerConfigurationFromSource({
    ...source,
    NOTICE_SCAN_CONFIGURED: "false",
  });
  assert.equal(unreadySelection.endpoint, null);
  assert.deepEqual(unreadySelection.ocr, { modelId: "acme-vision-v2", profileId: "contracts-en-v1" });

  for (const unready of [
    { ...source, NOTICE_SCAN_CONFIGURED: "false", NOTICE_SCAN_OCR_ENABLED: undefined },
    { ...source, NOTICE_SCAN_ENABLED: "false", NOTICE_SCAN_OCR_ENABLED: undefined },
  ]) {
    assert.throws(() => scannerConfigurationFromSource(unready), /must explicitly select or disable/i);
  }

  const uppercaseBoolean = { ...source, NOTICE_SCAN_OCR_ENABLED: "TRUE" };
  assert.throws(() => scannerConfigurationFromSource(uppercaseBoolean), /must explicitly select or disable/i);
  assert.equal(getIntegrationSummary(uppercaseBoolean, "scanner").testable, false);

  const uppercaseProvider = { ...source, NOTICE_SCAN_PROVIDER: "SCAN-GATEWAY" };
  assert.equal(scannerConfigurationFromSource(uppercaseProvider).endpoint, null);
  assert.equal(getIntegrationSummary(uppercaseProvider, "scanner").testable, false);
});

test("OCR readiness embeds and verifies a fresh per-run challenge", () => {
  const first = createOcrReadinessChallenge();
  const second = createOcrReadinessChallenge();
  assert.notEqual(first, second);
  assert.match(new TextDecoder().decode(syntheticOcrReadinessPdf(first)), new RegExp(first));
  assert.equal(ocrReadinessResultMatches("static nonempty OCR output", first), false);
  assert.equal(ocrReadinessResultMatches(`extracted ${first} exactly`, first), true);
  assert.equal(ocrReadinessResultMatches(`extracted ${first} exactly`, second), false);
});

test("complete credentials are testable before a production attestation is enabled", () => {
  const source = {
    NOTICE_ESIGN_ENABLED: "true",
    NOTICE_ESIGN_PROVIDER: "docuseal",
    NOTICE_ESIGN_CONFIGURED: "false",
    NOTICE_DOCUSEAL_DEPLOYMENT: "cloud-global",
    NOTICE_DOCUSEAL_API_BASE_URL: "https://api.docuseal.com",
    NOTICE_DOCUSEAL_API_TOKEN: "token",
    NOTICE_DOCUSEAL_WEBHOOK_SECRET: `whsec_${"b".repeat(32)}`,
    NOTICE_DOCUSEAL_TEMPLATE_ID: "7",
    NOTICE_DOCUSEAL_VALIDATED_RELEASE: "3.2.1",
    NOTICE_DOCUSEAL_API_CLIENT_CONTRACT: "1.0.24",
    NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED: "true",
    NOTICE_DOCUSEAL_EXPIRATION_HOURS: "168",
    NOTICE_DOCUSEAL_EMAIL_2FA_REQUIRED: "true",
    NOTICE_DOCUSEAL_MCP_ENABLED: "false",
  };
  const summary = getIntegrationSummary(source, "docuseal");
  assert.equal(summary.testable, true);
  assert.equal(summary.configured, false);
  assert.match(summary.detail, /ready for a live test/i);
});

test("DocuSeal status rejects Cloud/path mismatches, missing entitlement, and unsafe MCP configuration", () => {
  const base = {
    NOTICE_ESIGN_ENABLED: "true",
    NOTICE_ESIGN_PROVIDER: "docuseal",
    NOTICE_ESIGN_CONFIGURED: "true",
    NOTICE_DOCUSEAL_DEPLOYMENT: "cloud-global",
    NOTICE_DOCUSEAL_API_BASE_URL: "https://api.docuseal.com/api",
    NOTICE_DOCUSEAL_API_TOKEN: "api-token",
    NOTICE_DOCUSEAL_WEBHOOK_SECRET: `whsec_${"c".repeat(32)}`,
    NOTICE_DOCUSEAL_TEMPLATE_ID: "7",
    NOTICE_DOCUSEAL_VALIDATED_RELEASE: "3.2.1",
    NOTICE_DOCUSEAL_API_CLIENT_CONTRACT: "1.0.24",
    NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED: "false",
    NOTICE_DOCUSEAL_EXPIRATION_HOURS: "168",
    NOTICE_DOCUSEAL_EMAIL_2FA_REQUIRED: "true",
    NOTICE_DOCUSEAL_MCP_ENABLED: "true",
    NOTICE_DOCUSEAL_MCP_TOKEN: "api-token",
    NOTICE_DOCUSEAL_MCP_PROTOCOL_VERSION: "2025-11-25",
    NOTICE_DOCUSEAL_MCP_SERVER_VERSION: "3.2.1",
  };
  const summary = getIntegrationSummary(base, "docuseal");
  assert.equal(summary.testable, false);
  assert.equal(summary.configured, false);
  assert.match(summary.detail, /deployment type.*entitlement.*self-hosted same-origin MCP/i);
});

test("DocuSeal diagnostic evidence is invalidated by every provider contract and MCP change", async () => {
  const source = {
    NOTICE_ESIGN_ENABLED: "true",
    NOTICE_ESIGN_PROVIDER: "docuseal",
    NOTICE_ESIGN_CONFIGURED: "false",
    NOTICE_DOCUSEAL_DEPLOYMENT: "self-hosted",
    NOTICE_DOCUSEAL_API_BASE_URL: "https://signatures.orchid.test/api",
    NOTICE_DOCUSEAL_API_TOKEN: "api-token",
    NOTICE_DOCUSEAL_WEBHOOK_SECRET: `whsec_${"d".repeat(32)}`,
    NOTICE_DOCUSEAL_TEMPLATE_ID: "7",
    NOTICE_DOCUSEAL_VALIDATED_RELEASE: "3.2.1",
    NOTICE_DOCUSEAL_API_CLIENT_CONTRACT: "1.0.24",
    NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED: "true",
    NOTICE_DOCUSEAL_EXPIRATION_HOURS: "168",
    NOTICE_DOCUSEAL_EMAIL_2FA_REQUIRED: "true",
    NOTICE_DOCUSEAL_MCP_ENABLED: "true",
    NOTICE_DOCUSEAL_MCP_TOKEN: "separate-mcp-token",
    NOTICE_DOCUSEAL_MCP_PROTOCOL_VERSION: "2025-11-25",
    NOTICE_DOCUSEAL_MCP_SERVER_VERSION: "3.2.1",
  };
  const original = await integrationConfigurationFingerprint(source, "docuseal");
  assert.equal(
    original,
    await integrationConfigurationFingerprint({ ...source, NOTICE_ESIGN_CONFIGURED: "true" }, "docuseal"),
    "recording the final configured attestation must preserve its immediately preceding diagnostic",
  );
  for (const changed of [
    { NOTICE_DOCUSEAL_VALIDATED_RELEASE: "3.2.2" },
    { NOTICE_DOCUSEAL_API_CLIENT_CONTRACT: "1.0.25" },
    { NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED: "false" },
    { NOTICE_DOCUSEAL_EXPIRATION_HOURS: "72" },
    { NOTICE_DOCUSEAL_EMAIL_2FA_REQUIRED: "false" },
    { NOTICE_DOCUSEAL_MCP_TOKEN: "rotated-mcp-token" },
  ]) {
    assert.notEqual(original, await integrationConfigurationFingerprint({ ...source, ...changed }, "docuseal"));
  }
});

test("unsafe endpoints and unsupported providers fail closed", () => {
  const scanner = getIntegrationSummary({
    NOTICE_SCAN_ENABLED: "true",
    NOTICE_SCAN_PROVIDER: "scan-gateway",
    NOTICE_SCAN_CONFIGURED: "true",
    NOTICE_SCAN_GATEWAY_URL: "http://scanner.example.com/scan",
    NOTICE_SCAN_GATEWAY_SECRET: "secret",
    NOTICE_SCAN_OCR_ENABLED: "false",
  }, "scanner");
  assert.equal(scanner.testable, false);
  assert.equal(scanner.configured, false);

  const placeholderScanner = getIntegrationSummary({
    NOTICE_SCAN_ENABLED: "true",
    NOTICE_SCAN_PROVIDER: "scan-gateway",
    NOTICE_SCAN_CONFIGURED: "true",
    NOTICE_SCAN_GATEWAY_URL: "https://scanner.customer.invalid/scan",
    NOTICE_SCAN_GATEWAY_SECRET: "scanner-production-signing-secret-32",
    NOTICE_SCAN_OCR_ENABLED: "false",
  }, "scanner");
  assert.equal(placeholderScanner.testable, false);
  assert.equal(placeholderScanner.configured, false);

  const placeholderSecret = getIntegrationSummary({
    NOTICE_SCAN_ENABLED: "true",
    NOTICE_SCAN_PROVIDER: "scan-gateway",
    NOTICE_SCAN_CONFIGURED: "true",
    NOTICE_SCAN_GATEWAY_URL: "https://scanner.orchid.test/scan",
    NOTICE_SCAN_GATEWAY_SECRET: "replace-with-customer-scanner-secret-0000",
    NOTICE_SCAN_OCR_ENABLED: "false",
  }, "scanner");
  assert.equal(placeholderSecret.testable, false);
  assert.equal(placeholderSecret.configured, false);

  const incompleteCrm = getIntegrationSummary({
    NOTICE_CRM_ENABLED: "true",
    NOTICE_CRM_PROVIDER: "salesforce",
    NOTICE_CRM_CONFIGURED: "true",
    NOTICE_CRM_GATEWAY_URL: "https://crm-gateway.test.invalid/events",
    NOTICE_CRM_GATEWAY_SECRET: "secret",
  }, "crm");
  assert.equal(incompleteCrm.required, true);
  assert.equal(incompleteCrm.testable, false);
  assert.match(incompleteCrm.detail, /missing or invalid/i);

  const unsupportedCrm = getIntegrationSummary({
    NOTICE_CRM_ENABLED: "true",
    NOTICE_CRM_PROVIDER: "dynamics",
    NOTICE_CRM_CONFIGURED: "true",
    NOTICE_CRM_GATEWAY_URL: "https://crm.orchid.test/events",
    NOTICE_CRM_GATEWAY_SECRET: "crm-gateway-signing-secret-at-least-32",
  }, "crm");
  assert.equal(unsupportedCrm.testable, false);
  assert.match(unsupportedCrm.detail, /does not match/i);
});

test("included CRM providers require their independent runtime gateway", () => {
  for (const provider of ["hubspot", "salesforce", "custom"]) {
    const summary = getIntegrationSummary({
      NOTICE_CRM_ENABLED: "true",
      NOTICE_CRM_PROVIDER: provider,
      NOTICE_CRM_CONFIGURED: "true",
      NOTICE_CRM_GATEWAY_URL: "https://crm.orchid.test/v1/events",
      NOTICE_CRM_GATEWAY_SECRET: "crm-gateway-signing-secret-at-least-32",
      NOTICE_CRM_MAPPING_VERSION: "mapping-v1",
    }, "crm");
    assert.equal(summary.configured, true, provider);
    assert.equal(summary.testable, true, provider);
  }

  const noFallback = getIntegrationSummary({
    NOTICE_CRM_ENABLED: "true",
    NOTICE_CRM_PROVIDER: "hubspot",
    NOTICE_CRM_CONFIGURED: "true",
    NOTICE_DELIVERY_GATEWAY_URL: "https://delivery.orchid.test/events",
    NOTICE_DELIVERY_GATEWAY_SECRET: "delivery-gateway-signing-secret-32",
    NOTICE_CRM_MAPPING_VERSION: "mapping-v1",
  }, "crm");
  assert.equal(noFallback.configured, false);
  assert.match(noFallback.detail, /gateway URL.*gateway signing secret/i);
});

test("live diagnostic evidence is bound to the complete secret-backed configuration", async () => {
  const source = {
    NOTICE_CRM_ENABLED: "true",
    NOTICE_CRM_PROVIDER: "hubspot",
    NOTICE_CRM_CONFIGURED: "true",
    NOTICE_CRM_GATEWAY_URL: "https://crm.orchid.test/v1/events",
    NOTICE_CRM_GATEWAY_SECRET: "crm-gateway-signing-secret-at-least-32",
    NOTICE_CRM_MAPPING_VERSION: "mapping-v1",
  };
  const original = await integrationConfigurationFingerprint(source, "crm");
  const attestationOnly = await integrationConfigurationFingerprint({ ...source, NOTICE_CRM_CONFIGURED: "false" }, "crm");
  const rotatedSecret = await integrationConfigurationFingerprint({
    ...source,
    NOTICE_CRM_GATEWAY_SECRET: "rotated-crm-gateway-signing-secret-32",
  }, "crm");
  const changedMapping = await integrationConfigurationFingerprint({ ...source, NOTICE_CRM_MAPPING_VERSION: "mapping-v2" }, "crm");
  assert.equal(original, attestationOnly, "recording the operator attestation must not invalidate the test it follows");
  assert.notEqual(original, rotatedSecret);
  assert.notEqual(original, changedMapping);
  assert.doesNotMatch(original, /crm-gateway|mapping-v1/);

  const testedAt = "2026-08-02T12:00:00.000Z";
  const summaries = attachCurrentIntegrationDiagnostics(getIntegrationSummaries(source), {
    crm: { status: "passed", testedAt, detail: "Authenticated dry run passed." },
  });
  assert.equal(summaries.find((summary) => summary.id === "crm")?.lastTest?.testedAt, testedAt);
  assert.equal(summaries.find((summary) => summary.id === "delivery")?.lastTest, null);

  const now = Date.parse("2026-08-02T12:00:00.000Z");
  assert.equal(isCurrentIntegrationDiagnostic("2026-08-01T12:00:00.001Z", now), true);
  assert.equal(isCurrentIntegrationDiagnostic("2026-08-01T11:59:59.999Z", now), false);
  assert.equal(isCurrentIntegrationDiagnostic("2026-08-02T12:05:00.001Z", now), false);
  assert.equal(isCurrentIntegrationDiagnostic("not-a-date", now), false);
});
