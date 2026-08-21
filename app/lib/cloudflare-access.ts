import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type RemoteJWKSet,
  type RemoteJWKSetOptions,
} from "jose";
import type { CloudflareAccessConfig } from "./notice-config";
import {
  normalizeVerifiedDisplayName,
  normalizeVerifiedEmail,
  normalizeVerifiedSubject,
} from "./identity";

export const CLOUDFLARE_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const CLOCK_TOLERANCE_SECONDS = 5;
const remoteKeySets = new Map<string, RemoteJWKSet>();

export type VerifiedCloudflareAccessIdentity = Readonly<{
  provider: string;
  subject: string;
  email: string;
  displayName: string;
}>;

export type CloudflareAccessIdentityErrorCode = "TOKEN_MISSING" | "TOKEN_INVALID";

export class CloudflareAccessIdentityError extends Error {
  constructor(readonly code: CloudflareAccessIdentityErrorCode) {
    super(code === "TOKEN_MISSING" ? "Cloudflare Access authentication is required." : "Cloudflare Access identity is invalid.");
    this.name = "CloudflareAccessIdentityError";
  }
}

export type CloudflareAccessVerificationOptions = Readonly<{
  /** Test seam for a local or synthetic JWKS. Production callers omit this. */
  keyResolver?: JWTVerifyGetKey;
  currentDate?: Date;
}>;

/**
 * Build a rotating remote JWKS resolver. The URL is derived from the validated
 * Access team origin rather than accepted as independent deployment input.
 */
export function createCloudflareAccessKeyResolver(
  teamDomain: string,
  options: RemoteJWKSetOptions = {},
): RemoteJWKSet {
  return createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain), {
    timeoutDuration: 3_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
    ...options,
  });
}

function productionKeyResolver(config: CloudflareAccessConfig): RemoteJWKSet {
  const key = config.jwksUrl ?? config.teamDomain;
  let resolver = remoteKeySets.get(key);
  if (!resolver) {
    resolver = config.jwksUrl
      ? createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 3_000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 })
      : createCloudflareAccessKeyResolver(config.teamDomain);
    remoteKeySets.set(key, resolver);
  }
  return resolver;
}

function displayNameClaim(payload: Record<string, unknown>): { present: boolean; value: unknown } {
  if (Object.hasOwn(payload, "name")) return { present: true, value: payload.name };
  const custom = payload.custom;
  if (custom && typeof custom === "object" && !Array.isArray(custom) && Object.hasOwn(custom, "name")) {
    return { present: true, value: (custom as Record<string, unknown>).name };
  }
  return { present: false, value: undefined };
}

/**
 * Verify and normalize the identity carried by a Cloudflare Access application
 * token. Caller-provided convenience identity headers are intentionally never
 * consulted in this mode.
 */
export async function verifyCloudflareAccessIdentity(
  request: Request,
  config: CloudflareAccessConfig,
  options: CloudflareAccessVerificationOptions = {},
): Promise<VerifiedCloudflareAccessIdentity> {
  const token = request.headers.get(CLOUDFLARE_ACCESS_JWT_HEADER);
  if (!token) throw new CloudflareAccessIdentityError("TOKEN_MISSING");
  if (token.length > MAX_ACCESS_TOKEN_LENGTH) throw new CloudflareAccessIdentityError("TOKEN_INVALID");

  try {
    const { payload } = await jwtVerify(
      token,
      options.keyResolver ?? productionKeyResolver(config),
      {
        algorithms: ["RS256"],
        issuer: config.teamDomain,
        audience: config.audience,
        typ: "JWT",
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: options.currentDate,
        requiredClaims: ["sub", "email", "exp", "nbf", "type"],
      },
    );

    if (payload.type !== "app") throw new CloudflareAccessIdentityError("TOKEN_INVALID");
    const subject = normalizeVerifiedSubject(payload.sub);
    const email = normalizeVerifiedEmail(payload.email);
    if (!subject || !email) throw new CloudflareAccessIdentityError("TOKEN_INVALID");

    const nameClaim = displayNameClaim(payload as Record<string, unknown>);
    const displayName = nameClaim.present ? normalizeVerifiedDisplayName(nameClaim.value) : email;
    if (!displayName) throw new CloudflareAccessIdentityError("TOKEN_INVALID");

    return Object.freeze({
      provider: `cloudflare-access:${config.teamDomain}`,
      subject,
      email,
      displayName,
    });
  } catch (error) {
    if (error instanceof CloudflareAccessIdentityError) throw error;
    throw new CloudflareAccessIdentityError("TOKEN_INVALID");
  }
}
