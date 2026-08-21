import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectDocument, normalizedDocumentName, sha256Hex } from "../app/lib/document-security";
import { verifyDocuSealWebhook } from "../app/lib/docuseal";
import { guardMutationRequest } from "../app/lib/http";
import { evaluateProductionReadiness } from "../app/lib/readiness";
import { agreementMutationSchema, operationMutationSchema } from "../app/lib/validation";

test("document inspection uses content signatures instead of caller MIME claims", () => {
  const header = "%PDF-1.7\n";
  const catalog = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const pages = "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n";
  const catalogOffset = header.length;
  const pagesOffset = catalogOffset + catalog.length;
  const xrefOffset = pagesOffset + pages.length;
  const pdf = new TextEncoder().encode(`${header}${catalog}${pages}xref\n0 3\n0000000000 65535 f \n${String(catalogOffset).padStart(10, "0")} 00000 n \n${String(pagesOffset).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  assert.deepEqual(inspectDocument(pdf, "agreement.pdf"), {
    extension: "pdf",
    contentType: "application/pdf",
  });
  assert.throws(() => inspectDocument(new TextEncoder().encode("not a PDF"), "agreement.pdf"), /contents do not match/i);
  assert.throws(() => inspectDocument(new Uint8Array([0x4d, 0x5a, 0x90]), "agreement.txt"), /UTF-8|contents do not match/i);
  assert.equal(normalizedDocumentName("../../Confidential Agreement?.pdf"), "Confidential-Agreement-.pdf");
});

test("hashing is deterministic and DocuSeal webhooks reject tampering and stale delivery", async () => {
  assert.equal(await sha256Hex("notice"), await sha256Hex(new TextEncoder().encode("notice")));

  const secret = "whsec_synthetic-unit-test";
  const rawBody = JSON.stringify({ event_type: "submission.completed", data: { id: 42 } });
  const timestamp = 1_785_590_000;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const signature = Array.from(new Uint8Array(signed), (value) => value.toString(16).padStart(2, "0")).join("");

  assert.equal((await verifyDocuSealWebhook(rawBody, `${timestamp}.${signature}`, secret, timestamp * 1_000)).valid, true);
  assert.equal((await verifyDocuSealWebhook(`${rawBody} `, `${timestamp}.${signature}`, secret, timestamp * 1_000)).valid, false);
  assert.equal((await verifyDocuSealWebhook(rawBody, `${timestamp}.${signature}`, secret, (timestamp + 301) * 1_000)).valid, false);
});

test("browser mutation guard permits same-origin and denies absent or cross-site origins", async () => {
  const allowed = await guardMutationRequest(new Request("https://notice.example/api/agreements", {
    method: "POST",
    headers: { origin: "https://notice.example", "sec-fetch-site": "same-origin" },
  }));
  assert.equal(allowed.ok, true);

  const absent = await guardMutationRequest(new Request("https://notice.example/api/agreements", { method: "POST" }));
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.equal(absent.response.status, 403);

  const denied = await guardMutationRequest(new Request("https://notice.example/api/agreements", {
    method: "POST",
    headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
  }));
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.response.status, 403);
});

test("agreement and workflow inputs reject unbounded or caller-authoritative records", () => {
  const valid = agreementMutationSchema.parse({
    id: 99,
    party: "Orchid Systems",
    initials: "OS",
    side: "Sell-side",
    type: "Master Services Agreement",
    value: 125000,
    stage: "Draft",
    owner: "Legal Operations",
    due: "2026-08-10",
    crm: "None",
    crmRecord: "",
    tags: ["MSA"],
    department: "Legal",
    risk: "Unassessed",
    approvalStatus: "Pending",
    signatureStatus: "Not sent",
    effectiveDate: "",
    expirationDate: "",
  });
  assert.equal(valid.party, "Orchid Systems");
  assert.equal("stage" in valid, false);
  assert.equal("approvalStatus" in valid, false);
  assert.equal("signatureStatus" in valid, false);
  assert.equal(agreementMutationSchema.safeParse({ ...valid, nextAction: "Caller-owned queue" }).success, false);
  assert.equal(agreementMutationSchema.safeParse({ ...valid, side: "Every workspace" }).success, false);
  assert.equal(operationMutationSchema.safeParse({
    entity: "event",
    action: "comment",
    record: { agreementId: 99, detail: "Reviewed by the operating team" },
  }).success, true);
  assert.equal(operationMutationSchema.safeParse({
    entity: "event",
    action: "comment",
    record: { agreementId: 99, detail: "Comment", actor: "Caller supplied" },
  }).success, true, "unknown caller fields are stripped and never become server audit identity");
});

test("readiness separates maintainer controls from customer deployment configuration", () => {
  const empty = evaluateProductionReadiness({}, new Date("2026-08-01T00:00:00.000Z"));
  assert.equal(empty.readyForProduction, false);
  assert.ok(empty.code.checks.every((item) => item.owner === "maintainer"));
  assert.ok(empty.customer.checks.every((item) => item.owner === "customer"));

  const configuredSource = {
    NOTICE_APP_MODE: "production",
    NOTICE_DEPLOYMENT_MODEL: "hosted",
    NOTICE_WORKSPACE_ID: "orchid-firm",
    NOTICE_WORKSPACE_NAME: "Orchid Firm",
    NOTICE_PUBLIC_BASE_URL: "https://notice.orchid.test",
    NOTICE_BOOTSTRAP_ENABLED: "false",
    NOTICE_AUTH_MODE: "trusted-headers",
    NOTICE_TRUST_IDENTITY_HEADERS: "true",
    NOTICE_ESIGN_ENABLED: "true",
    NOTICE_ESIGN_PROVIDER: "docuseal",
    NOTICE_ESIGN_CONFIGURED: "true",
    NOTICE_DOCUSEAL_DEPLOYMENT: "self-hosted",
    NOTICE_DOCUSEAL_API_BASE_URL: "https://signatures.orchid.test/api",
    NOTICE_DOCUSEAL_API_TOKEN: "docuseal-production-token",
    NOTICE_DOCUSEAL_WEBHOOK_SECRET: `whsec_${"a".repeat(32)}`,
    NOTICE_DOCUSEAL_TEMPLATE_ID: "42",
    NOTICE_DOCUSEAL_VALIDATED_RELEASE: "3.2.1",
    NOTICE_DOCUSEAL_API_CLIENT_CONTRACT: "1.0.24",
    NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED: "true",
    NOTICE_DOCUSEAL_EXPIRATION_HOURS: "168",
    NOTICE_DOCUSEAL_EMAIL_2FA_REQUIRED: "true",
    NOTICE_DOCUSEAL_MCP_ENABLED: "false",
    NOTICE_CRM_ENABLED: "false",
    NOTICE_MAIL_ENABLED: "true",
    NOTICE_MAIL_PROVIDER: "delivery-gateway",
    NOTICE_MAIL_CONFIGURED: "true",
    NOTICE_NEGOTIATION_MAIL_ACCEPTED: "false",
    NOTICE_DELIVERY_GATEWAY_URL: "https://delivery.orchid.test/events",
    NOTICE_DELIVERY_GATEWAY_SECRET: "delivery-production-signing-secret-32",
    NOTICE_SCAN_ENABLED: "true",
    NOTICE_SCAN_PROVIDER: "scan-gateway",
    NOTICE_SCAN_CONFIGURED: "true",
    NOTICE_SCAN_GATEWAY_URL: "https://scanner.orchid.test/scan",
    NOTICE_SCAN_GATEWAY_SECRET: "scanner-production-signing-secret-32",
    NOTICE_SCAN_OCR_ENABLED: "false",
    NOTICE_COUNTERPARTY_PORTAL_ENABLED: "true",
    NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS: "72",
    NOTICE_EMAIL_CAPTURE_ENABLED: "false",
    NOTICE_EMAIL_CAPTURE_PROVIDER: "none",
    NOTICE_EMAIL_CAPTURE_CONFIGURED: "false",
    NOTICE_JOB_RUNNER_SECRET: "job-runner-secret-with-at-least-32-characters",
    NOTICE_OUTBOX_CRON: "*/5 * * * *",
    NOTICE_RETENTION_CRON: "15 2 * * *",
    NOTICE_AUDIT_SIGNING_KEY: "audit-signing-key-with-at-least-32-characters",
  };
  const configured = evaluateProductionReadiness(configuredSource);
  assert.equal(configured.customer.ready, true);
  assert.equal(configured.code.checks.length > 0, true);
  assert.ok(configured.code.checks.some((item) => item.id === "code.negotiation.secure_exchange" && item.status === "pass"));

  const emailCaptureSource = {
    ...configuredSource,
    NOTICE_EMAIL_CAPTURE_ENABLED: "true",
    NOTICE_EMAIL_CAPTURE_PROVIDER: "inbound-gateway",
    NOTICE_EMAIL_CAPTURE_CONFIGURED: "true",
    NOTICE_INBOUND_EMAIL_DOMAIN: "redlines.orchid-wealth.com",
    NOTICE_INBOUND_EMAIL_SECRET: "inbound-email-secret-with-at-least-32-characters",
  };
  const emailCaptureConfigured = evaluateProductionReadiness(emailCaptureSource);
  assert.equal(emailCaptureConfigured.customer.ready, true);

  const automatedNegotiationConfigured = evaluateProductionReadiness({
    ...configuredSource,
    NOTICE_NEGOTIATION_MAIL_ACCEPTED: "true",
  });
  assert.equal(automatedNegotiationConfigured.customer.ready, true);
  assert.ok(automatedNegotiationConfigured.customer.checks.some((item) => item.id === "customer.negotiation_mail.acceptance" && item.status === "pass"));

  const automatedNegotiationWithoutGateway = evaluateProductionReadiness({
    ...configuredSource,
    NOTICE_MAIL_CONFIGURED: "false",
    NOTICE_NEGOTIATION_MAIL_ACCEPTED: "true",
  });
  assert.equal(automatedNegotiationWithoutGateway.customer.ready, false);
  assert.ok(automatedNegotiationWithoutGateway.customer.checks.some((item) => item.id === "customer.negotiation_mail.acceptance" && item.status === "fail"));

  for (const mutation of [
    { NOTICE_COUNTERPARTY_PORTAL_ENABLED: undefined },
    { NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS: undefined },
    { NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS: "0" },
    { NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS: "337" },
    { NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS: "72.5" },
  ]) {
    const invalid = evaluateProductionReadiness({ ...configuredSource, ...mutation });
    assert.equal(invalid.customer.ready, false);
    assert.ok(invalid.customer.checks.some((item) => item.id.startsWith("customer.counterparty_portal.") && item.status === "fail"));
  }

  const missingNegotiationMailDecision = evaluateProductionReadiness({
    ...configuredSource,
    NOTICE_NEGOTIATION_MAIL_ACCEPTED: undefined,
  });
  assert.equal(missingNegotiationMailDecision.customer.ready, false);
  assert.ok(missingNegotiationMailDecision.customer.checks.some((item) => item.id === "customer.negotiation_mail.acceptance" && item.status === "fail"));

  for (const mutation of [
    { NOTICE_EMAIL_CAPTURE_ENABLED: undefined },
    { NOTICE_EMAIL_CAPTURE_PROVIDER: "none" },
    { NOTICE_INBOUND_EMAIL_DOMAIN: undefined },
    { NOTICE_INBOUND_EMAIL_DOMAIN: "redlines.customer.invalid" },
    { NOTICE_INBOUND_EMAIL_DOMAIN: "redlines.orchid.test" },
    { NOTICE_INBOUND_EMAIL_DOMAIN: "Redlines.Orchid-wealth.com" },
    { NOTICE_INBOUND_EMAIL_DOMAIN: "subdomain.workers.dev" },
    { NOTICE_INBOUND_EMAIL_DOMAIN: "your-redlines.example-bank.com" },
    { NOTICE_INBOUND_EMAIL_DOMAIN: "203.0.113.10" },
    { NOTICE_INBOUND_EMAIL_SECRET: undefined },
    { NOTICE_INBOUND_EMAIL_SECRET: "short" },
    { NOTICE_INBOUND_EMAIL_SECRET: "é".repeat(3_000) },
    { NOTICE_EMAIL_CAPTURE_CONFIGURED: "false" },
  ]) {
    const invalid = evaluateProductionReadiness({
      ...emailCaptureSource,
      ...mutation,
    });
    assert.equal(invalid.customer.ready, false);
    assert.ok(invalid.customer.checks.some((item) => item.id.startsWith("customer.email_capture.") && item.status === "fail"));
  }

  const staleDisabledEmailConfig = evaluateProductionReadiness({
    ...configuredSource,
    NOTICE_EMAIL_CAPTURE_PROVIDER: "inbound-gateway",
    NOTICE_EMAIL_CAPTURE_CONFIGURED: "true",
  });
  assert.equal(staleDisabledEmailConfig.customer.ready, false);
  assert.ok(staleDisabledEmailConfig.customer.checks.some((item) => item.id === "customer.email_capture.provider" && item.status === "fail"));
  assert.ok(staleDisabledEmailConfig.customer.checks.some((item) => item.id === "customer.email_capture.configured" && item.status === "fail"));

  for (const invalidCron of ["99 99 99 99 99", "*/0 * * * *", "0 0 * * 0"]) {
    const invalid = evaluateProductionReadiness({ ...configuredSource, NOTICE_OUTBOX_CRON: invalidCron });
    assert.ok(invalid.customer.checks.some((item) => item.id === "customer.jobs.crons" && item.status === "fail"), invalidCron);
  }

  const flagsWithoutCredentials = evaluateProductionReadiness({
    NOTICE_APP_MODE: "production",
    NOTICE_DEPLOYMENT_MODEL: "hosted",
    NOTICE_WORKSPACE_ID: "orchid-firm",
    NOTICE_WORKSPACE_NAME: "Orchid Firm",
    NOTICE_PUBLIC_BASE_URL: "https://notice.orchid.test",
    NOTICE_BOOTSTRAP_ENABLED: "true",
    NOTICE_BOOTSTRAP_ADMIN_EMAILS: "admin@orchid.test,backup-admin@orchid.test",
    NOTICE_AUTH_MODE: "trusted-headers",
    NOTICE_TRUST_IDENTITY_HEADERS: "true",
    NOTICE_ESIGN_ENABLED: "true",
    NOTICE_ESIGN_PROVIDER: "docuseal",
    NOTICE_ESIGN_CONFIGURED: "true",
    NOTICE_CRM_ENABLED: "false",
    NOTICE_MAIL_ENABLED: "true",
    NOTICE_MAIL_PROVIDER: "delivery-gateway",
    NOTICE_MAIL_CONFIGURED: "true",
    NOTICE_NEGOTIATION_MAIL_ACCEPTED: "false",
    NOTICE_SCAN_ENABLED: "true",
    NOTICE_SCAN_PROVIDER: "scan-gateway",
    NOTICE_SCAN_CONFIGURED: "true",
    NOTICE_SCAN_OCR_ENABLED: "false",
    NOTICE_COUNTERPARTY_PORTAL_ENABLED: "true",
    NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS: "72",
    NOTICE_EMAIL_CAPTURE_ENABLED: "false",
    NOTICE_EMAIL_CAPTURE_PROVIDER: "none",
    NOTICE_EMAIL_CAPTURE_CONFIGURED: "false",
  });
  assert.equal(flagsWithoutCredentials.customer.ready, false);
  assert.ok(flagsWithoutCredentials.customer.checks.some((item) => item.id === "customer.esign.configured" && item.status === "fail"));
});

test("a copied production environment template cannot be attested as ready", () => {
  const template = Object.fromEntries(
    readFileSync(new URL("../.env.example", import.meta.url), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );

  const readiness = evaluateProductionReadiness({
    ...template,
    NOTICE_TRUST_IDENTITY_HEADERS: "true",
    NOTICE_ESIGN_CONFIGURED: "true",
    NOTICE_DOCUSEAL_TEMPLATE_ID: "42",
    NOTICE_DOCUSEAL_API_TOKEN: "filled-in-docuseal-token",
    NOTICE_DOCUSEAL_WEBHOOK_SECRET: `whsec_${"b".repeat(32)}`,
    NOTICE_SCAN_CONFIGURED: "true",
    NOTICE_SCAN_GATEWAY_SECRET: "filled-in-scanner-gateway-secret-32",
    NOTICE_MAIL_CONFIGURED: "true",
    NOTICE_DELIVERY_GATEWAY_SECRET: "filled-in-delivery-gateway-secret-32",
    NOTICE_JOB_RUNNER_SECRET: "filled-in-job-runner-secret-32-characters",
    NOTICE_AUDIT_SIGNING_KEY: "filled-in-audit-signing-secret-32-characters",
  });

  assert.equal(readiness.readyForProduction, false);
  const failed = new Set(
    readiness.customer.checks
      .filter((item) => item.status === "fail")
      .map((item) => item.id),
  );
  assert.ok(failed.has("customer.workspace.id"));
  assert.ok(failed.has("customer.workspace.name"));
  assert.ok(failed.has("customer.deployment.public_base_url"));
  assert.ok(failed.has("customer.bootstrap.admins"));
  assert.ok(failed.has("customer.scan.configured"));
  assert.ok(failed.has("customer.mail.configured"));
});
