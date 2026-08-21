import assert from "node:assert/strict";
import test from "node:test";
import { actionIds, agentApiV1ActionIds } from "../app/lib/action-registry";
import { AGENT_OPENAPI_DOCUMENT_VERSION, agentOpenApiDocument } from "../app/lib/agent-openapi";
import { AGENT_API_SCHEMA_VERSION } from "../app/lib/service-principal-auth";

test("agent OpenAPI describes every governed route and the exact action registry", () => {
  assert.equal(agentOpenApiDocument.openapi, "3.1.0");
  assert.deepEqual(agentOpenApiDocument.components.schemas.ActionId.enum, [...actionIds]);
  assert.deepEqual(agentOpenApiDocument.components.schemas.AgentApiV1ActionId.enum, [...agentApiV1ActionIds]);
  assert.equal(agentOpenApiDocument.info.version, AGENT_OPENAPI_DOCUMENT_VERSION);
  assert.equal(agentOpenApiDocument["x-notice-agent-api-schema-version"], AGENT_API_SCHEMA_VERSION);
  assert.match(agentOpenApiDocument.info.description, /OpenAPI document release/);
  assert.match(agentOpenApiDocument.info.description, /Response envelopes independently advertise schemaVersion/);
  for (const path of [
    "/api/v1/openapi",
    "/api/v1/actions",
    "/api/v1/agreements/{id}/available-actions",
    "/api/v1/plans",
    "/api/v1/plans/{id}",
    "/api/v1/plans/{id}/decisions",
    "/api/v1/plans/{id}/execute",
  ]) assert.ok(path in agentOpenApiDocument.paths, `missing ${path}`);
});

test("agent OpenAPI limits execution to bounded reads and human-reviewed required-lane routing", () => {
  const execution = agentOpenApiDocument.paths["/api/v1/plans/{id}/execute"].post;
  assert.match(execution.description, /agreement\.read and approval\.request only/i);
  assert.match(execution.description, /approval\.request restricted to ensure_required mode/i);
  assert.match(execution.description, /commits its lanes, audit\/outbox evidence, plan transition, and durable receipt atomically/i);
  assert.deepEqual(execution.security, [{ CloudflareAccessServicePrincipal: [] }]);
  const decision = agentOpenApiDocument.paths["/api/v1/plans/{id}/decisions"].post;
  assert.deepEqual(decision.security, [{ CloudflareAccessHuman: [] }]);
  assert.equal(agentOpenApiDocument.components.schemas.PlanDecision.properties.confirmed.const, true);
  const conditional = agentOpenApiDocument.components.schemas.PlanProposal.allOf[0];
  assert.equal(conditional.if.properties.actionId.const, "approval.request");
  assert.equal(conditional.then.properties.proposedDiff.maxProperties, 0);
  assert.deepEqual(agentOpenApiDocument.components.schemas.ApprovalRequestInput.required, ["mode", "due"]);
  assert.equal(agentOpenApiDocument.components.schemas.ApprovalRequestInput.properties.mode.const, "ensure_required");
  assert.equal(
    agentOpenApiDocument.components.schemas.PlanProposal.properties.actionId.$ref,
    "#/components/schemas/AgentApiV1ActionId",
  );
  const collectionAction = agentOpenApiDocument.paths["/api/v1/plans"].get.parameters
    .find((parameter) => parameter.name === "actionId");
  assert.equal(collectionAction?.schema.$ref, "#/components/schemas/AgentApiV1ActionId");
});

test("plan proposal binds one exact grant and has explicit idempotent replay semantics", () => {
  const collection = agentOpenApiDocument.paths["/api/v1/plans"];
  assert.deepEqual(collection.get.security, [{ CloudflareAccessServicePrincipal: [] }]);
  const listGrant = collection.get.parameters.find((parameter) => parameter.name === "grantId");
  assert.equal(listGrant?.required, true);
  assert.equal(listGrant?.in, "query");

  const proposal = collection.post;
  assert.deepEqual(proposal.security, [{ CloudflareAccessServicePrincipal: [] }]);
  assert.equal(agentOpenApiDocument.components.schemas.PlanProposal.required.includes("grantId"), true);
  const idempotencyKey = proposal.parameters.find((parameter) => parameter.name === "Idempotency-Key");
  assert.equal(idempotencyKey?.in, "header");
  assert.equal(idempotencyKey?.required, true);
  assert.equal(idempotencyKey?.schema.minLength, 8);
  assert.equal(idempotencyKey?.schema.maxLength, 200);
  assert.equal(idempotencyKey?.schema.pattern, "^[\\x21-\\x7e]+$");
  assert.match(proposal.description, /exact canonical retry/i);
  assert.match(proposal.description, /different grant, action, resource, or proposal/i);
  assert.ok("200" in proposal.responses, "exact proposal replay must be documented");
  assert.ok("201" in proposal.responses, "new proposal creation must be documented");
  assert.ok("409" in proposal.responses, "idempotency conflict must be documented");
  assert.equal(proposal.responses["200"].headers["Idempotency-Replayed"].schema.const, "true");
});

test("plan detail permits exact service authority or human agent-admin review", () => {
  const detail = agentOpenApiDocument.paths["/api/v1/plans/{id}"].get;
  assert.deepEqual(detail.security, [
    { CloudflareAccessServicePrincipal: [] },
    { CloudflareAccessHuman: [] },
  ]);
  assert.match(detail.description, /exact grant/i);
  assert.match(detail.description, /agent:admin/i);
  assert.match(agentOpenApiDocument.components.securitySchemes.CloudflareAccessHuman.description, /agent:admin/i);

  const collection = agentOpenApiDocument.paths["/api/v1/plans"].get;
  assert.deepEqual(collection.security, [{ CloudflareAccessServicePrincipal: [] }]);
});
