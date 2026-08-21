import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  AGENT_API_V1_UNSUPPORTED_ACTION_BLOCKER_CODE,
  actionIds,
  agentApiV1ActionIds,
  getActionDefinition,
} from "../app/lib/action-registry";
import { canonicalJsonDigest } from "../app/lib/agent-governance";
import { permissionsForRole } from "../app/lib/authorization";
import {
  ACTION_CATALOG_VERSION,
  AGENT_API_SCHEMA_VERSION,
  actionCatalogPolicyMetadata,
  buildActionAffordance,
  buildActionCatalog,
  evaluatePersistedAgentAuthority,
  type ServicePrincipalContext,
} from "../app/lib/service-principal-auth";

const serviceContext: ServicePrincipalContext = {
  kind: "service",
  workspace: { id: "workspace-a", slug: "workspace-a", name: "Workspace A" },
  principal: {
    id: "principal-1",
    workspaceId: "workspace-a",
    issuer: "https://notice-service-fixture.cloudflareaccess.com",
    subject: "service-client.access",
    status: "active",
    name: "Contract operations agent",
    version: 3,
  },
  grants: [{
    grant: {
      id: "grant-1",
      workspaceId: "workspace-a",
      principalId: "principal-1",
      delegatorUserId: "sponsor-1",
      status: "active",
      actionIds: ["agreement.read", "approval.request"],
      resourceConstraints: { resources: [{ type: "agreement", ids: ["42"] }] },
      policyVersion: "agent-policy-1",
      startsAt: "2026-08-19T15:00:00.000Z",
      expiresAt: "2026-08-20T15:00:00.000Z",
      revokedAt: null,
    },
    sponsor: { id: "sponsor-1", status: "active" },
    membership: {
      workspaceId: "workspace-a",
      userId: "sponsor-1",
      role: "legal",
      status: "active",
    },
    resources: [{ type: "agreement", id: "42" }],
  }],
  authenticatedAt: "2026-08-19T16:00:00.000Z",
  identitySource: "cloudflare-access-service-token",
};

test("the v1 catalog preserves stable IDs and complete policy metadata", async () => {
  const actions = buildActionCatalog({ kind: "human", permissions: permissionsForRole("admin") });
  assert.deepEqual(actions.map((action) => action.id), actionIds);
  for (const action of actions) {
    assert.ok(action.label.length > 0);
    assert.ok(action.targetTypes.length > 0);
    assert.ok(action.permissions.length > 0);
    assert.ok(action.preconditions !== undefined);
    assert.equal(typeof action.agentApiV1.plannable, "boolean");
    assert.equal(typeof action.agentApiV1.executable, "boolean");
    assert.equal(action.authority.eligible, true);
  }
  const firstDigest = await canonicalJsonDigest({
    schemaVersion: AGENT_API_SCHEMA_VERSION,
    catalogVersion: ACTION_CATALOG_VERSION,
    actions: actionCatalogPolicyMetadata(actions),
  });
  const serviceActions = buildActionCatalog({ kind: "service", context: serviceContext });
  const secondDigest = await canonicalJsonDigest({
    actions: actionCatalogPolicyMetadata(serviceActions),
    catalogVersion: ACTION_CATALOG_VERSION,
    schemaVersion: AGENT_API_SCHEMA_VERSION,
  });
  assert.equal(firstDigest, secondDigest);
  assert.match(firstDigest, /^[a-f0-9]{64}$/);
});

test("service catalog coverage reflects action and resource grants without human-only escalation", () => {
  const actions = buildActionCatalog({ kind: "service", context: serviceContext });
  assert.equal(actions.find((action) => action.id === "agreement.read")?.authority.eligible, true);
  assert.equal(actions.find((action) => action.id === "approval.request")?.authority.eligible, true);
  assert.equal(actions.find((action) => action.id === "signature.create")?.authority.eligible, false);
  assert.equal(actions.find((action) => action.id === "risk.waive")?.authority.eligible, false);
  assert.equal(actions.find((action) => action.id === "agreement.read")?.agentApiV1.executable, true);
  assert.equal(actions.find((action) => action.id === "approval.request")?.agentApiV1.inputMode, "ensure_required");
  assert.equal(actions.find((action) => action.id === "signature.create")?.agentApiV1.executable, false);
  assert.equal(
    actions.find((action) => action.id === "signature.create")?.agentApiV1.blocker?.code,
    AGENT_API_V1_UNSUPPORTED_ACTION_BLOCKER_CODE,
  );
  assert.deepEqual(
    actions.find((action) => action.id === "agreement.read")?.authority.resourceConstraints,
    [{ resources: [{ type: "agreement", ids: ["42"] }] }],
  );
});

