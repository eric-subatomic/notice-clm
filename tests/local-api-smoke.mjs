import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const configuredPort = Number(process.env.NOTICE_SMOKE_PORT ?? 43_000 + (process.pid % 1_000));
assert.ok(Number.isSafeInteger(configuredPort) && configuredPort > 1_024 && configuredPort < 65_536, "NOTICE_SMOKE_PORT must be an available user port");
const origin = `http://localhost:${configuredPort}`;
let serverOutput = "";
let evaluationIdentitySwitch = null;

const server = spawn(
  "npm",
  ["run", "dev:evaluation", "--", "--host", "localhost", "--port", String(configuredPort), "--strictPort"],
  {
    cwd: projectRoot,
    detached: process.platform !== "win32",
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

for (const stream of [server.stdout, server.stderr]) {
  stream.on("data", (chunk) => {
    serverOutput = `${serverOutput}${String(chunk)}`.slice(-24_000);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForEvaluationSession() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Local server exited before it was ready.\n${serverOutput}`);
    try {
      const response = await fetch(`${origin}/api/session`);
      if (response.ok) {
        const session = await response.json();
        assert.equal(session.mode, "evaluation");
        assert.equal(session.role, "admin");
        return session;
      }
    } catch {
      // Startup races are expected until Vite and the local Worker are ready.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for the local API.\n${serverOutput}`);
}

async function stopServer() {
  if (server.exitCode !== null) return;
  const signal = (name) => {
    try {
      if (process.platform === "win32") server.kill(name);
      else process.kill(-server.pid, name);
    } catch {
      // The process may have exited between the check and signal.
    }
  };
  signal("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    delay(5_000),
  ]);
  if (server.exitCode === null) signal("SIGKILL");
}

function mutationHeaders(extra = {}) {
  return {
    origin,
    "sec-fetch-site": "same-origin",
    ...extra,
  };
}

async function json(response) {
  const body = await response.json();
  return { response, body };
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

async function evaluationD1DatabaseFile() {
  const persistenceRoot = join(projectRoot, ".wrangler", "state", "v3", "d1");
  for (const candidate of await sqliteFiles(persistenceRoot)) {
    const database = new DatabaseSync(candidate);
    try {
      const hasUsers = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
      const hasEvaluationWorkspace = hasUsers
        ? database.prepare("SELECT 1 FROM workspaces WHERE id = 'evaluation'").get()
        : null;
      if (hasEvaluationWorkspace) return candidate;
    } finally {
      database.close();
    }
  }
  throw new Error("The local evaluation D1 database could not be located.");
}

async function switchEvaluationIdentity(sponsorUserId, reviewerUserId, suffix) {
  const databaseFile = await evaluationD1DatabaseFile();
  const database = new DatabaseSync(databaseFile);
  database.exec("PRAGMA busy_timeout = 5000");
  try {
    const selectUser = database.prepare(`SELECT id, identity_provider AS identityProvider,
      identity_subject AS identitySubject, email, display_name AS displayName
      FROM users WHERE id = ?`);
    const sponsor = selectUser.get(sponsorUserId);
    const reviewer = selectUser.get(reviewerUserId);
    assert.ok(sponsor, "The grant sponsor must remain in the local evidence store");
    assert.ok(reviewer, "The invited reviewer must exist in the local evidence store");
    assert.equal(sponsor.identityProvider, "notice-evaluation");
    assert.equal(sponsor.identitySubject, "local-evaluation-user");
    assert.equal(reviewer.identityProvider, "pending-email");

    const parkedSubject = `parked-evaluation-sponsor-${suffix}`;
    const parkedEmail = `parked-evaluation-sponsor-${suffix}@notice.local`;
    database.exec("BEGIN IMMEDIATE");
    try {
      const parked = database.prepare(`UPDATE users SET identity_subject = ?, email = ?
        WHERE id = ? AND identity_provider = ? AND identity_subject = ? AND email = ?`)
        .run(parkedSubject, parkedEmail, sponsor.id, sponsor.identityProvider, sponsor.identitySubject, sponsor.email);
      assert.equal(parked.changes, 1, "The sponsor identity binding must be parked exactly once");
      const activated = database.prepare(`UPDATE users
        SET identity_provider = ?, identity_subject = ?, email = ?, display_name = ?
        WHERE id = ? AND identity_provider = ? AND identity_subject = ? AND email = ?`)
        .run(
          sponsor.identityProvider,
          sponsor.identitySubject,
          sponsor.email,
          reviewer.displayName,
          reviewer.id,
          reviewer.identityProvider,
          reviewer.identitySubject,
          reviewer.email,
        );
      assert.equal(activated.changes, 1, "The reviewer identity binding must be activated exactly once");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { databaseFile, sponsor, reviewer };
  } finally {
    database.close();
  }
}

function restoreEvaluationIdentity(identitySwitch) {
  const database = new DatabaseSync(identitySwitch.databaseFile);
  database.exec("PRAGMA busy_timeout = 5000");
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const { sponsor, reviewer } = identitySwitch;
      const restoredReviewer = database.prepare(`UPDATE users
        SET identity_provider = ?, identity_subject = ?, email = ?, display_name = ?
        WHERE id = ? AND identity_provider = ? AND identity_subject = ?`)
        .run(
          reviewer.identityProvider,
          reviewer.identitySubject,
          reviewer.email,
          reviewer.displayName,
          reviewer.id,
          sponsor.identityProvider,
          sponsor.identitySubject,
        );
      assert.equal(restoredReviewer.changes, 1, "The reviewer identity binding must be restored exactly once");
      const restoredSponsor = database.prepare(`UPDATE users
        SET identity_provider = ?, identity_subject = ?, email = ?, display_name = ?
        WHERE id = ?`)
        .run(
          sponsor.identityProvider,
          sponsor.identitySubject,
          sponsor.email,
          sponsor.displayName,
          sponsor.id,
        );
      assert.equal(restoredSponsor.changes, 1, "The sponsor identity binding must be restored exactly once");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

try {
  const evaluationSession = await waitForEvaluationSession();

  const spoofedSession = await json(await fetch(`${origin}/api/session`, {
    headers: {
      "x-notice-identity-subject": "attacker-selected-subject",
      "x-notice-identity-email": "attacker@evil.test",
      "x-notice-identity-name": "Attacker",
      "x-notice-identity-name-encoding": "percent-encoded-utf-8",
    },
  }));
  assert.equal(spoofedSession.response.status, 200);
  assert.equal(spoofedSession.body.mode, "evaluation");
  assert.equal(spoofedSession.body.user.email, "evaluation@notice.local");
  assert.equal(spoofedSession.body.identitySource, "evaluation");

  const initial = await json(await fetch(`${origin}/api/agreements`));
  assert.equal(initial.response.status, 200);
  assert.ok(Array.isArray(initial.body.agreements));
  assert.match(initial.response.headers.get("cache-control") ?? "", /no-store/);

  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const createKey = crypto.randomUUID();
  const createBody = JSON.stringify({
    creationMode: "manual",
    party: `API smoke ${suffix}`,
    side: "Buy-side",
    type: "Mutual NDA",
    value: 25_000,
    owner: "Evaluation administrator",
    due: "2026-08-15",
    crm: "None",
    crmRecord: "",
    tags: ["local-smoke"],
    department: "Legal",
    risk: "Low",
    effectiveDate: "",
    expirationDate: "",
  });
  const missingCreationKey = await json(await fetch(`${origin}/api/agreements`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: createBody,
  }));
  assert.equal(missingCreationKey.response.status, 400);
  assert.equal(missingCreationKey.body.error.code, "idempotency_key_required");
  const create = await json(await fetch(`${origin}/api/agreements`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json", "idempotency-key": createKey }),
    body: createBody,
  }));
  assert.equal(create.response.status, 201, JSON.stringify(create.body));
  assert.equal(create.body.agreement.workspaceId, "evaluation");
  assert.equal(create.body.agreement.nextAction, "Add a source document or create a working paper");
  assert.equal(create.body.event.sequence, 1);
  assert.equal(create.body.replay, false);
  assert.equal(create.response.headers.get("idempotency-replayed"), "false");
  const agreementId = create.body.agreement.id;

  const replayedCreate = await json(await fetch(`${origin}/api/agreements`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json", "idempotency-key": createKey }),
    body: createBody,
  }));
  assert.equal(replayedCreate.response.status, 200, JSON.stringify(replayedCreate.body));
  assert.equal(replayedCreate.body.replay, true);
  assert.equal(replayedCreate.body.agreement.id, agreementId);
  assert.equal(replayedCreate.body.event.id, create.body.event.id);
  assert.equal(replayedCreate.body.documentVersion, null);
  assert.equal(replayedCreate.response.headers.get("idempotency-replayed"), "true");

  const collidedCreate = await json(await fetch(`${origin}/api/agreements`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json", "idempotency-key": createKey }),
    body: createBody.replace(`API smoke ${suffix}`, `Different intake ${suffix}`),
  }));
  assert.equal(collidedCreate.response.status, 409);
  assert.equal(collidedCreate.body.error.code, "idempotency_key_conflict");

  const concurrentKey = crypto.randomUUID();
  const concurrentBody = JSON.stringify({
    ...JSON.parse(createBody),
    creationMode: "generated",
    party: `Concurrent generated intake ${suffix}`,
    governingLaw: "New York",
  });
  const concurrentResults = await Promise.all([0, 1].map(async () => json(await fetch(`${origin}/api/agreements`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json", "idempotency-key": concurrentKey }),
    body: concurrentBody,
  }))));
  assert.deepEqual(concurrentResults.map(({ response }) => response.status).sort(), [200, 201]);
  assert.equal(concurrentResults[0].body.agreement.id, concurrentResults[1].body.agreement.id);
  assert.equal(concurrentResults[0].body.documentVersion.id, concurrentResults[1].body.documentVersion.id);
  assert.deepEqual(concurrentResults.map(({ body }) => body.replay).sort(), [false, true]);

  const queueOverwrite = await json(await fetch(`${origin}/api/agreements`, {
    method: "PATCH",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ id: agreementId, version: 1, nextAction: "Verified atomic update" }),
  }));
  assert.equal(queueOverwrite.response.status, 400);
  assert.equal(queueOverwrite.body.error.code, "validation_failed");

  const update = await json(await fetch(`${origin}/api/agreements`, {
    method: "PATCH",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ id: agreementId, version: 1, ownerUserId: null }),
  }));
  assert.equal(update.response.status, 200, JSON.stringify(update.body));
  assert.equal(update.body.agreement.version, 2);
  assert.equal(update.body.event.sequence, 2);

  const stale = await json(await fetch(`${origin}/api/agreements`, {
    method: "PATCH",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ id: agreementId, version: 1, ownerUserId: evaluationSession.user.id }),
  }));
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "version_conflict");

  const crossSite = await fetch(`${origin}/api/agreements`, {
    method: "POST",
    headers: {
      origin: "https://attacker.invalid",
      "sec-fetch-site": "cross-site",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(crossSite.status, 403);

  const documentText = `MUTUAL NON-DISCLOSURE AGREEMENT\n\nEffective August 1, 2026, API smoke ${suffix} and Notice agree to protect confidential information. This agreement is governed by New York law. Each party will provide 30 days written notice before non-renewal. The liability cap is fees paid during the prior twelve months.`;
  const uploadKey = crypto.randomUUID();
  const uploadFileName = `api-smoke-${suffix}.txt`;
  const makeUploadForm = (text = documentText) => {
    const form = new FormData();
    form.set("file", new File([text], uploadFileName, { type: "text/plain" }));
    return form;
  };
  const missingUploadKey = await json(await fetch(`${origin}/api/documents/import`, {
    method: "POST",
    headers: mutationHeaders(),
    body: makeUploadForm(),
  }));
  assert.equal(missingUploadKey.response.status, 400);
  assert.equal(missingUploadKey.body.error.code, "idempotency_key_required");
  const malformedUploadKey = await json(await fetch(`${origin}/api/documents/import`, {
    method: "POST",
    headers: mutationHeaders({ "idempotency-key": uploadKey.toUpperCase() }),
    body: makeUploadForm(),
  }));
  assert.equal(malformedUploadKey.response.status, 400);
  assert.equal(malformedUploadKey.body.error.code, "invalid_idempotency_key");
  const concurrentUploads = await Promise.all([0, 1].map(async () => json(await fetch(`${origin}/api/documents/import`, {
    method: "POST",
    headers: mutationHeaders({ "idempotency-key": uploadKey }),
    body: makeUploadForm(),
  }))));
  assert.deepEqual(concurrentUploads.map(({ response }) => response.status).sort(), [200, 201]);
  assert.equal(concurrentUploads[0].body.document.id, concurrentUploads[1].body.document.id);
  const upload = concurrentUploads.find(({ response }) => response.status === 201) ?? concurrentUploads[0];
  assert.equal(upload.response.status, 201, JSON.stringify(upload.body));
  assert.equal(upload.response.headers.get("idempotency-replayed"), "false");
  assert.equal(upload.body.document.scanStatus, "evaluation-bypassed");
  assert.equal(upload.body.document.extracted.governingLaw, "New York");
  const documentId = upload.body.document.id;

  const recoveredUpload = await json(await fetch(`${origin}/api/documents/import`, {
    headers: { "idempotency-key": uploadKey },
  }));
  assert.equal(recoveredUpload.response.status, 200, JSON.stringify(recoveredUpload.body));
  assert.equal(recoveredUpload.body.document.id, documentId);
  assert.equal(recoveredUpload.body.replay, true);
  const conflictingUpload = await json(await fetch(`${origin}/api/documents/import`, {
    method: "POST",
    headers: mutationHeaders({ "idempotency-key": uploadKey }),
    body: makeUploadForm(`${documentText}\nChanged retry body.`),
  }));
  assert.equal(conflictingUpload.response.status, 409);
  assert.equal(conflictingUpload.body.error.code, "idempotency_key_conflict");

  const link = await json(await fetch(`${origin}/api/documents/import`, {
    method: "PATCH",
    headers: mutationHeaders({ "content-type": "application/json", "idempotency-key": uploadKey }),
    body: JSON.stringify({ documentId, agreementId }),
  }));
  assert.equal(link.response.status, 200, JSON.stringify(link.body));
  assert.equal(link.body.event.sequence, 3);
  assert.equal(link.body.workingVersionCreated, true);
  assert.equal(link.body.workingVersion.version, 1);

  const replayedLink = await json(await fetch(`${origin}/api/documents/import`, {
    method: "PATCH",
    headers: mutationHeaders({ "content-type": "application/json", "idempotency-key": uploadKey }),
    body: JSON.stringify({ documentId, agreementId }),
  }));
  assert.equal(replayedLink.response.status, 200, JSON.stringify(replayedLink.body));
  assert.equal(replayedLink.body.alreadyLinked, true);
  assert.equal(replayedLink.body.workingVersionCreated, false);
  assert.equal(replayedLink.body.event, undefined);

  const creationReplayAfterLink = await json(await fetch(`${origin}/api/agreements`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json", "idempotency-key": createKey }),
    body: createBody,
  }));
  assert.equal(creationReplayAfterLink.response.status, 200, JSON.stringify(creationReplayAfterLink.body));
  assert.equal(creationReplayAfterLink.body.agreement.version, 3);
  assert.equal(creationReplayAfterLink.body.documentVersion, null);

  const versions = await json(await fetch(`${origin}/api/agreements/${agreementId}/versions`));
  assert.equal(versions.response.status, 200, JSON.stringify(versions.body));
  assert.equal(versions.body.versions[0].version, 1);
  assert.equal(versions.body.versions[0].sourceDocumentId, documentId);
  assert.equal(versions.body.sourceDocuments.length, 1);
  assert.equal(versions.body.sourceDocuments[0].id, documentId);
  assert.equal(versions.body.sourceDocuments[0].sha256, upload.body.document.sha256);
  const workingVersion = await fetch(`${origin}/api/agreements/${agreementId}/versions?version=1`);
  assert.equal(workingVersion.status, 200);
  assert.match(workingVersion.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(await workingVersion.text(), documentText.trim());

  const download = await fetch(`${origin}/api/documents/${documentId}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-security-policy"), "sandbox");
  assert.match(download.headers.get("cache-control") ?? "", /no-store/);
  const downloadedBytes = new Uint8Array(await download.arrayBuffer());
  const downloadedHash = createHash("sha256").update(downloadedBytes).digest("hex");
  assert.equal(downloadedHash, upload.body.document.sha256);

  const audit = await json(await fetch(`${origin}/api/agreements/${agreementId}/audit`));
  assert.equal(audit.response.status, 200, JSON.stringify(audit.body));
  assert.equal(audit.body.evidence.audit.chain.valid, true);
  assert.equal(audit.body.evidence.audit.chain.checked, 3);
  assert.equal(audit.body.evidence.versions.length, 3);
  assert.equal(audit.body.evidence.documentVersions.length, 1);
  assert.equal(audit.body.evidence.documentVersions[0].sourceDocumentId, documentId);
  assert.equal(audit.body.evidence.documents[0].sha256, upload.body.document.sha256);

  const initialNegotiation = await json(await fetch(`${origin}/api/agreements/${agreementId}/negotiation`));
  assert.equal(initialNegotiation.response.status, 200, JSON.stringify(initialNegotiation.body));
  assert.equal(initialNegotiation.body.agreementVersion, link.body.agreement.version);
  assert.equal(initialNegotiation.body.activeRound, null);
  assert.equal(initialNegotiation.body.deliveryConfigured, false);
  assert.equal(initialNegotiation.body.negotiationMailAccepted, false);
  assert.equal(initialNegotiation.body.inboundEmailConfigured, false);
  assert.equal(initialNegotiation.body.portalEnabled, true);

  const counterpartyEmail = `counterparty-${suffix}@smoke.notice.local`;
  const preparedRound = await json(await fetch(`${origin}/api/agreements/${agreementId}/negotiation`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      action: "prepare",
      expectedAgreementVersion: initialNegotiation.body.agreementVersion,
      counterpartyEmail,
      counterpartyName: `Counterparty ${suffix}`,
    }),
  }));
  assert.equal(preparedRound.response.status, 200, JSON.stringify(preparedRound.body));
  assert.equal(preparedRound.body.result.agreement.version, initialNegotiation.body.agreementVersion + 1);
  assert.equal(preparedRound.body.result.round.status, "prepared");
  assert.equal(preparedRound.body.result.round.counterpartyEmail, counterpartyEmail);
  assert.equal(preparedRound.body.result.round.portalEnabled, true);
  assert.equal(preparedRound.body.result.round.emailAddress, null);
  assert.equal(preparedRound.body.result.portalTokenIssued, true);
  const roundId = preparedRound.body.result.round.id;
  const securePortalUrl = new URL(preparedRound.body.result.portalUrl);
  assert.equal(securePortalUrl.origin, origin);
  assert.match(securePortalUrl.pathname, /^\/api\/exchange\/[a-f0-9]{64}$/);
  const portalToken = securePortalUrl.pathname.split("/").at(-1);
  assert.ok(portalToken);
  assert.ok(!JSON.stringify(preparedRound.body.result.round).includes(portalToken));

  const blockedAutomatedSend = await json(await fetch(`${origin}/api/agreements/${agreementId}/negotiation`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      action: "send",
      roundId,
      expectedAgreementVersion: preparedRound.body.result.agreement.version,
      recipientEmail: counterpartyEmail,
      subject: `API smoke negotiation ${suffix}`,
      message: "Review the draft through the scoped secure portal.",
    }),
  }));
  assert.equal(blockedAutomatedSend.response.status, 503, JSON.stringify(blockedAutomatedSend.body));
  assert.equal(blockedAutomatedSend.body.error.code, "delivery_not_configured");

  const portalMetadataUrl = new URL(securePortalUrl);
  portalMetadataUrl.searchParams.set("format", "json");
  const portalMetadata = await json(await fetch(portalMetadataUrl));
  assert.equal(portalMetadata.response.status, 200, JSON.stringify(portalMetadata.body));
  assert.match(portalMetadata.response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(portalMetadata.response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(portalMetadata.body.exchange.requestingOrganization, "Notice evaluation");
  assert.equal(portalMetadata.body.exchange.party, create.body.agreement.party);
  assert.equal(portalMetadata.body.exchange.roundNumber, 1);
  assert.equal(portalMetadata.body.exchange.outboundDocument.sha256, link.body.workingVersion.sha256);

  const portalDownloadUrl = new URL(securePortalUrl);
  portalDownloadUrl.searchParams.set("download", "1");
  const portalDownload = await fetch(portalDownloadUrl);
  assert.equal(portalDownload.status, 200);
  assert.match(portalDownload.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(portalDownload.headers.get("content-security-policy")?.includes("default-src 'none'"), true);
  const portalDownloadBytes = new Uint8Array(await portalDownload.arrayBuffer());
  assert.equal(createHash("sha256").update(portalDownloadBytes).digest("hex"), link.body.workingVersion.sha256);

  const manualReference = `local-smoke-manual:${suffix}`;
  const manualSend = await json(await fetch(`${origin}/api/agreements/${agreementId}/negotiation`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      action: "attest_manual_send",
      roundId,
      expectedAgreementVersion: preparedRound.body.result.agreement.version,
      recipientEmail: counterpartyEmail,
      providerMessageId: manualReference,
    }),
  }));
  assert.equal(manualSend.response.status, 200, JSON.stringify(manualSend.body));
  assert.equal(manualSend.body.result.status, "outbound");
  assert.equal(manualSend.body.result.deliveryMethod, "manual");
  assert.equal(manualSend.body.result.agreement.version, preparedRound.body.result.agreement.version + 1);

  const returnedDocumentText = `${documentText.trim()}\n\nCOUNTERPARTY REDLINE: liability cap requires mutual written approval.`;
  const portalUploadForm = new FormData();
  portalUploadForm.set("senderEmail", counterpartyEmail);
  portalUploadForm.set("senderName", `Counterparty ${suffix}`);
  portalUploadForm.set("file", new File(
    [returnedDocumentText],
    `api-smoke-return-${suffix}.txt`,
    { type: "text/plain" },
  ));
  const portalUpload = await json(await fetch(securePortalUrl, {
    method: "POST",
    headers: mutationHeaders({ accept: "application/json" }),
    body: portalUploadForm,
  }));
  assert.equal(portalUpload.response.status, 201, JSON.stringify(portalUpload.body));
  assert.equal(portalUpload.body.accepted, true);
  assert.equal(portalUpload.body.recorded, true);
  assert.equal(portalUpload.body.receipts.length, 1);
  assert.match(portalUpload.body.receipts[0].receiptId, /^[a-f0-9-]{36}$/i);

  const returnedNegotiation = await json(await fetch(`${origin}/api/agreements/${agreementId}/negotiation`));
  assert.equal(returnedNegotiation.response.status, 200, JSON.stringify(returnedNegotiation.body));
  assert.equal(returnedNegotiation.body.agreementVersion, manualSend.body.result.agreement.version);
  assert.equal(returnedNegotiation.body.negotiationMailAccepted, false);
  assert.equal(returnedNegotiation.body.activeRound.id, roundId);
  assert.equal(returnedNegotiation.body.activeRound.status, "returned");
  assert.equal(returnedNegotiation.body.activeRound.deliveryMethod, "manual");
  assert.equal(returnedNegotiation.body.activeRound.deliveryState, "manual_recorded");
  assert.equal(returnedNegotiation.body.activeRound.providerMessageId, manualReference);
  assert.equal(returnedNegotiation.body.activeRound.portalEnabled, true);
  assert.equal(returnedNegotiation.body.submissions.length, 1);
  assert.equal(returnedNegotiation.body.submissions[0].source, "portal");
  assert.equal(returnedNegotiation.body.submissions[0].status, "ready");
  assert.equal(returnedNegotiation.body.submissions[0].document.scanStatus, "evaluation-bypassed");
  assert.equal(
    returnedNegotiation.body.submissions[0].document.sha256,
    createHash("sha256").update(returnedDocumentText).digest("hex"),
  );
  assert.equal(returnedNegotiation.body.comparisons.length, 1);
  assert.equal(returnedNegotiation.body.comparisons[0].status, "manual_required");
  assert.ok(!JSON.stringify(returnedNegotiation.body).includes(portalToken));

  const agentAgreementParty = `Agent tombstone ${suffix}`;
  const agentAgreement = await json(await fetch(`${origin}/api/agreements`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
    body: JSON.stringify({
      ...JSON.parse(createBody),
      party: agentAgreementParty,
      tags: ["agent-soft-delete"],
    }),
  }));
  assert.equal(agentAgreement.response.status, 201, JSON.stringify(agentAgreement.body));
  const agentAgreementId = agentAgreement.body.agreement.id;

  const agentPrincipal = await json(await fetch(`${origin}/api/admin/agent-principals`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      name: `Soft-delete read agent ${suffix}`,
      commonName: `soft-delete-${suffix}.access`,
    }),
  }));
  assert.equal(agentPrincipal.response.status, 201, JSON.stringify(agentPrincipal.body));
  const agentPrincipalId = agentPrincipal.body.principal.id;

  const agentGrant = await json(await fetch(`${origin}/api/admin/agent-grants`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      principalId: agentPrincipalId,
      actionIds: ["agreement.read"],
      resourceConstraints: { resources: [{ type: "agreement", ids: [String(agentAgreementId)] }] },
      policyVersion: "api-smoke-soft-delete-v1",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }),
  }));
  assert.equal(agentGrant.response.status, 201, JSON.stringify(agentGrant.body));
  const agentGrantId = agentGrant.body.grant.id;
  const serviceHeaders = { "x-notice-evaluation-service-principal-id": agentPrincipalId };
  const proposalKey = crypto.randomUUID();
  const proposalBody = JSON.stringify({
    grantId: agentGrantId,
    actionId: "agreement.read",
    target: { type: "agreement", id: String(agentAgreementId) },
    input: { include: ["summary", "workingDocumentEvidence"] },
    proposedDiff: {},
    provenance: {
      purpose: "Verify service plan visibility after soft delete",
      modelId: "api-smoke-model",
      toolVersion: "1",
    },
  });
  const proposedPlan = await json(await fetch(`${origin}/api/v1/plans`, {
    method: "POST",
    headers: mutationHeaders({
      ...serviceHeaders,
      "content-type": "application/json",
      "idempotency-key": proposalKey,
    }),
    body: proposalBody,
  }));
  assert.equal(proposedPlan.response.status, 201, JSON.stringify(proposedPlan.body));
  assert.equal(JSON.stringify(proposedPlan.body).includes(agentAgreementParty), true);
  const planId = proposedPlan.body.plan.id;
  const planDigest = proposedPlan.body.plan.planSha256;
  const planQuery = new URLSearchParams({
    grantId: agentGrantId,
    actionId: "agreement.read",
    resourceType: "agreement",
    resourceId: String(agentAgreementId),
  });

  const activePlanCollection = await json(await fetch(`${origin}/api/v1/plans?${planQuery}`, {
    headers: serviceHeaders,
  }));
  assert.equal(activePlanCollection.response.status, 200, JSON.stringify(activePlanCollection.body));
  assert.equal(activePlanCollection.body.plans.some((plan) => plan.id === planId), true);
  const replayProposal = () => fetch(`${origin}/api/v1/plans`, {
    method: "POST",
    headers: mutationHeaders({
      ...serviceHeaders,
      "content-type": "application/json",
      "idempotency-key": proposalKey,
    }),
    body: proposalBody,
  });
  const activeProposalReplay = await json(await replayProposal());
  assert.equal(activeProposalReplay.response.status, 200, JSON.stringify(activeProposalReplay.body));
  assert.equal(activeProposalReplay.body.replay, true);
  assert.equal(activeProposalReplay.response.headers.get("idempotency-replayed"), "true");
  const activePlanDetail = await json(await fetch(`${origin}/api/v1/plans/${planId}`, {
    headers: serviceHeaders,
  }));
  assert.equal(activePlanDetail.response.status, 200, JSON.stringify(activePlanDetail.body));
  assert.equal(activePlanDetail.body.plan.id, planId);

  const executionKey = crypto.randomUUID();
  const executePlan = () => fetch(`${origin}/api/v1/plans/${planId}/execute`, {
    method: "POST",
    headers: mutationHeaders({
      ...serviceHeaders,
      "content-type": "application/json",
      "idempotency-key": executionKey,
    }),
    body: JSON.stringify({ planDigest }),
  });
  const executedPlan = await json(await executePlan());
  assert.equal(executedPlan.response.status, 200, JSON.stringify(executedPlan.body));
  assert.equal(executedPlan.body.execution.result.agreement.party, agentAgreementParty);
  const activeExecutionReplay = await json(await executePlan());
  assert.equal(activeExecutionReplay.response.status, 200, JSON.stringify(activeExecutionReplay.body));
  assert.equal(activeExecutionReplay.body.replay, true);
  assert.equal(activeExecutionReplay.response.headers.get("idempotency-replayed"), "true");

  const softDelete = await json(await fetch(`${origin}/api/agreements`, {
    method: "DELETE",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ id: agentAgreementId, version: agentAgreement.body.agreement.version }),
  }));
  assert.equal(softDelete.response.status, 200, JSON.stringify(softDelete.body));
  assert.equal(softDelete.body.deleted, true);

  const tombstonedPlanResponses = [
    await json(await fetch(`${origin}/api/v1/plans?${planQuery}`, { headers: serviceHeaders })),
    await json(await replayProposal()),
    await json(await fetch(`${origin}/api/v1/plans/${planId}`, { headers: serviceHeaders })),
    await json(await executePlan()),
  ];
  assert.deepEqual(
    tombstonedPlanResponses.map(({ response }) => response.status),
    [404, 404, 404, 409],
  );
  assert.deepEqual(
    tombstonedPlanResponses.map(({ body }) => body.error.code),
    ["agreement_not_found", "agreement_not_found", "plan_not_found", "plan_basis_stale"],
  );
  for (const tombstoned of tombstonedPlanResponses) {
    const serialized = JSON.stringify(tombstoned.body);
    assert.equal(serialized.includes(agentAgreementParty), false);
    assert.equal("plan" in tombstoned.body, false);
    assert.equal("plans" in tombstoned.body, false);
    assert.equal("execution" in tombstoned.body, false);
  }

  const humanPlanDetail = await json(await fetch(`${origin}/api/v1/plans/${planId}`));
  assert.equal(humanPlanDetail.response.status, 200, JSON.stringify(humanPlanDetail.body));
  assert.equal(humanPlanDetail.body.plan.id, planId);
  assert.equal(JSON.stringify(humanPlanDetail.body).includes(agentAgreementParty), true);
  const humanPlanOversight = await json(await fetch(
    `${origin}/api/admin/agent-plans?limit=25&principalId=${encodeURIComponent(agentPrincipalId)}`,
  ));
  assert.equal(humanPlanOversight.response.status, 200, JSON.stringify(humanPlanOversight.body));
  assert.equal(humanPlanOversight.body.plans.some((plan) => plan.id === planId), true);

  const routedAgreementParty = `Governed agent routing ${suffix}`;
  const routedAgreement = await json(await fetch(`${origin}/api/agreements`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
    body: JSON.stringify({
      ...JSON.parse(createBody),
      creationMode: "generated",
      party: routedAgreementParty,
      type: "Professional Services Agreement",
      value: 250_001,
      governingLaw: "Delaware",
      tags: ["agent-approval-routing"],
    }),
  }));
  assert.equal(routedAgreement.response.status, 201, JSON.stringify(routedAgreement.body));
  assert.equal(routedAgreement.body.agreement.risk, "Unassessed");
  assert.equal(routedAgreement.body.documentVersion.version, 1);
  const routedAgreementId = routedAgreement.body.agreement.id;

  const routedVersions = await json(await fetch(`${origin}/api/agreements/${routedAgreementId}/versions`));
  assert.equal(routedVersions.response.status, 200, JSON.stringify(routedVersions.body));
  const routedRiskBasis = routedVersions.body.workflowBasis.riskAssessment;
  const routedRiskDecision = await json(await fetch(`${origin}/api/operations`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      entity: "risk",
      action: "assess",
      record: {
        agreementId: routedAgreementId,
        agreementVersion: routedVersions.body.workflowBasis.agreementVersion,
        level: "Low",
        rationale: "Evaluation administrator reviewed the exact generated paper for governed routing evidence.",
        basisHash: routedRiskBasis.basisHash,
        documentVersion: routedRiskBasis.documentVersion,
        documentSha256: routedRiskBasis.documentSha256,
        confirmed: true,
      },
    }),
  }));
  assert.equal(routedRiskDecision.response.status, 200, JSON.stringify(routedRiskDecision.body));
  assert.equal(routedRiskDecision.body.agreement.riskDisposition, "assessed");

  const reviewerEmail = `evaluation-reviewer-${suffix}@notice.local`;
  const reviewerInvite = await json(await fetch(`${origin}/api/admin/memberships`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      email: reviewerEmail,
      displayName: `Evaluation reviewer ${suffix}`,
      role: "admin",
    }),
  }));
  assert.equal(reviewerInvite.response.status, 201, JSON.stringify(reviewerInvite.body));
  assert.equal(reviewerInvite.body.member.role, "admin");
  assert.equal(reviewerInvite.body.member.status, "active");
  const reviewerUserId = reviewerInvite.body.member.userId;
  assert.notEqual(reviewerUserId, evaluationSession.user.id);

  const routingGrant = await json(await fetch(`${origin}/api/admin/agent-grants`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      principalId: agentPrincipalId,
      actionIds: ["agreement.read", "approval.request"],
      resourceConstraints: { resources: [{ type: "agreement", ids: [String(routedAgreementId)] }] },
      policyVersion: "api-smoke-approval-routing-v1",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }),
  }));
  assert.equal(routingGrant.response.status, 201, JSON.stringify(routingGrant.body));
  const routingGrantId = routingGrant.body.grant.id;
  const routingServiceHeaders = { "x-notice-evaluation-service-principal-id": agentPrincipalId };

  const routingAffordances = await json(await fetch(
    `${origin}/api/v1/agreements/${routedAgreementId}/available-actions`,
    { headers: routingServiceHeaders },
  ));
  assert.equal(routingAffordances.response.status, 200, JSON.stringify(routingAffordances.body));
  const approvalRequestAffordance = routingAffordances.body.actions.find((action) => action.id === "approval.request");
  assert.equal(approvalRequestAffordance.authority.authorized, true);
  assert.equal(approvalRequestAffordance.requiresHuman, true);
  assert.equal(approvalRequestAffordance.requiredEvidence.targetVersion, routedRiskDecision.body.agreement.version);
  assert.equal(approvalRequestAffordance.requiredEvidence.basisHash, routingAffordances.body.evidence.approval.basisHash);

  const routingProposalKey = crypto.randomUUID();
  const routingProposalBody = JSON.stringify({
    grantId: routingGrantId,
    actionId: "approval.request",
    target: {
      type: "agreement",
      id: String(routedAgreementId),
      expectedVersion: approvalRequestAffordance.requiredEvidence.targetVersion,
      expectedBasisHash: approvalRequestAffordance.requiredEvidence.basisHash,
    },
    input: { mode: "ensure_required", due: "2026-09-30" },
    proposedDiff: {},
    provenance: {
      purpose: "Propose exact policy-derived approval routing for API smoke evidence",
      modelId: "api-smoke-model",
      toolVersion: "1",
    },
  });
  const routedPlanProposal = await json(await fetch(`${origin}/api/v1/plans`, {
    method: "POST",
    headers: mutationHeaders({
      ...routingServiceHeaders,
      "content-type": "application/json",
      "idempotency-key": routingProposalKey,
    }),
    body: routingProposalBody,
  }));
  assert.equal(routedPlanProposal.response.status, 201, JSON.stringify(routedPlanProposal.body));
  assert.equal(routedPlanProposal.body.plan.status, "pending_approval");
  assert.equal(routedPlanProposal.body.plan.proposedDiff.effect.willMutate, true);
  assert.deepEqual(routedPlanProposal.body.plan.proposedDiff.effect.createdRoles, ["Legal", "Finance"]);
  assert.deepEqual(routedPlanProposal.body.plan.proposedDiff.policy.currentExactBasisLanes, []);
  const routedPlanId = routedPlanProposal.body.plan.id;
  const routedPlanDigest = routedPlanProposal.body.plan.planSha256;

  // Evaluation mode deliberately authenticates exactly one fixed local identity.
  // Bind that identity to the already invited second administrator in the local
  // evidence store so the next ordinary HTTP request exercises the real human
  // authorization path without adding a request-header or application bypass.
  evaluationIdentitySwitch = await switchEvaluationIdentity(
    evaluationSession.user.id,
    reviewerUserId,
    suffix,
  );
  const reviewerSession = await json(await fetch(`${origin}/api/session`));
  assert.equal(reviewerSession.response.status, 200, JSON.stringify(reviewerSession.body));
  assert.equal(reviewerSession.body.role, "admin");
  assert.equal(reviewerSession.body.user.id, reviewerUserId);
  assert.notEqual(reviewerSession.body.user.id, evaluationSession.user.id);

  const exactHumanReview = await json(await fetch(`${origin}/api/v1/plans/${routedPlanId}`));
  assert.equal(exactHumanReview.response.status, 200, JSON.stringify(exactHumanReview.body));
  assert.equal(exactHumanReview.body.plan.review.eligible, true);
  assert.equal(exactHumanReview.body.plan.planSha256, routedPlanDigest);
  assert.deepEqual(exactHumanReview.body.plan.proposedDiff, routedPlanProposal.body.plan.proposedDiff);

  const routedPlanDecision = await json(await fetch(`${origin}/api/v1/plans/${routedPlanId}/decisions`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      expectedStatus: "pending_approval",
      planDigest: routedPlanDigest,
      decision: "approved",
      reason: "Reviewed the exact server-derived Legal and Finance routing effect and immutable agreement basis.",
      confirmed: true,
    }),
  }));
  assert.equal(routedPlanDecision.response.status, 201, JSON.stringify(routedPlanDecision.body));
  assert.equal(routedPlanDecision.body.planStatus, "approved");
  assert.equal(routedPlanDecision.body.decision.decidedByUserId, reviewerSession.body.user.id);
  assert.notEqual(routedPlanDecision.body.decision.decidedByUserId, evaluationSession.user.id);

  const routingExecutionKey = crypto.randomUUID();
  const executeRoutingPlan = () => fetch(`${origin}/api/v1/plans/${routedPlanId}/execute`, {
    method: "POST",
    headers: mutationHeaders({
      ...routingServiceHeaders,
      "content-type": "application/json",
      "idempotency-key": routingExecutionKey,
    }),
    body: JSON.stringify({ planDigest: routedPlanDigest }),
  });
  const concurrentRoutingExecutions = await Promise.all([0, 1].map(async () => json(await executeRoutingPlan())));
  assert.deepEqual(concurrentRoutingExecutions.map(({ response }) => response.status), [200, 200]);
  assert.deepEqual(concurrentRoutingExecutions.map(({ body }) => body.execution.status), ["succeeded", "succeeded"]);
  assert.deepEqual(concurrentRoutingExecutions.map(({ body }) => body.replay).sort(), [false, true]);
  const routingExecution = concurrentRoutingExecutions.find(({ body }) => !body.replay) ?? concurrentRoutingExecutions[0];
  const routingResult = routingExecution.body.execution.result;
  assert.equal(routingResult.agreement.approvalStatus, "Pending");
  assert.deepEqual(routingResult.createdApprovals.map((approval) => approval.role), ["Legal", "Finance"]);
  assert.ok(routingResult.createdApprovals.every((approval) =>
    approval.requestedByUserId === evaluationSession.user.id
    && approval.sourceAgentPlanId === routedPlanId
    && approval.sourceAgentPlanReviewerUserId === reviewerSession.body.user.id
    && approval.basisHash === routingAffordances.body.evidence.approval.basisHash
  ));
  assert.equal(routingResult.evidence.humanReviewerUserId, reviewerSession.body.user.id);
  assert.notEqual(routingResult.evidence.humanReviewerUserId, evaluationSession.user.id);

  const routedOperations = await json(await fetch(`${origin}/api/operations`));
  assert.equal(routedOperations.response.status, 200, JSON.stringify(routedOperations.body));
  assert.ok(Array.isArray(routedOperations.body.obligations));
  assert.ok(Array.isArray(routedOperations.body.obligationSchedules));
  assert.ok(Array.isArray(routedOperations.body.obligationEvidence));
  assert.ok(Array.isArray(routedOperations.body.eligibleObligationOwners));
  assert.deepEqual(
    routedOperations.body.eligibleObligationOwners.find((owner) => owner.userId === evaluationSession.user.id),
    {
      userId: evaluationSession.user.id,
      displayName: evaluationSession.user.displayName,
      role: "admin",
    },
  );
  const routedApprovals = routedOperations.body.approvals.filter((approval) => approval.sourceAgentPlanId === routedPlanId);
  assert.equal(routedApprovals.length, 2);
  assert.deepEqual(routedApprovals.map((approval) => approval.role).sort(), ["Finance", "Legal"]);
  const routedEvent = routedOperations.body.events.find((event) => event.sourceAgentPlanId === routedPlanId);
  assert.ok(routedEvent);
  assert.match(routedEvent.detail, new RegExp(routedPlanId));

  const routedAudit = await json(await fetch(`${origin}/api/agreements/${routedAgreementId}/audit`));
  assert.equal(routedAudit.response.status, 200, JSON.stringify(routedAudit.body));
  assert.equal(routedAudit.body.evidence.audit.agentEvidenceClosure.valid, true);
  assert.deepEqual(routedAudit.body.evidence.agentActionPlans.map((plan) => plan.id), [routedPlanId]);
  assert.deepEqual(routedAudit.body.evidence.agentPlanDecisions.map((decision) => decision.planId), [routedPlanId]);
  assert.deepEqual(routedAudit.body.evidence.agentActionExecutions.map((execution) => execution.planId), [routedPlanId]);
  const routedAuditJson = JSON.stringify(routedAudit.body);
  assert.equal(routedAuditJson.includes(createHash("sha256").update(routingProposalKey).digest("hex")), false);
  assert.equal(routedAuditJson.includes(createHash("sha256").update(routingExecutionKey).digest("hex")), false);

  const dualRoleClaim = await json(await fetch(`${origin}/api/operations`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      entity: "approval",
      action: "claim",
      record: { id: routedApprovals[0].id, version: routedApprovals[0].version },
    }),
  }));
  assert.equal(dualRoleClaim.response.status, 403, JSON.stringify(dualRoleClaim.body));
  assert.equal(dualRoleClaim.body.error.code, "agent_plan_reviewer_separation_required");

  restoreEvaluationIdentity(evaluationIdentitySwitch);
  evaluationIdentitySwitch = null;
  const restoredSponsorSession = await json(await fetch(`${origin}/api/session`));
  assert.equal(restoredSponsorSession.response.status, 200, JSON.stringify(restoredSponsorSession.body));
  assert.equal(restoredSponsorSession.body.user.id, evaluationSession.user.id);

  const noOpAffordances = await json(await fetch(
    `${origin}/api/v1/agreements/${routedAgreementId}/available-actions`,
    { headers: routingServiceHeaders },
  ));
  assert.equal(noOpAffordances.response.status, 200, JSON.stringify(noOpAffordances.body));
  const noOpApprovalRequest = noOpAffordances.body.actions.find((action) => action.id === "approval.request");
  const noOpProposal = await json(await fetch(`${origin}/api/v1/plans`, {
    method: "POST",
    headers: mutationHeaders({
      ...routingServiceHeaders,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    }),
    body: JSON.stringify({
      ...JSON.parse(routingProposalBody),
      target: {
        type: "agreement",
        id: String(routedAgreementId),
        expectedVersion: noOpApprovalRequest.requiredEvidence.targetVersion,
        expectedBasisHash: noOpApprovalRequest.requiredEvidence.basisHash,
      },
    }),
  }));
  assert.equal(noOpProposal.response.status, 409, JSON.stringify(noOpProposal.body));
  assert.equal(noOpProposal.body.error.code, "action_no_effect");

  const evaluationObligationBody = JSON.stringify({
    entity: "obligation",
    action: "create",
    record: {
      agreementId: routedAgreementId,
      title: "Evaluation recurring obligation guard",
      dueDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      ownerUserId: evaluationSession.user.id,
      source: "Local API recurrence evidence",
      recurrence: {
        unit: "week",
        interval: 1,
        timezone: "Etc/UTC",
        reminderLeadDays: [8, 0],
      },
      confirmed: true,
    },
  });
  const obligationWithoutRetryKey = await json(await fetch(`${origin}/api/operations`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: evaluationObligationBody,
  }));
  assert.equal(obligationWithoutRetryKey.response.status, 400, JSON.stringify(obligationWithoutRetryKey.body));
  assert.equal(obligationWithoutRetryKey.body.error.code, "idempotency_key_required");
  const obligationBeforeExecution = await json(await fetch(`${origin}/api/operations`, {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
    body: evaluationObligationBody,
  }));
  assert.equal(obligationBeforeExecution.response.status, 409, JSON.stringify(obligationBeforeExecution.body));
  assert.equal(obligationBeforeExecution.body.error.code, "obligation_agreement_not_executed");

  const readiness = await json(await fetch(`${origin}/api/readiness`));
  assert.equal(readiness.response.status, 503);
  assert.equal(readiness.body.code.ready, true);
  assert.equal(readiness.body.customer.ready, false);

  process.stdout.write("Local D1/R2/API smoke passed.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n\nLocal server output:\n${serverOutput}\n`);
  process.exitCode = 1;
} finally {
  if (evaluationIdentitySwitch) {
    try {
      restoreEvaluationIdentity(evaluationIdentitySwitch);
    } catch (error) {
      process.stderr.write(`The local evaluation identity could not be restored: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    }
  }
  await stopServer();
}
