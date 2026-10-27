import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const configuredPort = Number(process.env.NOTICE_PRODUCTION_EVIDENCE_PORT ?? 45_000 + (process.pid % 1_000));
assert.ok(
  Number.isSafeInteger(configuredPort) && configuredPort > 1_024 && configuredPort < 64_000,
  "NOTICE_PRODUCTION_EVIDENCE_PORT must be an available user port below 64000",
);

const JOB_SECRET = "local-only-production-evidence-job-secret-0001";
const DELIVERY_SECRET = "local-only-production-evidence-delivery-secret-0001";
const CRM_SECRET = "local-only-production-evidence-crm-secret-000000001";
const WEBHOOK_SECRET = `whsec_${"e".repeat(32)}`;
const SCAN_SECRET = "local-only-production-evidence-scan-secret-0001";
const DOCUSEAL_TOKEN = "local-only-synthetic-docuseal-token";
// The local evidence harness mocks JWKS retrieval and never resolves this
// provider-shaped fixture team domain.
const ACCESS_TEAM_DOMAIN = "https://notice-production-evidence-fixture.cloudflareaccess.com";
const ACCESS_AUDIENCE = "a".repeat(64);
const ACCESS_KEY_ID = "production-evidence-rsa-key";
const ACCESS_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ACCESS_PUBLIC_JWK = {
  ...ACCESS_KEYS.publicKey.export({ format: "jwk" }),
  kid: ACCESS_KEY_ID,
  alg: "RS256",
  use: "sig",
};
const ADMIN_EMAIL = "admin@production-evidence.notice.test";
const REVIEWER_ADMIN_EMAIL = "backup-admin@production-evidence.notice.test";
const CRM_LEGACY_CLEANUP_CONFIRMATION = "I confirm every legacy CRM copy for this agreement was reconciled or deleted outside Notice.";
const FINAL_SIGNATURE_REVIEW_CONFIRMATION = "I confirm I reviewed the final signed artifact and its exact approved agreement basis.";
const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const workspaceA = `evidence-a-${runId}`;
const workspaceB = `evidence-b-${runId}`;
const invitedEmail = `requester-${runId}@production-evidence.notice.test`;
const adminIdentity = {
  subject: "local-production-evidence-admin",
  email: ADMIN_EMAIL,
  displayName: "Production Evidence Admin",
};
const reviewerAdminIdentity = {
  subject: `local-production-evidence-reviewer-admin-${runId}`,
  email: REVIEWER_ADMIN_EMAIL,
  displayName: "Production Evidence Reviewer Admin",
};
const requesterIdentity = {
  subject: `local-production-evidence-requester-${runId}`,
  email: invitedEmail,
  displayName: "Production Evidence Requester",
};
const replacementRequesterIdentity = {
  ...requesterIdentity,
  subject: `local-production-evidence-requester-replacement-${runId}`,
};
const crossWorkspaceAttackerIdentity = {
  ...requesterIdentity,
  subject: `local-production-evidence-cross-workspace-attacker-${runId}`,
};

const persistencePath = await mkdtemp(join(tmpdir(), "notice-production-evidence-"));
let evidenceDatabaseFile;
const provider = await startLoopbackProvider();
let activeServer = null;

