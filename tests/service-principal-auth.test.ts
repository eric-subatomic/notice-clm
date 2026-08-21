import assert from "node:assert/strict";
import test from "node:test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
} from "jose";
import {
  ServiceTokenVerificationError,
  evaluatePersistedAgentAuthority,
  normalizeV1ReadRateLimitPath,
  servicePrincipalActionRateLimits,
  servicePrincipalActorRateLimit,
  verifyCloudflareAccessServiceIdentity,
  type PersistedAgentGrant,
  type PersistedGrantSponsor,
  type PersistedServicePrincipal,
  type PersistedSponsorMembership,
} from "../app/lib/service-principal-auth";
import { checkBestEffortRateLimit } from "../app/lib/http";

const TEAM_DOMAIN = "https://notice-service-fixture.cloudflareaccess.com";
const AUDIENCE = "b".repeat(64);
const CURRENT_DATE = new Date("2026-08-19T16:00:00.000Z");
const CURRENT_SECONDS = Math.floor(CURRENT_DATE.getTime() / 1_000);
const ACCESS_CONFIG = { teamDomain: TEAM_DOMAIN, audience: AUDIENCE } as const;
const rsa = await generateKeyPair("RS256", { extractable: true });
const publicJwk: JWK = {
  ...await exportJWK(rsa.publicKey),
  kid: "service-rsa",
  alg: "RS256",
  use: "sig",
};
const resolver = createLocalJWKSet({ keys: [publicJwk] });

function serviceClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    iss: TEAM_DOMAIN,
    aud: [AUDIENCE],
    sub: "",
    common_name: "2e7ec6c74f6a4ea9a773dc4ac6f60495.access",
    type: "app",
    iat: CURRENT_SECONDS - 5,
    nbf: CURRENT_SECONDS - 5,
    exp: CURRENT_SECONDS + 300,
    ...overrides,
  };
}

async function signedServiceToken(payload: JWTPayload = serviceClaims()): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "service-rsa", typ: "JWT" })
    .sign(rsa.privateKey);
}

function serviceRequest(token?: string, headers: HeadersInit = {}): Request {
  const requestHeaders = new Headers(headers);
  if (token) requestHeaders.set("Cf-Access-Jwt-Assertion", token);
  return new Request("https://notice.example.test/api/v1/actions", { headers: requestHeaders });
}

function routeRequest(pathname: string, method = "GET"): Request {
  return new Request(`https://notice.example.test${pathname}`, { method });
}

const RATE_LIMIT_PLAN_ID = "123e4567-e89b-42d3-a456-426614174000";
const EQUIVALENT_RATE_LIMIT_PLAN_IDS = [
  RATE_LIMIT_PLAN_ID,
  RATE_LIMIT_PLAN_ID.toUpperCase(),
  `%31${RATE_LIMIT_PLAN_ID.slice(1)}`,
  RATE_LIMIT_PLAN_ID.replace("e", "%65"),
  RATE_LIMIT_PLAN_ID.replace("-", "%2d"),
  RATE_LIMIT_PLAN_ID.replace("-", "%2D"),
] as const;

function assertEquivalentRateLimitDescriptors(
  [canonicalPath, ...aliases]: readonly [string, ...string[]],
  method = "GET",
): void {
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const canonicalRequest = routeRequest(canonicalPath, method);
  const canonicalActor = servicePrincipalActorRateLimit(workspaceId, principalId, canonicalRequest);
  const canonicalAction = servicePrincipalActionRateLimits(
    workspaceId,
    principalId,
    canonicalRequest,
    "agreement.read",
    { type: "agreement", id: "42" },
  );

  for (const alias of aliases) {
    const request = routeRequest(alias, method);
    assert.deepEqual(servicePrincipalActorRateLimit(workspaceId, principalId, request), canonicalActor);
    assert.deepEqual(servicePrincipalActionRateLimits(
      workspaceId,
      principalId,
      request,
      "agreement.read",
      { type: "agreement", id: "42" },
    ), canonicalAction);
  }
}

