import { sha256Hex } from "./document-security";
import {
  cancelResponseBody,
  fetchWithHeaderDeadline,
  readBoundedResponseBody,
  ResponseBoundaryError,
} from "./response-boundary";
import { z } from "zod";

export const DOCUSEAL_JSON_RESPONSE_MAX_BYTES = 1 * 1_024 * 1_024;
export const DOCUSEAL_MCP_JSON_RESPONSE_MAX_BYTES = 256 * 1_024;
export const DOCUSEAL_ARTIFACT_MAX_BYTES = 25 * 1_024 * 1_024;
export const DOCUSEAL_HEADER_TIMEOUT_MS = 15_000;
export const DOCUSEAL_BODY_TIMEOUT_MS = 15_000;
export const DOCUSEAL_ARTIFACT_TIMEOUT_MS = 20_000;
export const DOCUSEAL_VALIDATED_RELEASE = "3.2.1" as const;
export const DOCUSEAL_API_CLIENT_CONTRACT_VERSION = "1.0.24" as const;
export const DOCUSEAL_MCP_PROTOCOL_VERSION = "2025-11-25" as const;
export const DOCUSEAL_MAX_EXPIRATION_HOURS = 720;

export const docuSealDeployments = ["cloud-global", "cloud-eu", "self-hosted"] as const;
export type DocuSealDeployment = (typeof docuSealDeployments)[number];

export type DocuSealMcpConfiguration = Readonly<{
  token: string;
  protocolVersion: typeof DOCUSEAL_MCP_PROTOCOL_VERSION;
  serverVersion: typeof DOCUSEAL_VALIDATED_RELEASE;
}>;

export type DocuSealConfiguration = Readonly<{
  deployment: DocuSealDeployment;
  apiBaseUrl: string;
  apiToken: string;
  templateId: number;
  webhookSecret: string;
  validatedRelease: typeof DOCUSEAL_VALIDATED_RELEASE;
  apiClientContractVersion: typeof DOCUSEAL_API_CLIENT_CONTRACT_VERSION;
  htmlSubmissionsEntitled: true;
  expirationHours: number;
  email2faRequired: boolean;
  mcp: DocuSealMcpConfiguration | null;
}>;

