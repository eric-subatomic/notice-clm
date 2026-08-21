import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocuSealSubmission,
  DOCUSEAL_ARTIFACT_MAX_BYTES,
  DOCUSEAL_BODY_TIMEOUT_MS,
  DOCUSEAL_HEADER_TIMEOUT_MS,
  DOCUSEAL_JSON_RESPONSE_MAX_BYTES,
  DOCUSEAL_MCP_PROTOCOL_VERSION,
  docuSealProviderEventId,
  downloadDocuSealArtifact,
  findDocuSealSubmissionByPacketExternalId,
  getDocuSealDocuments,
  getDocuSealSubmission,
  getDocuSealTemplateProfile,
  getDocuSealTemplateRoles,
  normalizeDocuSealApiBaseUrl,
  probeDocuSealMcp,
  renderDocuSealSigningDocument,
  resolveDocuSealApiUrl,
  signerRolesMatchTemplate,
  type DocuSealConfiguration,
  verifyDocuSealWebhook,
} from "../app/lib/docuseal";

function cloudConfiguration(overrides: Partial<DocuSealConfiguration> = {}): DocuSealConfiguration {
  return {
    deployment: "cloud-global",
    apiBaseUrl: "https://api.docuseal.com",
    apiToken: "token",
    webhookSecret: `whsec_${"x".repeat(32)}`,
    templateId: 91,
    validatedRelease: "3.2.1",
    apiClientContractVersion: "1.0.24",
    htmlSubmissionsEntitled: true,
    expirationHours: 168,
    email2faRequired: true,
    mcp: null,
    ...overrides,
  };
}

function safeTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 91,
    archived_at: null,
    shared_link: false,
    submitters: [
      { name: "Our Signer", uuid: "role-ours" },
      { name: "Counterparty", uuid: "role-counterparty" },
    ],
    fields: [
      {
        submitter_uuid: "role-ours",
        type: "signature",
        required: true,
        areas: [{ x: 0.1, y: 0.2, w: 0.2, h: 0.1, attachment_uuid: "attachment-1", page: 0 }],
      },
      {
        submitter_uuid: "role-counterparty",
        type: "initials",
        required: true,
        areas: [{ x: 0.5, y: 0.6, w: 0.1, h: 0.1, attachment_uuid: "attachment-1", page: 0 }],
      },
    ],
    ...overrides,
  };
}

function mcpTools(): Array<Record<string, unknown>> {
  const annotations = {
    search_templates: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    load_template: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    create_template: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    send_documents: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    search_documents: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  } as const;
  return Object.entries(annotations).map(([name, toolAnnotations]) => ({
    name,
    title: name,
    description: `Pinned ${name} tool`,
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: toolAnnotations,
  }));
}