test("signed service-token common_name is authoritative and an empty sub is accepted", async () => {
  const identity = await verifyCloudflareAccessServiceIdentity(
    serviceRequest(await signedServiceToken(), {
      "CF-Access-Client-Id": "attacker-selected.access",
      "CF-Access-Client-Secret": "must-never-be-consulted",
    }),
    ACCESS_CONFIG,
    { keyResolver: resolver, currentDate: CURRENT_DATE },
  );
  assert.deepEqual(identity, {
    issuer: TEAM_DOMAIN,
    commonName: "2e7ec6c74f6a4ea9a773dc4ac6f60495.access",
  });
});

test("raw Cloudflare client headers cannot authenticate without a signed JWT", async () => {
  await assert.rejects(
    verifyCloudflareAccessServiceIdentity(
      serviceRequest(undefined, {
        "CF-Access-Client-Id": "forged.access",
        "CF-Access-Client-Secret": "forged-secret",
      }),
      ACCESS_CONFIG,
      { keyResolver: resolver, currentDate: CURRENT_DATE },
    ),
    (error) => error instanceof ServiceTokenVerificationError && error.code === "TOKEN_MISSING",
  );
});

test("dynamic agreement discovery paths share one service-principal rate bucket", () => {
  const firstPath = normalizeV1ReadRateLimitPath("/api/v1/agreements/42/available-actions");
  const secondPath = normalizeV1ReadRateLimitPath("/api/v1/agreements/9001/available-actions/");
  assert.equal(firstPath, "/api/v1/agreements/:id/available-actions");
  assert.equal(secondPath, firstPath);
  assert.equal(normalizeV1ReadRateLimitPath("/api/v1/actions"), "/api/v1/actions");

  const prefix = crypto.randomUUID();
  const options = { limit: 2, windowMs: 60_000, capacity: 100, now: CURRENT_DATE.getTime() };
  const first = checkBestEffortRateLimit(`${prefix}:${firstPath}`, options);
  const second = checkBestEffortRateLimit(`${prefix}:${secondPath}`, options);
  const rotated = checkBestEffortRateLimit(
    `${prefix}:${normalizeV1ReadRateLimitPath("/api/v1/agreements/777/available-actions")}`,
    options,
  );
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(rotated.allowed, false);
});

test("dynamic plan paths share stable actor buckets while distinct routes remain separate", () => {
  const firstPlanId = "11111111-1111-4111-8111-111111111111";
  const secondPlanId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();

  const firstDetail = servicePrincipalActorRateLimit(
    workspaceId,
    principalId,
    routeRequest(`/api/v1/plans/${firstPlanId}`),
  );
  const secondDetail = servicePrincipalActorRateLimit(
    workspaceId,
    principalId,
    routeRequest(`/api/v1/plans/${secondPlanId}/`),
  );
  const firstExecute = servicePrincipalActorRateLimit(
    workspaceId,
    principalId,
    routeRequest(`/api/v1/plans/${firstPlanId}/execute`, "POST"),
  );
  const secondExecute = servicePrincipalActorRateLimit(
    workspaceId,
    principalId,
    routeRequest(`/api/v1/plans/${secondPlanId}/execute/`, "POST"),
  );
  const actions = servicePrincipalActorRateLimit(
    workspaceId,
    principalId,
    routeRequest("/api/v1/actions"),
  );

  assert.equal(normalizeV1ReadRateLimitPath(`/api/v1/plans/${firstPlanId}`), "/api/v1/plans/:id");
  assert.equal(normalizeV1ReadRateLimitPath(`/api/v1/plans/${secondPlanId}/execute`), "/api/v1/plans/:id/execute");
  assert.equal(firstDetail.key, secondDetail.key);
  assert.equal(firstExecute.key, secondExecute.key);
  assert.notEqual(firstDetail.key, firstExecute.key);
  assert.notEqual(firstDetail.key, actions.key);
  assert.equal(normalizeV1ReadRateLimitPath("/api/v1/plans"), "/api/v1/plans");
  assert.equal(normalizeV1ReadRateLimitPath("/api/v1/plans/not-a-uuid"), "/api/v1/plans/not-a-uuid");
});