export class DocuSealApiError extends Error {
  constructor(readonly status: number) {
    super(`DocuSeal request failed with HTTP ${status}`);
    this.name = "DocuSealApiError";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Canonicalize the deployment-specific API boundary. DocuSeal Cloud exposes
 * its API at an origin root, while a standard self-hosted installation exposes
 * it below `/api`. Keeping that distinction explicit prevents URL resolution
 * from silently discarding the self-hosted prefix.
 */
export function normalizeDocuSealApiBaseUrl(
  candidate: string,
  deployment: DocuSealDeployment,
): string {
  let base: URL;
  try {
    base = new URL(candidate);
  } catch {
    throw new Error("DocuSeal API base URL is invalid");
  }
  const loopback = isLoopbackHostname(base.hostname);
  if (
    base.username
    || base.password
    || base.search
    || base.hash
    || (base.protocol !== "https:" && !(loopback && base.protocol === "http:"))
  ) {
    throw new Error("DocuSeal API base URL must be a credential-free HTTPS endpoint");
  }
  if (/%(?:2f|5c)/i.test(base.pathname)) {
    throw new Error("DocuSeal API base URL must not contain encoded path separators");
  }

  const normalizedPath = base.pathname.replace(/\/+$/, "") || "/";
  if (deployment === "cloud-global") {
    if (base.origin !== "https://api.docuseal.com" || normalizedPath !== "/") {
      throw new Error("DocuSeal global Cloud must use https://api.docuseal.com");
    }
    return "https://api.docuseal.com";
  }
  if (deployment === "cloud-eu") {
    if (base.origin !== "https://api.docuseal.eu" || normalizedPath !== "/") {
      throw new Error("DocuSeal EU Cloud must use https://api.docuseal.eu");
    }
    return "https://api.docuseal.eu";
  }
  if (deployment !== "self-hosted") throw new Error("DocuSeal deployment type is unsupported");
  if (["api.docuseal.com", "api.docuseal.eu"].includes(base.hostname)) {
    throw new Error("Official DocuSeal Cloud origins must use their matching Cloud deployment type");
  }
  if (!normalizedPath.endsWith("/api")) {
    throw new Error("Self-hosted DocuSeal API base URL must end with /api");
  }
  return `${base.origin}${normalizedPath}`;
}

export function resolveDocuSealApiUrl(
  configuration: Pick<DocuSealConfiguration, "apiBaseUrl" | "deployment">,
  relativePath: string,
): URL {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")) {
    throw new Error("DocuSeal API path must be relative to its configured base");
  }
  const normalizedBase = normalizeDocuSealApiBaseUrl(configuration.apiBaseUrl, configuration.deployment);
  const base = new URL(`${normalizedBase}/`);
  const url = new URL(relativePath, base);
  const basePrefix = base.pathname.replace(/\/+$/, "");
  if (
    url.origin !== base.origin
    || (basePrefix && url.pathname !== basePrefix && !url.pathname.startsWith(`${basePrefix}/`))
  ) {
    throw new Error("DocuSeal API path escaped the configured provider boundary");
  }
  return url;
}

export type SignatureParty = {
  role: string;
  email: string;
  name?: string;
};

export type DocuSealSubmitter = {
  id?: number;
  submission_id?: number;
  email?: string;
  status?: string;
  external_id?: string | null;
};

export type DocuSealSubmission = {
  id: number;
  status: "pending" | "completed" | "declined" | "expired" | string;
  slug?: string;
  audit_log_url?: string | null;
  combined_document_url?: string | null;
  completed_at?: string | null;
  archived_at?: string | null;
  submitters?: DocuSealSubmitter[];
  documents?: Array<{ name: string; url: string }>;
};

export function signerRolesMatchTemplate(configuredRoles: readonly string[], submittedRoles: readonly string[]): boolean {
  return configuredRoles.length === submittedRoles.length &&
    new Set(submittedRoles).size === submittedRoles.length &&
    configuredRoles.every((role, index) => submittedRoles[index] === role);
}

const positiveSafeInteger = z.number().int().positive().refine(Number.isSafeInteger);
const docuSealSubmitterSchema = z.object({
  id: positiveSafeInteger.optional(),
  submission_id: positiveSafeInteger.optional(),
  email: z.string().max(320).optional(),
  status: z.string().min(1).max(100).optional(),
  external_id: z.string().max(1_000).nullable().optional(),
});
const docuSealDocumentSchema = z.object({
  name: z.string().min(1).max(500),
  url: z.url().max(4_096),
});
const docuSealSubmissionSchema = z.object({
  id: positiveSafeInteger,
  status: z.string().min(1).max(100),
  slug: z.string().max(1_000).optional(),
  audit_log_url: z.string().max(4_096).nullable().optional(),
  combined_document_url: z.string().max(4_096).nullable().optional(),
  completed_at: z.string().max(100).nullable().optional(),
  archived_at: z.string().max(100).nullable().optional(),
  submitters: z.array(docuSealSubmitterSchema).max(100).optional(),
  documents: z.array(docuSealDocumentSchema).max(100).optional(),
});
const docuSealSubmitterListSchema = z.object({
  data: z.array(docuSealSubmitterSchema).max(100),
});
const docuSealDocumentsSchema = z.object({
  id: positiveSafeInteger,
  // Notice creates one signing document and requests DocuSeal's merged
  // artifact. Cardinality is security-sensitive: accepting a prefix of a
  // multi-document response would make the aggregate byte bound ineffective
  // and could retain partial evidence before a later download failed.
  documents: z.array(docuSealDocumentSchema).length(1),
});
const docuSealTemplateSchema = z.object({
  id: positiveSafeInteger,
  archived_at: z.string().max(100).nullable(),
  shared_link: z.boolean(),
  submitters: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    uuid: z.string().trim().min(1).max(100),
  })).min(1).max(10),
  fields: z.array(z.object({
    submitter_uuid: z.string().trim().min(1).max(100),
    type: z.string().trim().min(1).max(100),
    required: z.boolean(),
    areas: z.array(z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      w: z.number().finite().positive(),
      h: z.number().finite().positive(),
      attachment_uuid: z.string().trim().min(1).max(100),
      page: z.number().int().nonnegative(),
    })).max(100),
  })).min(1).max(1_000),
});

const docuSealMcpInitializeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.literal(1),
  result: z.object({
    protocolVersion: z.literal(DOCUSEAL_MCP_PROTOCOL_VERSION),
    serverInfo: z.object({
      name: z.literal("DocuSeal"),
      version: z.literal(DOCUSEAL_VALIDATED_RELEASE),
    }).strict(),
    capabilities: z.object({
      tools: z.object({ listChanged: z.literal(false) }).strict(),
    }).strict(),
  }).strict(),
}).strict();

const mcpToolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean(),
  destructiveHint: z.boolean(),
  idempotentHint: z.boolean(),
  openWorldHint: z.boolean(),
}).strict();
const docuSealMcpToolsSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.literal(2),
  result: z.object({
    tools: z.array(z.object({
      name: z.string().min(1).max(100),
      title: z.string().min(1).max(200),
      description: z.string().min(1).max(2_000),
      inputSchema: z.object({
        type: z.literal("object"),
        properties: z.record(z.string(), z.unknown()),
        required: z.array(z.string().min(1).max(100)).max(100),
      }).strict(),
      annotations: mcpToolAnnotationsSchema,
    }).strict()).length(5),
  }).strict(),
}).strict();

const docuSealMcpToolResultSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.literal(3),
  result: z.object({
    content: z.array(z.object({
      type: z.literal("text"),
      text: z.string().min(2).max(DOCUSEAL_MCP_JSON_RESPONSE_MAX_BYTES),
    }).strict()).length(1),
    isError: z.boolean().optional(),
  }).strict(),
}).strict();

const docuSealMcpLoadedTemplateSchema = z.object({
  id: positiveSafeInteger,
  name: z.string().trim().min(1).max(500),
  roles: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
  fields: z.array(z.object({
    name: z.string().trim().min(1).max(500),
    type: z.string().trim().min(1).max(100),
    role: z.string().trim().min(1).max(100).nullable(),
  }).strict()).max(1_000),
}).strict();

const expectedMcpToolAnnotations = Object.freeze({
  search_templates: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  load_template: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  create_template: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
  send_documents: Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }),
  search_documents: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
});

export type DocuSealTemplateProfile = Readonly<{
  id: number;
  roles: readonly string[];
  requiredSigningFieldCount: number;
}>;

async function parseDocuSealJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  operation: string,
): Promise<T> {
  let payload: unknown;
  try {
    const bytes = await readBoundedResponseBody(response, {
      maximumBytes: DOCUSEAL_JSON_RESPONSE_MAX_BYTES,
      timeoutMs: DOCUSEAL_BODY_TIMEOUT_MS,
      invalidLengthMessage: `DocuSeal ${operation} response Content-Length was invalid`,
      tooLargeMessage: `DocuSeal ${operation} response exceeded the configured limit`,
      timeoutMessage: `DocuSeal ${operation} response body timed out`,
      readFailureMessage: `DocuSeal ${operation} response could not be read`,
    });
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ResponseBoundaryError) throw error;
    throw new Error(`DocuSeal ${operation} response was not valid JSON`);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error(`DocuSeal ${operation} response did not match the required schema`);
  return parsed.data;
}