test("max-shape service catalogs evaluate each grant and compatible action at most once", () => {
  const grantCount = 50;
  const agreementIds = Array.from({ length: 100 }, (_, index) => `agreement-${index + 1}`);
  const documentIds = Array.from({ length: 100 }, (_, index) => `document-${index + 1}`);
  const resourceConstraints = {
    resources: [
      { type: "agreement" as const, ids: agreementIds },
      { type: "document" as const, ids: documentIds },
    ],
  };
  const resources = resourceConstraints.resources.flatMap((resource) =>
    resource.ids.map((id) => ({ type: resource.type, id })));
  let sponsorStatusReads = 0;
  const context: ServicePrincipalContext = {
    ...serviceContext,
    grants: Array.from({ length: grantCount }, (_, index) => ({
      grant: {
        ...serviceContext.grants[0].grant,
        id: `grant-${index + 1}`,
        delegatorUserId: `sponsor-${index + 1}`,
        actionIds: ["agreement.read"],
        resourceConstraints,
      },
      sponsor: {
        id: `sponsor-${index + 1}`,
        get status() {
          sponsorStatusReads += 1;
          return "active";
        },
      },
      membership: {
        workspaceId: "workspace-a",
        userId: `sponsor-${index + 1}`,
        role: "admin",
        status: "active",
      },
      resources,
    })),
  };
  const representativeActionCount = agentApiV1ActionIds.length;

  const startedAt = performance.now();
  const actions = buildActionCatalog({ kind: "service", context });
  const elapsedMs = performance.now() - startedAt;

  // One authority evaluation reads sponsor status twice; retrying per resource
  // would make this count grow with the 200-resource allowlist.
  assert.equal(sponsorStatusReads, grantCount * representativeActionCount * 2);
  assert.equal(actions.find((action) => action.id === "agreement.read")?.authority.grantIds.length, grantCount);
  assert.equal(actions.find((action) => action.id === "risk.assess")?.authority.eligible, false);
  assert.ok(elapsedMs < 2_000, `max-shape catalog took ${elapsedMs.toFixed(2)} ms`);
});

test("agreement affordances return exact version, paper basis, and document hash evidence", () => {
  const basisHash = "a".repeat(64);
  const documentSha256 = "b".repeat(64);
  const definition = getActionDefinition("signature.create");
  const affordance = buildActionAffordance({
    definition,
    actorKind: "agent",
    permissions: ["agreement:update", "document:read"],
    target: {
      type: "agreement",
      id: "42",
      version: 7,
      basisHash,
      documentVersion: 4,
      documentSha256,
      stage: "Signature",
      satisfiedPreconditions: [
        "working_document_present",
        "risk_cleared",
        "no_open_changes",
        "approvals_satisfied",
        "signature_not_in_flight",
      ],
    },
    authority: { authorized: true, grantIds: ["grant-1"] },
  });

  assert.deepEqual(affordance.requiredEvidence, {
    targetVersion: 7,
    basisHash,
    documentVersion: 4,
    documentSha256,
  });
  assert.equal(affordance.availableNow, false);
  assert.equal(affordance.authority.authorized, false);
  assert.equal(affordance.agentApiV1.plannable, false);
  assert.equal(affordance.requiresHuman, true);
  assert.equal(affordance.blockers.some((blocker) => blocker.code === AGENT_API_V1_UNSUPPORTED_ACTION_BLOCKER_CODE), true);
  assert.equal(affordance.blockers.some((blocker) => blocker.code === "ACTION_APPROVED_PLAN_REQUIRED"), true);
  assert.equal(affordance.blockers.some((blocker) => blocker.code === "ACTION_CONFIRMATION_REQUIRED"), true);
  assert.deepEqual(affordance.requiredPreconditions, definition.preconditions);
});

test("persisted legacy grants cannot authorize registry actions outside the v1 allowlist", () => {
  const baseGrant = serviceContext.grants[0];
  const unsupported = evaluatePersistedAgentAuthority({
    principal: serviceContext.principal,
    grant: {
      ...baseGrant.grant,
      actionIds: ["agreement.read", "risk.assess"],
    },
    sponsor: baseGrant.sponsor,
    membership: baseGrant.membership,
    workspaceId: serviceContext.workspace.id,
    actionId: "risk.assess",
    resource: { type: "agreement", id: "42" },
    now: serviceContext.authenticatedAt,
  });
  assert.equal(unsupported.authorized, false);
  assert.equal(
    unsupported.blockers.some((blocker) => blocker.code === AGENT_API_V1_UNSUPPORTED_ACTION_BLOCKER_CODE),
    true,
  );
});

test("the first v1 discovery endpoints are GET-only and contain no execution mutation", async () => {
  const [catalogRoute, availableActionsRoute] = await Promise.all([
    readFile(new URL("../app/api/v1/actions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v1/agreements/[id]/available-actions/route.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [catalogRoute, availableActionsRoute]) {
    assert.match(source, /export async function GET/);
    assert.doesNotMatch(source, /export async function (?:POST|PUT|PATCH|DELETE)/);
  }
  assert.match(availableActionsRoute, /eq\(agreements\.workspaceId, workspaceId\)/);
  assert.match(availableActionsRoute, /documentSha256/);
  assert.match(availableActionsRoute, /basisHash/);
});

test("agent grant creation maps the durable commit-time cap to a stable conflict", async () => {
  const route = await readFile(new URL("../app/api/admin/agent-grants/route.ts", import.meta.url), "utf8");
  assert.match(route, /input\.actionIds\.find\(\(actionId\) => !isAgentApiV1ActionId\(actionId\)\)/);
  assert.match(route, /AGENT_API_V1_UNSUPPORTED_ACTION_ERROR_CODE/);
  assert.match(route, /isGrantLimitConflict/);
  assert.match(route, /"active_grant_limit_reached"/);
  assert.match(route, /active unexpired or scheduled grants/);
});