test("DocuSeal submission contains the exact escaped working document and integrity binding", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body));
    return Response.json({
      id: 17,
      status: "pending",
      submitters: [{ id: 77, email: "signer@client.test", status: "pending", embed_src: "https://docuseal.com/signer-capability" }],
    });
  };

  try {
    const submission = await createDocuSealSubmission(
      cloudConfiguration(),
      {
        agreementId: 42,
        externalId: "notice:workspace:42:v3:packet-7",
        name: "Orchid — Agreement",
        parties: [{ role: "Client", email: "signer@client.test" }],
        document: {
          name: "Orchid agreement v3",
          content: "Pay <nothing> & sign.",
          contentType: "text/plain",
          version: 3,
          sha256: "a".repeat(64),
        },
      },
    );

    assert.equal(requestedUrl, "https://api.docuseal.com/submissions/html");
    assert.deepEqual(requestedBody.template_ids, [91]);
    assert.equal(requestedBody.send_email, true);
    assert.equal(requestedBody.send_sms, false);
    assert.equal(requestedBody.order, "preserved");
    assert.equal(requestedBody.merge_documents, true);
    const expiresInHours = (Date.parse(String(requestedBody.expire_at)) - Date.now()) / (60 * 60 * 1_000);
    assert.ok(expiresInHours > 167.9 && expiresInHours <= 168);
    const document = (requestedBody.documents as Array<{ html: string }>)[0];
    assert.match(document.html, /Pay &lt;nothing&gt; &amp; sign\./);
    assert.match(document.html, /working version 3/);
    assert.match(document.html, new RegExp("a{64}"));
    assert.equal(document.html.includes("<nothing>"), false);
    const submitter = (requestedBody.submitters as Array<{
      external_id: string;
      metadata: Record<string, string>;
      send_email: boolean;
      require_email_2fa: boolean;
    }>)[0];
    assert.equal(submitter.send_email, true);
    assert.equal(submitter.require_email_2fa, true);
    assert.equal(submitter.external_id, "notice:workspace:42:v3:packet-7:signer:1");
    assert.equal(submitter.metadata.notice_document_version, "3");
    assert.equal(submitter.metadata.notice_document_sha256, "a".repeat(64));
    assert.equal("embed_src" in (submission.submitters?.[0] ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("form replay identities distinguish submitters at the same provider timestamp", () => {
  const timestamp = "2026-08-01T12:00:00.000Z";
  const first = docuSealProviderEventId("form.completed", "812", timestamp, { id: 71 });
  const second = docuSealProviderEventId("form.completed", "812", timestamp, { id: 72 });
  assert.notEqual(first, second);
  assert.equal(first, "form.completed:812:submitter:71:2026-08-01T12:00:00.000Z");
  assert.equal(docuSealProviderEventId("form.completed", "812", timestamp, {}), null);
  assert.equal(docuSealProviderEventId("submission.completed", "812", timestamp, {}), "submission.completed:812:2026-08-01T12:00:00.000Z");
});

test("a packet-owned signer key recovers the authoritative DocuSeal submission", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/submitters?")) {
      return Response.json({ data: [{ id: 71, submission_id: 812, external_id: "notice:workspace:42:v3:packet-7:signer:1" }] });
    }
    return Response.json({ id: 812, status: "pending", submitters: [{ id: 71, status: "sent" }] });
  };
  try {
    const recovered = await findDocuSealSubmissionByPacketExternalId(
      { deployment: "cloud-global", apiBaseUrl: "https://api.docuseal.com", apiToken: "token" },
      "notice:workspace:42:v3:packet-7",
    );
    assert.equal(recovered?.id, 812);
    assert.match(urls[0], /external_id=notice%3Aworkspace%3A42%3Av3%3Apacket-7%3Asigner%3A1/);
    assert.equal(urls[1], "https://api.docuseal.com/submissions/812");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("only an empty recovery lookup proves provider absence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    data: [{ id: 71, external_id: "notice:workspace:42:v3:packet-7:signer:1" }],
  });
  try {
    await assert.rejects(
      findDocuSealSubmissionByPacketExternalId(
        { deployment: "cloud-global", apiBaseUrl: "https://api.docuseal.com", apiToken: "token" },
        "notice:workspace:42:v3:packet-7",
      ),
      /ambiguous signer mapping/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("configured signer roles are ordered and provider envelopes bind to requested resources", async () => {
  assert.equal(signerRolesMatchTemplate(["Our Signer", "Counterparty"], ["Our Signer", "Counterparty"]), true);
  assert.equal(signerRolesMatchTemplate(["Our Signer", "Counterparty"], ["Counterparty", "Our Signer"]), false);
  assert.equal(signerRolesMatchTemplate(["Counterparty"], ["Counterparty", "Counterparty"]), false);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/templates/91")) return Response.json(safeTemplate());
    if (url.endsWith("/submissions/812")) return Response.json({ id: 999, status: "pending", submitters: [] });
    return Response.json({ id: 999, documents: [{ name: "merged", url: "https://files.docuseal.com/merged.pdf" }] });
  };
  try {
    assert.deepEqual(await getDocuSealTemplateRoles({ deployment: "cloud-global", apiBaseUrl: "https://api.docuseal.com", apiToken: "token", templateId: 91 }), ["Our Signer", "Counterparty"]);
    await assert.rejects(
      getDocuSealSubmission({ deployment: "cloud-global", apiBaseUrl: "https://api.docuseal.com", apiToken: "token" }, 812),
      /did not match the requested submission/,
    );
    await assert.rejects(
      getDocuSealDocuments({ deployment: "cloud-global", apiBaseUrl: "https://api.docuseal.com", apiToken: "token" }, 812),
      /did not match the requested submission/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("template diagnostics reject archived, public, duplicate, or unsigned signer profiles", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [template, expected] of [
      [safeTemplate({ archived_at: "2026-08-01T00:00:00Z" }), /archived/],
      [safeTemplate({ shared_link: true }), /public shared link/],
      [safeTemplate({ submitters: [{ name: "Signer", uuid: "role-1" }, { name: "Signer", uuid: "role-2" }] }), /duplicate signer roles/],
      [safeTemplate({ fields: (safeTemplate().fields as Array<Record<string, unknown>>).slice(0, 1) }), /Every DocuSeal signer role/],
    ] as const) {
      globalThis.fetch = async () => Response.json(template);
      await assert.rejects(getDocuSealTemplateProfile({
        deployment: "cloud-global",
        apiBaseUrl: "https://api.docuseal.com",
        apiToken: "token",
        templateId: 91,
      }), expected);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deployment-aware URL resolution preserves self-hosted /api prefixes", () => {
  assert.equal(
    normalizeDocuSealApiBaseUrl("https://sign.orchid.test/tenant/api/", "self-hosted"),
    "https://sign.orchid.test/tenant/api",
  );
  assert.equal(
    resolveDocuSealApiUrl({
      deployment: "self-hosted",
      apiBaseUrl: "https://sign.orchid.test/tenant/api",
    }, "templates/91").toString(),
    "https://sign.orchid.test/tenant/api/templates/91",
  );
  assert.throws(
    () => normalizeDocuSealApiBaseUrl("https://sign.orchid.test", "self-hosted"),
    /must end with \/api/,
  );
  assert.throws(
    () => normalizeDocuSealApiBaseUrl("https://api.docuseal.com/api", "cloud-global"),
    /global Cloud/,
  );
  assert.throws(
    () => resolveDocuSealApiUrl({
      deployment: "self-hosted",
      apiBaseUrl: "https://sign.orchid.test/tenant/api",
    }, "../admin"),
    /escaped the configured provider boundary/,
  );
});

test("self-hosted MCP diagnostic proves the strict handshake and one exact read-only template load", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null; method: string; params?: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown };
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      method: body.method,
      params: body.params,
    });
    if (body.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: DOCUSEAL_MCP_PROTOCOL_VERSION,
          serverInfo: { name: "DocuSeal", version: "3.2.1" },
          capabilities: { tools: { listChanged: false } },
        },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/list") {
      return Response.json({ jsonrpc: "2.0", id: 2, result: { tools: mcpTools() } });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            id: 91,
            name: "Notice signature page",
            roles: ["Our Signer", "Counterparty"],
            fields: [
              { name: "Signature", type: "signature", role: "Our Signer" },
              { name: "Initials", type: "initials", role: "Counterparty" },
            ],
          }),
        }],
      },
    });
  };
  const configuration = cloudConfiguration({
    deployment: "self-hosted",
    apiBaseUrl: "https://sign.orchid.test/tenant/api",
    apiToken: "api-token",
    mcp: { token: "separate-mcp-token", protocolVersion: "2025-11-25", serverVersion: "3.2.1" },
  });
  try {
    assert.deepEqual(await probeDocuSealMcp(configuration, ["Our Signer", "Counterparty"]), {
      serverVersion: "3.2.1",
      toolCount: 5,
      verifiedReadTool: "load_template",
      roleCount: 2,
    });
    assert.deepEqual(calls, [
      {
        url: "https://sign.orchid.test/mcp",
        authorization: "Bearer separate-mcp-token",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "Notice CLM integration diagnostic", version: "1.0" },
        },
      },
      { url: "https://sign.orchid.test/mcp", authorization: "Bearer separate-mcp-token", method: "notifications/initialized", params: undefined },
      { url: "https://sign.orchid.test/mcp", authorization: "Bearer separate-mcp-token", method: "tools/list", params: {} },
      {
        url: "https://sign.orchid.test/mcp",
        authorization: "Bearer separate-mcp-token",
        method: "tools/call",
        params: { name: "load_template", arguments: { template_id: 91 } },
      },
    ]);
    assert.equal(calls.filter((call) => call.method === "tools/call").length, 1);

    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "DocuSeal", version: "3.2.1" },
            capabilities: { tools: { listChanged: false } },
          },
        });
      }
      return body.method === "notifications/initialized"
        ? Response.json({ accepted: true })
        : Response.json({ jsonrpc: "2.0", id: 2, result: { tools: mcpTools() } });
    };
    await assert.rejects(probeDocuSealMcp(configuration, ["Our Signer", "Counterparty"]), /initialized notification did not match/);

    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "DocuSeal", version: "3.2.1" },
            capabilities: { tools: { listChanged: false } },
          },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      const tools = mcpTools();
      (tools.find((tool) => tool.name === "send_documents")?.annotations as Record<string, boolean>).destructiveHint = false;
      return Response.json({ jsonrpc: "2.0", id: 2, result: { tools } });
    };
    await assert.rejects(probeDocuSealMcp(configuration, ["Our Signer", "Counterparty"]), /safety annotations/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("self-hosted MCP rejects tool errors and REST-to-MCP template substitution", async () => {
  const originalFetch = globalThis.fetch;
  const configuration = cloudConfiguration({
    deployment: "self-hosted",
    apiBaseUrl: "https://sign.orchid.test/api",
    apiToken: "api-token",
    mcp: { token: "separate-mcp-token", protocolVersion: "2025-11-25", serverVersion: "3.2.1" },
  });
  try {
    for (const toolResult of [
      { content: [{ type: "text", text: "Template not found" }], isError: true },
      { content: [{ type: "text", text: JSON.stringify({ id: 92, name: "Other", roles: ["Our Signer", "Counterparty"], fields: [] }) }] },
      { content: [{ type: "text", text: JSON.stringify({ id: 91, name: "Notice", roles: ["Counterparty", "Our Signer"], fields: [] }) }] },
    ]) {
      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-11-25",
              serverInfo: { name: "DocuSeal", version: "3.2.1" },
              capabilities: { tools: { listChanged: false } },
            },
          });
        }
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: 2, result: { tools: mcpTools() } });
        return Response.json({ jsonrpc: "2.0", id: 3, result: toolResult });
      };
      await assert.rejects(
        probeDocuSealMcp(configuration, ["Our Signer", "Counterparty"]),
        /verification failed|template evidence did not match/,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("merged DocuSeal evidence requires exactly one artifact before any download", async () => {
  const originalFetch = globalThis.fetch;
  let artifactDownloads = 0;
  try {
    for (const documents of [
      [],
      [
        { name: "first", url: "https://files.docuseal.com/first.pdf" },
        { name: "second", url: "https://files.docuseal.com/second.pdf" },
      ],
    ]) {
      globalThis.fetch = async (input) => {
        if (String(input).includes("/documents?merge=true")) return Response.json({ id: 812, documents });
        artifactDownloads += 1;
        return new Response("%PDF-1.7\nartifact", { status: 200 });
      };
      await assert.rejects(
        getDocuSealDocuments({ deployment: "cloud-global", apiBaseUrl: "https://api.docuseal.com", apiToken: "token" }, 812),
        /did not match the required schema|exactly one artifact/,
      );
    }
    globalThis.fetch = async (input) => {
      if (String(input).includes("/documents?merge=true")) {
        return Response.json({ id: 812, documents: [{ name: "merged", url: "https://files.docuseal.com/merged.pdf" }] });
      }
      artifactDownloads += 1;
      return new Response("%PDF-1.7\nartifact", { status: 200 });
    };
    assert.deepEqual(
      await getDocuSealDocuments({ deployment: "cloud-global", apiBaseUrl: "https://api.docuseal.com", apiToken: "token" }, 812),
      { id: 812, documents: [{ name: "merged", url: "https://files.docuseal.com/merged.pdf" }] },
    );
    assert.equal(artifactDownloads, 0, "cardinality validation must not download any artifact");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed DocuSeal creation envelopes fail before durable mapping", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    id: 17,
    status: "pending",
    submitters: [{ email: "signer@client.test", status: "pending" }],
  });
  try {
    await assert.rejects(createDocuSealSubmission(
      cloudConfiguration(),
      {
        agreementId: 42,
        externalId: "notice:workspace:42:v3:packet-7",
        name: "Orchid — Agreement",
        parties: [{ role: "Counterparty", email: "signer@client.test" }],
        document: { name: "Orchid agreement v3", content: "Text", contentType: "text/plain", version: 3, sha256: "a".repeat(64) },
      },
    ), /exact signer mapping/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signing document renderer escapes document names and content", () => {
  const rendered = renderDocuSealSigningDocument({
    name: "<script>alert(1)</script>",
    content: "<img src=x onerror=alert(1)>",
    contentType: "text/markdown",
    version: 1,
    sha256: "b".repeat(64),
  });
  assert.equal(rendered.includes("<script>"), false);
  assert.equal(rendered.includes("<img"), false);
});

async function signatureFor(secret: string, timestamp: number, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const hex = Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, "0")).join("");
  return `${timestamp}.${hex}`;
}