test("static V1 slash aliases share actor, action aggregate, and resource buckets", () => {
  assertEquivalentRateLimitDescriptors([
    "/api/v1/actions",
    "/api/v1/actions/",
    "/api/v1/actions////",
    "/api//v1/actions",
    "/api/v1//actions",
    "/api//v1//actions///",
  ]);
  assertEquivalentRateLimitDescriptors([
    "/api/v1/plans",
    "/api/v1/plans/",
    "/api/v1/plans////",
    "/api//v1/plans",
    "/api/v1//plans",
    "/api//v1//plans///",
  ]);
  assertEquivalentRateLimitDescriptors([
    "/api/v1/plans",
    "/api/v1/plans/",
    "/api/v1/plans////",
    "/api//v1//plans///",
  ], "POST");
  assert.equal(normalizeV1ReadRateLimitPath("/api//v1///"), "/api/v1/");
});

test("dynamic V1 slash aliases share actor, action aggregate, and resource buckets", () => {
  assertEquivalentRateLimitDescriptors([
    `/api/v1/plans/${RATE_LIMIT_PLAN_ID}`,
    `/api/v1/plans/${RATE_LIMIT_PLAN_ID}/`,
    `/api/v1/plans/${RATE_LIMIT_PLAN_ID}////`,
    `/api//v1/plans/${RATE_LIMIT_PLAN_ID}`,
    `/api/v1//plans//${RATE_LIMIT_PLAN_ID}`,
    `/api//v1//plans//${RATE_LIMIT_PLAN_ID}///`,
  ]);
  assertEquivalentRateLimitDescriptors([
    `/api/v1/plans/${RATE_LIMIT_PLAN_ID}/execute`,
    `/api/v1/plans/${RATE_LIMIT_PLAN_ID}/execute/`,
    `/api/v1/plans/${RATE_LIMIT_PLAN_ID}/execute////`,
    `/api//v1/plans/${RATE_LIMIT_PLAN_ID}/execute`,
    `/api/v1//plans//${RATE_LIMIT_PLAN_ID}//execute`,
    `/api//v1//plans//${RATE_LIMIT_PLAN_ID}//execute///`,
  ], "POST");
  assertEquivalentRateLimitDescriptors([
    "/api/v1/agreements/42/available-actions",
    "/api/v1/agreements/42/available-actions///",
    "/api//v1//agreements//42//available-actions///",
  ]);
});

test("equivalent encoded plan detail paths share actor, action aggregate, and resource buckets", () => {
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const baselineRequest = routeRequest(`/api/v1/plans/${RATE_LIMIT_PLAN_ID}`);
  const baselineActor = servicePrincipalActorRateLimit(workspaceId, principalId, baselineRequest);
  const baselineAction = servicePrincipalActionRateLimits(
    workspaceId,
    principalId,
    baselineRequest,
    "agreement.read",
    { type: "agreement", id: "42" },
  );

  for (const planId of EQUIVALENT_RATE_LIMIT_PLAN_IDS) {
    const request = routeRequest(`/api/v1/plans/${planId}`);
    assert.deepEqual(servicePrincipalActorRateLimit(workspaceId, principalId, request), baselineActor);
    assert.deepEqual(
      servicePrincipalActionRateLimits(
        workspaceId,
        principalId,
        request,
        "agreement.read",
        { type: "agreement", id: "42" },
      ),
      baselineAction,
    );
  }
});