try {
  // Prove the ordinary local command retains the production default and cannot
  // synthesize a user or workspace when production bindings are absent.
  activeServer = startNoticeServer("dev", configuredPort, {});
  const failClosed = await waitForJson(activeServer, `${activeServer.origin}/api/session`, {}, (response, body) =>
    response.status === 503 && body?.code === "NOTICE_CONFIGURATION_ERROR");
  assert.equal(failClosed.response.status, 503);
  assert.equal(failClosed.body.code, "NOTICE_CONFIGURATION_ERROR");
  await stopNoticeServer(activeServer);
  activeServer = null;

  activeServer = startProductionEvidenceServer(configuredPort, workspaceA, provider.deliveryUrl, provider.crmUrl, provider.accessJwksUrl);
  const readyA = await waitForJson(
    activeServer,
    `${activeServer.origin}/api/session`,
    { headers: identityHeaders(adminIdentity) },
    (response, body) => response.ok && body?.mode === "production" && body?.workspace?.id === workspaceA,
  );
  assert.equal(readyA.body.identitySource, "cloudflare-access");
  assert.equal(readyA.body.role, "admin");
  assert.equal(readyA.body.user.email, ADMIN_EMAIL);

  const noIdentity = await requestJson(activeServer.origin, "/api/session");
  assert.equal(noIdentity.response.status, 401);
  assert.equal(noIdentity.body.code, "AUTHENTICATION_REQUIRED");

  const validAccessToken = accessToken(adminIdentity);
  const tamperedParts = validAccessToken.split(".");
  tamperedParts[2] = `${tamperedParts[2][0] === "A" ? "B" : "A"}${tamperedParts[2].slice(1)}`;
  const tamperedAccessToken = tamperedParts.join(".");
  const invalidAccessIdentity = await requestJson(activeServer.origin, "/api/session", {
    headers: { "cf-access-jwt-assertion": tamperedAccessToken },
  });
  assert.equal(invalidAccessIdentity.response.status, 401);
  assert.equal(invalidAccessIdentity.body.code, "IDENTITY_INVALID");

  const incompleteIdentity = await requestJson(activeServer.origin, "/api/session", {
    headers: { "x-notice-identity-subject": "incomplete-trusted-identity" },
  });
  assert.equal(incompleteIdentity.response.status, 401);
  assert.equal(incompleteIdentity.body.code, "AUTHENTICATION_REQUIRED");

  const outsider = await requestJson(activeServer.origin, "/api/session", {
    headers: identityHeaders({
      subject: `outsider-${runId}`,
      email: `outsider-${runId}@production-evidence.notice.test`,
      displayName: "Uninvited User",
    }),
  });
  assert.equal(outsider.response.status, 403);
  assert.equal(outsider.body.code, "MEMBERSHIP_REQUIRED");

  const initialMembers = await requestJson(activeServer.origin, "/api/admin/memberships", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(initialMembers.response.status, 200, JSON.stringify(initialMembers.body));
  const bootstrapAdmin = initialMembers.body.members.find((member) => member.email === ADMIN_EMAIL);
  assert.ok(bootstrapAdmin);
  assert.equal(bootstrapAdmin.role, "admin");
  assert.equal(bootstrapAdmin.membershipStatus, "active");
  const bootstrapMembershipEvent = initialMembers.body.recentEvents.find((event) =>
    event.type === "MembershipBootstrap" && event.subjectEmail === ADMIN_EMAIL);
  assert.ok(bootstrapMembershipEvent);
  assert.equal(bootstrapMembershipEvent.actorUserId, bootstrapAdmin.userId);
  assert.equal(bootstrapMembershipEvent.actorEmail, ADMIN_EMAIL);
  assert.equal(bootstrapMembershipEvent.subjectUserId, bootstrapAdmin.userId);
  assert.equal(bootstrapMembershipEvent.subjectEmail, ADMIN_EMAIL);
  assert.match(bootstrapMembershipEvent.eventHash, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(bootstrapMembershipEvent.sequence) && bootstrapMembershipEvent.sequence > 0);

  const docuSealConnection = await requestJson(activeServer.origin, "/api/admin/integrations", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ provider: "docuseal" }),
  });
  assert.equal(docuSealConnection.response.status, 200, JSON.stringify(docuSealConnection.body));
  assert.equal(docuSealConnection.body.integration.lastTest.status, "passed", JSON.stringify({
    integration: docuSealConnection.body.integration,
    providerFailures: provider.failures,
  }));
  assert.equal(provider.templateChecks.length, 1);

  const scannerConnection = await requestJson(activeServer.origin, "/api/admin/integrations", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ provider: "scanner" }),
  });
  assert.equal(scannerConnection.response.status, 200, JSON.stringify(scannerConnection.body));
  assert.equal(scannerConnection.body.integration.lastTest.status, "passed", JSON.stringify({
    integration: scannerConnection.body.integration,
    providerFailures: provider.failures,
  }));
  assert.equal(provider.scans.length, 1);
  assert.equal(provider.scans[0].fileName, "notice-connection-test.txt");

  for (const integration of ["delivery", "crm"]) {
    const connection = await requestJson(activeServer.origin, "/api/admin/integrations", {
      method: "POST",
      headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
      body: JSON.stringify({ provider: integration }),
    });
    assert.equal(connection.response.status, 200, JSON.stringify(connection.body));
    assert.equal(connection.body.integration.lastTest.status, "passed", JSON.stringify({
      integration: connection.body.integration,
      providerFailures: provider.failures,
    }));
  }
  assert.equal(provider.deliveries.filter((delivery) => delivery.body.event.workspaceId === "__connection_test__").length, 1);
  const crmConnectionEvidence = provider.crmDeliveries.filter((delivery) => delivery.body.event.workspaceId === "__connection_test__");
  assert.equal(crmConnectionEvidence.length, 1);
  assert.equal(crmConnectionEvidence[0].crmProvider, "custom");
  assert.equal(crmConnectionEvidence[0].crmMappingVersion, "v1");

  const retainedIntegrationEvidence = await requestJson(activeServer.origin, "/api/admin/integrations", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(retainedIntegrationEvidence.response.status, 200, JSON.stringify(retainedIntegrationEvidence.body));
  assert.deepEqual(
    retainedIntegrationEvidence.body.integrations.map((integration) => [integration.id, integration.lastTest?.status]),
    [["docuseal", "passed"], ["scanner", "passed"], ["delivery", "passed"], ["crm", "passed"]],
  );
  const readinessWithLiveEvidence = await requestJson(activeServer.origin, "/api/readiness", {
    headers: identityHeaders(adminIdentity),
  });
  assert.ok([200, 503].includes(readinessWithLiveEvidence.response.status));
  const liveDiagnosticChecks = readinessWithLiveEvidence.body.customer.checks
    .filter((check) => check.id.endsWith(".live_diagnostic"));
  assert.equal(liveDiagnosticChecks.length, 4);
  assert.ok(liveDiagnosticChecks.every((check) => check.status === "pass"));
  const customerCheckById = new Map(
    readinessWithLiveEvidence.body.customer.checks.map((check) => [check.id, check]),
  );
  const requiredCounterpartyPosture = [
    ["customer.counterparty_portal.selection", "pass", /explicitly enabled/i],
    ["customer.counterparty_portal.ttl", "pass", /72 hours/i],
    ["customer.negotiation_mail.acceptance", "pass", /explicitly locked/i],
    ["customer.email_capture.selection", "pass", /explicitly disabled/i],
    ["customer.email_capture.provider", "pass", /no inbound email provider/i],
    ["customer.email_capture.domain", "not_required", /no inbound domain is required/i],
    ["customer.email_capture.secret", "not_required", /no inbound signing secret is required/i],
    ["customer.email_capture.configured", "pass", /explicitly unattested/i],
  ];
  for (const [id, status, message] of requiredCounterpartyPosture) {
    const check = customerCheckById.get(id);
    assert.ok(check, `Missing production-readiness check ${id}`);
    assert.equal(check.status, status, JSON.stringify(check));
    assert.match(check.message, message);
  }

  const missingUploadKeyForm = new FormData();
  missingUploadKeyForm.set("file", new File(["missing retry key"], "missing-key.txt", { type: "text/plain" }));
  const missingUploadKey = await requestJson(activeServer.origin, "/api/documents/import", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity),
    body: missingUploadKeyForm,
  });
  assert.equal(missingUploadKey.response.status, 400);
  assert.equal(missingUploadKey.body.error.code, "idempotency_key_required");

  const malformedUpload = await requestJson(activeServer.origin, "/api/documents/import", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "text/plain", "idempotency-key": randomUUID() }),
    body: "not multipart form data",
  });
  assert.equal(malformedUpload.response.status, 400);
  assert.equal(malformedUpload.body.error.code, "invalid_multipart");

  const pdfUpload = new FormData();
  const opaqueImportCreationKey = randomUUID();
  const pdfOverDefaultActionLimit = createMinimalPdf(
    "Vendor Master Services Agreement with misleading filename terms.",
    1024 * 1024 + 64,
  );
  pdfUpload.set(
    "file",
    new File(
      [pdfOverDefaultActionLimit],
      "Vendor Master Services Agreement.pdf",
      { type: "application/pdf" },
    ),
  );
  const importedPdf = await requestJson(activeServer.origin, "/api/documents/import", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "idempotency-key": opaqueImportCreationKey }),
    body: pdfUpload,
  });
  assert.equal(importedPdf.response.status, 201, JSON.stringify(importedPdf.body));
  assert.match(importedPdf.body.document.extractionMode, /stored after scanning; customer-hosted OCR is disabled, so create a reviewed text working version/i);
  assert.deepEqual(importedPdf.body.document.tags, []);
  assert.deepEqual(importedPdf.body.document.riskFlags, []);
  assert.ok(Object.values(importedPdf.body.document.extracted).every((value) => value === ""));
  assert.equal(importedPdf.body.document.size, pdfOverDefaultActionLimit.byteLength);
  assert.equal(provider.scans.at(-1)?.fileName, "Vendor-Master-Services-Agreement.pdf");
  const recoveredPdf = await requestJson(activeServer.origin, "/api/documents/import", {
    headers: { ...identityHeaders(adminIdentity), "idempotency-key": opaqueImportCreationKey },
  });
  assert.equal(recoveredPdf.response.status, 200, JSON.stringify(recoveredPdf.body));
  assert.equal(recoveredPdf.body.document.id, importedPdf.body.document.id);
  assert.equal(recoveredPdf.body.replay, true);

  const opaqueImportCreationBody = JSON.stringify({
    creationMode: "imported",
    party: `Opaque PDF evidence ${runId}`,
    side: "Buy-side",
    type: "Vendor Master Services Agreement",
    value: 0,
    owner: adminIdentity.displayName,
    due: "2026-09-30",
    crm: "None",
    crmRecord: "",
    tags: ["Imported source"],
    department: "Operations",
    risk: "Low",
    effectiveDate: "",
    expirationDate: "",
  });
  const opaqueImportCreate = await requestJson(activeServer.origin, "/api/agreements", {
    method: "POST",
    headers: agreementCreationHeaders(activeServer.origin, adminIdentity, opaqueImportCreationKey),
    body: opaqueImportCreationBody,
  });
  assert.equal(opaqueImportCreate.response.status, 201, JSON.stringify(opaqueImportCreate.body));
  assert.equal(opaqueImportCreate.body.documentVersion, null);
  const opaqueImportAgreementId = opaqueImportCreate.body.agreement.id;
  const opaqueImportLink = await requestJson(activeServer.origin, "/api/documents/import", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json", "idempotency-key": opaqueImportCreationKey }),
    body: JSON.stringify({ documentId: importedPdf.body.document.id, agreementId: opaqueImportAgreementId }),
  });
  assert.equal(opaqueImportLink.response.status, 200, JSON.stringify(opaqueImportLink.body));
  assert.equal(opaqueImportLink.body.workingVersionCreated, false);
  assert.equal(opaqueImportLink.body.workingVersion, null);
  const opaqueImportLinkReplay = await requestJson(activeServer.origin, "/api/documents/import", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json", "idempotency-key": opaqueImportCreationKey }),
    body: JSON.stringify({ documentId: importedPdf.body.document.id, agreementId: opaqueImportAgreementId }),
  });
  assert.equal(opaqueImportLinkReplay.response.status, 200, JSON.stringify(opaqueImportLinkReplay.body));
  assert.equal(opaqueImportLinkReplay.body.alreadyLinked, true);
  assert.equal(opaqueImportLinkReplay.body.workingVersionCreated, false);
  const opaqueImportCreationReplay = await requestJson(activeServer.origin, "/api/agreements", {
    method: "POST",
    headers: agreementCreationHeaders(activeServer.origin, adminIdentity, opaqueImportCreationKey),
    body: opaqueImportCreationBody,
  });
  assert.equal(opaqueImportCreationReplay.response.status, 200, JSON.stringify(opaqueImportCreationReplay.body));
  assert.equal(opaqueImportCreationReplay.body.agreement.version, 2);
  assert.equal(opaqueImportCreationReplay.body.documentVersion, null);
  const replayPdfForm = new FormData();
  replayPdfForm.set(
    "file",
    new File([pdfOverDefaultActionLimit], "Vendor Master Services Agreement.pdf", { type: "application/pdf" }),
  );
  const uploadReplayAfterLink = await requestJson(activeServer.origin, "/api/documents/import", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "idempotency-key": opaqueImportCreationKey }),
    body: replayPdfForm,
  });
  assert.equal(uploadReplayAfterLink.response.status, 200, JSON.stringify(uploadReplayAfterLink.body));
  assert.equal(uploadReplayAfterLink.body.document.id, importedPdf.body.document.id);
  assert.equal(uploadReplayAfterLink.body.replay, true);

  const lastAdmin = await requestJson(activeServer.origin, "/api/admin/memberships", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ userId: bootstrapAdmin.userId, role: "viewer", status: "active" }),
  });
  assert.equal(lastAdmin.response.status, 409);
  assert.equal(lastAdmin.body.error.code, "last_admin");

  const rejectedInviteEmail = `rejected-${runId}@production-evidence.notice.test`;
  const inviteState = async () => mutateEvidenceD1((database) => ({
    users: database.prepare("SELECT count(*) AS count FROM users WHERE email = ?")
      .get(rejectedInviteEmail).count,
    memberships: database.prepare("SELECT count(*) AS count FROM workspace_memberships WHERE workspace_id = ?")
      .get(workspaceA).count,
    workspaceEvents: database.prepare("SELECT count(*) AS count FROM workspace_events WHERE workspace_id = ?")
      .get(workspaceA).count,
    outboxEvents: database.prepare("SELECT count(*) AS count FROM outbox_events WHERE workspace_id = ?")
      .get(workspaceA).count,
  }));
  const beforeRejectedInvite = await inviteState();
  const rejectedInvite = await requestJson(activeServer.origin, "/api/admin/memberships", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      email: rejectedInviteEmail,
      displayName: "Injected administrator\r\n\u202eHidden text",
      role: "requester",
    }),
  });
  assert.equal(rejectedInvite.response.status, 400, JSON.stringify(rejectedInvite.body));
  assert.equal(rejectedInvite.body.error.code, "validation_failed");
  assert.ok(rejectedInvite.body.issues.some((issue) => issue.path.join(".") === "displayName"));
  assert.deepEqual(await inviteState(), beforeRejectedInvite);

  const invite = await requestJson(activeServer.origin, "/api/admin/memberships", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ email: invitedEmail, displayName: requesterIdentity.displayName, role: "requester" }),
  });
  assert.equal(invite.response.status, 201, JSON.stringify(invite.body));
  assert.equal(invite.body.member.role, "requester");
  const requesterUserId = invite.body.member.userId;

  const pendingMembers = await requestJson(activeServer.origin, "/api/admin/memberships", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(
    pendingMembers.body.members.find((member) => member.userId === requesterUserId)?.identityProvider,
    "pending-email",
  );

  const requesterSession = await requestJson(activeServer.origin, "/api/session", {
    headers: identityHeaders(requesterIdentity),
  });
  assert.equal(requesterSession.response.status, 200, JSON.stringify(requesterSession.body));
  assert.equal(requesterSession.body.mode, "production");
  assert.equal(requesterSession.body.identitySource, "cloudflare-access");
  assert.equal(requesterSession.body.role, "requester");
  assert.ok(requesterSession.body.permissions.includes("agreement:create"));
  assert.ok(!requesterSession.body.permissions.includes("document:manage"));

  const boundMembers = await requestJson(activeServer.origin, "/api/admin/memberships", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(
    boundMembers.body.members.find((member) => member.userId === requesterUserId)?.identityProvider,
    `cloudflare-access:${ACCESS_TEAM_DOMAIN}`,
  );

  const requesterAdminAttempt = await requestJson(activeServer.origin, "/api/admin/memberships", {
    headers: identityHeaders(requesterIdentity),
  });
  assert.equal(requesterAdminAttempt.response.status, 403);
  assert.equal(requesterAdminAttempt.body.error.code, "permission_denied");

  const generatedParty = `Generated evidence <unsafe & ${runId}>`;
  const generatedCreationKey = randomUUID();
  const generatedCreationBody = JSON.stringify({
    creationMode: "generated",
    party: generatedParty,
    side: "Buy-side",
    type: "Vendor Services Agreement",
    value: 50_000,
    owner: requesterIdentity.displayName,
    due: "2026-09-30",
    crm: "None",
    crmRecord: "",
    tags: ["Generated", "Delaware law"],
    department: "Operations",
    risk: "Low",
    effectiveDate: "2026-10-01",
    expirationDate: "",
    governingLaw: "Delaware",
  });
  const generatedCreate = await requestJson(activeServer.origin, "/api/agreements", {
    method: "POST",
    headers: agreementCreationHeaders(activeServer.origin, requesterIdentity, generatedCreationKey),
    body: generatedCreationBody,
  });
  assert.equal(generatedCreate.response.status, 201, JSON.stringify(generatedCreate.body));
  assert.equal(generatedCreate.body.agreement.version, 1);
  assert.equal(generatedCreate.body.agreement.nextAction, "Review the generated working draft");
  assert.equal(generatedCreate.body.documentVersion.version, 1);
  assert.equal(generatedCreate.body.documentVersion.label, "Generated starter working draft");
  assert.equal(generatedCreate.body.documentVersion.sourceDocumentId, null);
  assert.equal(generatedCreate.body.documentVersion.objectKey, undefined);
  assert.equal(generatedCreate.body.replay, false);
  assert.equal(generatedCreate.response.headers.get("idempotency-replayed"), "false");
  const generatedAgreementId = generatedCreate.body.agreement.id;

  const generatedReplay = await requestJson(activeServer.origin, "/api/agreements", {
    method: "POST",
    headers: agreementCreationHeaders(activeServer.origin, requesterIdentity, generatedCreationKey),
    body: generatedCreationBody,
  });
  assert.equal(generatedReplay.response.status, 200, JSON.stringify(generatedReplay.body));
  assert.equal(generatedReplay.body.replay, true);
  assert.equal(generatedReplay.body.agreement.id, generatedAgreementId);
  assert.equal(generatedReplay.body.event.id, generatedCreate.body.event.id);
  assert.equal(generatedReplay.body.documentVersion.id, generatedCreate.body.documentVersion.id);
  assert.equal(generatedReplay.body.documentVersion.sha256, generatedCreate.body.documentVersion.sha256);
  assert.equal(generatedReplay.response.headers.get("idempotency-replayed"), "true");

  const generatedVersions = await requestJson(activeServer.origin, `/api/agreements/${generatedAgreementId}/versions`, {
    headers: identityHeaders(requesterIdentity),
  });
  assert.equal(generatedVersions.response.status, 200, JSON.stringify(generatedVersions.body));
  assert.equal(generatedVersions.body.versions.length, 1);
  assert.equal(generatedVersions.body.versions[0].version, 1);
  assert.equal(generatedVersions.body.versions[0].sha256, generatedCreate.body.documentVersion.sha256);
  const generatedVersionBytes = await fetch(`${activeServer.origin}/api/agreements/${generatedAgreementId}/versions?version=1`, {
    headers: identityHeaders(requesterIdentity),
  });
  assert.equal(generatedVersionBytes.status, 200);
  const generatedContent = await generatedVersionBytes.text();
  assert.ok(generatedContent.includes(generatedParty));
  assert.match(generatedContent, /as of 2026-10-01/);
  assert.match(generatedContent, /laws of Delaware/);
  assert.equal(createHash("sha256").update(generatedContent).digest("hex"), generatedCreate.body.documentVersion.sha256);

  const agreementCreate = await requestJson(activeServer.origin, "/api/agreements", {
    method: "POST",
    headers: agreementCreationHeaders(activeServer.origin, requesterIdentity),
    body: JSON.stringify({
      workspaceId: workspaceB,
      id: 42,
      version: 99,
      creationMode: "manual",
      party: `Production evidence ${runId}`,
      side: "Buy-side",
      type: "Vendor services agreement",
      value: 25_000,
      owner: requesterIdentity.displayName,
      due: "2026-09-15",
      crm: "Custom CRM",
      crmRecord: `current-profile-${runId}`,
      tags: ["production-evidence"],
      department: "Operations",
      risk: "Low",
      effectiveDate: "",
      expirationDate: "",
    }),
  });
  assert.equal(agreementCreate.response.status, 201, JSON.stringify(agreementCreate.body));
  assert.equal(agreementCreate.body.agreement.workspaceId, workspaceA);
  assert.equal(agreementCreate.body.agreement.version, 1);
  assert.notEqual(agreementCreate.body.agreement.id, 42);
  const agreementId = agreementCreate.body.agreement.id;

  const mismatchedCrmCreate = await requestJson(activeServer.origin, "/api/agreements", {
    method: "POST",
    headers: agreementCreationHeaders(activeServer.origin, requesterIdentity),
    body: JSON.stringify({
      creationMode: "manual",
      party: `Wrong CRM target ${runId}`,
      side: "Buy-side",
      type: "Provider mismatch evidence",
      value: 1,
      owner: requesterIdentity.displayName,
      due: "2026-09-15",
      crm: "Salesforce",
      crmRecord: "must-not-sync",
      tags: ["production-evidence"],
      department: "Operations",
      risk: "Low",
      effectiveDate: "",
      expirationDate: "",
    }),
  });
  assert.equal(mismatchedCrmCreate.response.status, 409, JSON.stringify(mismatchedCrmCreate.body));
  assert.equal(mismatchedCrmCreate.body.error.code, "crm_provider_unavailable");

  const requesterVersionAttempt = await requestJson(activeServer.origin, `/api/agreements/${agreementId}/versions`, {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, requesterIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      content: "Requester-authored arbitrary draft",
      contentType: "text/plain",
      label: "Unauthorized version",
      expectedAgreementVersion: 1,
    }),
  });
  assert.equal(requesterVersionAttempt.response.status, 403);
  assert.equal(requesterVersionAttempt.body.error.code, "permission_denied");

  const versionContent = `# Production evidence draft\n\nSynthetic content for ${runId}.\nNo customer data.`;
  const versionCreate = await requestJson(activeServer.origin, `/api/agreements/${agreementId}/versions`, {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      content: versionContent,
      contentType: "text/markdown",
      label: "Production evidence draft",
      expectedAgreementVersion: 1,
    }),
  });
  assert.equal(versionCreate.response.status, 201, JSON.stringify(versionCreate.body));
  assert.equal(versionCreate.body.version.version, 1);
  assert.equal(versionCreate.body.agreement.version, 2);
  assert.equal(versionCreate.body.version.sha256, createHash("sha256").update(versionContent).digest("hex"));
  assert.equal(versionCreate.body.version.objectKey, undefined);

  const versions = await requestJson(activeServer.origin, `/api/agreements/${agreementId}/versions`, {
    headers: identityHeaders(requesterIdentity),
  });
  assert.equal(versions.response.status, 200, JSON.stringify(versions.body));
  assert.equal(versions.body.versions.length, 1);
  assert.equal(versions.body.versions[0].version, 1);
  assert.equal(versions.body.versions[0].label, "Production evidence draft");
  assert.deepEqual(versions.body.sourceDocuments, []);

  const versionBytes = await fetch(`${activeServer.origin}/api/agreements/${agreementId}/versions?version=1`, {
    headers: identityHeaders(requesterIdentity),
  });
  assert.equal(versionBytes.status, 200);
  assert.equal(versionBytes.headers.get("content-type"), "text/markdown");
  assert.equal(versionBytes.headers.get("content-security-policy"), "sandbox");
  assert.equal(await versionBytes.text(), versionContent);

  const retentionRead = await requestJson(activeServer.origin, `/api/admin/retention?agreementId=${agreementId}`, {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(retentionRead.response.status, 200, JSON.stringify(retentionRead.body));
  assert.equal(retentionRead.body.policy.version, 2);

  const retentionUpdate = await requestJson(activeServer.origin, "/api/admin/retention", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      targetType: "agreement",
      targetId: agreementId,
      expectedVersion: 2,
      legalHold: true,
      retentionUntil: "2035-12-31",
      cascadeRetentionToDocuments: false,
      reason: "Synthetic production evidence hold",
    }),
  });
  assert.equal(retentionUpdate.response.status, 200, JSON.stringify(retentionUpdate.body));
  assert.equal(retentionUpdate.body.policy.version, 3);
  assert.equal(retentionUpdate.body.policy.legalHold, true);
  assert.equal(retentionUpdate.body.policy.retentionUntil, "2035-12-31T23:59:59.999Z");

  const wrongRetentionJob = await requestJson(activeServer.origin, "/api/jobs/retention?dryRun=true", {
    method: "POST",
    headers: { authorization: `Bearer ${"x".repeat(JOB_SECRET.length)}` },
  });
  assert.equal(wrongRetentionJob.response.status, 401);
  assert.equal(wrongRetentionJob.body.error.code, "authentication_required");

  const retentionJob = await requestJson(activeServer.origin, "/api/jobs/retention?dryRun=true", {
    method: "POST",
    headers: { authorization: `Bearer ${JOB_SECRET}` },
  });
  assert.equal(retentionJob.response.status, 200, JSON.stringify(retentionJob.body));
  assert.equal(retentionJob.body.workspaceId, workspaceA);
  assert.equal(retentionJob.body.dryRun, true);
  assert.equal(retentionJob.body.safeguards.legalHoldOverridesRetention, true);
  assert.ok(!retentionJob.body.softDeleted.agreementIds.includes(agreementId));

  const invalidWebhook = await requestJson(activeServer.origin, "/api/webhooks/docuseal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-docuseal-signature": "0.deadbeef",
    },
    body: JSON.stringify({
      event_type: "submission.completed",
      timestamp: new Date().toISOString(),
      data: { id: 12345 },
    }),
  });
  assert.equal(invalidWebhook.response.status, 401);
  assert.equal(invalidWebhook.body.error.code, "invalid_signature");

  const malformedWebhookBody = "{\"event_type\":";
  const malformedWebhook = await requestJson(activeServer.origin, "/api/webhooks/docuseal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-docuseal-signature": signDocuSealWebhook(malformedWebhookBody),
    },
    body: malformedWebhookBody,
  });
  assert.equal(malformedWebhook.response.status, 400);
  assert.equal(malformedWebhook.body.error.code, "invalid_payload");

  // Seed a complete non-secret governance graph directly so the live signed
  // workspace export proves both referential closure and field-level
  // sanitization without weakening the production service-identity boundary.
  const governanceReviewerSession = await requestJson(activeServer.origin, "/api/session", {
    headers: identityHeaders(reviewerAdminIdentity),
  });
  assert.equal(governanceReviewerSession.response.status, 200, JSON.stringify(governanceReviewerSession.body));
  assert.equal(governanceReviewerSession.body.role, "admin");
  assert.equal(governanceReviewerSession.body.user.email, REVIEWER_ADMIN_EMAIL);
  assert.notEqual(governanceReviewerSession.body.user.id, bootstrapAdmin.userId);
  const governanceReviewerUserId = governanceReviewerSession.body.user.id;
  const governancePrincipalId = randomUUID();
  const governanceGrantId = randomUUID();
  const governanceRunId = randomUUID();
  const governancePlanId = randomUUID();
  const governanceDecisionId = randomUUID();
  const governancePurgeId = randomUUID();
  const governancePlanDigest = "7".repeat(64);
  const governanceProposalKeyDigest = "8".repeat(64);
  const governanceExecutionKeyDigest = "9".repeat(64);
  await mutateEvidenceD1((database) => {
    const timestamp = "2026-08-20T12:00:00.000Z";
    database.prepare(`INSERT INTO service_principals (
      id, workspace_id, name, issuer, subject, status, version,
      created_by_user_id, created_at, updated_at, last_seen_at
    ) VALUES (?, ?, 'Export evidence agent', 'https://identity.example.test',
      'export-evidence-agent', 'active', 1, ?, ?, ?, ?)`)
      .run(governancePrincipalId, workspaceA, bootstrapAdmin.userId, timestamp, timestamp, timestamp);
    database.prepare(`INSERT INTO agent_grants (
      id, workspace_id, principal_id, delegator_user_id, status, action_ids,
      resource_constraints, policy_version, starts_at, expires_at, version,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, 'export-evidence-v1', ?, ?, 1, ?, ?)`)
      .run(
        governanceGrantId,
        workspaceA,
        governancePrincipalId,
        bootstrapAdmin.userId,
        JSON.stringify(["agreement.read"]),
        JSON.stringify({ resources: [{ type: "agreement", ids: [String(agreementId)] }] }),
        timestamp,
        "2026-08-21T12:00:00.000Z",
        timestamp,
        timestamp,
      );
    database.prepare(`INSERT INTO agent_runs (
      id, workspace_id, principal_id, grant_id, sponsor_user_id, purpose,
      status, model_provider, model_id, tool_version, prompt_sha256,
      context_sha256, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 'Prove signed export closure', 'succeeded',
      'customer', 'export-evidence-model', '1.0.0', ?, ?, ?, ?)`)
      .run(
        governanceRunId,
        workspaceA,
        governancePrincipalId,
        governanceGrantId,
        bootstrapAdmin.userId,
        "a".repeat(64),
        "b".repeat(64),
        timestamp,
        timestamp,
      );
    database.prepare(`INSERT INTO agent_action_plans (
      id, workspace_id, principal_id, grant_id, run_id, action_id,
      resource_type, resource_id, agreement_id, canonical_input, input_sha256,
      plan_sha256, expected_version, basis_hash, document_version,
      document_sha256, policy_version, risk_tier, status, before_snapshot,
      proposed_diff, blockers, provenance, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'agreement.read', 'agreement', ?, ?, '{}', ?, ?,
      1, NULL, NULL, NULL, 'export-evidence-v1', 'low', 'succeeded', '{}', '{}',
      '[]', ?, '2026-08-21T12:00:00.000Z', ?, ?)`)
      .run(
        governancePlanId,
        workspaceA,
        governancePrincipalId,
        governanceGrantId,
        governanceRunId,
        String(agreementId),
        agreementId,
        "c".repeat(64),
        governancePlanDigest,
        JSON.stringify({
          schemaVersion: "1.0",
          run: { id: governanceRunId, modelId: "export-evidence-model", toolVersion: "1.0.0" },
          idempotency: {
            keySha256: governanceProposalKeyDigest,
            requestSha256: "d".repeat(64),
            rawRetryToken: "must-not-leave-the-live-store",
          },
        }),
        timestamp,
        timestamp,
      );
    database.prepare(`INSERT INTO agent_plan_decisions (
      id, workspace_id, plan_id, plan_sha256, decision, reason,
      decided_by_user_id, decided_at
    ) VALUES (?, ?, ?, ?, 'approved', 'Approved exact export evidence fixture', ?, ?)`)
      .run(governanceDecisionId, workspaceA, governancePlanId, governancePlanDigest, governanceReviewerUserId, timestamp);
    database.prepare(`INSERT INTO agent_action_executions (
      id, workspace_id, plan_id, principal_id, grant_id, action_id,
      plan_sha256, request_sha256, idempotency_key_sha256, status, result,
      agreement_event_ids, provenance, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 'agreement.read', ?, ?, ?, 'succeeded', '{}',
      '[]', '{}', ?, ?)`)
      .run(
        governancePlanId,
        workspaceA,
        governancePlanId,
        governancePrincipalId,
        governanceGrantId,
        governancePlanDigest,
        "e".repeat(64),
        governanceExecutionKeyDigest,
        timestamp,
        timestamp,
      );
    database.prepare(`INSERT INTO purge_jobs (
      id, workspace_id, resource_type, resource_id, object_keys, status,
      guard_changes, attempts, last_error, last_attempt_at, created_at,
      updated_at, completed_at
    ) VALUES (?, ?, 'document', 'export-evidence-purged-document', ?, 'completed',
      1, 1, 'provider detail must not leave the live store', ?, ?, ?, ?)`)
      .run(
        governancePurgeId,
        workspaceA,
        JSON.stringify([`workspaces/${workspaceA}/documents/private/file.pdf`]),
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      );
  });

  const exportBeforeOutbox = await requestJson(activeServer.origin, "/api/admin/export", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(exportBeforeOutbox.response.status, 200, JSON.stringify(exportBeforeOutbox.body));
  assert.equal(exportBeforeOutbox.body.evidence.audit.agentEvidenceClosure.valid, true);
  for (const recordType of [
    "purgeJobs", "integrationDiagnostics", "servicePrincipals", "agentGrants",
    "agentRuns", "agentActionPlans", "agentPlanDecisions", "agentActionExecutions",
  ]) {
    assert.ok(Array.isArray(exportBeforeOutbox.body.evidence.records[recordType]), `${recordType} must be exported as a deterministic record collection`);
    assert.equal(
      exportBeforeOutbox.body.evidence.counts[recordType],
      exportBeforeOutbox.body.evidence.records[recordType].length,
      `${recordType} count must reconcile to the signed record collection`,
    );
  }
  const exportedGovernancePlan = exportBeforeOutbox.body.evidence.records.agentActionPlans.find(
    (plan) => plan.id === governancePlanId,
  );
  const exportedGovernanceExecution = exportBeforeOutbox.body.evidence.records.agentActionExecutions.find(
    (execution) => execution.id === governancePlanId,
  );
  const exportedGovernanceDecision = exportBeforeOutbox.body.evidence.records.agentPlanDecisions.find(
    (decision) => decision.id === governanceDecisionId,
  );
  const exportedPurgeJob = exportBeforeOutbox.body.evidence.records.purgeJobs.find(
    (job) => job.id === governancePurgeId,
  );
  assert.ok(exportedGovernancePlan);
  assert.ok(exportedGovernanceExecution);
  assert.ok(exportedGovernanceDecision);
  assert.ok(exportedPurgeJob);
  assert.equal(exportedGovernanceDecision.decidedByUserId, governanceReviewerUserId);
  assert.notEqual(exportedGovernanceDecision.decidedByUserId, bootstrapAdmin.userId);
  assert.equal(exportedGovernancePlan.provenance.idempotency.keySha256, undefined);
  assert.equal(exportedGovernancePlan.provenance.idempotency.requestSha256, "d".repeat(64));
  assert.equal(exportedGovernanceExecution.idempotencyKeySha256, undefined);
  assert.ok(exportBeforeOutbox.body.evidence.records.ingestionBatches.every((batch) =>
    batch.idempotencyKeySha256 === undefined && batch.requestSha256 === undefined));
  assert.equal(exportedPurgeJob.objectCount, 1);
  assert.equal(exportedPurgeJob.objectKeys, undefined);
  assert.equal(exportedPurgeJob.lastError, undefined);
  assert.ok(exportBeforeOutbox.body.evidence.records.integrationDiagnostics.length >= 4);
  assert.ok(exportBeforeOutbox.body.evidence.records.integrationDiagnostics.every((diagnostic) =>
    diagnostic.configurationFingerprint === undefined && diagnostic.detail === undefined));
  const serializedGovernanceExport = JSON.stringify(exportBeforeOutbox.body);
  for (const secretMaterial of [
    governanceProposalKeyDigest,
    governanceExecutionKeyDigest,
    "must-not-leave-the-live-store",
    "provider detail must not leave the live store",
    `workspaces/${workspaceA}/documents/private/file.pdf`,
  ]) assert.equal(serializedGovernanceExport.includes(secretMaterial), false);
  const pendingOutbox = exportBeforeOutbox.body.evidence.records.outboxEvents;
  assert.equal(pendingOutbox.length, 4);
  assert.ok(pendingOutbox.every((event) => event.status === "pending" && event.attempts === 0));
  assert.ok(pendingOutbox.some((event) => event.topic === "notification.workspace_access"));
  assert.ok(pendingOutbox.some((event) => event.topic === "agreement.created"));

  // Invalid internet traffic must not consume the authenticated scheduler's
  // in-process quota. Exceed the job limit with same-length bad tokens, then
  // prove the first legitimate scheduler call remains available.
  for (let attempt = 0; attempt < 13; attempt += 1) {
    const wrongOutboxJob = await requestJson(activeServer.origin, "/api/jobs/outbox", {
      method: "POST",
      headers: { authorization: `Bearer ${"x".repeat(JOB_SECRET.length)}` },
    });
    assert.equal(wrongOutboxJob.response.status, 401);
    assert.equal(wrongOutboxJob.body.error.code, "authentication_required");
  }

  const outboxJob = await requestJson(activeServer.origin, "/api/jobs/outbox", {
    method: "POST",
    headers: { authorization: `Bearer ${JOB_SECRET}` },
  });
  assert.equal(outboxJob.response.status, 200, JSON.stringify(outboxJob.body));
  assert.equal(outboxJob.body.processed, 4);
  assert.equal(outboxJob.body.delivered + outboxJob.body.retried + outboxJob.body.dead, 4);
  assert.equal(outboxJob.body.dead, 0);
  assert.equal(outboxJob.body.acceptedBySink.delivery, 4);
  assert.equal(outboxJob.body.acceptedBySink.crm, pendingOutbox.filter((event) =>
    event.payload?.crmAgreement?.crm === "Custom CRM" || event.payload?.crm === "Custom CRM"
  ).length);

  const workspaceDeliveries = provider.deliveries.filter((delivery) => delivery.body.event.workspaceId === workspaceA);
  assert.equal(workspaceDeliveries.length, outboxJob.body.acceptedBySink.delivery);
  for (const delivery of workspaceDeliveries) {
    assert.equal(delivery.validSignature, true);
    assert.equal(delivery.eventId, delivery.body.event.id);
  }
  const workspaceCrmDeliveries = provider.crmDeliveries.filter((delivery) => delivery.body.event.workspaceId === workspaceA);
  assert.equal(workspaceCrmDeliveries.length, outboxJob.body.acceptedBySink.crm);
  for (const delivery of workspaceCrmDeliveries) {
    assert.equal(delivery.validSignature, true);
    assert.equal(delivery.eventId, delivery.body.event.id);
    assert.equal(delivery.crmProvider, "custom");
    assert.equal(delivery.crmMappingVersion, "v1");
    assert.ok(["agreement.created", "agreement.updated", "agreement.stage_changed", "agreement.deleted", "signature.completed"].includes(delivery.body.event.topic));
  }

  const exportAfterOutbox = await requestJson(activeServer.origin, "/api/admin/export", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(exportAfterOutbox.response.status, 200, JSON.stringify(exportAfterOutbox.body));
  const attemptedOutbox = exportAfterOutbox.body.evidence.records.outboxEvents;
  const attemptedDeliveries = exportAfterOutbox.body.evidence.records.outboxDeliveries;
  assert.equal(attemptedOutbox.length, 4);
  assert.equal(attemptedOutbox.filter((event) => event.status === "processed").length, outboxJob.body.delivered);
  assert.equal(attemptedOutbox.filter((event) => event.status === "pending" && event.attempts === 1).length, outboxJob.body.retried);
  assert.equal(attemptedDeliveries.filter((delivery) => delivery.sink === "delivery" && delivery.status === "accepted").length, outboxJob.body.acceptedBySink.delivery);
  assert.equal(attemptedDeliveries.filter((delivery) => delivery.sink === "crm" && delivery.status === "accepted").length, outboxJob.body.acceptedBySink.crm);
  assert.ok(attemptedDeliveries.filter((delivery) => delivery.sink === "crm").every((delivery) =>
    delivery.crmProvider === "custom"
    && delivery.crmMappingVersion === "v1"
    && /^[a-f0-9]{64}$/.test(delivery.crmDestinationFingerprint)
  ));
  const generatedOutbox = attemptedOutbox.find((event) =>
    event.topic === "agreement.created" && event.aggregateId === String(generatedAgreementId)
  );
  assert.ok(generatedOutbox);
  assert.equal(attemptedDeliveries.some((delivery) => delivery.eventId === generatedOutbox.id && delivery.sink === "crm"), false);

  const immediateOutboxRetry = await requestJson(activeServer.origin, "/api/jobs/outbox", {
    method: "POST",
    headers: { authorization: `Bearer ${JOB_SECRET}` },
  });
  assert.equal(immediateOutboxRetry.response.status, 200, JSON.stringify(immediateOutboxRetry.body));
  assert.equal(immediateOutboxRetry.body.processed, 0);

  // Seed the only state migrations cannot reconstruct: a pre-delivery-ledger
  // CRM projection with no destination row. Exercise the public route around
  // that fixture; direct D1 access is confined to creating the legacy premise.
  const legacyCreate = await requestJson(activeServer.origin, "/api/agreements", {
    method: "POST",
    headers: agreementCreationHeaders(activeServer.origin, adminIdentity),
    body: JSON.stringify({
      creationMode: "manual",
      party: `Legacy CRM cleanup evidence ${runId}`,
      side: "Sell-side",
      type: "Synthetic legacy CRM evidence",
      value: 1,
      owner: adminIdentity.displayName,
      due: "2026-09-30",
      crm: "Custom CRM",
      crmRecord: `legacy-${runId}`,
      tags: ["production-evidence"],
      department: "Legal",
      risk: "Low",
      effectiveDate: "",
      expirationDate: "",
    }),
  });
  assert.equal(legacyCreate.response.status, 201, JSON.stringify(legacyCreate.body));
  const legacyAgreementId = legacyCreate.body.agreement.id;
  const legacyInitialDelivery = await requestJson(activeServer.origin, "/api/jobs/outbox", {
    method: "POST",
    headers: { authorization: `Bearer ${JOB_SECRET}` },
  });
  assert.equal(legacyInitialDelivery.response.status, 200, JSON.stringify(legacyInitialDelivery.body));
  assert.equal(legacyInitialDelivery.body.processed, 1);
  assert.equal(legacyInitialDelivery.body.acceptedBySink.crm, 1);

  const legacyDeletion = await requestJson(activeServer.origin, "/api/agreements", {
    method: "DELETE",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ id: legacyAgreementId, version: 1 }),
  });
  assert.equal(legacyDeletion.response.status, 200, JSON.stringify(legacyDeletion.body));
  assert.equal(legacyDeletion.body.agreement.version, 2);
  const legacyBeforeSeed = await requestJson(activeServer.origin, "/api/admin/export", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(legacyBeforeSeed.response.status, 200, JSON.stringify(legacyBeforeSeed.body));
  const legacyCreatedEvent = legacyBeforeSeed.body.evidence.records.outboxEvents.find((event) =>
    event.topic === "agreement.created" && event.aggregateId === String(legacyAgreementId));
  const legacyDeletionEvent = legacyBeforeSeed.body.evidence.records.outboxEvents.find((event) =>
    event.topic === "agreement.deleted" && event.aggregateId === String(legacyAgreementId));
  assert.ok(legacyCreatedEvent);
  assert.ok(legacyDeletionEvent);
  const oldDeletionEpoch = "2020-01-02T03:04:05.000Z";
  const expiredRetention = "2020-01-01T23:59:59.999Z";
  const exactDeletionPayload = { ...legacyDeletionEvent.payload, deletedAt: oldDeletionEpoch };
  await mutateEvidenceD1((database) => {
    database.prepare(`UPDATE agreements
      SET retention_until = ?, deleted_at = ?, updated = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ?`).run(
      expiredRetention,
      oldDeletionEpoch,
      oldDeletionEpoch,
      oldDeletionEpoch,
      workspaceA,
      legacyAgreementId,
    );
    database.prepare("UPDATE outbox_events SET payload = ? WHERE workspace_id = ? AND id = ?")
      .run(JSON.stringify(exactDeletionPayload), workspaceA, legacyDeletionEvent.id);
  });
  const exactDeletionDelivery = await requestJson(activeServer.origin, "/api/jobs/outbox", {
    method: "POST",
    headers: { authorization: `Bearer ${JOB_SECRET}` },
  });
  assert.equal(exactDeletionDelivery.response.status, 200, JSON.stringify(exactDeletionDelivery.body));
  assert.equal(exactDeletionDelivery.body.processed, 1);
  assert.equal(exactDeletionDelivery.body.acceptedBySink.crm, 1);

  const legacyEventId = `legacy-pre-ledger-${runId}`;
  const legacyPayload = structuredClone(legacyCreatedEvent.payload);
  legacyPayload.crmAgreement = { ...legacyPayload.crmAgreement, crm: "Custom CRM", version: 1 };
  await mutateEvidenceD1((database) => {
    database.prepare(`INSERT INTO outbox_events (
      id, workspace_id, topic, aggregate_type, aggregate_id, payload, status,
      attempts, available_at, locked_at, processed_at, last_error, created_at
    ) VALUES (?, ?, 'agreement.updated', 'agreement', ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?)`)
      .run(
        legacyEventId,
        workspaceA,
        String(legacyAgreementId),
        JSON.stringify(legacyPayload),
        oldDeletionEpoch,
        oldDeletionEpoch,
      );
  });

  const retentionBlockedByLegacy = await requestJson(activeServer.origin, "/api/jobs/retention?dryRun=true", {
    method: "POST",
    headers: { authorization: `Bearer ${JOB_SECRET}` },
  });
  assert.equal(retentionBlockedByLegacy.response.status, 200, JSON.stringify(retentionBlockedByLegacy.body));
  assert.ok(retentionBlockedByLegacy.body.blocked.some((entry) =>
    entry.resourceType === "agreement"
    && entry.resourceId === String(legacyAgreementId)
    && entry.reason.includes("legacy unprofiled evidence")));
  assert.ok(!retentionBlockedByLegacy.body.hardPurged.agreementIds.includes(legacyAgreementId));

  const legacyCandidates = await requestJson(activeServer.origin, "/api/admin/integrations/resync", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(legacyCandidates.response.status, 200, JSON.stringify(legacyCandidates.body));
  const legacyCandidate = legacyCandidates.body.agreements.find((candidate) => candidate.id === legacyAgreementId);
  assert.ok(legacyCandidate?.eligibleActions.includes("legacy_cleanup_attestation"));
  assert.equal(legacyCandidate.version, 2);

  const legacyAttestationBase = {
    agreementId: legacyAgreementId,
    version: 2,
    action: "legacy_cleanup_attestation",
    reason: "Synthetic externally reconciled legacy CRM evidence",
  };
  const missingLegacyPhrase = await requestJson(activeServer.origin, "/api/admin/integrations/resync", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ ...legacyAttestationBase, legacyCleanupConfirmed: true }),
  });
  assert.equal(missingLegacyPhrase.response.status, 400);
  const uncheckedLegacyAttestation = await requestJson(activeServer.origin, "/api/admin/integrations/resync", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      ...legacyAttestationBase,
      legacyCleanupConfirmed: false,
      legacyCleanupConfirmation: CRM_LEGACY_CLEANUP_CONFIRMATION,
    }),
  });
  assert.equal(uncheckedLegacyAttestation.response.status, 400);
  const wrongLegacyPhrase = await requestJson(activeServer.origin, "/api/admin/integrations/resync", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      ...legacyAttestationBase,
      legacyCleanupConfirmed: true,
      legacyCleanupConfirmation: `${CRM_LEGACY_CLEANUP_CONFIRMATION} `,
    }),
  });
  assert.equal(wrongLegacyPhrase.response.status, 400);
  const unauthorizedLegacyAttestation = await requestJson(activeServer.origin, "/api/admin/integrations/resync", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, requesterIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      ...legacyAttestationBase,
      legacyCleanupConfirmed: true,
      legacyCleanupConfirmation: CRM_LEGACY_CLEANUP_CONFIRMATION,
    }),
  });
  assert.equal(unauthorizedLegacyAttestation.response.status, 403);

  const crmCallsBeforeLegacyAttestation = provider.crmDeliveries.length;
  const acceptedLegacyAttestation = await requestJson(activeServer.origin, "/api/admin/integrations/resync", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      ...legacyAttestationBase,
      legacyCleanupConfirmed: true,
      legacyCleanupConfirmation: CRM_LEGACY_CLEANUP_CONFIRMATION,
    }),
  });
  assert.equal(acceptedLegacyAttestation.response.status, 201, JSON.stringify(acceptedLegacyAttestation.body));
  assert.equal(acceptedLegacyAttestation.body.agreement.version, 3);
  assert.equal(acceptedLegacyAttestation.body.auditEvent.type, "Legacy CRM cleanup attested");
  assert.equal(acceptedLegacyAttestation.body.crm.attestedEvents, 1);
  assert.equal(acceptedLegacyAttestation.body.crm.hasMore, false);
  assert.equal(acceptedLegacyAttestation.body.crm.deliveryQueued, true);
  assert.equal(acceptedLegacyAttestation.body.event.topic, "agreement.deleted");
  assert.equal(acceptedLegacyAttestation.body.event.aggregateVersion, 3);
  assert.equal(provider.crmDeliveries.length, crmCallsBeforeLegacyAttestation);

  const exportAfterLegacyAttestation = await requestJson(activeServer.origin, "/api/admin/export", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(exportAfterLegacyAttestation.response.status, 200, JSON.stringify(exportAfterLegacyAttestation.body));
  const legacyAttestation = exportAfterLegacyAttestation.body.evidence.records.crmLegacyCleanupAttestations.find((row) =>
    row.eventId === legacyEventId);
  assert.ok(legacyAttestation);
  assert.equal(legacyAttestation.workspaceId, workspaceA);
  assert.equal(legacyAttestation.agreementId, legacyAgreementId);
  assert.equal(legacyAttestation.eventPayloadSha256, canonicalPayloadSha256(legacyPayload));
  assert.equal(legacyAttestation.providerSelection, "Custom CRM");
  assert.equal(legacyAttestation.reason, legacyAttestationBase.reason);
  assert.equal(legacyAttestation.attestedByUserId, bootstrapAdmin.userId);
  assert.ok(exportAfterLegacyAttestation.body.evidence.records.agreementEvents.some((event) =>
    event.id === acceptedLegacyAttestation.body.auditEvent.id
    && event.agreementId === legacyAgreementId
    && event.type === "Legacy CRM cleanup attested"));
  assert.ok(exportAfterLegacyAttestation.body.evidence.records.agreementVersions.some((version) =>
    version.agreementId === legacyAgreementId && version.version === 3));
  const freshLegacyTombstone = exportAfterLegacyAttestation.body.evidence.records.outboxEvents.find((event) =>
    event.id === acceptedLegacyAttestation.body.event.id);
  assert.ok(freshLegacyTombstone);
  assert.equal(freshLegacyTombstone.payload.aggregateVersion, 3);
  assert.equal(freshLegacyTombstone.payload.version, 3);
  assert.equal(freshLegacyTombstone.payload.deletedAt, oldDeletionEpoch);
  assert.equal(exportAfterLegacyAttestation.body.evidence.records.outboxDeliveries.some((delivery) =>
    delivery.eventId === legacyEventId), false);

  const repeatLegacyAttestation = await requestJson(activeServer.origin, "/api/admin/integrations/resync", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      ...legacyAttestationBase,
      version: 3,
      legacyCleanupConfirmed: true,
      legacyCleanupConfirmation: CRM_LEGACY_CLEANUP_CONFIRMATION,
    }),
  });
  assert.equal(repeatLegacyAttestation.response.status, 409);
  assert.equal(repeatLegacyAttestation.body.error.code, "legacy_cleanup_not_eligible");

  const retentionWaitingForFreshTombstone = await requestJson(activeServer.origin, "/api/jobs/retention?dryRun=true", {
    method: "POST",
    headers: { authorization: `Bearer ${JOB_SECRET}` },
  });
  assert.equal(retentionWaitingForFreshTombstone.response.status, 200, JSON.stringify(retentionWaitingForFreshTombstone.body));
  assert.ok(retentionWaitingForFreshTombstone.body.blocked.some((entry) =>
    entry.resourceType === "agreement" && entry.resourceId === String(legacyAgreementId)));
  assert.ok(!retentionWaitingForFreshTombstone.body.hardPurged.agreementIds.includes(legacyAgreementId));

  const crmCallsBeforeLegacyFence = provider.crmDeliveries.length;
  const legacyFenceDelivery = await requestJson(activeServer.origin, "/api/jobs/outbox", {
    method: "POST",
    headers: { authorization: `Bearer ${JOB_SECRET}` },
  });
  assert.equal(legacyFenceDelivery.response.status, 200, JSON.stringify(legacyFenceDelivery.body));
  assert.equal(legacyFenceDelivery.body.processed, 2);
  assert.equal(legacyFenceDelivery.body.delivered, 2);
  assert.equal(legacyFenceDelivery.body.acceptedBySink.delivery, 2);
  assert.equal(legacyFenceDelivery.body.acceptedBySink.crm, 1);
  assert.equal(provider.crmDeliveries.length, crmCallsBeforeLegacyFence + 1);
  assert.equal(provider.crmDeliveries.some((delivery) => delivery.eventId === legacyEventId), false);
  assert.equal(provider.crmDeliveries.some((delivery) => delivery.eventId === freshLegacyTombstone.id), true);

  const exportAfterLegacyFence = await requestJson(activeServer.origin, "/api/admin/export", {
    headers: identityHeaders(adminIdentity),
  });
  const finalLegacyEvent = exportAfterLegacyFence.body.evidence.records.outboxEvents.find((event) => event.id === legacyEventId);
  assert.equal(finalLegacyEvent.status, "processed");
  const finalLegacyDeliveries = exportAfterLegacyFence.body.evidence.records.outboxDeliveries
    .filter((delivery) => delivery.eventId === legacyEventId);
  assert.deepEqual(finalLegacyDeliveries.map((delivery) => [delivery.sink, delivery.status]), [["delivery", "accepted"]]);
  assert.deepEqual(
    exportAfterLegacyFence.body.evidence.records.crmLegacyCleanupAttestations.find((row) => row.eventId === legacyEventId),
    legacyAttestation,
  );

  const retentionReadyAfterLegacyCleanup = await requestJson(activeServer.origin, "/api/jobs/retention?dryRun=true", {
    method: "POST",
    headers: { authorization: `Bearer ${JOB_SECRET}` },
  });
  assert.equal(retentionReadyAfterLegacyCleanup.response.status, 200, JSON.stringify(retentionReadyAfterLegacyCleanup.body));
  assert.ok(retentionReadyAfterLegacyCleanup.body.hardPurged.agreementIds.includes(legacyAgreementId));
  assert.ok(!retentionReadyAfterLegacyCleanup.body.blocked.some((entry) =>
    entry.resourceType === "agreement" && entry.resourceId === String(legacyAgreementId)));

  // Simulate a worker crash after the ordinary delivery sink was initialized
  // but before the CRM sink existed. A retry must repair the incomplete sink
  // set and cannot silently finalize the event as delivery-only.
  const partialSinkCreate = await requestJson(activeServer.origin, "/api/agreements", {
    method: "POST",
    headers: agreementCreationHeaders(activeServer.origin, adminIdentity),
    body: JSON.stringify({
      creationMode: "manual",
      party: `Partial outbox recovery evidence ${runId}`,
      side: "Sell-side",
      type: "Synthetic partial sink evidence",
      value: 1,
      owner: adminIdentity.displayName,
      due: "2026-09-30",
      crm: "Custom CRM",
      crmRecord: `partial-sink-${runId}`,
      tags: ["production-evidence"],
      department: "Legal",
      risk: "Low",
      effectiveDate: "",
      expirationDate: "",
    }),
  });
  assert.equal(partialSinkCreate.response.status, 201, JSON.stringify(partialSinkCreate.body));
  const partialSinkAgreementId = partialSinkCreate.body.agreement.id;
  const partialSinkEvent = await mutateEvidenceD1((database) => {
    const event = database.prepare(`SELECT id, available_at, created_at
      FROM outbox_events
      WHERE workspace_id = ? AND topic = 'agreement.created' AND aggregate_id = ?
      ORDER BY created_at DESC LIMIT 1`).get(workspaceA, String(partialSinkAgreementId));
    assert.ok(event?.id);
    database.prepare(`INSERT INTO outbox_deliveries (
      event_id, sink, workspace_id, status, attempts, available_at, accepted_at,
      last_error, crm_provider, crm_mapping_version,
      crm_destination_fingerprint, created_at, updated_at
    ) VALUES (?, 'delivery', ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`).run(
      event.id,
      workspaceA,
      event.available_at,
      event.created_at,
      event.created_at,
    );
    return event;
  });
  const partialSinkRecovery = await requestJson(activeServer.origin, "/api/jobs/outbox", {
    method: "POST",
    headers: { authorization: `Bearer ${JOB_SECRET}` },
  });
  assert.equal(partialSinkRecovery.response.status, 200, JSON.stringify(partialSinkRecovery.body));
  const partialSinkState = await mutateEvidenceD1((database) => database.prepare(`SELECT sink, status,
      crm_provider, crm_mapping_version, crm_destination_fingerprint
    FROM outbox_deliveries
    WHERE workspace_id = ? AND event_id = ?
    ORDER BY sink`).all(workspaceA, partialSinkEvent.id));
  assert.deepEqual(partialSinkState.map((delivery) => [delivery.sink, delivery.status]), [
    ["crm", "accepted"],
    ["delivery", "accepted"],
  ]);
  const repairedCrmDelivery = partialSinkState.find((delivery) => delivery.sink === "crm");
  assert.equal(repairedCrmDelivery?.crm_provider, "custom");
  assert.equal(repairedCrmDelivery?.crm_mapping_version, "v1");
  assert.match(repairedCrmDelivery?.crm_destination_fingerprint ?? "", /^[a-f0-9]{64}$/);
  assert.equal(provider.crmDeliveries.some((delivery) => delivery.eventId === partialSinkEvent.id), true);

  // Race the no-row fence itself. Exactly one side may establish authority:
  // either the attestation commits and CRM is forever omitted, or the outbox
  // binds/sends the complete profile and the attestation is rejected.
  const raceCreate = await requestJson(activeServer.origin, "/api/agreements", {
    method: "POST",
    headers: agreementCreationHeaders(activeServer.origin, adminIdentity),
    body: JSON.stringify({
      creationMode: "manual",
      party: `Legacy CRM race evidence ${runId}`,
      side: "Sell-side",
      type: "Synthetic legacy race evidence",
      value: 1,
      owner: adminIdentity.displayName,
      due: "2026-09-30",
      crm: "Custom CRM",
      crmRecord: `legacy-race-${runId}`,
      tags: ["production-evidence"],
      department: "Legal",
      risk: "Low",
      effectiveDate: "",
      expirationDate: "",
    }),
  });
  assert.equal(raceCreate.response.status, 201, JSON.stringify(raceCreate.body));
  const raceAgreementId = raceCreate.body.agreement.id;
  const raceEvent = await mutateEvidenceD1((database) => database.prepare(`SELECT id
    FROM outbox_events
    WHERE workspace_id = ? AND topic = 'agreement.created' AND aggregate_id = ?
    ORDER BY created_at DESC LIMIT 1`).get(workspaceA, String(raceAgreementId)));
  assert.ok(raceEvent?.id);
  const [raceAttestation, raceOutbox] = await Promise.all([
    requestJson(activeServer.origin, "/api/admin/integrations/resync", {
      method: "POST",
      headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
      body: JSON.stringify({
        agreementId: raceAgreementId,
        version: 1,
        action: "legacy_cleanup_attestation",
        reason: "Synthetic concurrent external reconciliation evidence",
        legacyCleanupConfirmed: true,
        legacyCleanupConfirmation: CRM_LEGACY_CLEANUP_CONFIRMATION,
      }),
    }),
    requestJson(activeServer.origin, "/api/jobs/outbox", {
      method: "POST",
      headers: { authorization: `Bearer ${JOB_SECRET}` },
    }),
  ]);
  assert.ok([201, 409].includes(raceAttestation.response.status), JSON.stringify(raceAttestation.body));
  assert.equal(raceOutbox.response.status, 200, JSON.stringify(raceOutbox.body));
  const raceState = await mutateEvidenceD1((database) => ({
    attestation: database.prepare(`SELECT event_id
      FROM crm_legacy_cleanup_attestations
      WHERE workspace_id = ? AND event_id = ?`).get(workspaceA, raceEvent.id),
    crmDelivery: database.prepare(`SELECT status, crm_provider, crm_mapping_version, crm_destination_fingerprint
      FROM outbox_deliveries
      WHERE workspace_id = ? AND event_id = ? AND sink = 'crm'`).get(workspaceA, raceEvent.id),
  }));
  const raceAttestationPersisted = Boolean(raceState.attestation);
  const raceCrmDelivery = raceState.crmDelivery;
  const raceCrmSent = provider.crmDeliveries.some((delivery) => delivery.eventId === raceEvent.id);
  if (raceAttestation.response.status === 201) {
    assert.equal(raceAttestationPersisted, true);
    assert.equal(raceCrmDelivery, undefined);
    assert.equal(raceCrmSent, false);
  } else {
    assert.equal(raceAttestationPersisted, false);
    assert.equal(raceCrmDelivery?.status, "accepted");
    assert.equal(raceCrmDelivery?.crm_provider, "custom");
    assert.equal(raceCrmDelivery?.crm_mapping_version, "v1");
    assert.match(raceCrmDelivery?.crm_destination_fingerprint ?? "", /^[a-f0-9]{64}$/);
    assert.equal(raceCrmSent, true);
  }

  const requesterResyncAttempt = await requestJson(activeServer.origin, "/api/admin/integrations/resync", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, requesterIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ agreementId, version: 3, action: "projection", reason: "Unauthorized projection replay" }),
  });
  assert.equal(requesterResyncAttempt.response.status, 403);
  assert.equal(requesterResyncAttempt.body.error.code, "permission_denied");

  const resyncCandidates = await requestJson(activeServer.origin, "/api/admin/integrations/resync", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(resyncCandidates.response.status, 200, JSON.stringify(resyncCandidates.body));
  assert.ok(resyncCandidates.body.agreements.some((candidate) => candidate.id === agreementId && candidate.version === 3 && candidate.deletedAt === null));

  const activeResync = await requestJson(activeServer.origin, "/api/admin/integrations/resync", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ agreementId, version: 3, action: "projection", reason: "Synthetic current-profile backfill evidence" }),
  });
  assert.equal(activeResync.response.status, 202, JSON.stringify(activeResync.body));
  assert.equal(activeResync.body.agreement.version, 4);
  assert.equal(activeResync.body.event.topic, "agreement.updated");
  assert.equal(activeResync.body.event.aggregateVersion, 4);
  assert.equal(activeResync.body.crm.provider, "custom");
  assert.equal(activeResync.body.crm.mappingVersion, "v1");

  const staleResync = await requestJson(activeServer.origin, "/api/admin/integrations/resync", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ agreementId, version: 3, action: "projection", reason: "Stale replay must be rejected" }),
  });
  assert.equal(staleResync.response.status, 409);
  assert.equal(staleResync.body.error.code, "version_conflict");

  const deletionResyncCreate = await requestJson(activeServer.origin, "/api/agreements", {
    method: "POST",
    headers: agreementCreationHeaders(activeServer.origin, adminIdentity),
    body: JSON.stringify({
      creationMode: "manual",
      party: `Deletion resync evidence ${runId}`,
      side: "Sell-side",
      type: "Synthetic deletion evidence",
      value: 1,
      owner: adminIdentity.displayName,
      due: "2026-09-30",
      crm: "Custom CRM",
      crmRecord: `synthetic-${runId}`,
      tags: ["production-evidence"],
      department: "Legal",
      risk: "Low",
      effectiveDate: "",
      expirationDate: "",
    }),
  });
  assert.equal(deletionResyncCreate.response.status, 201, JSON.stringify(deletionResyncCreate.body));
  const deletionResyncAgreementId = deletionResyncCreate.body.agreement.id;
  const deletion = await requestJson(activeServer.origin, "/api/agreements", {
    method: "DELETE",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ id: deletionResyncAgreementId, version: 1 }),
  });
  assert.equal(deletion.response.status, 200, JSON.stringify(deletion.body));
  assert.equal(deletion.body.agreement.version, 2);
  assert.ok(deletion.body.agreement.deletedAt);

  const tombstoneResync = await requestJson(activeServer.origin, "/api/admin/integrations/resync", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ agreementId: deletionResyncAgreementId, version: 2, action: "tombstone", reason: "Synthetic tombstone backfill evidence" }),
  });
  assert.equal(tombstoneResync.response.status, 202, JSON.stringify(tombstoneResync.body));
  assert.equal(tombstoneResync.body.agreement.version, 3);
  assert.equal(tombstoneResync.body.event.topic, "agreement.deleted");

  const candidatesWithDeleted = await requestJson(activeServer.origin, "/api/admin/integrations/resync", {
    headers: identityHeaders(adminIdentity),
  });
  assert.ok(candidatesWithDeleted.body.agreements.some((candidate) =>
    candidate.id === deletionResyncAgreementId && candidate.version === 3 && candidate.deletedAt === deletion.body.agreement.deletedAt
  ));

  const crmDeliveriesBeforeResync = provider.crmDeliveries.length;
  const resyncOutbox = await requestJson(activeServer.origin, "/api/jobs/outbox", {
    method: "POST",
    headers: { authorization: `Bearer ${JOB_SECRET}` },
  });
  assert.equal(resyncOutbox.response.status, 200, JSON.stringify(resyncOutbox.body));
  assert.equal(resyncOutbox.body.processed, 4);
  assert.equal(resyncOutbox.body.delivered, 4);
  assert.equal(resyncOutbox.body.acceptedBySink.delivery, 4);
  assert.equal(resyncOutbox.body.acceptedBySink.crm, 4);
  const resyncCrmDeliveries = provider.crmDeliveries.slice(crmDeliveriesBeforeResync);
  const activeProjection = resyncCrmDeliveries.find((delivery) =>
    delivery.body.event.topic === "agreement.updated" && delivery.body.event.aggregateId === String(agreementId)
  );
  assert.equal(activeProjection?.body.event.payload.aggregateVersion, 4);
  assert.equal(activeProjection?.body.event.payload.changedFields.includes("crmProjection"), true);
  const deletionTombstones = resyncCrmDeliveries.filter((delivery) =>
    delivery.body.event.topic === "agreement.deleted" && delivery.body.event.aggregateId === String(deletionResyncAgreementId)
  );
  assert.deepEqual(deletionTombstones.map((delivery) => delivery.body.event.payload.aggregateVersion).sort(), [2, 3]);
  assert.ok(deletionTombstones.every((delivery) =>
    delivery.body.event.payload.tombstone === true && !("crmAgreement" in delivery.body.event.payload)
  ));

  const highValueCreate = await requestJson(activeServer.origin, "/api/agreements", {
    method: "POST",
    headers: agreementCreationHeaders(activeServer.origin, requesterIdentity),
    body: JSON.stringify({
      creationMode: "generated",
      party: `High-value routing evidence ${runId}`,
      side: "Buy-side",
      type: "Professional Services Agreement",
      value: 250_001,
      owner: requesterIdentity.displayName,
      due: "2026-09-30",
      crm: "None",
      crmRecord: "",
      tags: ["Generated", "High-value evidence"],
      department: "Operations",
      risk: "Low",
      effectiveDate: "2026-10-01",
      expirationDate: "",
      governingLaw: "Delaware",
    }),
  });
  assert.equal(highValueCreate.response.status, 201, JSON.stringify(highValueCreate.body));
  assert.equal(highValueCreate.body.agreement.approvalStatus, "Required");
  const highValueAgreementId = highValueCreate.body.agreement.id;
  const unassessedRouting = await requestJson(activeServer.origin, "/api/operations", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, requesterIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ entity: "approval", action: "ensure_required", record: { agreementId: highValueAgreementId, due: "2026-09-20" } }),
  });
  assert.equal(unassessedRouting.response.status, 409, JSON.stringify(unassessedRouting.body));
  assert.equal(unassessedRouting.body.error.code, "risk_assessment_required");
  const highValueRiskDecision = await assessAgreementRisk(activeServer.origin, highValueAgreementId, adminIdentity, "Low");
  assert.equal(highValueRiskDecision.agreement.risk, "Low");
  assert.equal(highValueRiskDecision.agreement.riskDisposition, "assessed");
  const requiredRouting = await requestJson(activeServer.origin, "/api/operations", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, requesterIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ entity: "approval", action: "ensure_required", record: { agreementId: highValueAgreementId, due: "2026-09-20" } }),
  });
  assert.equal(requiredRouting.response.status, 201, JSON.stringify(requiredRouting.body));
  assert.deepEqual(requiredRouting.body.createdRoles, ["Legal", "Finance"]);
  assert.equal(requiredRouting.body.agreement.approvalStatus, "Pending");
  assert.equal(requiredRouting.body.approvals.length, 2);
  assert.ok(requiredRouting.body.approvals.every((approval) =>
    approval.requestedByUserId === requesterUserId &&
    approval.documentVersion === highValueCreate.body.documentVersion.version &&
    approval.documentSha256 === highValueCreate.body.documentVersion.sha256 &&
    approval.basisHash === requiredRouting.body.approvals[0].basisHash
  ));
  const repeatedRouting = await requestJson(activeServer.origin, "/api/operations", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, requesterIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ entity: "approval", action: "ensure_required", record: { agreementId: highValueAgreementId, due: "2026-09-20" } }),
  });
  assert.equal(repeatedRouting.response.status, 200, JSON.stringify(repeatedRouting.body));
  assert.deepEqual(repeatedRouting.body.createdRoles, []);
  assert.equal(repeatedRouting.body.approvals.length, 2);

  const highValueBeforeMaterialChange = repeatedRouting.body.agreement;
  const materialAgreementUpdate = await requestJson(activeServer.origin, "/api/agreements", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      id: highValueAgreementId,
      version: highValueBeforeMaterialChange.version,
      value: highValueBeforeMaterialChange.value + 1,
    }),
  });
  assert.equal(materialAgreementUpdate.response.status, 200, JSON.stringify(materialAgreementUpdate.body));
  assert.equal(materialAgreementUpdate.body.unchanged, undefined);
  assert.equal(materialAgreementUpdate.body.agreement.version, highValueBeforeMaterialChange.version + 1);
  assert.equal(materialAgreementUpdate.body.agreement.approvalStatus, "Required");
  assert.ok(materialAgreementUpdate.body.event);
  const operationsAfterMaterialChange = await requestJson(activeServer.origin, "/api/operations", {
    headers: identityHeaders(adminIdentity),
  });
  const supersededHighValueApprovals = operationsAfterMaterialChange.body.approvals.filter(
    (approval) => approval.agreementId === highValueAgreementId,
  );
  assert.equal(supersededHighValueApprovals.length, 2);
  assert.ok(supersededHighValueApprovals.every((approval) => approval.status === "Superseded"));

  const prematureObligation = await requestJson(activeServer.origin, "/api/operations", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    }),
    body: JSON.stringify({
      entity: "obligation",
      action: "create",
      record: {
        agreementId: generatedAgreementId,
        title: "Premature synthetic obligation",
        dueDate: "2026-11-01",
        cadence: "One-time",
        source: "Production evidence negative path",
        confirmed: true,
      },
    }),
  });
  assert.equal(prematureObligation.response.status, 409, JSON.stringify(prematureObligation.body));
  assert.equal(prematureObligation.body.error.code, "obligation_agreement_not_executed");

  let signingAgreement = generatedCreate.body.agreement;
  for (const toStage of ["Review", "Negotiation"]) {
    const transition = await requestJson(activeServer.origin, "/api/agreements/transition", {
      method: "POST",
      headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
      body: JSON.stringify({ id: generatedAgreementId, version: signingAgreement.version, toStage }),
    });
    assert.equal(transition.response.status, 200, JSON.stringify(transition.body));
    assert.equal(transition.body.agreement.stage, toStage);
    assert.equal(transition.body.agreement.version, signingAgreement.version + 1);
    signingAgreement = transition.body.agreement;
  }
  const generatedRiskDecision = await assessAgreementRisk(activeServer.origin, generatedAgreementId, adminIdentity, "Low");
  signingAgreement = generatedRiskDecision.agreement;
  assert.equal(signingAgreement.riskDisposition, "assessed");

  const requestedApprovals = [];
  for (const role of ["Legal", "Risk"]) {
    const approvalRequest = await requestJson(activeServer.origin, "/api/operations", {
      method: "POST",
      headers: mutationHeaders(activeServer.origin, requesterIdentity, { "content-type": "application/json" }),
      body: JSON.stringify({
        entity: "approval",
        action: "create",
        record: { agreementId: generatedAgreementId, role, due: "2026-09-20" },
      }),
    });
    assert.equal(approvalRequest.response.status, 201, JSON.stringify(approvalRequest.body));
    assert.equal(approvalRequest.body.approval.status, "Pending");
    assert.equal(approvalRequest.body.approval.approver, `Unassigned ${role}`);
    assert.equal(approvalRequest.body.approval.approverUserId, null);
    assert.equal(approvalRequest.body.approval.requestedByUserId, requesterUserId);
    assert.equal(approvalRequest.body.approval.documentVersion, 1);
    assert.equal(approvalRequest.body.approval.documentSha256, generatedCreate.body.documentVersion.sha256);
    requestedApprovals.push(approvalRequest.body.approval);
  }

  const operationsWithPendingApprovals = await requestJson(activeServer.origin, "/api/operations", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(operationsWithPendingApprovals.response.status, 200, JSON.stringify(operationsWithPendingApprovals.body));
  const persistedApprovals = operationsWithPendingApprovals.body.approvals.filter(
    (approval) => approval.agreementId === generatedAgreementId,
  );
  assert.equal(persistedApprovals.length, 2);
  assert.ok(persistedApprovals.every((approval) => approval.status === "Pending" && approval.approverUserId === null));

  const agreementsAfterApprovalRequests = await requestJson(activeServer.origin, "/api/agreements", {
    headers: identityHeaders(adminIdentity),
  });
  signingAgreement = agreementsAfterApprovalRequests.body.agreements.find((agreement) => agreement.id === generatedAgreementId);
  assert.ok(signingAgreement);
  assert.equal(signingAgreement.stage, "Negotiation");
  assert.equal(signingAgreement.approvalStatus, "Pending");

  const selfApprovalAttempt = await requestJson(activeServer.origin, "/api/operations", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, requesterIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      entity: "approval",
      action: "decide",
      record: {
        id: requestedApprovals[0].id,
        version: requestedApprovals[0].version,
        status: "Approved",
        comment: "A requester must not approve their own request",
        basisHash: requestedApprovals[0].basisHash,
        documentVersion: requestedApprovals[0].documentVersion,
        documentSha256: requestedApprovals[0].documentSha256,
        confirmed: true,
      },
    }),
  });
  assert.equal(selfApprovalAttempt.response.status, 403, JSON.stringify(selfApprovalAttempt.body));
  assert.equal(selfApprovalAttempt.body.error.code, "permission_denied");

  for (const [index, approval] of requestedApprovals.entries()) {
    const decision = await requestJson(activeServer.origin, "/api/operations", {
      method: "POST",
      headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
      body: JSON.stringify({
        entity: "approval",
        action: "decide",
        record: {
          id: approval.id,
          version: approval.version,
          status: "Approved",
          comment: `Synthetic ${approval.role.toLowerCase()} approval evidence`,
          basisHash: approval.basisHash,
          documentVersion: approval.documentVersion,
          documentSha256: approval.documentSha256,
          confirmed: true,
        },
      }),
    });
    assert.equal(decision.response.status, 200, JSON.stringify(decision.body));
    assert.equal(decision.body.approval.status, "Approved");
    assert.equal(decision.body.approval.decidedByUserId, bootstrapAdmin.userId);
    assert.equal(decision.body.agreement.approvalStatus, index === requestedApprovals.length - 1 ? "Approved" : "Pending");
    signingAgreement = decision.body.agreement;
  }

  const approvedCoverageBeforeNoop = (await requestJson(activeServer.origin, "/api/operations", {
    headers: identityHeaders(adminIdentity),
  })).body.approvals.filter((approval) => approval.agreementId === generatedAgreementId)
    .map(({ id, status, version }) => ({ id, status, version }));
  const approvedNoop = await requestJson(activeServer.origin, "/api/agreements", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify(agreementDetailsPatch(signingAgreement)),
  });
  assert.equal(approvedNoop.response.status, 200, JSON.stringify(approvedNoop.body));
  assert.equal(approvedNoop.body.unchanged, true);
  assert.equal(approvedNoop.body.event, null);
  assert.equal(approvedNoop.body.agreement.version, signingAgreement.version);
  assert.equal(approvedNoop.body.agreement.approvalStatus, "Approved");
  const approvedCoverageAfterNoop = (await requestJson(activeServer.origin, "/api/operations", {
    headers: identityHeaders(adminIdentity),
  })).body.approvals.filter((approval) => approval.agreementId === generatedAgreementId)
    .map(({ id, status, version }) => ({ id, status, version }));
  assert.deepEqual(approvedCoverageAfterNoop, approvedCoverageBeforeNoop);

  const signatureTransition = await requestJson(activeServer.origin, "/api/agreements/transition", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ id: generatedAgreementId, version: signingAgreement.version, toStage: "Signature" }),
  });
  assert.equal(signatureTransition.response.status, 200, JSON.stringify(signatureTransition.body));
  assert.equal(signatureTransition.body.agreement.stage, "Signature");
  assert.equal(signatureTransition.body.agreement.approvalStatus, "Approved");
  assert.equal(signatureTransition.body.agreement.signatureStatus, "Preparing");
  signingAgreement = signatureTransition.body.agreement;

  const signatureNoop = await requestJson(activeServer.origin, "/api/agreements", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify(agreementDetailsPatch(signingAgreement)),
  });
  assert.equal(signatureNoop.response.status, 200, JSON.stringify(signatureNoop.body));
  assert.equal(signatureNoop.body.unchanged, true);
  assert.equal(signatureNoop.body.event, null);
  assert.equal(signatureNoop.body.agreement.version, signingAgreement.version);
  assert.equal(signatureNoop.body.agreement.stage, "Signature");
  assert.equal(signatureNoop.body.agreement.approvalStatus, "Approved");
  assert.equal(signatureNoop.body.agreement.signatureStatus, "Preparing");

  const nonmaterialAgreementUpdate = await requestJson(activeServer.origin, "/api/agreements", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      id: signingAgreement.id,
      version: signingAgreement.version,
      ownerUserId: bootstrapAdmin.userId,
    }),
  });
  assert.equal(nonmaterialAgreementUpdate.response.status, 200, JSON.stringify(nonmaterialAgreementUpdate.body));
  assert.equal(nonmaterialAgreementUpdate.body.agreement.version, signingAgreement.version + 1);
  assert.equal(nonmaterialAgreementUpdate.body.agreement.stage, "Signature");
  assert.equal(nonmaterialAgreementUpdate.body.agreement.approvalStatus, "Approved");
  assert.equal(nonmaterialAgreementUpdate.body.agreement.signatureStatus, "Preparing");
  assert.equal(nonmaterialAgreementUpdate.body.agreement.ownerUserId, bootstrapAdmin.userId);
  assert.equal(nonmaterialAgreementUpdate.body.agreement.owner, bootstrapAdmin.displayName);
  signingAgreement = nonmaterialAgreementUpdate.body.agreement;
  const approvedCoverageAfterNonmaterialChange = (await requestJson(activeServer.origin, "/api/operations", {
    headers: identityHeaders(adminIdentity),
  })).body.approvals.filter((approval) => approval.agreementId === generatedAgreementId)
    .map(({ id, status, version }) => ({ id, status, version }));
  assert.deepEqual(approvedCoverageAfterNonmaterialChange, approvedCoverageBeforeNoop);

  const signer = {
    role: "Counterparty",
    email: `signer-${runId}@production-evidence.notice.test`,
    name: "Synthetic Counterparty Signer",
  };
  const signatureCreate = await requestJson(activeServer.origin, "/api/signatures", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ agreementId: generatedAgreementId, version: signingAgreement.version, parties: [signer] }),
  });
  assert.equal(signatureCreate.response.status, 201, JSON.stringify(signatureCreate.body));
  assert.equal(signatureCreate.body.embedSrc, null);
  assert.equal(signatureCreate.body.signaturePacket.status, "pending");
  assert.equal(signatureCreate.body.signaturePacket.documentVersion, 1);
  assert.equal(signatureCreate.body.signaturePacket.documentSha256, generatedCreate.body.documentVersion.sha256);
  assertNoProviderCapability(signatureCreate.body.signaturePacket, provider.embedSrc);
  signingAgreement = signatureCreate.body.agreement;
  assert.equal(signingAgreement.signatureStatus, "Sent");

  assert.equal(provider.submissionRequests.length, 1);
  const submissionRequest = provider.submissionRequests[0].body;
  const signingDocumentName = `${generatedParty} — Vendor Services Agreement — working version 1`;
  assert.deepEqual(submissionRequest.template_ids, [1]);
  assert.equal(submissionRequest.documents.length, 1);
  assert.equal(submissionRequest.documents[0].name, signingDocumentName);
  assert.equal(
    submissionRequest.documents[0].html,
    renderExpectedSigningHtml({
      name: signingDocumentName,
      content: generatedContent,
      version: 1,
      sha256: generatedCreate.body.documentVersion.sha256,
    }),
  );
  assert.ok(submissionRequest.documents[0].html.includes("&lt;unsafe &amp;"));
  assert.ok(!submissionRequest.documents[0].html.includes("<unsafe &"));
  assert.equal(submissionRequest.submitters[0].email, signer.email);
  assert.equal(submissionRequest.submitters[0].metadata.notice_document_version, "1");
  assert.equal(submissionRequest.submitters[0].metadata.notice_document_sha256, generatedCreate.body.documentVersion.sha256);

  const duplicateSignature = await requestJson(activeServer.origin, "/api/signatures", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ agreementId: generatedAgreementId, version: signingAgreement.version, parties: [signer] }),
  });
  assert.equal(duplicateSignature.response.status, 409, JSON.stringify(duplicateSignature.body));
  assert.equal(duplicateSignature.body.error.code, "signature_packet_exists");
  assert.equal(duplicateSignature.body.embedSrc, undefined);
  assert.equal(provider.submissionRequests.length, 1);

  const signatureListBeforeCompletion = await requestJson(activeServer.origin, "/api/signatures", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(signatureListBeforeCompletion.response.status, 200, JSON.stringify(signatureListBeforeCompletion.body));
  const listedPendingPacket = signatureListBeforeCompletion.body.signaturePackets.find(
    (packet) => packet.id === signatureCreate.body.signaturePacket.id,
  );
  assert.ok(listedPendingPacket);
  assertNoProviderCapability(listedPendingPacket, provider.embedSrc);

  const auditBeforeCompletion = await requestJson(activeServer.origin, `/api/agreements/${generatedAgreementId}/audit`, {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(auditBeforeCompletion.response.status, 200, JSON.stringify(auditBeforeCompletion.body));
  assertNoProviderCapability(auditBeforeCompletion.body.evidence.signaturePackets, provider.embedSrc);

  const persistedBeforeCompletion = await requestJson(activeServer.origin, "/api/admin/export", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(persistedBeforeCompletion.response.status, 200, JSON.stringify(persistedBeforeCompletion.body));
  const persistedPendingPacket = persistedBeforeCompletion.body.evidence.records.signaturePackets.find(
    (packet) => packet.id === signatureCreate.body.signaturePacket.id,
  );
  assert.ok(persistedPendingPacket);
  assertNoProviderCapability(persistedPendingPacket, provider.embedSrc);

  const partialWebhookBody = JSON.stringify({
    event_type: "form.completed",
    timestamp: new Date(Date.now() - 1_000).toISOString(),
    data: {
      id: 91_000,
      submission_id: provider.submissionId,
      email: signer.email,
      status: "completed",
    },
  });
  const partialWebhook = await requestJson(activeServer.origin, "/api/webhooks/docuseal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-docuseal-signature": signDocuSealWebhook(partialWebhookBody),
    },
    body: partialWebhookBody,
  });
  assert.equal(partialWebhook.response.status, 200, JSON.stringify(partialWebhook.body));
  const partialSignatures = await requestJson(activeServer.origin, "/api/signatures", {
    headers: identityHeaders(adminIdentity),
  });
  const partiallySignedPacket = partialSignatures.body.signaturePackets.find(
    (packet) => packet.id === signatureCreate.body.signaturePacket.id,
  );
  assert.equal(partiallySignedPacket.status, "partially_signed");
  assert.equal(partiallySignedPacket.signers[0].status, "completed");
  const partialAgreements = await requestJson(activeServer.origin, "/api/agreements", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(
    partialAgreements.body.agreements.find((agreement) => agreement.id === generatedAgreementId).signatureStatus,
    "Partially signed",
  );

  const webhookBody = JSON.stringify({
    event_type: "submission.completed",
    timestamp: new Date().toISOString(),
    data: { id: provider.submissionId },
  });
  const webhookSignature = signDocuSealWebhook(webhookBody);
  const completedWebhook = await requestJson(activeServer.origin, "/api/webhooks/docuseal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-docuseal-signature": webhookSignature,
    },
    body: webhookBody,
  });
  assert.equal(completedWebhook.response.status, 200, JSON.stringify(completedWebhook.body));
  assert.equal(completedWebhook.body.accepted, true);
  assert.equal(completedWebhook.body.replay, false);
  assert.equal(provider.submissionReads, 1);
  assert.equal(provider.documentReads, 1);
  assert.equal(provider.artifactDownloads, 1);

  const signedScan = provider.scans.find((scan) => scan.fileName === "signed-evidence.pdf");
  assert.ok(signedScan);
  assert.equal(signedScan.contentType, "application/pdf");
  assert.equal(signedScan.declaredSha256, provider.artifactSha256);
  assert.equal(signedScan.actualSha256, provider.artifactSha256);

  const agreementsAwaitingSignatureReview = await requestJson(activeServer.origin, "/api/agreements", {
    headers: identityHeaders(adminIdentity),
  });
  const reviewRequiredAgreement = agreementsAwaitingSignatureReview.body.agreements.find(
    (agreement) => agreement.id === generatedAgreementId,
  );
  assert.ok(reviewRequiredAgreement);
  assert.equal(reviewRequiredAgreement.stage, "Signature");
  assert.equal(reviewRequiredAgreement.approvalStatus, "Approved");
  assert.equal(reviewRequiredAgreement.signatureStatus, "completed_review_required");
  assert.equal(reviewRequiredAgreement.nextAction, "Review completed signature evidence");

  const signaturesAwaitingReview = await requestJson(activeServer.origin, "/api/signatures", {
    headers: identityHeaders(adminIdentity),
  });
  const reviewRequiredPacket = signaturesAwaitingReview.body.signaturePackets.find(
    (packet) => packet.id === signatureCreate.body.signaturePacket.id,
  );
  assert.ok(reviewRequiredPacket);
  assert.equal(reviewRequiredPacket.status, "completed_review_required");
  assert.ok(reviewRequiredPacket.activeKey);
  assert.ok(reviewRequiredPacket.evidenceDocumentId);
  assert.equal(reviewRequiredPacket.finalArtifactSha256, provider.artifactSha256);
  assertNoProviderCapability(reviewRequiredPacket, provider.embedSrc);

  const signatureReviewBase = {
    action: "review_completed",
    packetId: reviewRequiredPacket.id,
    version: reviewRequiredPacket.version,
    agreementVersion: reviewRequiredAgreement.version,
    basisHash: reviewRequiredPacket.basisHash,
    documentVersion: reviewRequiredPacket.documentVersion,
    documentSha256: reviewRequiredPacket.documentSha256,
    evidenceDocumentId: reviewRequiredPacket.evidenceDocumentId,
    finalArtifactSha256: reviewRequiredPacket.finalArtifactSha256,
    confirmed: true,
    confirmation: FINAL_SIGNATURE_REVIEW_CONFIRMATION,
    reason: "Synthetic authorized review of the exact final signed evidence",
  };
  const unauthorizedSignatureReview = await requestJson(activeServer.origin, "/api/signatures", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, requesterIdentity, { "content-type": "application/json" }),
    body: JSON.stringify(signatureReviewBase),
  });
  assert.equal(unauthorizedSignatureReview.response.status, 403, JSON.stringify(unauthorizedSignatureReview.body));
  assert.equal(unauthorizedSignatureReview.body.error.code, "permission_denied");

  const staleSignatureReview = await requestJson(activeServer.origin, "/api/signatures", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ ...signatureReviewBase, agreementVersion: reviewRequiredAgreement.version - 1 }),
  });
  assert.equal(staleSignatureReview.response.status, 409, JSON.stringify(staleSignatureReview.body));
  assert.equal(staleSignatureReview.body.error.code, "version_conflict");

  const mismatchedArtifactReview = await requestJson(activeServer.origin, "/api/signatures", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ ...signatureReviewBase, finalArtifactSha256: "f".repeat(64) }),
  });
  assert.equal(mismatchedArtifactReview.response.status, 409, JSON.stringify(mismatchedArtifactReview.body));
  assert.equal(mismatchedArtifactReview.body.error.code, "signature_review_artifact_changed");

  const authorizedSignatureReview = await requestJson(activeServer.origin, "/api/signatures", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify(signatureReviewBase),
  });
  assert.equal(authorizedSignatureReview.response.status, 200, JSON.stringify(authorizedSignatureReview.body));
  assert.equal(authorizedSignatureReview.body.reviewed, true);
  assert.equal(authorizedSignatureReview.body.activated, true);
  const completedAgreement = authorizedSignatureReview.body.agreement;
  assert.equal(completedAgreement.stage, "Active");
  assert.equal(completedAgreement.approvalStatus, "Approved");
  assert.equal(completedAgreement.signatureStatus, "Completed");

  const activeNoopSideEffectsBefore = await mutateEvidenceD1((database) => ({
    events: database.prepare("SELECT COUNT(*) AS count FROM agreement_events WHERE workspace_id = ? AND agreement_id = ?").get(workspaceA, generatedAgreementId).count,
    versions: database.prepare("SELECT COUNT(*) AS count FROM agreement_versions WHERE workspace_id = ? AND agreement_id = ?").get(workspaceA, generatedAgreementId).count,
    outbox: database.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE workspace_id = ? AND aggregate_id = ?").get(workspaceA, String(generatedAgreementId)).count,
  }));
  const activeNoop = await requestJson(activeServer.origin, "/api/agreements", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify(agreementDetailsPatch(completedAgreement)),
  });
  assert.equal(activeNoop.response.status, 200, JSON.stringify(activeNoop.body));
  assert.equal(activeNoop.body.unchanged, true);
  assert.equal(activeNoop.body.event, null);
  assert.equal(activeNoop.body.agreement.version, completedAgreement.version);
  assert.equal(activeNoop.body.agreement.stage, "Active");
  assert.equal(activeNoop.body.agreement.approvalStatus, "Approved");
  assert.equal(activeNoop.body.agreement.signatureStatus, "Completed");
  const activeNoopSideEffectsAfter = await mutateEvidenceD1((database) => ({
    events: database.prepare("SELECT COUNT(*) AS count FROM agreement_events WHERE workspace_id = ? AND agreement_id = ?").get(workspaceA, generatedAgreementId).count,
    versions: database.prepare("SELECT COUNT(*) AS count FROM agreement_versions WHERE workspace_id = ? AND agreement_id = ?").get(workspaceA, generatedAgreementId).count,
    outbox: database.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE workspace_id = ? AND aggregate_id = ?").get(workspaceA, String(generatedAgreementId)).count,
  }));
  assert.deepEqual(activeNoopSideEffectsAfter, activeNoopSideEffectsBefore);

  const executedMaterialUpdate = await requestJson(activeServer.origin, "/api/agreements", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      id: completedAgreement.id,
      version: completedAgreement.version,
      party: `${completedAgreement.party} amended without an amendment`,
    }),
  });
  assert.equal(executedMaterialUpdate.response.status, 409, JSON.stringify(executedMaterialUpdate.body));
  assert.equal(executedMaterialUpdate.body.error.code, "executed_agreement_immutable");

  const obligationToday = new Date().toISOString().slice(0, 10);
  // Lead the weekly cadence by nine days so occurrence 2 is materializable
  // today while occurrence 1 remains in the future even if this long-running
  // suite crosses a UTC midnight between setup and the job request.
  const obligationAnchorDate = addUtcCalendarDays(obligationToday, 2);
  const obligationSecondDueDate = addUtcCalendarDays(obligationAnchorDate, 7);
  const obligationThirdDueDate = addUtcCalendarDays(obligationAnchorDate, 14);
  const obligationCreationKey = randomUUID();
  const obligationCreationBody = JSON.stringify({
    entity: "obligation",
    action: "create",
    record: {
      agreementId: completedAgreement.id,
      title: `Synthetic weekly post-signature obligation ${runId}`,
      dueDate: obligationAnchorDate,
      ownerUserId: requesterUserId,
      source: "Production recurring-obligation evidence",
      recurrence: {
        unit: "week",
        interval: 1,
        timezone: "Etc/UTC",
        reminderLeadDays: [9, 0],
      },
      confirmed: true,
    },
  });
  const postExecutionObligation = await requestJson(activeServer.origin, "/api/operations", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, {
      "content-type": "application/json",
      "idempotency-key": obligationCreationKey,
    }),
    body: obligationCreationBody,
  });
  assert.equal(postExecutionObligation.response.status, 201, JSON.stringify(postExecutionObligation.body));
  assert.equal(postExecutionObligation.response.headers.get("idempotency-replayed"), "false");
  assert.equal(postExecutionObligation.body.replay, false);
  assert.equal(postExecutionObligation.body.schedule.agreementId, completedAgreement.id);
  assert.equal(postExecutionObligation.body.schedule.ownerUserId, requesterUserId);
  assert.equal(postExecutionObligation.body.schedule.recurrenceUnit, "week");
  assert.equal(postExecutionObligation.body.schedule.recurrenceInterval, 1);
  assert.equal(postExecutionObligation.body.schedule.timezone, "Etc/UTC");
  assert.deepEqual(postExecutionObligation.body.schedule.reminderLeadDays, [9, 0]);
  assert.equal(postExecutionObligation.body.schedule.anchorDate, obligationAnchorDate);
  assert.equal(postExecutionObligation.body.schedule.status, "active");
  assert.equal(postExecutionObligation.body.schedule.nextOccurrenceNumber, 2);
  assert.equal(postExecutionObligation.body.schedule.nextOccurrenceDate, obligationSecondDueDate);
  assert.equal(postExecutionObligation.body.schedule.nextMaterializationDate, obligationToday);
  assert.equal(postExecutionObligation.body.obligation.agreementId, completedAgreement.id);
  assert.equal(postExecutionObligation.body.obligation.scheduleId, postExecutionObligation.body.schedule.id);
  assert.equal(postExecutionObligation.body.obligation.occurrenceNumber, 1);
  assert.equal(postExecutionObligation.body.obligation.ownerUserId, requesterUserId);
  assert.equal(postExecutionObligation.body.obligation.status, "Open");
  assert.equal(postExecutionObligation.body.obligation.cadence, "Weekly");
  const obligationScheduleId = postExecutionObligation.body.schedule.id;
  const firstObligationId = postExecutionObligation.body.obligation.id;

  const replayedObligationCreation = await requestJson(activeServer.origin, "/api/operations", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, {
      "content-type": "application/json",
      "idempotency-key": obligationCreationKey,
    }),
    body: obligationCreationBody,
  });
  assert.equal(replayedObligationCreation.response.status, 200, JSON.stringify(replayedObligationCreation.body));
  assert.equal(replayedObligationCreation.response.headers.get("idempotency-replayed"), "true");
  assert.equal(replayedObligationCreation.body.replay, true);
  assert.equal(replayedObligationCreation.body.schedule.id, obligationScheduleId);
  assert.equal(replayedObligationCreation.body.obligation.id, firstObligationId);
  assert.equal(replayedObligationCreation.body.event.id, postExecutionObligation.body.event.id);

  const collidedObligationCreation = await requestJson(activeServer.origin, "/api/operations", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, {
      "content-type": "application/json",
      "idempotency-key": obligationCreationKey,
    }),
    body: JSON.stringify({
      ...JSON.parse(obligationCreationBody),
      record: {
        ...JSON.parse(obligationCreationBody).record,
        title: `Conflicting weekly obligation ${runId}`,
      },
    }),
  });
  assert.equal(collidedObligationCreation.response.status, 409, JSON.stringify(collidedObligationCreation.body));
  assert.equal(collidedObligationCreation.body.error.code, "idempotency_key_conflict");

  const obligationProjectionBeforeJob = await requestJson(activeServer.origin, "/api/operations", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(obligationProjectionBeforeJob.response.status, 200, JSON.stringify(obligationProjectionBeforeJob.body));
  assert.equal(
    obligationProjectionBeforeJob.body.obligationSchedules.filter((schedule) => schedule.id === obligationScheduleId).length,
    1,
  );
  assert.equal(
    obligationProjectionBeforeJob.body.obligations.filter((obligation) => obligation.scheduleId === obligationScheduleId).length,
    1,
  );
  assert.equal(
    obligationProjectionBeforeJob.body.obligationEvidence.filter((evidence) => evidence.obligationId === firstObligationId).length,
    0,
  );
  assert.deepEqual(
    obligationProjectionBeforeJob.body.eligibleObligationOwners.find((owner) => owner.userId === requesterUserId),
    { userId: requesterUserId, displayName: requesterIdentity.displayName, role: "requester" },
  );
  assert.deepEqual(
    obligationProjectionBeforeJob.body.eligibleObligationOwners.find((owner) => owner.userId === bootstrapAdmin.userId),
    { userId: bootstrapAdmin.userId, displayName: adminIdentity.displayName, role: "admin" },
  );

  const wrongObligationJob = await requestJson(activeServer.origin, "/api/jobs/obligations", {
    method: "POST",
    headers: { authorization: `Bearer ${"x".repeat(JOB_SECRET.length)}` },
  });
  assert.equal(wrongObligationJob.response.status, 401, JSON.stringify(wrongObligationJob.body));
  assert.equal(wrongObligationJob.body.error.code, "authentication_required");
  const obligationJob = await requestJson(activeServer.origin, "/api/jobs/obligations", {
    method: "POST",
    headers: { authorization: `Bearer ${JOB_SECRET}` },
  });
  assert.equal(obligationJob.response.status, 202, JSON.stringify(obligationJob.body));
  assert.equal(obligationJob.body.materialized, 1);
  assert.equal(obligationJob.body.remindersQueued, 2);
  assert.equal(obligationJob.body.reminderDuplicates, 0);
  assert.equal(obligationJob.body.conflicts, 0);

  const obligationProjectionAfterJob = await requestJson(activeServer.origin, "/api/operations", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(obligationProjectionAfterJob.response.status, 200, JSON.stringify(obligationProjectionAfterJob.body));
  const materializedSchedule = obligationProjectionAfterJob.body.obligationSchedules.find(
    (schedule) => schedule.id === obligationScheduleId,
  );
  assert.ok(materializedSchedule);
  assert.equal(materializedSchedule.version, 2);
  assert.equal(materializedSchedule.nextOccurrenceNumber, 3);
  assert.equal(materializedSchedule.nextOccurrenceDate, obligationThirdDueDate);
  assert.equal(materializedSchedule.nextMaterializationDate, addUtcCalendarDays(obligationToday, 7));
  const materializedOccurrences = obligationProjectionAfterJob.body.obligations
    .filter((obligation) => obligation.scheduleId === obligationScheduleId)
    .sort((left, right) => left.occurrenceNumber - right.occurrenceNumber);
  assert.equal(materializedOccurrences.length, 2);
  assert.deepEqual(materializedOccurrences.map((obligation) => obligation.occurrenceNumber), [1, 2]);
  assert.deepEqual(materializedOccurrences.map((obligation) => obligation.dueDate), [obligationAnchorDate, obligationSecondDueDate]);
  assert.equal(materializedOccurrences[0].nextReminderDate, obligationAnchorDate);
  assert.equal(materializedOccurrences[1].nextReminderDate, obligationSecondDueDate);
  const secondObligationId = materializedOccurrences[1].id;

  const completionEvidenceText = `Requester verified occurrence 1 in production evidence run ${runId}.`;
  const completedObligation = await requestJson(activeServer.origin, "/api/operations", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, requesterIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      entity: "obligation",
      action: "complete",
      record: {
        id: firstObligationId,
        evidence: completionEvidenceText,
        version: materializedOccurrences[0].version,
        confirmed: true,
      },
    }),
  });
  assert.equal(completedObligation.response.status, 200, JSON.stringify(completedObligation.body));
  assert.equal(completedObligation.body.obligation.status, "Complete");
  assert.equal(completedObligation.body.obligation.version, materializedOccurrences[0].version + 1);
  assert.equal(completedObligation.body.obligation.completedByUserId, requesterUserId);
  assert.equal(completedObligation.body.evidence.obligationId, firstObligationId);
  assert.equal(completedObligation.body.evidence.evidenceText, completionEvidenceText);
  assert.equal(
    completedObligation.body.evidence.evidenceSha256,
    createHash("sha256").update(completionEvidenceText).digest("hex"),
  );
  assert.equal(completedObligation.body.evidence.submittedByUserId, requesterUserId);
  assert.equal(completedObligation.body.evidence.overrideReason, null);
  assert.equal(completedObligation.body.evidence.provenance, "native");

  const changedEvidenceRetry = await requestJson(activeServer.origin, "/api/operations", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, requesterIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      entity: "obligation",
      action: "complete",
      record: {
        id: firstObligationId,
        evidence: `Conflicting evidence ${runId}`,
        version: completedObligation.body.obligation.version,
        confirmed: true,
      },
    }),
  });
  assert.equal(changedEvidenceRetry.response.status, 409, JSON.stringify(changedEvidenceRetry.body));
  assert.equal(changedEvidenceRetry.body.error.code, "obligation_already_complete");

  const blockedOwnerOffboarding = await requestJson(activeServer.origin, "/api/admin/memberships", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ userId: requesterUserId, role: "viewer", status: "active" }),
  });
  assert.equal(blockedOwnerOffboarding.response.status, 409, JSON.stringify(blockedOwnerOffboarding.body));
  assert.equal(blockedOwnerOffboarding.body.error.code, "owned_obligations_require_reassignment");

  const reassignedObligationSchedule = await requestJson(activeServer.origin, "/api/operations", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      entity: "obligation",
      action: "reassign",
      record: {
        scheduleId: obligationScheduleId,
        version: materializedSchedule.version,
        newOwnerUserId: bootstrapAdmin.userId,
        reason: "Move the live recurring schedule to the workspace administrator.",
        includeOpenOccurrences: true,
        confirmed: true,
      },
    }),
  });
  assert.equal(reassignedObligationSchedule.response.status, 200, JSON.stringify(reassignedObligationSchedule.body));
  assert.equal(reassignedObligationSchedule.body.schedule.version, 3);
  assert.equal(reassignedObligationSchedule.body.schedule.ownerUserId, bootstrapAdmin.userId);
  assert.equal(reassignedObligationSchedule.body.updatedOpenOccurrences.length, 1);
  assert.equal(reassignedObligationSchedule.body.updatedOpenOccurrences[0].id, secondObligationId);
  assert.equal(reassignedObligationSchedule.body.updatedOpenOccurrences[0].ownerUserId, bootstrapAdmin.userId);

  const setObligationScheduleStatus = async (version, status, reason) => requestJson(activeServer.origin, "/api/operations", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      entity: "obligation",
      action: "schedule_status",
      record: { scheduleId: obligationScheduleId, version, status, reason, confirmed: true },
    }),
  });
  const pausedObligationSchedule = await setObligationScheduleStatus(
    reassignedObligationSchedule.body.schedule.version,
    "paused",
    "Pause while the synthetic owner transfer is reviewed.",
  );
  assert.equal(pausedObligationSchedule.response.status, 200, JSON.stringify(pausedObligationSchedule.body));
  assert.equal(pausedObligationSchedule.body.schedule.status, "paused");
  assert.equal(pausedObligationSchedule.body.schedule.version, 4);
  const resumedObligationSchedule = await setObligationScheduleStatus(
    pausedObligationSchedule.body.schedule.version,
    "active",
    "Resume after the synthetic owner transfer review completed.",
  );
  assert.equal(resumedObligationSchedule.response.status, 200, JSON.stringify(resumedObligationSchedule.body));
  assert.equal(resumedObligationSchedule.body.schedule.status, "active");
  assert.equal(resumedObligationSchedule.body.schedule.version, 5);
  const endedObligationSchedule = await setObligationScheduleStatus(
    resumedObligationSchedule.body.schedule.version,
    "ended",
    "End the synthetic recurring schedule after lifecycle evidence.",
  );
  assert.equal(endedObligationSchedule.response.status, 200, JSON.stringify(endedObligationSchedule.body));
  assert.equal(endedObligationSchedule.body.schedule.status, "ended");
  assert.equal(endedObligationSchedule.body.schedule.version, 6);
  assert.equal(endedObligationSchedule.body.schedule.nextOccurrenceNumber, null);
  assert.equal(endedObligationSchedule.body.schedule.nextOccurrenceDate, null);
  assert.equal(endedObligationSchedule.body.schedule.nextMaterializationDate, null);
  const endedScheduleResume = await setObligationScheduleStatus(
    endedObligationSchedule.body.schedule.version,
    "active",
    "An ended schedule must fail closed instead of being reactivated.",
  );
  assert.equal(endedScheduleResume.response.status, 409, JSON.stringify(endedScheduleResume.body));
  assert.equal(endedScheduleResume.body.error.code, "obligation_schedule_ended");

  const finalObligationProjection = await requestJson(activeServer.origin, "/api/operations", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(finalObligationProjection.response.status, 200, JSON.stringify(finalObligationProjection.body));
  const finalSchedules = finalObligationProjection.body.obligationSchedules.filter(
    (schedule) => schedule.id === obligationScheduleId,
  );
  const finalOccurrences = finalObligationProjection.body.obligations.filter(
    (obligation) => obligation.scheduleId === obligationScheduleId,
  );
  const finalEvidence = finalObligationProjection.body.obligationEvidence.filter(
    (evidence) => evidence.obligationId === firstObligationId,
  );
  assert.equal(finalSchedules.length, 1);
  assert.equal(finalSchedules[0].status, "ended");
  assert.equal(finalOccurrences.length, 2);
  assert.equal(new Set(finalOccurrences.map((obligation) => obligation.occurrenceNumber)).size, 2);
  assert.equal(finalOccurrences.find((obligation) => obligation.id === firstObligationId)?.status, "Complete");
  assert.equal(finalOccurrences.find((obligation) => obligation.id === secondObligationId)?.ownerUserId, bootstrapAdmin.userId);
  assert.equal(finalEvidence.length, 1);
  assert.equal(finalEvidence[0].id, completedObligation.body.evidence.id);
  assert.equal(finalEvidence[0].evidenceSha256, completedObligation.body.evidence.evidenceSha256);

  const signaturesAfterCompletion = await requestJson(activeServer.origin, "/api/signatures", {
    headers: identityHeaders(adminIdentity),
  });
  const completedPacket = signaturesAfterCompletion.body.signaturePackets.find(
    (packet) => packet.id === signatureCreate.body.signaturePacket.id,
  );
  assert.ok(completedPacket);
  assert.equal(completedPacket.status, "completed");
  assert.equal(completedPacket.activeKey, null);
  assert.ok(completedPacket.evidenceDocumentId);
  assertNoProviderCapability(completedPacket, provider.embedSrc);

  const completionAudit = await requestJson(activeServer.origin, `/api/agreements/${generatedAgreementId}/audit`, {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(completionAudit.response.status, 200, JSON.stringify(completionAudit.body));
  assert.equal(completionAudit.body.evidence.agreement.stage, "Active");
  assert.equal(completionAudit.body.evidence.agreement.signatureStatus, "Completed");
  const auditedPacket = completionAudit.body.evidence.signaturePackets.find((packet) => packet.id === completedPacket.id);
  assert.equal(auditedPacket.status, "completed");
  assertNoProviderCapability(auditedPacket, provider.embedSrc);
  const signedEvidence = completionAudit.body.evidence.documents.find((document) => document.id === completedPacket.evidenceDocumentId);
  assert.ok(signedEvidence);
  assert.equal(signedEvidence.scanStatus, "clean");
  assert.equal(signedEvidence.scanProvider, "local-production-evidence-scanner");
  assert.equal(signedEvidence.sha256, provider.artifactSha256);
  assert.equal(signedEvidence.size, provider.artifactBytes.byteLength);

  const evidenceDownload = await fetch(`${activeServer.origin}/api/documents/${completedPacket.evidenceDocumentId}`, {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(evidenceDownload.status, 200);
  assert.equal(evidenceDownload.headers.get("content-type"), "application/pdf");
  assert.deepEqual(Buffer.from(await evidenceDownload.arrayBuffer()), provider.artifactBytes);

  const replayedWebhook = await requestJson(activeServer.origin, "/api/webhooks/docuseal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-docuseal-signature": webhookSignature,
    },
    body: webhookBody,
  });
  assert.equal(replayedWebhook.response.status, 200, JSON.stringify(replayedWebhook.body));
  assert.equal(replayedWebhook.body.replay, true);
  assert.equal(provider.submissionReads, 1);
  assert.equal(provider.documentReads, 1);
  assert.equal(provider.artifactDownloads, 1);

  const viewerUpdate = await requestJson(activeServer.origin, "/api/admin/memberships", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ userId: requesterUserId, role: "viewer", status: "active" }),
  });
  assert.equal(viewerUpdate.response.status, 200, JSON.stringify(viewerUpdate.body));

  const viewerSession = await requestJson(activeServer.origin, "/api/session", {
    headers: identityHeaders(requesterIdentity),
  });
  assert.equal(viewerSession.response.status, 200);
  assert.equal(viewerSession.body.role, "viewer");
  assert.ok(!viewerSession.body.permissions.includes("agreement:create"));

  const viewerCreate = await requestJson(activeServer.origin, "/api/agreements", {
    method: "POST",
    headers: agreementCreationHeaders(activeServer.origin, requesterIdentity),
    body: JSON.stringify({}),
  });
  assert.equal(viewerCreate.response.status, 403);
  assert.equal(viewerCreate.body.error.code, "permission_denied");

  const disableMember = await requestJson(activeServer.origin, "/api/admin/memberships", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ userId: requesterUserId, role: "viewer", status: "disabled" }),
  });
  assert.equal(disableMember.response.status, 200, JSON.stringify(disableMember.body));

  const disabledSession = await requestJson(activeServer.origin, "/api/session", {
    headers: identityHeaders(requesterIdentity),
  });
  assert.equal(disabledSession.response.status, 403);
  assert.equal(disabledSession.body.code, "MEMBERSHIP_REQUIRED");

  const mismatchedIdentityReplacement = await requestJson(activeServer.origin, "/api/admin/memberships", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      action: "replace_identity",
      userId: requesterUserId,
      confirmationEmail: `wrong-${invitedEmail}`,
      newIdentitySubject: replacementRequesterIdentity.subject,
    }),
  });
  assert.equal(mismatchedIdentityReplacement.response.status, 409);
  assert.equal(mismatchedIdentityReplacement.body.error.code, "identity_confirmation_mismatch");

  const identityReplacement = await requestJson(activeServer.origin, "/api/admin/memberships", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      action: "replace_identity",
      userId: requesterUserId,
      confirmationEmail: invitedEmail,
      newIdentitySubject: replacementRequesterIdentity.subject,
    }),
  });
  assert.equal(identityReplacement.response.status, 200, JSON.stringify(identityReplacement.body));
  assert.equal(identityReplacement.body.member.status, "disabled");

  const replacementWhileDisabled = await requestJson(activeServer.origin, "/api/session", {
    headers: identityHeaders(replacementRequesterIdentity),
  });
  assert.equal(replacementWhileDisabled.response.status, 403);
  assert.equal(replacementWhileDisabled.body.code, "MEMBERSHIP_REQUIRED");

  const reenableReplacement = await requestJson(activeServer.origin, "/api/admin/memberships", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ userId: requesterUserId, role: "viewer", status: "active" }),
  });
  assert.equal(reenableReplacement.response.status, 200, JSON.stringify(reenableReplacement.body));

  const replacementSession = await requestJson(activeServer.origin, "/api/session", {
    headers: identityHeaders(replacementRequesterIdentity),
  });
  assert.equal(replacementSession.response.status, 200, JSON.stringify(replacementSession.body));
  assert.equal(replacementSession.body.role, "viewer");

  const supersededIdentitySession = await requestJson(activeServer.origin, "/api/session", {
    headers: identityHeaders(requesterIdentity),
  });
  assert.equal(supersededIdentitySession.response.status, 403);
  assert.equal(supersededIdentitySession.body.code, "MEMBERSHIP_REQUIRED");

  await stopNoticeServer(activeServer);
  activeServer = null;

  // Reuse the same isolated D1/R2 state under a second production workspace.
  // Its bootstrap administrator must not be able to enumerate or address the
  // agreement or document version created in workspace A.
  activeServer = startProductionEvidenceServer(configuredPort + 1, workspaceB, provider.deliveryUrl, provider.crmUrl, provider.accessJwksUrl);
  await waitForJson(
    activeServer,
    `${activeServer.origin}/api/session`,
    { headers: identityHeaders(adminIdentity) },
    (response, body) => response.ok && body?.workspace?.id === workspaceB,
  );

  const workspaceBList = await requestJson(activeServer.origin, "/api/agreements", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(workspaceBList.response.status, 200, JSON.stringify(workspaceBList.body));
  assert.ok(!workspaceBList.body.agreements.some((agreement) => agreement.id === agreementId));
  const workspaceBIntegrationEvidence = await requestJson(activeServer.origin, "/api/admin/integrations", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(workspaceBIntegrationEvidence.response.status, 200, JSON.stringify(workspaceBIntegrationEvidence.body));
  assert.ok(workspaceBIntegrationEvidence.body.integrations.every((integration) => integration.lastTest === null));

  const crossWorkspaceAudit = await requestJson(activeServer.origin, `/api/agreements/${agreementId}/audit`, {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(crossWorkspaceAudit.response.status, 404);
  assert.equal(crossWorkspaceAudit.body.error.code, "agreement_not_found");

  const crossWorkspaceVersions = await requestJson(activeServer.origin, `/api/agreements/${agreementId}/versions`, {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(crossWorkspaceVersions.response.status, 404);
  assert.equal(crossWorkspaceVersions.body.error.code, "agreement_not_found");

  const crossWorkspaceRetention = await requestJson(activeServer.origin, `/api/admin/retention?agreementId=${agreementId}`, {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(crossWorkspaceRetention.response.status, 404);
  assert.equal(crossWorkspaceRetention.body.error.code, "agreement_not_found");

  const sharedMemberInvite = await requestJson(activeServer.origin, "/api/admin/memberships", {
    method: "POST",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ email: invitedEmail, displayName: requesterIdentity.displayName, role: "viewer" }),
  });
  assert.equal(sharedMemberInvite.response.status, 201, JSON.stringify(sharedMemberInvite.body));
  assert.equal(sharedMemberInvite.body.member.userId, requesterUserId);

  const sharedMemberSession = await requestJson(activeServer.origin, "/api/session", {
    headers: identityHeaders(replacementRequesterIdentity),
  });
  assert.equal(sharedMemberSession.response.status, 200, JSON.stringify(sharedMemberSession.body));
  assert.equal(sharedMemberSession.body.workspace.id, workspaceB);

  await stopNoticeServer(activeServer);
  activeServer = startProductionEvidenceServer(configuredPort, workspaceA, provider.deliveryUrl, provider.crmUrl, provider.accessJwksUrl);
  await waitForJson(
    activeServer,
    `${activeServer.origin}/api/session`,
    { headers: identityHeaders(adminIdentity) },
    (response, body) => response.ok && body?.workspace?.id === workspaceA,
  );
  const persistedIntegrationEvidence = await requestJson(activeServer.origin, "/api/admin/integrations", {
    headers: identityHeaders(adminIdentity),
  });
  assert.equal(persistedIntegrationEvidence.response.status, 200, JSON.stringify(persistedIntegrationEvidence.body));
  assert.ok(persistedIntegrationEvidence.body.integrations.every((integration) => integration.lastTest?.status === "passed"));

  const disableSharedMember = await requestJson(activeServer.origin, "/api/admin/memberships", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ userId: requesterUserId, role: "viewer", status: "disabled" }),
  });
  assert.equal(disableSharedMember.response.status, 200, JSON.stringify(disableSharedMember.body));

  const crossWorkspaceIdentityReplacement = await requestJson(activeServer.origin, "/api/admin/memberships", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({
      action: "replace_identity",
      userId: requesterUserId,
      confirmationEmail: invitedEmail,
      newIdentitySubject: crossWorkspaceAttackerIdentity.subject,
    }),
  });
  assert.equal(crossWorkspaceIdentityReplacement.response.status, 409);
  assert.equal(crossWorkspaceIdentityReplacement.body.error.code, "identity_replacement_shared_account");

  const restoreSharedMember = await requestJson(activeServer.origin, "/api/admin/memberships", {
    method: "PATCH",
    headers: mutationHeaders(activeServer.origin, adminIdentity, { "content-type": "application/json" }),
    body: JSON.stringify({ userId: requesterUserId, role: "viewer", status: "active" }),
  });
  assert.equal(restoreSharedMember.response.status, 200, JSON.stringify(restoreSharedMember.body));
  assert.equal((await requestJson(activeServer.origin, "/api/session", {
    headers: identityHeaders(replacementRequesterIdentity),
  })).response.status, 200);
  const rejectedCrossWorkspaceIdentity = await requestJson(activeServer.origin, "/api/session", {
    headers: identityHeaders(crossWorkspaceAttackerIdentity),
  });
  assert.equal(rejectedCrossWorkspaceIdentity.response.status, 403);
  assert.equal(rejectedCrossWorkspaceIdentity.body.code, "MEMBERSHIP_REQUIRED");

  assert.deepEqual(provider.failures, []);

  process.stdout.write("Local production identity/D1/R2/approval/signature/webhook/obligation evidence passed.\n");
} catch (error) {
  const serverOutput = activeServer?.output() ?? "";
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n\nLocal server output:\n${serverOutput}\n`);
  process.exitCode = 1;
} finally {
  if (activeServer) await stopNoticeServer(activeServer);
  await provider.close();
  await rm(persistencePath, { recursive: true, force: true });
}

async function sqliteFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sqliteFiles(path);
    return entry.isFile() && entry.name.endsWith(".sqlite") && entry.name !== "metadata.sqlite" ? [path] : [];
  }));
  return nested.flat();
}

async function evidenceD1DatabaseFile() {
  if (evidenceDatabaseFile) return evidenceDatabaseFile;
  for (const candidate of await sqliteFiles(persistencePath)) {
    const database = new DatabaseSync(candidate);
    try {
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agreements'").get()) {
        evidenceDatabaseFile = candidate;
        return candidate;
      }
    } finally {
      database.close();
    }
  }
  throw new Error("The isolated production-evidence D1 database could not be located.");
}

async function mutateEvidenceD1(operation) {
  const database = new DatabaseSync(await evidenceD1DatabaseFile());
  database.exec("PRAGMA busy_timeout = 5000");
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalJson(nested)]));
}

function canonicalPayloadSha256(payload) {
  return createHash("sha256").update(JSON.stringify(canonicalJson(payload))).digest("hex");
}

function startProductionEvidenceServer(port, workspaceId, deliveryGatewayUrl, crmGatewayUrl, accessJwksUrl) {
  return startNoticeServer("dev:production-evidence", port, {
    NOTICE_LOCAL_PRODUCTION_EVIDENCE: "true",
    NOTICE_LOCAL_PERSIST_PATH: persistencePath,
    NOTICE_EVIDENCE_WORKSPACE_ID: workspaceId,
    NOTICE_EVIDENCE_ADMIN_EMAILS: `${ADMIN_EMAIL},${REVIEWER_ADMIN_EMAIL}`,
    NOTICE_EVIDENCE_DELIVERY_GATEWAY_URL: deliveryGatewayUrl,
    NOTICE_EVIDENCE_CRM_GATEWAY_URL: crmGatewayUrl,
    NOTICE_EVIDENCE_ACCESS_JWKS_URL: accessJwksUrl,
  });
}

function startNoticeServer(script, port, noticeEnvironment) {
  const origin = `http://localhost:${port}`;
  let serverOutput = "";
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("NOTICE_")),
  );
  const child = spawn(
    "npm",
    ["run", script, "--", "--host", "localhost", "--port", String(port), "--strictPort"],
    {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      env: { ...environment, ...noticeEnvironment, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      serverOutput = `${serverOutput}${String(chunk)}`.slice(-32_000);
    });
  }
  return { child, origin, output: () => serverOutput };
}

