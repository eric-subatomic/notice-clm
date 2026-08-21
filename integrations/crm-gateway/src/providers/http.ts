import { CrmProviderError } from "./types";

const MAX_RETRY_AFTER_MS = 5 * 60 * 1_000;
export const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

const PROVIDER_TIMEOUT = Symbol("provider-timeout");

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function providerFetch(
  fetcher: FetchLike,
  input: string | URL,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init.signal;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const forwardCallerAbort = () => controller.abort(callerSignal?.reason);

  if (callerSignal?.aborted === true) {
    forwardCallerAbort();
  } else {
    callerSignal?.addEventListener("abort", forwardCallerAbort, { once: true });
  }

  try {
    // Inspect redirects instead of following them or relying on the runtime's
    // redirect rejection, which is otherwise indistinguishable from a
    // transient network failure. Callers classify every 3xx as permanent.
    const request = Promise.resolve().then(() => fetcher(input, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    }));
    const deadline = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(PROVIDER_TIMEOUT);
      }, PROVIDER_REQUEST_TIMEOUT_MS);
    });
    return await Promise.race([request, deadline]);
  } catch (error) {
    if (timedOut || error === PROVIDER_TIMEOUT) {
      throw new CrmProviderError("CRM_PROVIDER_TIMEOUT", true);
    }
    throw new CrmProviderError("CRM_PROVIDER_NETWORK_ERROR", true);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", forwardCallerAbort);
  }
}

export function retryAfterMs(response: Response, now = Date.now()): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  const seconds = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(raw) - now;
  if (!Number.isFinite(milliseconds)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(milliseconds)));
}

export function throwForProviderStatus(response: Response): void {
  if (response.status >= 200 && response.status < 300) return;
  if (response.status >= 300 && response.status < 400) {
    throw new CrmProviderError("CRM_PROVIDER_REDIRECT_REJECTED", false);
  }
  if (response.status === 401 || response.status === 403) {
    throw new CrmProviderError("CRM_PROVIDER_AUTH_FAILED", false);
  }
  if (response.status === 429) {
    throw new CrmProviderError("CRM_PROVIDER_RATE_LIMITED", true, retryAfterMs(response));
  }
  if (response.status >= 500 && response.status <= 599) {
    throw new CrmProviderError("CRM_PROVIDER_UNAVAILABLE", true, retryAfterMs(response));
  }
  throw new CrmProviderError("CRM_PROVIDER_REJECTED", false);
}

export async function readBoundedJson(response: Response, maxBytes = 64 * 1_024): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
  }
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(PROVIDER_TIMEOUT);
    }, PROVIDER_REQUEST_TIMEOUT_MS);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof CrmProviderError) throw error;
    if (timedOut || error === PROVIDER_TIMEOUT) {
      void reader.cancel().catch(() => undefined);
      throw new CrmProviderError("CRM_PROVIDER_TIMEOUT", true);
    }
    throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
  }
}

export function boundedResponseId(candidate: unknown): string | null {
  if (candidate === undefined || candidate === null || candidate === "") return null;
  if (
    typeof candidate !== "string"
    || candidate.length > 256
    || /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
  }
  return candidate;
}