export function docuSealProviderEventId(
  eventType: string,
  submissionId: string,
  timestamp: string,
  data: Record<string, unknown>,
): string | null {
  if (!eventType.startsWith("form.")) return `${eventType}:${submissionId}:${timestamp}`;
  const rawSubmitterId = data.id;
  const submitterId = typeof rawSubmitterId === "number" && Number.isSafeInteger(rawSubmitterId) && rawSubmitterId > 0
    ? String(rawSubmitterId)
    : typeof rawSubmitterId === "string" && /^\d{1,20}$/.test(rawSubmitterId)
      ? rawSubmitterId
      : null;
  return submitterId ? `${eventType}:${submissionId}:submitter:${submitterId}:${timestamp}` : null;
}

export async function createDocuSealSubmission(
  configuration: DocuSealConfiguration,
  input: {
    agreementId: number;
    externalId: string;
    name: string;
    parties: SignatureParty[];
    document: {
      name: string;
      content: string;
      contentType: "text/plain" | "text/markdown";
      version: number;
      sha256: string;
    };
    completedRedirectUrl?: string;
  },
): Promise<DocuSealSubmission> {
  if (!configuration.htmlSubmissionsEntitled) {
    throw new Error("DocuSeal HTML submission entitlement has not been attested");
  }
  if (
    !Number.isSafeInteger(configuration.expirationHours)
    || configuration.expirationHours < 1
    || configuration.expirationHours > DOCUSEAL_MAX_EXPIRATION_HOURS
  ) {
    throw new Error(`DocuSeal expiration must be between 1 and ${DOCUSEAL_MAX_EXPIRATION_HOURS} hours`);
  }
  const expireAt = new Date(Date.now() + (configuration.expirationHours * 60 * 60 * 1_000)).toISOString();
  const response = await docuSealFetch(configuration, "submissions/html", {
    method: "POST",
    body: JSON.stringify({
      // The configured template supplies the customer-approved signature
      // fields/page. The one-off HTML document is the exact immutable working
      // version being approved and signed, not a generic template substitute.
      template_ids: [configuration.templateId],
      send_email: true,
      send_sms: false,
      order: "preserved",
      merge_documents: true,
      expire_at: expireAt,
      completed_redirect_url: input.completedRedirectUrl,
      documents: [{
        name: input.document.name,
        html: renderDocuSealSigningDocument(input.document),
      }],
      submitters: input.parties.map((party, index) => ({
        role: party.role,
        email: party.email,
        name: party.name,
        send_email: true,
        require_email_2fa: configuration.email2faRequired,
        // This stable packet-owned key is the recovery handle if DocuSeal
        // accepts the submission but the response cannot be persisted in D1.
        external_id: `${input.externalId}:signer:${index + 1}`,
        metadata: {
          notice_agreement_id: String(input.agreementId),
          notice_document_version: String(input.document.version),
          notice_document_sha256: input.document.sha256,
        },
      })),
      name: input.name,
    }),
  });
  const submission = await parseDocuSealJson(response, docuSealSubmissionSchema, "submission creation");
  const submitters = submission.submitters ?? [];
  const submitterIds = new Set(submitters.map((submitter) => submitter.id));
  const hasExactSignerMapping = submitters.length === input.parties.length &&
    submitterIds.size === submitters.length &&
    submitters.every((submitter) => typeof submitter.id === "number") &&
    input.parties.every((party, index) => {
      const expectedExternalId = `${input.externalId}:signer:${index + 1}`;
      return submitters.some((submitter) =>
        submitter.external_id === expectedExternalId ||
        submitter.email?.trim().toLowerCase() === party.email.trim().toLowerCase()
      );
    });
  if (!hasExactSignerMapping) throw new Error("DocuSeal submission creation response did not contain an exact signer mapping");
  return submission;
}