async function waitForJson(server, url, init, accept) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Local server exited before it was ready.\n${server.output()}`);
    }
    try {
      const response = await fetch(url, init);
      const body = await response.json();
      if (accept(response, body)) return { response, body };
    } catch {
      // Startup races are expected until Vite and the local Worker are ready.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for the local API.\n${server.output()}`);
}

async function stopNoticeServer(server) {
  if (server.child.exitCode !== null) return;
  const signal = (name) => {
    try {
      if (process.platform === "win32") server.child.kill(name);
      else process.kill(-server.child.pid, name);
    } catch {
      // The process may have exited between the check and signal.
    }
  };
  signal("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.child.once("exit", resolve)),
    delay(5_000),
  ]);
  if (server.child.exitCode === null) signal("SIGKILL");
}

function identityHeaders(identity) {
  return { "cf-access-jwt-assertion": accessToken(identity) };
}

function accessToken(identity, overrides = {}) {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: ACCESS_KEY_ID, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: ACCESS_TEAM_DOMAIN,
    aud: [ACCESS_AUDIENCE],
    sub: identity.subject,
    email: identity.email,
    name: identity.displayName,
    type: "app",
    iat: now - 5,
    nbf: now - 5,
    exp: now + 300,
    ...overrides,
  })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), ACCESS_KEYS.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function mutationHeaders(origin, identity, extra = {}) {
  return {
    origin,
    "sec-fetch-site": "same-origin",
    ...identityHeaders(identity),
    ...extra,
  };
}

