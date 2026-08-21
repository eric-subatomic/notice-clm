import { actionIds, agentApiV1ActionIds } from "./action-registry";
import { AGENT_API_SCHEMA_VERSION } from "./service-principal-auth";

/** OpenAPI document release; distinct from response `schemaVersion`. */
export const AGENT_OPENAPI_DOCUMENT_VERSION = "1.1.0";

const errorEnvelope = {
  type: "object",
  required: ["error", "requestId"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
      additionalProperties: true,
    },
    requestId: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
} as const;

const errorResponses = {
  "400": { description: "Invalid bounded request", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
  "401": { description: "Verified identity required", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
  "403": { description: "Exact principal, grant, sponsor, or resource authority denied", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
  "409": { description: "Plan, basis, digest, authority, or idempotency conflict", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
  "429": { description: "Rate limit exceeded", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
} as const;

const planIdParameter = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

const idempotencyKeyParameter = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  description: "Retain one key for retries of the same canonical request. Reuse with a different scoped request returns 409 idempotency_key_conflict.",
  schema: {
    type: "string",
    minLength: 8,
    maxLength: 200,
    pattern: "^[\\x21-\\x7e]+$",
  },
} as const;

export const agentOpenApiDocument = Object.freeze({
  openapi: "3.1.0",
  info: {
    title: "Notice Governed Agent API",
    version: AGENT_OPENAPI_DOCUMENT_VERSION,
    description: `OpenAPI document release ${AGENT_OPENAPI_DOCUMENT_VERSION}. Discover the full governed action registry, inspect each action's explicit v1 machine capability, and plan or execute only bounded agreement.read plus server-derived approval.request/ensure_required. Response envelopes independently advertise schemaVersion ${AGENT_API_SCHEMA_VERSION}.`,
  },
  "x-notice-agent-api-schema-version": AGENT_API_SCHEMA_VERSION,
  jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  paths: {
    "/api/v1/openapi": {
      get: {
        operationId: "getAgentOpenApi",
        summary: "Read this OpenAPI document",
        security: [],
        responses: { "200": { description: "OpenAPI 3.1 document" } },
      },
    },
    "/api/v1/actions": {
      get: {
        operationId: "listGovernedActions",
        summary: "List the full registry with explicit v1 machine capability and caller-specific authority",
        security: [{ CloudflareAccessAssertion: [] }],
        responses: { "200": { description: "Action catalog, digest, actor, authority coverage, and agentApiV1 planning/execution blockers" }, ...errorResponses },
      },
    },
    "/api/v1/agreements/{id}/available-actions": {
      get: {
        operationId: "getAgreementAvailableActions",
        summary: "Evaluate exact agreement evidence, preconditions, and action blockers",
        security: [{ CloudflareAccessAssertion: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: { "200": { description: "Exact target version, paper hashes, risk/approval evidence, and affordances" }, ...errorResponses },
      },
    },
    "/api/v1/plans": {
      get: {
        operationId: "listAgentPlans",
        summary: "List plans within one exact action, grant, principal, and agreement scope",
        security: [{ CloudflareAccessServicePrincipal: [] }],
        parameters: [
          { name: "actionId", in: "query", required: true, schema: { $ref: "#/components/schemas/AgentApiV1ActionId" } },
          { name: "grantId", in: "query", required: true, schema: { type: "string", format: "uuid" } },
          { name: "resourceType", in: "query", required: true, schema: { const: "agreement" } },
          { name: "resourceId", in: "query", required: true, schema: { type: "string", pattern: "^[1-9][0-9]{0,15}$" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 25 } },
          { name: "cursor", in: "query", schema: { type: "string", format: "uuid" } },
        ],
        responses: { "200": { description: "Cursor-bounded plan page" }, ...errorResponses },
      },
      post: {
        operationId: "proposeAgentPlan",
        summary: "Persist a canonical exact-basis action plan and provenance",
        description: "The body must select the exact grantId used for authorization. For approval.request, input is strictly {mode:'ensure_required',due:'YYYY-MM-DD'} and proposedDiff must be empty because Notice compiles the exact policy effect. Idempotency-Key is scoped to the verified workspace and service principal: an exact canonical retry returns the existing plan with Idempotency-Replayed: true; reuse for a different grant, action, resource, or proposal returns 409 idempotency_key_conflict.",
        security: [{ CloudflareAccessServicePrincipal: [] }],
        parameters: [idempotencyKeyParameter],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PlanProposal" } } } },
        responses: {
          "200": {
            description: "Exact idempotent replay of the existing plan",
            headers: {
              "Idempotency-Replayed": {
                description: "true for an exact replay",
                schema: { const: "true" },
              },
            },
          },
          "201": { description: "New durable plan with digest, status, blockers, basis, and provenance" },
          ...errorResponses,
        },
      },
    },
    "/api/v1/plans/{id}": {
      get: {
        operationId: "getAgentPlan",
        summary: "Read one plan, human decision, and execution receipt for review",
        description: "The exact creating service principal must still hold the plan's exact grant. An active human with agent:admin may also read the plan for oversight; human review does not confer service execution authority.",
        security: [
          { CloudflareAccessServicePrincipal: [] },
          { CloudflareAccessHuman: [] },
        ],
        parameters: [planIdParameter],
        responses: { "200": { description: "Exact-authority or human-admin review projection" }, ...errorResponses },
      },
    },
    "/api/v1/plans/{id}/decisions": {
      post: {
        operationId: "decideAgentPlan",
        summary: "Record an attributable human Admin decision for one exact plan digest",
        security: [{ CloudflareAccessHuman: [] }],
        parameters: [planIdParameter],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PlanDecision" } } } },
        responses: { "201": { description: "Immutable exact-digest decision" }, ...errorResponses },
      },
    },
    "/api/v1/plans/{id}/execute": {
      post: {
        operationId: "executeAgentPlan",
        summary: "Execute an approved bounded read or required-approval routing plan",
        description: "The v1 agent capability policy executes agreement.read and approval.request only, with approval.request restricted to ensure_required mode. Approval routing is compiled from current policy, requires exact human review, and commits its lanes, audit/outbox evidence, plan transition, and durable receipt atomically. Every other registry action is non-delegable and non-plannable; a legacy unsupported plan returns action_not_executable.",
        security: [{ CloudflareAccessServicePrincipal: [] }],
        parameters: [
          planIdParameter,
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200 } },
        ],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PlanExecution" } } } },
        responses: { "200": { description: "Execution result or exact idempotent replay" }, ...errorResponses },
      },
    },
  },
  components: {
    securitySchemes: {
      CloudflareAccessAssertion: {
        type: "apiKey",
        in: "header",
        name: "Cf-Access-Jwt-Assertion",
        description: "A cryptographically verified Cloudflare Access application assertion for either a human session or registered service-token identity, as required by the operation.",
      },
      CloudflareAccessServicePrincipal: {
        type: "apiKey",
        in: "header",
        name: "Cf-Access-Jwt-Assertion",
        description: "Cloudflare Access service-token JWT. Notice trusts only the signed common_name claim and an active registered principal plus one independently sufficient grant.",
      },
      CloudflareAccessHuman: {
        type: "apiKey",
        in: "header",
        name: "Cf-Access-Jwt-Assertion",
        description: "Cloudflare Access human JWT resolving to an active workspace member with agent:admin. This identity may review and decide plans but does not inherit service execution authority.",
      },
    },
    schemas: {
      ActionId: {
        type: "string",
        enum: [...actionIds],
        description: "Any stable registry action ID. Registry presence does not imply v1 agent planning or execution support.",
      },
      AgentApiV1ActionId: {
        type: "string",
        enum: [...agentApiV1ActionIds],
        description: "The explicit v1 agent grant, planning, and execution allowlist.",
      },
      Sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      ErrorEnvelope: errorEnvelope,
      PlanProposal: {
        type: "object",
        required: ["grantId", "actionId", "target", "input", "provenance"],
        properties: {
          grantId: { type: "string", format: "uuid" },
          actionId: { $ref: "#/components/schemas/AgentApiV1ActionId" },
          target: {
            type: "object",
            required: ["type", "id"],
            properties: {
              type: { const: "agreement" },
              id: { type: "string", pattern: "^[1-9][0-9]{0,15}$" },
              expectedVersion: { type: "integer", minimum: 1 },
              expectedBasisHash: { $ref: "#/components/schemas/Sha256" },
            },
            additionalProperties: false,
          },
          input: { type: "object", maxProperties: 100 },
          proposedDiff: { type: "object", maxProperties: 100, default: {} },
          actorConfirmed: { type: "boolean", default: false },
          expiresAt: { type: "string", format: "date-time" },
          provenance: {
            type: "object",
            required: ["purpose", "modelId", "toolVersion"],
            properties: {
              purpose: { type: "string", minLength: 3, maxLength: 500 },
              modelProvider: { type: "string", maxLength: 100 },
              modelId: { type: "string", minLength: 1, maxLength: 200 },
              toolVersion: { type: "string", minLength: 1, maxLength: 200 },
              promptSha256: { $ref: "#/components/schemas/Sha256" },
              contextSha256: { $ref: "#/components/schemas/Sha256" },
            },
            additionalProperties: false,
          },
        },
        allOf: [{
          if: {
            required: ["actionId"],
            properties: { actionId: { const: "approval.request" } },
          },
          then: {
            properties: {
              input: { $ref: "#/components/schemas/ApprovalRequestInput" },
              proposedDiff: { type: "object", maxProperties: 0, default: {} },
            },
          },
        }],
        additionalProperties: false,
      },
      ApprovalRequestInput: {
        type: "object",
        required: ["mode", "due"],
        properties: {
          mode: { const: "ensure_required" },
          due: { type: "string", format: "date" },
        },
        additionalProperties: false,
      },
      PlanDecision: {
        type: "object",
        required: ["expectedStatus", "planDigest", "decision", "reason", "confirmed"],
        properties: {
          expectedStatus: { const: "pending_approval" },
          planDigest: { $ref: "#/components/schemas/Sha256" },
          decision: { enum: ["approved", "rejected"] },
          reason: { type: "string", minLength: 8, maxLength: 4000 },
          confirmed: { const: true },
        },
        additionalProperties: false,
      },
      PlanExecution: {
        type: "object",
        required: ["planDigest"],
        properties: { planDigest: { $ref: "#/components/schemas/Sha256" } },
        additionalProperties: false,
      },
    },
  },
} as const);