export async function findDocuSealSubmissionByPacketExternalId(
  configuration: Pick<DocuSealConfiguration, "apiBaseUrl" | "apiToken" | "deployment">,
  packetExternalId: string,
): Promise<DocuSealSubmission | null> {
  const signerExternalId = `${packetExternalId}:signer:1`;
  const response = await docuSealFetch(
    configuration,
    `submitters?external_id=${encodeURIComponent(signerExternalId)}&limit=2`,
    { method: "GET" },
  );
  const payload = await parseDocuSealJson(response, docuSealSubmitterListSchema, "submitter lookup");
  if (payload.data.length === 0) return null;
  if (payload.data.some((submitter) => submitter.external_id !== signerExternalId || submitter.submission_id === undefined)) {
    throw new Error("DocuSeal recovery lookup returned an ambiguous signer mapping");
  }
  const matches = payload.data;
  const submissionIds = new Set(matches.map((submitter) => submitter.submission_id));
  if (submissionIds.size !== 1) throw new Error("DocuSeal recovery key matched multiple submissions");
  const submissionId = matches[0].submission_id;
  if (typeof submissionId !== "number") return null;
  return getDocuSealSubmission(configuration, submissionId);
}

export async function getDocuSealTemplateRoles(
  configuration: Pick<DocuSealConfiguration, "apiBaseUrl" | "apiToken" | "templateId" | "deployment">,
): Promise<string[]> {
  return [...(await getDocuSealTemplateProfile(configuration)).roles];
}

export async function getDocuSealTemplateProfile(
  configuration: Pick<DocuSealConfiguration, "apiBaseUrl" | "apiToken" | "templateId" | "deployment">,
): Promise<DocuSealTemplateProfile> {
  const response = await docuSealFetch(configuration, `templates/${configuration.templateId}`, { method: "GET" });
  const template = await parseDocuSealJson(response, docuSealTemplateSchema, "template lookup");
  if (template.id !== configuration.templateId) throw new Error("DocuSeal template response did not match the configured template");
  if (template.archived_at !== null) throw new Error("DocuSeal template is archived");
  if (template.shared_link) throw new Error("DocuSeal template has a public shared link");

  const roles = template.submitters.map((submitter) => submitter.name);
  const roleUuids = template.submitters.map((submitter) => submitter.uuid);
  if (new Set(roles).size !== roles.length) throw new Error("DocuSeal template contains duplicate signer roles");
  if (new Set(roleUuids).size !== roleUuids.length) throw new Error("DocuSeal template contains duplicate signer role identifiers");
  const knownRoleUuids = new Set(roleUuids);
  if (template.fields.some((field) => !knownRoleUuids.has(field.submitter_uuid))) {
    throw new Error("DocuSeal template contains a field assigned to an unknown signer role");
  }
  const signingFieldTypes = new Set(["signature", "initials"]);
  const requiredSigningFields = template.fields.filter((field) =>
    field.required && field.areas.length > 0 && signingFieldTypes.has(field.type)
  );
  for (const submitter of template.submitters) {
    if (!requiredSigningFields.some((field) => field.submitter_uuid === submitter.uuid)) {
      throw new Error("Every DocuSeal signer role must have a required signature or initials field");
    }
  }
  return Object.freeze({
    id: template.id,
    roles: Object.freeze([...roles]),
    requiredSigningFieldCount: requiredSigningFields.length,
  });
}

async function parseDocuSealMcpJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  operation: string,
): Promise<T> {
  let payload: unknown;
  try {
    const bytes = await readBoundedResponseBody(response, {
      maximumBytes: DOCUSEAL_MCP_JSON_RESPONSE_MAX_BYTES,
      timeoutMs: DOCUSEAL_BODY_TIMEOUT_MS,
      invalidLengthMessage: `DocuSeal MCP ${operation} response Content-Length was invalid`,
      tooLargeMessage: `DocuSeal MCP ${operation} response exceeded the configured limit`,
      timeoutMessage: `DocuSeal MCP ${operation} response body timed out`,
      readFailureMessage: `DocuSeal MCP ${operation} response could not be read`,
    });
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ResponseBoundaryError) throw error;
    throw new Error(`DocuSeal MCP ${operation} response was not valid JSON`);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error(`DocuSeal MCP ${operation} response did not match the pinned protocol`);
  return parsed.data;
}