test("DocuSeal webhook verification enforces signature syntax, constant payload binding, and freshness", async () => {
  const secret = "docuseal-webhook-unit-secret";
  const body = JSON.stringify({ event_type: "submission.completed", data: { id: 812 } });
  const timestamp = 1_785_600_000;
  const header = await signatureFor(secret, timestamp, body);

  const verified = await verifyDocuSealWebhook(body, header, secret, timestamp * 1_000);
  assert.equal(verified.valid, true);
  assert.equal(verified.timestamp, timestamp);

  assert.equal((await verifyDocuSealWebhook(body, header, secret, (timestamp + 300) * 1_000)).valid, true);
  assert.equal((await verifyDocuSealWebhook(body, header, secret, (timestamp - 300) * 1_000)).valid, true);
  assert.equal((await verifyDocuSealWebhook(body, header, secret, (timestamp + 301) * 1_000)).valid, false);
  assert.equal((await verifyDocuSealWebhook(body, header, secret, (timestamp - 301) * 1_000)).valid, false);
  assert.equal((await verifyDocuSealWebhook(`${body} `, header, secret, timestamp * 1_000)).valid, false);
  assert.equal((await verifyDocuSealWebhook(body, header, `${secret}-wrong`, timestamp * 1_000)).valid, false);

  for (const malformed of [null, "", "123", `.abcd`, `${timestamp}.not-hex`, `NaN.abcd`]) {
    assert.equal((await verifyDocuSealWebhook(body, malformed, secret, timestamp * 1_000)).valid, false);
  }
});