test("equivalent encoded plan execute paths share actor, action aggregate, and resource buckets", () => {
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const baselineRequest = routeRequest(`/api/v1/plans/${RATE_LIMIT_PLAN_ID}/execute`, "POST");
  const baselineActor = servicePrincipalActorRateLimit(workspaceId, principalId, baselineRequest);
  const baselineAction = servicePrincipalActionRateLimits(
    workspaceId,
    principalId,
    baselineRequest,
    "approval.request",
    { type: "agreement", id: "42" },
  );

  for (const planId of EQUIVALENT_RATE_LIMIT_PLAN_IDS) {
    const request = routeRequest(`/api/v1/plans/${planId}/execute`, "POST");
    assert.deepEqual(servicePrincipalActorRateLimit(workspaceId, principalId, request), baselineActor);
    assert.deepEqual(
      servicePrincipalActionRateLimits(
        workspaceId,
        principalId,
        request,
        "approval.request",
        { type: "agreement", id: "42" },
      ),
      baselineAction,
    );
  }
});

test("malformed URI encodings share one stable non-path limiter token", () => {
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const malformedDetails = [
    "/api/v1/plans/%",
    "/api/v1/plans/%GG",
    "/api/v1/plans/%C0%AF",
  ];
  const malformedExecutions = malformedDetails.map((path) => `${path}/execute`);
  const normalized = [...malformedDetails, ...malformedExecutions].map(normalizeV1ReadRateLimitPath);
  assert.deepEqual([...new Set(normalized)], ["<invalid-v1-rate-limit-path>"]);
  assert.equal(normalized.includes(malformedDetails[0]), false);

  const actorKeys = malformedDetails.map((path) =>
    servicePrincipalActorRateLimit(workspaceId, principalId, routeRequest(path)).key);
  assert.equal(new Set(actorKeys).size, 1);

  const actionKeys = malformedExecutions.map((path) => servicePrincipalActionRateLimits(
    workspaceId,
    principalId,
    routeRequest(path, "POST"),
    "agreement.read",
    { type: "agreement", id: "42" },
  ));
  assert.equal(new Set(actionKeys.map((limits) => limits.aggregate.key)).size, 1);
  assert.equal(new Set(actionKeys.map((limits) => limits.resource.key)).size, 1);
});

test("HEAD shares GET buckets and limits while query strings are excluded", () => {
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const path = `/api/v1/plans/${RATE_LIMIT_PLAN_ID}`;
  const getRequest = routeRequest(path);
  const headRequest = routeRequest(`${path}?projection=summary`, "HEAD");
  const queryRequest = routeRequest(`${path}?projection=full`);
  const getActor = servicePrincipalActorRateLimit(workspaceId, principalId, getRequest);
  assert.deepEqual(servicePrincipalActorRateLimit(workspaceId, principalId, headRequest), getActor);
  assert.deepEqual(servicePrincipalActorRateLimit(workspaceId, principalId, queryRequest), getActor);
  assert.equal(getActor.limit, 240);

  const getAction = servicePrincipalActionRateLimits(
    workspaceId,
    principalId,
    getRequest,
    "agreement.read",
    { type: "agreement", id: "42" },
  );
  assert.deepEqual(servicePrincipalActionRateLimits(
    workspaceId,
    principalId,
    headRequest,
    "agreement.read",
    { type: "agreement", id: "42" },
  ), getAction);
  assert.deepEqual(servicePrincipalActionRateLimits(
    workspaceId,
    principalId,
    queryRequest,
    "agreement.read",
    { type: "agreement", id: "42" },
  ), getAction);

  const executePath = `/api/v1/plans/${RATE_LIMIT_PLAN_ID}/execute`;
  assert.deepEqual(
    servicePrincipalActionRateLimits(
      workspaceId,
      principalId,
      routeRequest(executePath, "POST"),
      "agreement.read",
      { type: "agreement", id: "42" },
    ),
    servicePrincipalActionRateLimits(
      workspaceId,
      principalId,
      routeRequest(`${executePath}?retry=1`, "POST"),
      "agreement.read",
      { type: "agreement", id: "42" },
    ),
  );
});