function docuSealMcpEndpoint(
  configuration: Pick<DocuSealConfiguration, "apiBaseUrl" | "deployment">,
): URL {
  if (configuration.deployment !== "self-hosted") {
    throw new Error("DocuSeal MCP diagnostics are supported only for self-hosted deployments");
  }
  const apiBase = new URL(normalizeDocuSealApiBaseUrl(configuration.apiBaseUrl, configuration.deployment));
  const endpoint = new URL("/mcp", apiBase.origin);
  if (endpoint.origin !== apiBase.origin || endpoint.pathname !== "/mcp") {
    throw new Error("DocuSeal MCP endpoint escaped the configured self-hosted origin");
  }
  return endpoint;
}

async function postDocuSealMcp(
  configuration: Pick<DocuSealConfiguration, "apiBaseUrl" | "deployment" | "mcp">,
  payload: Readonly<Record<string, unknown>>,
): Promise<Response> {
  if (!configuration.mcp) throw new Error("DocuSeal MCP is not configured");
  const response = await fetchWithHeaderDeadline(
    docuSealMcpEndpoint(configuration),
    {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${configuration.mcp.token}`,
        "content-type": "application/json",
        "mcp-protocol-version": configuration.mcp.protocolVersion,
      },
      body: JSON.stringify(payload),
    },
    {
      timeoutMs: DOCUSEAL_HEADER_TIMEOUT_MS,
      timeoutMessage: "DocuSeal MCP request timed out",
      failureMessage: "DocuSeal MCP request failed",
    },
  );
  if (!response.ok) {
    cancelResponseBody(response, "DocuSeal MCP diagnostic was rejected");
    throw new Error(`DocuSeal MCP diagnostic failed with HTTP ${response.status}`);
  }
  return response;
}

/**
 * Prove the pinned MCP handshake, published safety metadata, and one exact
 * read-only capability against the same configured template already inspected
 * through REST. Mutation and open-world MCP tools remain outside Notice's
 * execution boundary.
 */
export async function probeDocuSealMcp(
  configuration: Pick<DocuSealConfiguration, "apiBaseUrl" | "apiToken" | "deployment" | "mcp" | "templateId">,
  expectedRoles: readonly string[],
): Promise<Readonly<{
  serverVersion: typeof DOCUSEAL_VALIDATED_RELEASE;
  toolCount: number;
  verifiedReadTool: "load_template";
  roleCount: number;
}>> {
  const mcp = configuration.mcp;
  if (!mcp) throw new Error("DocuSeal MCP is not configured");
  if (
    mcp.protocolVersion !== DOCUSEAL_MCP_PROTOCOL_VERSION
    || mcp.serverVersion !== DOCUSEAL_VALIDATED_RELEASE
  ) {
    throw new Error("DocuSeal MCP configuration does not match the pinned protocol and server release");
  }
  if (!mcp.token || mcp.token === configuration.apiToken) {
    throw new Error("DocuSeal MCP requires a separate Bearer token");
  }

  const initialized = await parseDocuSealMcpJson(
    await postDocuSealMcp(configuration, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: DOCUSEAL_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "Notice CLM integration diagnostic", version: "1.0" },
      },
    }),
    docuSealMcpInitializeSchema,
    "initialize",
  );
  if (initialized.result.serverInfo.version !== mcp.serverVersion) {
    throw new Error("DocuSeal MCP server release did not match the configured attestation");
  }

  const initializedNotification = await postDocuSealMcp(configuration, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  if (initializedNotification.status !== 202) {
    cancelResponseBody(
      initializedNotification,
      "DocuSeal MCP initialized notification returned an unexpected response",
    );
    throw new Error("DocuSeal MCP initialized notification did not match the pinned protocol");
  }
  cancelResponseBody(
    initializedNotification,
    "DocuSeal MCP initialized notification response was not consumed",
  );

  const listed = await parseDocuSealMcpJson(
    await postDocuSealMcp(configuration, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
    docuSealMcpToolsSchema,
    "tools/list",
  );
  const seenNames = new Set<string>();
  for (const tool of listed.result.tools) {
    const expected = expectedMcpToolAnnotations[tool.name as keyof typeof expectedMcpToolAnnotations];
    if (!expected || seenNames.has(tool.name)) {
      throw new Error("DocuSeal MCP tool inventory did not match the pinned release");
    }
    seenNames.add(tool.name);
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (tool.annotations[key] !== expected[key]) {
        throw new Error("DocuSeal MCP tool safety annotations did not match the pinned release");
      }
    }
  }
  if (seenNames.size !== Object.keys(expectedMcpToolAnnotations).length) {
    throw new Error("DocuSeal MCP tool inventory did not match the pinned release");
  }

  const toolResult = await parseDocuSealMcpJson(
    await postDocuSealMcp(configuration, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "load_template",
        arguments: { template_id: configuration.templateId },
      },
    }),
    docuSealMcpToolResultSchema,
    "tools/call load_template",
  );
  if (toolResult.result.isError) {
    throw new Error("DocuSeal MCP read-only template verification failed");
  }
  let loadedPayload: unknown;
  try {
    loadedPayload = JSON.parse(toolResult.result.content[0].text);
  } catch {
    throw new Error("DocuSeal MCP load_template result was not valid JSON");
  }
  const loaded = docuSealMcpLoadedTemplateSchema.safeParse(loadedPayload);
  if (!loaded.success) {
    throw new Error("DocuSeal MCP load_template result did not match the pinned release");
  }
  if (
    loaded.data.id !== configuration.templateId
    || !signerRolesMatchTemplate(expectedRoles, loaded.data.roles)
  ) {
    throw new Error("DocuSeal MCP template evidence did not match the configured REST template");
  }

  return Object.freeze({
    serverVersion: DOCUSEAL_VALIDATED_RELEASE,
    toolCount: seenNames.size,
    verifiedReadTool: "load_template",
    roleCount: loaded.data.roles.length,
  });
}

export function renderDocuSealSigningDocument(document: {
  name: string;
  content: string;
  contentType: "text/plain" | "text/markdown";
  version: number;
  sha256: string;
}): string {
  const escapedName = escapeHtml(document.name);
  const escapedContent = escapeHtml(document.content);
  const escapedSha = escapeHtml(document.sha256);
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:12pt/1.5 Arial,sans-serif;color:#111}h1{font-size:18pt}.notice-integrity{font-size:8pt;color:#555;overflow-wrap:anywhere}pre{font:11pt/1.5 Arial,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>${escapedName}</h1><p class="notice-integrity">Notice immutable working version ${document.version} · SHA-256 ${escapedSha}</p><pre>${escapedContent}</pre></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function getDocuSealSubmission(
  configuration: Pick<DocuSealConfiguration, "apiBaseUrl" | "apiToken" | "deployment">,
  submissionId: number,
): Promise<DocuSealSubmission> {
  const response = await docuSealFetch(configuration, `submissions/${submissionId}`, { method: "GET" });
  const submission = await parseDocuSealJson(response, docuSealSubmissionSchema, "submission lookup");
  if (submission.id !== submissionId) throw new Error("DocuSeal submission response did not match the requested submission");
  return submission;
}

export async function getDocuSealDocuments(
  configuration: Pick<DocuSealConfiguration, "apiBaseUrl" | "apiToken" | "deployment">,
  submissionId: number,
): Promise<{ id: number; documents: Array<{ name: string; url: string }> }> {
  const response = await docuSealFetch(configuration, `submissions/${submissionId}/documents?merge=true`, { method: "GET" });
  const documents = await parseDocuSealJson(response, docuSealDocumentsSchema, "document lookup");
  if (documents.id !== submissionId) throw new Error("DocuSeal document response did not match the requested submission");
  if (documents.documents.length !== 1) throw new Error("DocuSeal merged document response must contain exactly one artifact");
  return documents;
}

export async function downloadDocuSealArtifact(
  configuration: Pick<DocuSealConfiguration, "apiBaseUrl" | "apiToken" | "deployment">,
  artifactUrl: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const base = new URL(normalizeDocuSealApiBaseUrl(configuration.apiBaseUrl, configuration.deployment));
  const target = new URL(artifactUrl);
  const officialZone = ["docuseal.com", "docuseal.eu"].find(
    (zone) => base.hostname === zone || base.hostname.endsWith(`.${zone}`),
  );
  const localLoopback = ["localhost", "127.0.0.1"].includes(base.hostname)
    && target.origin === base.origin
    && target.protocol === "http:";
  const allowed = (target.protocol === "https:" || localLoopback) && (
    target.origin === base.origin ||
    (officialZone && (target.hostname === officialZone || target.hostname.endsWith(`.${officialZone}`)))
  );
  if (!allowed) throw new Error("DocuSeal artifact URL is outside the configured provider boundary");

  const response = await fetchWithHeaderDeadline(
    target,
    {
      headers: target.origin === base.origin ? { "x-auth-token": configuration.apiToken } : undefined,
      redirect: "manual",
    },
    {
      timeoutMs: DOCUSEAL_ARTIFACT_TIMEOUT_MS,
      timeoutMessage: "DocuSeal artifact request timed out",
      failureMessage: "DocuSeal artifact request failed",
    },
  );
  if (!response.ok) {
    cancelResponseBody(response, "DocuSeal artifact request was rejected");
    throw new Error(`DocuSeal artifact download failed with HTTP ${response.status}`);
  }
  const bytes = await readBoundedResponseBody(response, {
    maximumBytes: DOCUSEAL_ARTIFACT_MAX_BYTES,
    timeoutMs: DOCUSEAL_ARTIFACT_TIMEOUT_MS,
    invalidLengthMessage: "DocuSeal artifact Content-Length is invalid",
    tooLargeMessage: "DocuSeal artifact exceeds the 25 MB limit",
    timeoutMessage: "DocuSeal artifact response body timed out",
    readFailureMessage: "DocuSeal artifact response could not be read",
  });
  if (bytes.byteLength === 0) throw new Error("DocuSeal artifact size is invalid");
  return { bytes, contentType: response.headers.get("content-type")?.split(";")[0] ?? "application/pdf" };
}

export async function verifyDocuSealWebhook(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  now = Date.now(),
): Promise<{ valid: boolean; timestamp: number | null; digest: string }> {
  const digest = await sha256Hex(rawBody);
  if (!signatureHeader || !secret) return { valid: false, timestamp: null, digest };
  const separator = signatureHeader.indexOf(".");
  if (separator <= 0) return { valid: false, timestamp: null, digest };

  const timestampText = signatureHeader.slice(0, separator);
  const supplied = signatureHeader.slice(separator + 1).toLowerCase();
  const timestamp = Number(timestampText);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1_000 - timestamp) > 300) {
    return { valid: false, timestamp: Number.isFinite(timestamp) ? timestamp : null, digest };
  }

  const expected = await hmacHex(secret, `${timestampText}.${rawBody}`);
  return { valid: constantTimeHexEqual(expected, supplied), timestamp, digest };
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length || !/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function docuSealFetch(
  configuration: Pick<DocuSealConfiguration, "apiBaseUrl" | "apiToken" | "deployment">,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const url = resolveDocuSealApiUrl(configuration, path);

  const response = await fetchWithHeaderDeadline(
    url,
    {
      ...init,
      redirect: "manual",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-auth-token": configuration.apiToken,
        ...init.headers,
      },
    },
    {
      timeoutMs: DOCUSEAL_HEADER_TIMEOUT_MS,
      timeoutMessage: "DocuSeal request timed out",
      failureMessage: "DocuSeal request failed",
    },
  );
  if (!response.ok) {
    cancelResponseBody(response, "DocuSeal request was rejected");
    throw new DocuSealApiError(response.status);
  }
  return response;
}