test("the verified raw-body digest is stable for durable replay detection", async () => {
  const secret = "docuseal-replay-unit-secret";
  const body = JSON.stringify({ event_type: "form.completed", timestamp: "2026-08-01T12:00:00Z", data: { id: 44 } });
  const firstTimestamp = 1_785_600_000;
  const secondTimestamp = firstTimestamp + 10;
  const first = await verifyDocuSealWebhook(
    body,
    await signatureFor(secret, firstTimestamp, body),
    secret,
    firstTimestamp * 1_000,
  );
  const providerRetry = await verifyDocuSealWebhook(
    body,
    await signatureFor(secret, secondTimestamp, body),
    secret,
    secondTimestamp * 1_000,
  );
  const changedPayload = await verifyDocuSealWebhook(
    `${body}\n`,
    await signatureFor(secret, secondTimestamp, `${body}\n`),
    secret,
    secondTimestamp * 1_000,
  );

  assert.equal(first.valid, true);
  assert.equal(providerRetry.valid, true);
  assert.equal(first.digest, providerRetry.digest);
  assert.notEqual(first.digest, changedPayload.digest);
});

test("signed artifact downloads reject non-HTTPS and lookalike provider hosts before network access", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("%PDF-1.7\nartifact", { status: 200, headers: { "content-type": "application/pdf" } });
  };

  try {
    const configuration = { deployment: "cloud-global" as const, apiBaseUrl: "https://api.docuseal.com", apiToken: "unit-token" };
    for (const target of [
      "http://api.docuseal.com/signed.pdf",
      "https://api.docuseal.com.attacker.test/signed.pdf",
      "https://docuseal.com.attacker.test/signed.pdf",
      "https://attacker.test/signed.pdf",
      "https://files.docuseal.eu/cross-region.pdf",
    ]) {
      await assert.rejects(
        downloadDocuSealArtifact(configuration, target),
        /outside the configured provider boundary/,
      );
    }
    await assert.rejects(
      downloadDocuSealArtifact(
        { deployment: "self-hosted", apiBaseUrl: "http://127.0.0.1:8787/api", apiToken: "local-token" },
        "http://127.0.0.1:8788/cross-origin.pdf",
      ),
      /outside the configured provider boundary/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("artifact downloads attach provider credentials only to the configured origin", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; token: string | null; redirect: RequestRedirect | undefined }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      token: new Headers(init?.headers).get("x-auth-token"),
      redirect: init?.redirect,
    });
    return new Response("%PDF-1.7\nartifact", {
      status: 200,
      headers: { "content-type": "application/pdf; charset=binary", "content-length": "18" },
    });
  };

  try {
    const official = { deployment: "cloud-global" as const, apiBaseUrl: "https://api.docuseal.com", apiToken: "official-token" };
    const sameOrigin = await downloadDocuSealArtifact(official, "https://api.docuseal.com/files/one.pdf");
    const siblingOrigin = await downloadDocuSealArtifact(official, "https://files.docuseal.com/files/two.pdf");
    const eu = { deployment: "cloud-eu" as const, apiBaseUrl: "https://api.docuseal.eu", apiToken: "eu-token" };
    await downloadDocuSealArtifact(eu, "https://files.docuseal.eu/files/eu.pdf");
    const custom = { deployment: "self-hosted" as const, apiBaseUrl: "https://sign.orchid.test/api", apiToken: "custom-token" };
    await downloadDocuSealArtifact(custom, "https://sign.orchid.test/files/three.pdf");
    const loopback = { deployment: "self-hosted" as const, apiBaseUrl: "http://127.0.0.1:8787/api", apiToken: "loopback-token" };
    await downloadDocuSealArtifact(loopback, "http://127.0.0.1:8787/files/local-evidence.pdf");

    assert.equal(sameOrigin.contentType, "application/pdf");
    assert.equal(siblingOrigin.bytes.byteLength > 0, true);
    assert.deepEqual(requests, [
      { url: "https://api.docuseal.com/files/one.pdf", token: "official-token", redirect: "manual" },
      { url: "https://files.docuseal.com/files/two.pdf", token: null, redirect: "manual" },
      { url: "https://files.docuseal.eu/files/eu.pdf", token: null, redirect: "manual" },
      { url: "https://sign.orchid.test/files/three.pdf", token: "custom-token", redirect: "manual" },
      { url: "http://127.0.0.1:8787/files/local-evidence.pdf", token: "loopback-token", redirect: "manual" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("artifact downloads reject declared oversize payloads before buffering", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  }), {
    status: 200,
    headers: { "content-length": String(DOCUSEAL_ARTIFACT_MAX_BYTES + 1) },
  });

  try {
    await assert.rejects(
      downloadDocuSealArtifact(
        { deployment: "cloud-global", apiBaseUrl: "https://api.docuseal.com", apiToken: "unit-token" },
        "https://api.docuseal.com/files/oversize.pdf",
      ),
      /exceeds the 25 MB limit/,
    );
    await Promise.resolve();
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DocuSeal JSON responses reject malformed and declared oversize lengths before buffering", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [declaredLength, expected] of [
      ["12x", /Content-Length was invalid/],
      [String(DOCUSEAL_JSON_RESPONSE_MAX_BYTES + 1), /exceeded the configured limit/],
    ] as const) {
      let cancelled = false;
      globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
        cancel() { cancelled = true; },
      }), { headers: { "content-length": declaredLength } });
      await assert.rejects(
        getDocuSealSubmission({ deployment: "cloud-global", apiBaseUrl: "https://api.docuseal.com", apiToken: "unit-token" }, 812),
        expected,
      );
      await Promise.resolve();
      assert.equal(cancelled, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chunked DocuSeal JSON and artifact responses are cancelled at their actual byte limits", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let jsonCancelled = false;
    const jsonChunk = new Uint8Array(Math.floor(DOCUSEAL_JSON_RESPONSE_MAX_BYTES / 2) + 1);
    let jsonChunks = 0;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        jsonChunks += 1;
        controller.enqueue(jsonChunk);
      },
      cancel() { jsonCancelled = true; },
    }));
    await assert.rejects(
      getDocuSealSubmission({ deployment: "cloud-global", apiBaseUrl: "https://api.docuseal.com", apiToken: "unit-token" }, 812),
      /exceeded the configured limit/,
    );
    assert.ok(jsonChunks >= 2);
    assert.equal(jsonCancelled, true);

    let artifactCancelled = false;
    const artifactChunk = new Uint8Array(1_024 * 1_024);
    let artifactChunks = 0;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        artifactChunks += 1;
        controller.enqueue(artifactChunk);
      },
      cancel() { artifactCancelled = true; },
    }), { headers: { "content-type": "application/pdf" } });
    await assert.rejects(
      downloadDocuSealArtifact(
        { deployment: "cloud-global", apiBaseUrl: "https://api.docuseal.com", apiToken: "unit-token" },
        "https://api.docuseal.com/files/chunked-oversize.pdf",
      ),
      /exceeds the 25 MB limit/,
    );
    assert.ok(artifactChunks >= (DOCUSEAL_ARTIFACT_MAX_BYTES / artifactChunk.byteLength) + 1);
    assert.equal(artifactCancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stalled DocuSeal response bodies time out, cancel, and keep provider details redacted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull() { return new Promise<void>(() => undefined); },
    cancel() { cancelled = true; },
  }));
  try {
    const lookup = getDocuSealSubmission({
      deployment: "cloud-global",
      apiBaseUrl: "https://api.docuseal.com",
      apiToken: "DO-NOT-LEAK-DOCUSEAL-TOKEN",
    }, 812);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(DOCUSEAL_BODY_TIMEOUT_MS);
    await assert.rejects(lookup, (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /response body timed out/);
      assert.equal(error.message.includes("DO-NOT-LEAK-DOCUSEAL-TOKEN"), false);
      return true;
    });
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stalled DocuSeal response headers are aborted at the header deadline with a redacted error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal);
    signal.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("DO-NOT-LEAK-UPSTREAM-DETAIL"));
    }, { once: true });
  });
  try {
    const lookup = getDocuSealSubmission({
      deployment: "cloud-global",
      apiBaseUrl: "https://api.docuseal.com",
      apiToken: "DO-NOT-LEAK-DOCUSEAL-TOKEN",
    }, 812);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(DOCUSEAL_HEADER_TIMEOUT_MS);
    await assert.rejects(lookup, (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "DocuSeal request timed out");
      assert.equal(error.message.includes("DO-NOT-LEAK"), false);
      return true;
    });
    assert.equal(aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
