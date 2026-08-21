import {
  readBoundedResponseBody,
  ResponseBoundaryError,
} from "./response-boundary";

export const INTEGRATION_LIVE_TEST_TIMEOUT_MS = 10_000;
export const INTEGRATION_DIAGNOSTIC_MAX_BYTES = 8 * 1_024;

export async function readBoundedIntegrationDiagnostic(response: Response): Promise<unknown> {
  try {
    const bytes = await readBoundedResponseBody(response, {
      maximumBytes: INTEGRATION_DIAGNOSTIC_MAX_BYTES,
      timeoutMs: INTEGRATION_LIVE_TEST_TIMEOUT_MS,
      invalidLengthMessage: "Integration diagnostic Content-Length was invalid",
      tooLargeMessage: "Integration diagnostic response was too large",
      timeoutMessage: "Integration diagnostic response timed out",
      readFailureMessage: "Integration diagnostic response could not be read",
    });
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ResponseBoundaryError && error.code === "body_timeout") throw error;
    return null;
  }
}
