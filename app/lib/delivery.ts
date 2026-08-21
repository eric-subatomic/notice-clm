import { hmacSha256Hex } from "./document-security";

export type DeliveryGatewayEvent = {
  id: string;
  workspaceId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type PreparedDeliveryGatewayRequest = Readonly<{
  endpoint: URL;
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

export type DeliveryGatewayConfiguration = Readonly<{
  endpoint: string;
  secret: string;
  /** Present only for the dedicated CRM gateway. Both fields are signed. */
  provider?: "hubspot" | "salesforce" | "custom";
  mappingVersion?: string;
}>;

export type CrmDeliveryProfile = Readonly<{
  provider: "hubspot" | "salesforce" | "custom";
  mappingVersion: string;
}>;

export async function crmDestinationFingerprint(configuration: DeliveryGatewayConfiguration): Promise<string> {
  const profile = crmDeliveryProfile(configuration);
  if (!profile) throw new Error("A CRM destination fingerprint requires a CRM delivery profile");
  const endpoint = new URL(configuration.endpoint);
  const material = new TextEncoder().encode(JSON.stringify([
    "notice-crm-destination-v1",
    endpoint.toString(),
    profile.provider,
    profile.mappingVersion,
  ]));
  const digest = await crypto.subtle.digest("SHA-256", material);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const MAX_DELIVERY_BODY_BYTES = 128 * 1_024;
const MAX_RETRY_AFTER_MS = 6 * 60 * 60_000;

export class GatewayDeliveryError extends Error {
  readonly code: string;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryAfterMs: number | null = null, retryable = true, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GatewayDeliveryError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
  }
}

export async function prepareDeliveryGatewayRequest(
  configuration: DeliveryGatewayConfiguration,
  event: DeliveryGatewayEvent,
  options: { connectionTest?: boolean; now?: Date } = {},
): Promise<PreparedDeliveryGatewayRequest> {
  if (configuration.secret.length < 32) throw new Error("Delivery gateway secret must contain at least 32 characters");
  const endpoint = new URL(configuration.endpoint);
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
  if (endpoint.username || endpoint.password || (endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:"))) {
    throw new Error("Delivery gateway must use HTTPS without embedded credentials");
  }
  const profile = crmDeliveryProfile(configuration);
  const body = JSON.stringify({ schemaVersion: "1.0", event });
  if (new TextEncoder().encode(body).byteLength > MAX_DELIVERY_BODY_BYTES) {
    throw new Error("Delivery gateway event exceeds the 128 KiB request limit");
  }
  const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1_000).toString();
  const signature = await hmacSha256Hex(configuration.secret, deliverySignatureInput(timestamp, body, profile));
  return Object.freeze({
    endpoint,
    method: "POST",
    headers: Object.freeze({
      "content-type": "application/json",
      "x-notice-event-id": event.id,
      ...(options.connectionTest ? { "x-notice-test": "connection" } : {}),
      ...(profile ? {
        "x-notice-crm-provider": profile.provider,
        "x-notice-crm-mapping-version": profile.mappingVersion,
      } : {}),
      "x-notice-timestamp": timestamp,
      "x-notice-signature": `sha256=${signature}`,
    }),
    body,
  });
}

export async function deliverOutboxEvent(
  configuration: DeliveryGatewayConfiguration,
  event: DeliveryGatewayEvent,
): Promise<void> {
  const request = await prepareDeliveryGatewayRequest(configuration, event);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(request.endpoint, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new GatewayDeliveryError(
        `gateway_http_${response.status}`,
        `Delivery gateway returned HTTP ${response.status}`,
        retryAfterMilliseconds(response.headers.get("retry-after")),
        response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
      );
    }
  } catch (error) {
    if (error instanceof GatewayDeliveryError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new GatewayDeliveryError("gateway_timeout", "Delivery gateway timed out", null, true, error);
    }
    throw new GatewayDeliveryError("gateway_unreachable", "Delivery gateway could not be reached", null, true, error);
  } finally {
    clearTimeout(timer);
  }
}

export function deliverySignatureInput(
  timestamp: string,
  body: string,
  profile: CrmDeliveryProfile | null = null,
): string {
  return profile
    ? `${timestamp}.${profile.provider}.${profile.mappingVersion}.${body}`
    : `${timestamp}.${body}`;
}

function crmDeliveryProfile(configuration: DeliveryGatewayConfiguration): CrmDeliveryProfile | null {
  const provider = configuration.provider;
  const mappingVersion = configuration.mappingVersion;
  if (provider === undefined && mappingVersion === undefined) return null;
  if (
    !provider
    || !["hubspot", "salesforce", "custom"].includes(provider)
    || !mappingVersion
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(mappingVersion)
  ) {
    throw new Error("CRM delivery profile must contain a supported provider and stable mapping version");
  }
  return Object.freeze({ provider, mappingVersion });
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
  const delay = seconds === null ? Date.parse(value) - Date.now() : seconds * 1_000;
  if (!Number.isFinite(delay) || delay < 0) return null;
  return Math.min(delay, MAX_RETRY_AFTER_MS);
}