function agreementCreationHeaders(origin, identity, idempotencyKey = randomUUID()) {
  return mutationHeaders(origin, identity, {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  });
}

async function requestJson(origin, path, init = {}) {
  const response = await fetch(`${origin}${path}`, init);
  const body = await response.json();
  return { response, body };
}

async function startLoopbackProvider() {
  const deliveries = [];
  const crmDeliveries = [];
  const failures = [];
  const templateChecks = [];
  const submissionRequests = [];
  const scans = [];
  const submissionId = 73_001;
  const artifactBytes = createMinimalPdf("Synthetic signed evidence. No customer data.");
  const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  let submissionReads = 0;
  let documentReads = 0;
  let artifactDownloads = 0;
  let origin = "";
  let embedSrc = "";
  const server = createHttpServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", origin || "http://127.0.0.1");

      if (request.method === "GET" && requestUrl.pathname === "/access/certs") {
        sendJson(response, 200, { keys: [ACCESS_PUBLIC_JWK] });
        return;
      }

      if (request.method === "POST" && ["/events", "/crm-events"].includes(requestUrl.pathname)) {
        const rawBody = (await readRequestBytes(request)).toString("utf8");
        const timestamp = request.headers["x-notice-timestamp"];
        const signature = request.headers["x-notice-signature"];
        assert.equal(typeof timestamp, "string");
        assert.ok(Math.abs(Date.now() / 1_000 - Number(timestamp)) <= 300);
        const crmProvider = request.headers["x-notice-crm-provider"];
        const crmMappingVersion = request.headers["x-notice-crm-mapping-version"];
        const signingInput = requestUrl.pathname === "/crm-events"
          ? `${timestamp}.${crmProvider}.${crmMappingVersion}.${rawBody}`
          : `${timestamp}.${rawBody}`;
        const expected = createHmac("sha256", requestUrl.pathname === "/crm-events" ? CRM_SECRET : DELIVERY_SECRET)
          .update(signingInput)
          .digest("hex");
        const validSignature = signature === `sha256=${expected}`;
        const body = JSON.parse(rawBody);
        const accepted = {
          body,
          eventId: request.headers["x-notice-event-id"],
          crmProvider,
          crmMappingVersion,
          validSignature,
        };
        (requestUrl.pathname === "/crm-events" ? crmDeliveries : deliveries).push(accepted);
        if (validSignature && requestUrl.pathname === "/crm-events" && request.headers["x-notice-test"] === "connection") {
          sendJson(response, 200, {
            status: "ok",
            dryRun: true,
            provider: crmProvider,
            mappingVersion: crmMappingVersion,
          });
        } else {
          response.statusCode = validSignature ? 204 : 401;
          response.end();
        }
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/templates/1") {
        assert.equal(request.headers["x-auth-token"], DOCUSEAL_TOKEN);
        templateChecks.push({ templateId: 1 });
        sendJson(response, 200, {
          id: 1,
          name: "Synthetic production evidence template",
          archived_at: null,
          shared_link: false,
          submitters: [{ name: "Counterparty", uuid: "role-counterparty" }],
          fields: [{
            submitter_uuid: "role-counterparty",
            type: "signature",
            required: true,
            areas: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.1, attachment_uuid: "attachment-1", page: 0 }],
          }],
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/submissions/html") {
        assert.equal(request.headers["x-auth-token"], DOCUSEAL_TOKEN);
        const rawBody = (await readRequestBytes(request)).toString("utf8");
        const body = JSON.parse(rawBody);
        assert.deepEqual(body.template_ids, [1]);
        assert.equal(body.documents.length, 1);
        assert.ok(body.submitters.length >= 1);
        assert.equal(body.send_email, true);
        assert.equal(body.send_sms, false);
        assert.equal(body.order, "preserved");
        assert.equal(body.merge_documents, true);
        assert.ok(Date.parse(body.expire_at) > Date.now());
        assert.ok(body.submitters.every((submitter) => submitter.send_email === true && submitter.require_email_2fa === true));
        submissionRequests.push({ body, rawBody });
        sendJson(response, 201, {
          id: submissionId,
          status: "pending",
          submitters: body.submitters.map((submitter, index) => ({
            id: 91_000 + index,
            email: submitter.email,
            status: "pending",
            embed_src: index === 0 ? embedSrc : `${embedSrc}-${index + 1}`,
          })),
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === `/api/submissions/${submissionId}`) {
        assert.equal(request.headers["x-auth-token"], DOCUSEAL_TOKEN);
        submissionReads += 1;
        sendJson(response, 200, {
          id: submissionId,
          status: "completed",
          completed_at: new Date().toISOString(),
          archived_at: null,
          submitters: (submissionRequests[0]?.body.submitters ?? []).map((submitter, index) => ({
            id: 91_000 + index,
            submission_id: submissionId,
            email: submitter.email,
            external_id: submitter.external_id,
            status: "completed",
          })),
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === `/api/submissions/${submissionId}/documents`) {
        assert.equal(request.headers["x-auth-token"], DOCUSEAL_TOKEN);
        assert.equal(requestUrl.searchParams.get("merge"), "true");
        documentReads += 1;
        sendJson(response, 200, {
          id: submissionId,
          documents: [{ name: "signed-evidence", url: `${origin}/artifacts/${submissionId}.pdf` }],
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === `/artifacts/${submissionId}.pdf`) {
        assert.equal(request.headers["x-auth-token"], DOCUSEAL_TOKEN);
        artifactDownloads += 1;
        response.statusCode = 200;
        response.setHeader("content-type", "application/pdf");
        response.setHeader("content-length", String(artifactBytes.byteLength));
        response.end(artifactBytes);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/scan") {
        const rawBody = await readRequestBytes(request);
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (Array.isArray(value)) headers.set(name, value.join(", "));
          else if (typeof value === "string") headers.set(name, value);
        }
        const scanRequest = new Request(`${origin}/scan`, { method: "POST", headers, body: rawBody });
        const timestamp = scanRequest.headers.get("x-notice-timestamp");
        assert.ok(timestamp);
        assert.ok(Math.abs(Date.now() - Date.parse(timestamp)) <= 300_000);
        const form = await scanRequest.formData();
        const file = form.get("file");
        const documentId = form.get("documentId");
        const declaredSha256 = form.get("sha256");
        assert.ok(file instanceof Blob);
        assert.equal(typeof documentId, "string");
        assert.match(declaredSha256, /^[0-9a-f]{64}$/);
        const bytes = Buffer.from(await file.arrayBuffer());
        const actualSha256 = createHash("sha256").update(bytes).digest("hex");
        assert.equal(actualSha256, declaredSha256);
        const expected = createHmac("sha256", SCAN_SECRET)
          .update(`${timestamp}.${documentId}.${declaredSha256}`)
          .digest("hex");
        assert.equal(scanRequest.headers.get("x-notice-signature"), `sha256=${expected}`);
        scans.push({
          documentId,
          declaredSha256,
          actualSha256,
          fileName: typeof file.name === "string" ? file.name : "document",
          contentType: file.type,
          bytes,
        });
        sendJson(response, 200, {
          verdict: "clean",
          provider: "local-production-evidence-scanner",
          detail: "Synthetic loopback scanner accepted the artifact.",
        });
        return;
      }

      response.statusCode = 404;
      response.end();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      response.statusCode = 400;
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://localhost:${address.port}`;
  embedSrc = `${origin}/sign/${submissionId}/capability-${runId}`;
  return {
    deliveries,
    crmDeliveries,
    failures,
    templateChecks,
    submissionRequests,
    scans,
    submissionId,
    artifactBytes,
    artifactSha256,
    deliveryUrl: `${origin}/events`,
    crmUrl: `${origin}/crm-events`,
    accessJwksUrl: `${origin}/access/certs`,
    get embedSrc() { return embedSrc; },
    get submissionReads() { return submissionReads; },
    get documentReads() { return documentReads; },
    get artifactDownloads() { return artifactDownloads; },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function readRequestBytes(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", String(bytes.byteLength));
  response.end(bytes);
}

function createMinimalPdf(message, paddingBytes = 0) {
  const escaped = message.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escaped}) Tj\nET\n%${" ".repeat(paddingBytes)}`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function renderExpectedSigningHtml(document) {
  const escapedName = escapeHtml(document.name);
  const escapedContent = escapeHtml(document.content);
  const escapedSha = escapeHtml(document.sha256);
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:12pt/1.5 Arial,sans-serif;color:#111}h1{font-size:18pt}.notice-integrity{font-size:8pt;color:#555;overflow-wrap:anywhere}pre{font:11pt/1.5 Arial,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>${escapedName}</h1><p class="notice-integrity">Notice immutable working version ${document.version} · SHA-256 ${escapedSha}</p><pre>${escapedContent}</pre></body></html>`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function assertNoProviderCapability(value, capability) {
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes(capability));
  assert.ok(!serialized.includes('"embedSrc"'));
  assert.ok(!serialized.includes('"embed_src"'));
}

function agreementDetailsPatch(agreement) {
  return {
    id: agreement.id,
    version: agreement.version,
    party: agreement.party,
    type: agreement.type,
    side: agreement.side,
    department: agreement.department,
    value: agreement.value,
    owner: agreement.owner,
    effectiveDate: agreement.effectiveDate,
    expirationDate: agreement.expirationDate,
    crm: agreement.crm,
    crmRecord: agreement.crmRecord,
  };
}

async function assessAgreementRisk(origin, agreementId, identity, level) {
  const versions = await requestJson(origin, `/api/agreements/${agreementId}/versions`, {
    headers: identityHeaders(identity),
  });
  assert.equal(versions.response.status, 200, JSON.stringify(versions.body));
  assert.ok(versions.body.workflowBasis?.riskAssessment);
  const basis = versions.body.workflowBasis.riskAssessment;
  const decision = await requestJson(origin, "/api/operations", {
    method: "POST",
    headers: mutationHeaders(origin, identity, { "content-type": "application/json" }),
    body: JSON.stringify({
      entity: "risk",
      action: "assess",
      record: {
        agreementId,
        agreementVersion: versions.body.workflowBasis.agreementVersion,
        level,
        rationale: `Synthetic ${level.toLowerCase()} risk assessment bound to the exact current working paper`,
        basisHash: basis.basisHash,
        documentVersion: basis.documentVersion,
        documentSha256: basis.documentSha256,
        confirmed: true,
      },
    }),
  });
  assert.equal(decision.response.status, 200, JSON.stringify(decision.body));
  return decision.body;
}

function signDocuSealWebhook(rawBody) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  return `${timestamp}.${signature}`;
}

function addUtcCalendarDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  assert.equal(Number.isNaN(date.getTime()), false, `Invalid UTC calendar date: ${isoDate}`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