test("reserved slashes and genuinely distinct routes or methods remain separate", () => {
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  assert.equal(normalizeV1ReadRateLimitPath("/api/v1/plans/%2f"), "/api/v1/plans/%2F");
  assert.equal(normalizeV1ReadRateLimitPath("/api//v1//plans//%2f///"), "/api/v1/plans/%2F");
  assert.notEqual(normalizeV1ReadRateLimitPath("/api/v1/plans/%2f"), "/api/v1/plans/:id");

  const detailGet = servicePrincipalActorRateLimit(
    workspaceId,
    principalId,
    routeRequest(`/api/v1/plans/${RATE_LIMIT_PLAN_ID}`),
  );
  const executeGet = servicePrincipalActorRateLimit(
    workspaceId,
    principalId,
    routeRequest(`/api/v1/plans/${RATE_LIMIT_PLAN_ID}/execute`),
  );
  const executePost = servicePrincipalActorRateLimit(
    workspaceId,
    principalId,
    routeRequest(`/api/v1/plans/${RATE_LIMIT_PLAN_ID}/execute`, "POST"),
  );
  const actionsGet = servicePrincipalActorRateLimit(
    workspaceId,
    principalId,
    routeRequest("/api/v1/actions"),
  );
  assert.notEqual(detailGet.key, executeGet.key);
  assert.notEqual(executeGet.key, executePost.key);
  assert.notEqual(detailGet.key, actionsGet.key);
  assert.equal(executeGet.limit, 240);
  assert.equal(executePost.limit, 60);
});

test("rotating plan UUIDs cannot reset the first-stage actor limit", () => {
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const options = { limit: 2, windowMs: 60_000, capacity: 100, now: CURRENT_DATE.getTime() };
  const paths = [
    "/api/v1/plans/11111111-1111-4111-8111-111111111111",
    "/api/v1/plans/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    "/api/v1/plans/33333333-3333-4333-8333-333333333333",
  ];
  const decisions = paths.map((pathname) => {
    const rateLimit = servicePrincipalActorRateLimit(workspaceId, principalId, routeRequest(pathname));
    return checkBestEffortRateLimit(rateLimit.key, options);
  });

  assert.deepEqual(decisions.map((decision) => decision.allowed), [true, true, false]);
});

test("execute uses mutation limits and separate actor and action-stage namespaces", () => {
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const planId = "11111111-1111-4111-8111-111111111111";
  const getRequest = routeRequest(`/api/v1/plans/${planId}/execute`);
  const postRequest = routeRequest(`/api/v1/plans/${planId}/execute`, "POST");
  const actorGet = servicePrincipalActorRateLimit(workspaceId, principalId, getRequest);
  const actorPost = servicePrincipalActorRateLimit(workspaceId, principalId, postRequest);
  const actionPost = servicePrincipalActionRateLimits(
    workspaceId,
    principalId,
    postRequest,
    "agreement.read",
    { type: "agreement", id: "42" },
  );

  assert.equal(actorGet.limit, 240);
  assert.equal(actorPost.limit, 60);
  assert.equal(actionPost.aggregate.limit, 60);
  assert.notEqual(actorGet.key, actorPost.key);
  assert.notEqual(actorPost.key, actionPost.aggregate.key);
  assert.match(actorPost.key, /^service-principal:actor:/);
  assert.match(actionPost.aggregate.key, /^service-principal:action-aggregate:/);
  assert.match(actionPost.resource.key, /^service-principal:action-resource:/);
});

