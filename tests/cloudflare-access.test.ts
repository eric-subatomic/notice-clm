import assert from "node:assert/strict";
import test from "node:test";
import {
  SignJWT,
  createLocalJWKSet,
  customFetch,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import {
  CloudflareAccessIdentityError,
  createCloudflareAccessKeyResolver,
  verifyCloudflareAccessIdentity,
} from "../app/lib/cloudflare-access";

// JWT verification requires the provider's real hostname shape. This unique
// test-only team label is never resolved because keys and fetches are mocked.
const TEAM_DOMAIN = "https://notice-fixture-invalid-iana-org.cloudflareaccess.com";
const AUDIENCE = "a".repeat(64);
const CURRENT_DATE = new Date("2026-08-02T12:00:00.000Z");
const CURRENT_SECONDS = Math.floor(CURRENT_DATE.getTime() / 1_000);
const accessConfig = { teamDomain: TEAM_DOMAIN, audience: AUDIENCE } as const;

const rsaOne = await generateKeyPair("RS256", { extractable: true });
const rsaTwo = await generateKeyPair("RS256", { extractable: true });
const ecKey = await generateKeyPair("ES256", { extractable: true });
const rsaOneJwk = await publicJwk(rsaOne.publicKey, "rsa-one", "RS256");
const rsaTwoJwk = await publicJwk(rsaTwo.publicKey, "rsa-two", "RS256");
const ecJwk = await publicJwk(ecKey.publicKey, "ec-one", "ES256");
const rsaOneResolver = createLocalJWKSet({ keys: [rsaOneJwk] });

async function publicJwk(key: CryptoKey, kid: string, alg: string): Promise<JWK> {
  return { ...await exportJWK(key), kid, alg, use: "sig" };
}

function claims(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    iss: TEAM_DOMAIN,
    aud: [AUDIENCE],
    sub: "7335d417-61da-459d-899c-0a01c76a2f94",
    email: "Legal.User@Orchid.test",
    type: "app",
    iat: CURRENT_SECONDS - 5,
    nbf: CURRENT_SECONDS - 5,
    exp: CURRENT_SECONDS + 300,
    custom: { name: "Orchid Legal User" },
    ...overrides,
  };
}

async function signedToken(
  payload: JWTPayload = claims(),
  options: { key?: CryptoKey; kid?: string; alg?: "RS256" | "ES256" } = {},
): Promise<string> {
  const alg = options.alg ?? "RS256";
  return new SignJWT(payload)
    .setProtectedHeader({ alg, kid: options.kid ?? "rsa-one", typ: "JWT" })
    .sign(options.key ?? rsaOne.privateKey);
}

function requestWithToken(token?: string, extraHeaders: HeadersInit = {}): Request {
  const headers = new Headers(extraHeaders);
  if (token) headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request("https://notice.orchid.test/api/session", { headers });
}

async function verify(token: string, resolver: JWTVerifyGetKey = rsaOneResolver) {
  return verifyCloudflareAccessIdentity(requestWithToken(token), accessConfig, {
    keyResolver: resolver,
    currentDate: CURRENT_DATE,
  });
}

async function rejectsInvalid(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(
    operation,
    (error) => error instanceof CloudflareAccessIdentityError && error.code === "TOKEN_INVALID",
  );
}

test("a valid Access application JWT supplies the only authoritative identity", async () => {
  const token = await signedToken();
  const identity = await verifyCloudflareAccessIdentity(
    requestWithToken(token, {
      "x-notice-identity-subject": "attacker-selected-subject",
      "x-notice-identity-email": "attacker@evil.test",
      "x-notice-identity-name": "Attacker",
    }),
    accessConfig,
    { keyResolver: rsaOneResolver, currentDate: CURRENT_DATE },
  );

  assert.deepEqual(identity, {
    provider: `cloudflare-access:${TEAM_DOMAIN}`,
    subject: "7335d417-61da-459d-899c-0a01c76a2f94",
    email: "legal.user@orchid.test",
    displayName: "Orchid Legal User",
  });
});

