import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, createHmac, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const statePath = join(projectRoot, "work", "playwright", "production-harness", "state.json");

const ACCESS_TEAM_DOMAIN = "https://notice-production-evidence-fixture.cloudflareaccess.com";
const ACCESS_AUDIENCE = "a".repeat(64);
const ACCESS_KEY_ID = "production-browser-evidence-rsa-key";
const ADMIN_EMAIL = "admin@production-evidence.notice.test";
const BACKUP_ADMIN_EMAIL = "backup-admin@production-evidence.notice.test";
const DOCUSEAL_TOKEN = "local-only-synthetic-docuseal-token";
const DELIVERY_SECRET = "local-only-production-evidence-delivery-secret-0001";
const CRM_SECRET = "local-only-production-evidence-crm-secret-000000001";
const SCAN_SECRET = "local-only-production-evidence-scan-secret-0001";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sendJson(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", String(bytes.byteLength));
  response.end(bytes);
}

async function readRequestBytes(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function startLoopbackProviders(accessPublicJwk) {
  const failures = [];
  const server = createHttpServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && requestUrl.pathname === "/access/certs") {
        sendJson(response, 200, { keys: [accessPublicJwk] });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/templates/1") {
        assert.equal(request.headers["x-auth-token"], DOCUSEAL_TOKEN);
        sendJson(response, 200, {
          id: 1,
          name: "Synthetic production browser evidence template",
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
        const secret = requestUrl.pathname === "/crm-events" ? CRM_SECRET : DELIVERY_SECRET;
        const expected = createHmac("sha256", secret).update(signingInput).digest("hex");
        assert.equal(signature, `sha256=${expected}`);
        if (requestUrl.pathname === "/crm-events" && request.headers["x-notice-test"] === "connection") {
          sendJson(response, 200, {
            status: "ok",
            dryRun: true,
            provider: crmProvider,
            mappingVersion: crmMappingVersion,
          });
        } else {
          response.statusCode = 204;
          response.end();
        }
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/scan") {
        const rawBody = await readRequestBytes(request);
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (Array.isArray(value)) headers.set(name, value.join(", "));
          else if (typeof value === "string") headers.set(name, value);
        }
        const scanRequest = new Request("http://127.0.0.1/scan", { method: "POST", headers, body: rawBody });
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
        assert.equal(createHash("sha256").update(bytes).digest("hex"), declaredSha256);
        const expected = createHmac("sha256", SCAN_SECRET)
          .update(`${timestamp}.${documentId}.${declaredSha256}`)
          .digest("hex");
        assert.equal(scanRequest.headers.get("x-notice-signature"), `sha256=${expected}`);
        sendJson(response, 200, {
          verdict: "clean",
          provider: "local-production-browser-scanner",
          detail: "Synthetic loopback scanner accepted the harmless fixture.",
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
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    deliveryUrl: `${origin}/events`,
    crmUrl: `${origin}/crm-events`,
    accessJwksUrl: `${origin}/access/certs`,
    failures,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function availablePort() {
  const server = createHttpServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function startNoticeServer(port, persistencePath, workspaceId, provider) {
  const origin = `http://127.0.0.1:${port}`;
  let serverOutput = "";
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("NOTICE_")),
  );
  const child = spawn(
    "npm",
    ["run", "dev:production-evidence", "--", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      env: {
        ...environment,
        NOTICE_LOCAL_PRODUCTION_EVIDENCE: "true",
        NOTICE_LOCAL_PERSIST_PATH: persistencePath,
        NOTICE_EVIDENCE_WORKSPACE_ID: workspaceId,
        NOTICE_EVIDENCE_ADMIN_EMAILS: `${ADMIN_EMAIL},${BACKUP_ADMIN_EMAIL}`,
        NOTICE_EVIDENCE_DELIVERY_GATEWAY_URL: provider.deliveryUrl,
        NOTICE_EVIDENCE_CRM_GATEWAY_URL: provider.crmUrl,
        NOTICE_EVIDENCE_ACCESS_JWKS_URL: provider.accessJwksUrl,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      serverOutput = `${serverOutput}${String(chunk)}`.slice(-48_000);
    });
  }
  return { child, origin, output: () => serverOutput };
}

async function stopNoticeServer(server) {
  if (server.child.exitCode !== null) return;
  const signal = (name) => {
    try {
      if (process.platform === "win32") server.child.kill(name);
      else process.kill(-server.child.pid, name);
    } catch {
      // The process may exit between the status check and signal.
    }
  };
  signal("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.child.once("exit", resolve)),
    delay(5_000),
  ]);
  if (server.child.exitCode === null) signal("SIGKILL");
}

function accessToken(identity, accessPrivateKey) {
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
    exp: now + 30 * 60,
  })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), accessPrivateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

async function waitForProductionSession(server, token) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Production browser server exited before readiness.\n${server.output()}`);
    }
    try {
      const response = await fetch(`${server.origin}/api/session`, {
        headers: { "cf-access-jwt-assertion": token },
      });
      const body = await response.json();
      if (response.ok && body?.mode === "production" && body?.identitySource === "cloudflare-access") return body;
    } catch {
      // Vite, the Worker, and the isolated schema may still be starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for the production browser server.\n${server.output()}`);
}

export async function startProductionBrowserHarness() {
  const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const workspaceId = `browser-evidence-${runId}`.slice(0, 63);
  const persistencePath = await mkdtemp(join(tmpdir(), "notice-production-browser-"));
  const accessKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const accessPublicJwk = {
    ...accessKeys.publicKey.export({ format: "jwk" }),
    kid: ACCESS_KEY_ID,
    alg: "RS256",
    use: "sig",
  };
  const admin = {
    subject: `production-browser-admin-${runId}`,
    email: ADMIN_EMAIL,
    displayName: "Production Browser Admin",
  };
  const viewer = {
    subject: `production-browser-viewer-${runId}`,
    email: `viewer-${runId}@production-evidence.notice.test`,
    displayName: "Production Browser Viewer",
  };
  let provider;
  let server;
  try {
    provider = await startLoopbackProviders(accessPublicJwk);
    server = startNoticeServer(await availablePort(), persistencePath, workspaceId, provider);
    const adminToken = accessToken(admin, accessKeys.privateKey);
    const viewerToken = accessToken(viewer, accessKeys.privateKey);
    await waitForProductionSession(server, adminToken);
    const state = {
      origin: server.origin,
      workspaceId,
      admin,
      viewer,
      adminToken,
      viewerToken,
    };
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return async () => {
      await stopNoticeServer(server);
      await provider.close();
      assert.deepEqual(provider.failures, [], `Loopback provider failures: ${provider.failures.join("; ")}`);
      await rm(persistencePath, { recursive: true, force: true });
      await rm(statePath, { force: true });
    };
  } catch (error) {
    if (server) await stopNoticeServer(server);
    if (provider) await provider.close();
    await rm(persistencePath, { recursive: true, force: true });
    await rm(statePath, { force: true });
    const output = server?.output() ?? "";
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\n\nProduction browser server output:\n${output}`);
  }
}