test("action aggregate limits span wildcard and many resource IDs without merging legitimate routes", () => {
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const collectionRequest = routeRequest("/api/v1/plans", "POST");
  const options = { limit: 2, windowMs: 60_000, capacity: 100, now: CURRENT_DATE.getTime() };
  const wildcard = servicePrincipalActionRateLimits(
    workspaceId,
    principalId,
    collectionRequest,
    "agreement.read",
    { type: "agreement", id: "*" },
  );
  const firstResource = servicePrincipalActionRateLimits(
    workspaceId,
    principalId,
    collectionRequest,
    "agreement.read",
    { type: "agreement", id: "42" },
  );
  const secondResource = servicePrincipalActionRateLimits(
    workspaceId,
    principalId,
    collectionRequest,
    "approval.request",
    { type: "agreement", id: "9001" },
  );
  const execute = servicePrincipalActionRateLimits(
    workspaceId,
    principalId,
    routeRequest("/api/v1/plans/11111111-1111-4111-8111-111111111111/execute", "POST"),
    "agreement.read",
    { type: "agreement", id: "42" },
  );

  assert.equal(wildcard.aggregate.key, firstResource.aggregate.key);
  assert.equal(firstResource.aggregate.key, secondResource.aggregate.key);
  assert.notEqual(wildcard.resource.key, firstResource.resource.key);
  assert.notEqual(firstResource.resource.key, secondResource.resource.key);
  assert.notEqual(firstResource.aggregate.key, execute.aggregate.key);

  const decisions = [wildcard, firstResource, secondResource].map((rateLimits) =>
    checkBestEffortRateLimit(rateLimits.aggregate.key, options));
  assert.deepEqual(decisions.map((decision) => decision.allowed), [true, true, false]);
});

test("a valid human assertion is distinguished from a service-token assertion", async () => {
  const claims = serviceClaims();
  delete claims.common_name;
  claims.sub = "human-subject";
  claims.email = "human@example.test";
  await assert.rejects(
    verifyCloudflareAccessServiceIdentity(
      serviceRequest(await signedServiceToken(claims)),
      ACCESS_CONFIG,
      { keyResolver: resolver, currentDate: CURRENT_DATE },
    ),
    (error) => error instanceof ServiceTokenVerificationError && error.code === "TOKEN_NOT_SERVICE",
  );
});

test("service-token classification requires an explicitly empty subject", async () => {
  for (const sub of ["human-subject", undefined]) {
    const claims = serviceClaims();
    if (sub === undefined) delete claims.sub;
    else claims.sub = sub;
    await assert.rejects(
      verifyCloudflareAccessServiceIdentity(
        serviceRequest(await signedServiceToken(claims)),
        ACCESS_CONFIG,
        { keyResolver: resolver, currentDate: CURRENT_DATE },
      ),
      (error) => error instanceof ServiceTokenVerificationError && error.code === "TOKEN_NOT_SERVICE",
    );
  }
});

test("issuer, audience, app type, and common_name are verified and bounded", async () => {
  for (const overrides of [
    { iss: "https://other.cloudflareaccess.com" },
    { aud: ["c".repeat(64)] },
    { type: "org" },
    { common_name: "contains whitespace.access" },
    { common_name: "x".repeat(513) },
  ]) {
    await assert.rejects(
      verifyCloudflareAccessServiceIdentity(
        serviceRequest(await signedServiceToken(serviceClaims(overrides))),
        ACCESS_CONFIG,
        { keyResolver: resolver, currentDate: CURRENT_DATE },
      ),
      (error) => error instanceof ServiceTokenVerificationError && error.code === "TOKEN_INVALID",
    );
  }
});

const principal: PersistedServicePrincipal = {
  id: "principal-1",
  workspaceId: "workspace-a",
  issuer: TEAM_DOMAIN,
  subject: "2e7ec6c74f6a4ea9a773dc4ac6f60495.access",
  status: "active",
};

const grant: PersistedAgentGrant = {
  id: "grant-1",
  workspaceId: "workspace-a",
  principalId: "principal-1",
  delegatorUserId: "sponsor-1",
  status: "active",
  actionIds: ["agreement.read", "approval.request"],
  resourceConstraints: {
    resources: [{ type: "agreement", ids: ["42"] }],
  },
  policyVersion: "agent-policy-1",
  startsAt: "2026-08-19T15:00:00.000Z",
  expiresAt: "2026-08-20T15:00:00.000Z",
  revokedAt: null,
};

