export type ResponseBoundaryErrorCode =
  | "invalid_content_length"
  | "response_too_large"
  | "body_timeout"
  | "body_read_failed"
  | "header_timeout"
  | "request_failed";

export class ResponseBoundaryError extends Error {
  readonly code: ResponseBoundaryErrorCode;

  constructor(code: ResponseBoundaryErrorCode, message: string) {
    super(message);
    this.name = "ResponseBoundaryError";
    this.code = code;
  }
}

export type BoundedResponseBodyOptions = Readonly<{
  maximumBytes: number;
  timeoutMs: number;
  invalidLengthMessage: string;
  tooLargeMessage: string;
  timeoutMessage: string;
  readFailureMessage: string;
}>;

/**
 * Read an upstream response without trusting Content-Length or buffering an
 * unbounded chunked body. All caller-provided messages must be safe to expose
 * to application logs and diagnostics.
 */
export async function readBoundedResponseBody(
  response: Response,
  options: BoundedResponseBodyOptions,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1) {
    throw new Error("Response size limit is invalid");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("Response body timeout is invalid");
  }

  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(0|[1-9]\d*)$/.test(declared) || !Number.isSafeInteger(Number(declared))) {
      cancelResponseBody(response, "Response Content-Length was invalid");
      throw new ResponseBoundaryError("invalid_content_length", options.invalidLengthMessage);
    }
    if (Number(declared) > options.maximumBytes) {
      cancelResponseBody(response, "Response exceeded the configured limit");
      throw new ResponseBoundaryError("response_too_large", options.tooLargeMessage);
    }
  }

  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new ResponseBoundaryError("body_timeout", options.timeoutMessage));
      cancelReader(reader, "Response body timed out");
    }, options.timeoutMs);
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > options.maximumBytes) {
        cancelReader(reader, "Response exceeded the configured limit");
        throw new ResponseBoundaryError("response_too_large", options.tooLargeMessage);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ResponseBoundaryError) throw error;
    cancelReader(reader, "Response body could not be read");
    throw new ResponseBoundaryError(
      timedOut ? "body_timeout" : "body_read_failed",
      timedOut ? options.timeoutMessage : options.readFailureMessage,
    );
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    try { reader.releaseLock(); } catch { /* the stream may already be cancelled */ }
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Enforce a header deadline even when a fetch implementation ignores abort.
 * Late responses are cancelled so their bodies cannot continue consuming
 * resources after the caller has failed closed.
 */
export async function fetchWithHeaderDeadline(
  input: string | URL,
  init: RequestInit,
  options: Readonly<{
    timeoutMs: number;
    timeoutMessage: string;
    failureMessage: string;
  }>,
): Promise<Response> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("Response header timeout is invalid");
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const request = Promise.resolve().then(() => fetch(input, { ...init, signal: controller.signal }));
  void request.then((response) => {
    if (timedOut) cancelResponseBody(response, "Response arrived after its header deadline");
  }, () => undefined);
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ResponseBoundaryError("header_timeout", options.timeoutMessage));
    }, options.timeoutMs);
  });

  try {
    return await Promise.race([request, deadline]);
  } catch (error) {
    if (error instanceof ResponseBoundaryError) throw error;
    throw new ResponseBoundaryError(
      timedOut ? "header_timeout" : "request_failed",
      timedOut ? options.timeoutMessage : options.failureMessage,
    );
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function cancelResponseBody(response: Response, reason: string): void {
  if (response.body === null) return;
  try {
    void response.body.cancel(reason).catch(() => undefined);
  } catch {
    // A locked or already-consumed stream needs no further handling here.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: string): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // A closed stream needs no further handling here.
  }
}