test("the Access assertion header is required and no cookie fallback is accepted", async () => {
  await assert.rejects(
    verifyCloudflareAccessIdentity(
      requestWithToken(undefined, { cookie: "CF_Authorization=untrusted-cookie-value" }),
      accessConfig,
      { keyResolver: rsaOneResolver, currentDate: CURRENT_DATE },
    ),
    (error) => error instanceof CloudflareAccessIdentityError && error.code === "TOKEN_MISSING",
  );
});

test("tampered signatures and non-RS256 algorithms fail closed", async () => {
  const valid = await signedToken();
  const pieces = valid.split(".");
  pieces[2] = `${pieces[2][0] === "A" ? "B" : "A"}${pieces[2].slice(1)}`;
  await rejectsInvalid(verify(pieces.join(".")));

  const esToken = await signedToken(claims(), { key: ecKey.privateKey, kid: "ec-one", alg: "ES256" });
  await rejectsInvalid(verify(esToken, createLocalJWKSet({ keys: [ecJwk] })));
});

test("issuer and application audience are exact", async () => {
  await rejectsInvalid(verify(await signedToken(claims({ iss: "https://other.cloudflareaccess.invalid" }))));
  await rejectsInvalid(verify(await signedToken(claims({ aud: ["b".repeat(64)] }))));
});

test("expired and not-yet-valid assertions fail closed", async () => {
  await rejectsInvalid(verify(await signedToken(claims({ exp: CURRENT_SECONDS - 10 }))));
  await rejectsInvalid(verify(await signedToken(claims({ nbf: CURRENT_SECONDS + 10 }))));
});

test("only bounded identity application claims are accepted", async () => {
  const invalidClaims: Array<Record<string, unknown>> = [
    { type: "org" },
    { type: "service" },
    { sub: "" },
    { sub: `subject ${"x".repeat(10)}` },
    { sub: "x".repeat(513) },
    { email: "not-an-email" },
    { email: `${"x".repeat(245)}@orchid.test` },
    { custom: { name: "x".repeat(201) } },
    { custom: { name: "Unsafe\u0000Name" } },
  ];
  for (const overrides of invalidClaims) {
    await rejectsInvalid(verify(await signedToken(claims(overrides))));
  }

  const missingRequired = claims();
  delete missingRequired.exp;
  await rejectsInvalid(verify(await signedToken(missingRequired)));

  const withoutName = claims();
  delete withoutName.custom;
  assert.equal((await verify(await signedToken(withoutName))).displayName, "legal.user@orchid.test");
});

test("the remote JWKS resolver follows key rotation and fails closed on fetch failure", async () => {
  let currentJwks = { keys: [rsaOneJwk] };
  let fetches = 0;
  const resolver = createCloudflareAccessKeyResolver(TEAM_DOMAIN, {
    cooldownDuration: 0,
    cacheMaxAge: Number.POSITIVE_INFINITY,
    [customFetch]: async () => {
      fetches += 1;
      return Response.json(currentJwks);
    },
  });

  assert.equal((await verify(await signedToken(), resolver)).email, "legal.user@orchid.test");
  currentJwks = { keys: [rsaTwoJwk] };
  const rotated = await signedToken(claims(), { key: rsaTwo.privateKey, kid: "rsa-two" });
  assert.equal((await verify(rotated, resolver)).subject, "7335d417-61da-459d-899c-0a01c76a2f94");
  assert.ok(fetches >= 2, "an unknown rotated kid should refresh the remote JWKS");

  const unavailable = createCloudflareAccessKeyResolver(TEAM_DOMAIN, {
    cooldownDuration: 0,
    [customFetch]: async () => {
      throw new Error("synthetic JWKS outage");
    },
  });
  await rejectsInvalid(verify(await signedToken(), unavailable));
});