const sponsor: PersistedGrantSponsor = { id: "sponsor-1", status: "active" };
const membership: PersistedSponsorMembership = {
  workspaceId: "workspace-a",
  userId: "sponsor-1",
  role: "legal",
  status: "active",
};

function evaluate(
  overrides: Partial<Parameters<typeof evaluatePersistedAgentAuthority>[0]> = {},
) {
  return evaluatePersistedAgentAuthority({
    principal,
    grant,
    sponsor,
    membership,
    workspaceId: "workspace-a",
    actionId: "approval.request",
    resource: { type: "agreement", id: "42" },
    now: CURRENT_DATE.toISOString(),
    ...overrides,
  });
}

test("one current grant, current sponsor role, and exact resource authorize together", () => {
  const result = evaluate();
  assert.equal(result.authorized, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.effectivePermissions, ["agreement:read", "approval:request"]);
});

test("disabled principal and disabled or removed sponsors fail closed", () => {
  const disabledPrincipal = evaluate({ principal: { ...principal, status: "disabled" } });
  assert.equal(disabledPrincipal.authorized, false);
  assert.equal(disabledPrincipal.blockers.some((blocker) => blocker.code === "SERVICE_PRINCIPAL_DISABLED"), true);

  const disabledSponsor = evaluate({ sponsor: { ...sponsor, status: "disabled" } });
  assert.equal(disabledSponsor.blockers.some((blocker) => blocker.code === "AGENT_SPONSOR_DISABLED"), true);

  const removedMembership = evaluate({ membership: { ...membership!, status: "disabled" } });
  assert.equal(removedMembership.blockers.some((blocker) => blocker.code === "AGENT_SPONSOR_MEMBERSHIP_INACTIVE"), true);
});

test("expired and revoked grants fail closed", () => {
  const expired = evaluate({ now: grant.expiresAt });
  assert.equal(expired.authorized, false);
  assert.equal(expired.blockers.some((blocker) => blocker.code === "AGENT_GRANT_EXPIRED"), true);

  const revoked = evaluate({
    grant: {
      ...grant,
      status: "revoked",
      revokedAt: "2026-08-19T15:30:00.000Z",
    },
  });
  assert.equal(revoked.authorized, false);
  assert.equal(revoked.blockers.some((blocker) => blocker.code === "AGENT_GRANT_REVOKED"), true);
});

test("sponsor demotion immediately removes delegated permissions", () => {
  const demoted = evaluate({ membership: { ...membership!, role: "viewer" } });
  assert.equal(demoted.authorized, false);
  assert.equal(demoted.blockers.some((blocker) =>
    blocker.code === "AGENT_GRANT_DELEGATOR_PERMISSION_DENIED"
    && blocker.permission === "approval:request"), true);
});

test("resource mismatches and tenant mismatches fail closed", () => {
  const otherAgreement = evaluate({ resource: { type: "agreement", id: "43" } });
  assert.equal(otherAgreement.blockers.some((blocker) => blocker.code === "AGENT_GRANT_RESOURCE_DENIED"), true);

  const otherWorkspace = evaluate({ workspaceId: "workspace-b" });
  assert.equal(otherWorkspace.authorized, false);
  assert.equal(otherWorkspace.blockers.some((blocker) =>
    blocker.code === "SERVICE_PRINCIPAL_WORKSPACE_MISMATCH"
    || blocker.code === "AGENT_GRANT_WORKSPACE_MISMATCH"), true);
});

test("agreement mutations require explicit read scope in the same grant", () => {
  const withoutRead = evaluate({
    grant: { ...grant, actionIds: ["approval.request"] },
  });
  assert.equal(withoutRead.authorized, false);
  assert.equal(withoutRead.blockers.some((blocker) =>
    blocker.code === "AGENT_GRANT_READ_SCOPE_REQUIRED"), true);
});
