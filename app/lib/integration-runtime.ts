import {
  prepareDeliveryGatewayRequest,
  type DeliveryGatewayConfiguration,
  type DeliveryGatewayEvent,
} from "./delivery";
import {
  extractDocumentTextWithCustomerHostedOcr,
  scanDocument,
  sha256Hex,
  type ScannerConfiguration,
} from "./document-security";
import {
  getDocuSealTemplateProfile,
  probeDocuSealMcp,
  type DocuSealConfiguration,
} from "./docuseal";
import {
  getDeliveryConfiguration,
  getCrmConfiguration,
  getDocuSealConfiguration,
  getDocuSealDiagnosticConfiguration,
} from "./providers";
import {
  getIntegrationSummary,
  type IntegrationId,
  type IntegrationLiveTest,
  type IntegrationStatusSource,
} from "./integration-status";
import {
  INTEGRATION_LIVE_TEST_TIMEOUT_MS,
  readBoundedIntegrationDiagnostic,
} from "./integration-response";
import { createOcrReadinessChallenge, ocrReadinessResultMatches, syntheticOcrReadinessPdf } from "./ocr-readiness";
import {
  cancelResponseBody,
  fetchWithHeaderDeadline,
  ResponseBoundaryError,
} from "./response-boundary";

function value(source: IntegrationStatusSource, name: string): string {
  const candidate = source[name];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function safeEndpoint(raw: string): URL {
  const endpoint = new URL(raw);
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
  if (endpoint.username || endpoint.password || (endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:"))) {
    throw new Error("Integration endpoints must use HTTPS and must not contain embedded credentials");
  }
  return endpoint;
}

async function fetchWithDeadline(input: URL, init: RequestInit): Promise<Response> {
  return fetchWithHeaderDeadline(input, { ...init, redirect: "manual" }, {
    timeoutMs: INTEGRATION_LIVE_TEST_TIMEOUT_MS,
    timeoutMessage: "Integration request timed out",
    failureMessage: "Integration request failed",
  });
}

function result(status: IntegrationLiveTest["status"], detail: string): IntegrationLiveTest {
  return Object.freeze({ status, testedAt: new Date().toISOString(), detail });
}

function docuSealConfiguration(source: IntegrationStatusSource): DocuSealConfiguration {
  if (value(source, "NOTICE_ESIGN_CONFIGURED") === "true") {
    return getDocuSealConfiguration();
  }
  return getDocuSealDiagnosticConfiguration(source);
}

async function testDocuSeal(source: IntegrationStatusSource): Promise<IntegrationLiveTest> {
  const configuration = docuSealConfiguration(source);
  safeEndpoint(configuration.apiBaseUrl);

  try {
    const profile = await getDocuSealTemplateProfile(configuration);
    const mcp = configuration.mcp ? await probeDocuSealMcp(configuration, profile.roles) : null;
    return result("passed", [
      `DocuSeal ${configuration.deployment} authenticated; the adapter configuration is pinned to validated release ${configuration.validatedRelease} and API client contract ${configuration.apiClientContractVersion}.`,
      `The non-archived, non-public template exposes ${profile.roles.length} ordered unique signer role${profile.roles.length === 1 ? "" : "s"}, each with a required signature or initials field.`,
      "The /submissions/html entitlement is explicitly attested.",
      mcp
        ? `The same-origin MCP ${mcp.serverVersion} handshake exposed ${mcp.toolCount} tools with pinned safety annotations, then ${mcp.verifiedReadTool} independently matched the configured template's ${mcp.roleCount} ordered signer role${mcp.roleCount === 1 ? "" : "s"}. Mutation tools were not called.`
        : "MCP is explicitly disabled.",
    ].join(" "));
  } catch (error) {
    const timedOut = error instanceof ResponseBoundaryError
      && (error.code === "header_timeout" || error.code === "body_timeout");
    return result("failed", timedOut
      ? "DocuSeal did not respond before the connection test timed out."
      : "DocuSeal authentication, pinned release/API contract, template safety profile, entitlement, or optional MCP validation failed.");
  }
}

async function testScanner(source: IntegrationStatusSource): Promise<IntegrationLiveTest> {
  const bytes = new TextEncoder().encode("Notice scanner connection test. This contains no customer data.\n");
  const sha256 = await sha256Hex(bytes);
  const ocrEnabled = value(source, "NOTICE_SCAN_OCR_ENABLED") === "true";
  const configuration: ScannerConfiguration = {
    // Live diagnostics deliberately run before the operator records the
    // CONFIGURED attestation. Normal uploads use the attestation-gated runtime
    // configuration in providers.ts.
    endpoint: value(source, "NOTICE_SCAN_GATEWAY_URL") || null,
    secret: value(source, "NOTICE_SCAN_GATEWAY_SECRET") || null,
    ocr: ocrEnabled
      ? {
          modelId: value(source, "NOTICE_SCAN_OCR_MODEL_ID"),
          profileId: value(source, "NOTICE_SCAN_OCR_PROFILE_ID"),
        }
      : null,
  };
  const verdict = await scanDocument(bytes, {
    id: crypto.randomUUID(),
    fileName: "notice-connection-test.txt",
    contentType: "text/plain",
    sha256,
  }, configuration);

  if (verdict.status === "clean") {
    if (!configuration.ocr) {
      return result("passed", "The scanning gateway authenticated and accepted a harmless test document; customer-hosted OCR is explicitly disabled.");
    }
    try {
      const ocrChallenge = createOcrReadinessChallenge();
      const ocrBytes = syntheticOcrReadinessPdf(ocrChallenge);
      const ocrSha256 = await sha256Hex(ocrBytes);
      const extraction = await extractDocumentTextWithCustomerHostedOcr(ocrBytes, {
        id: crypto.randomUUID(),
        fileName: "notice-ocr-readiness.pdf",
        contentType: "application/pdf",
        sha256: ocrSha256,
      }, configuration);
      if (!ocrReadinessResultMatches(extraction.text, ocrChallenge)) {
        return result("failed", "The scanning gateway passed malware scanning, but customer-hosted OCR did not return the exact per-run synthetic challenge.");
      }
      return result(
        "passed",
        `The scanning gateway authenticated, accepted a harmless scan, and completed the synthetic customer-hosted OCR check for model ${configuration.ocr.modelId} with profile ${configuration.ocr.profileId}.`,
      );
    } catch {
      return result("failed", "The scanning gateway passed malware scanning, but the selected customer-hosted OCR model/profile did not complete the bounded synthetic check.");
    }
  }
  if (verdict.status === "malicious") {
    return result("failed", "The scanning gateway classified the harmless test document as malicious.");
  }
  return result("failed", verdict.detail === "Scanner timed out"
    ? "The scanning gateway did not respond before the connection test timed out."
    : "The scanning gateway could not complete the test scan.");
}

function gatewayConfiguration(source: IntegrationStatusSource, id: "delivery" | "crm"): DeliveryGatewayConfiguration {
  if (id === "delivery" && value(source, "NOTICE_MAIL_CONFIGURED") === "true") {
    return getDeliveryConfiguration();
  }
  if (id === "crm") {
    if (value(source, "NOTICE_CRM_CONFIGURED") === "true") {
      const configuration = getCrmConfiguration();
      if (!configuration) throw new Error("CRM synchronization is disabled");
      return configuration;
    }
    return {
      endpoint: value(source, "NOTICE_CRM_GATEWAY_URL"),
      secret: value(source, "NOTICE_CRM_GATEWAY_SECRET"),
      provider: value(source, "NOTICE_CRM_PROVIDER") as "hubspot" | "salesforce" | "custom",
      mappingVersion: value(source, "NOTICE_CRM_MAPPING_VERSION"),
    };
  }
  return {
    endpoint: value(source, "NOTICE_DELIVERY_GATEWAY_URL"),
    secret: value(source, "NOTICE_DELIVERY_GATEWAY_SECRET"),
  };
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

/**
 * Send an authenticated dry-run event. A conforming gateway verifies the HMAC
 * and returns 2xx without sending mail or mutating a CRM when both
 * `x-notice-test: connection` and `payload.dryRun: true` are present.
 */
async function testGateway(source: IntegrationStatusSource, id: "delivery" | "crm"): Promise<IntegrationLiveTest> {
  const configuration = gatewayConfiguration(source, id);
  safeEndpoint(configuration.endpoint);
  const eventId = crypto.randomUUID();
  const event: DeliveryGatewayEvent = {
    id: eventId,
    workspaceId: "__connection_test__",
    topic: `integration.${id}.connection_test`,
    aggregateType: "system",
    aggregateId: eventId,
    payload: { dryRun: true, channel: id },
    createdAt: new Date().toISOString(),
  };
  const request = await prepareDeliveryGatewayRequest(configuration, event, { connectionTest: true });

  try {
    const response = await fetchWithDeadline(request.endpoint, {
      method: request.method,
      headers: {
        accept: "application/json",
        ...request.headers,
      },
      body: request.body,
    });
    if (response.ok) {
      if (id === "crm") {
        const evidence = await readBoundedIntegrationDiagnostic(response);
        if (
          !isRecord(evidence)
          || evidence.status !== "ok"
          || evidence.dryRun !== true
          || evidence.provider !== configuration.provider
          || evidence.mappingVersion !== configuration.mappingVersion
        ) {
          return result("failed", "CRM gateway profile evidence did not match the selected provider and field-mapping version.");
        }
      } else {
        cancelResponseBody(response, "Mail gateway diagnostic completed");
      }
      return result("passed", id === "delivery"
        ? "The mail gateway authenticated the dry-run event without sending a message."
        : "The CRM gateway authenticated the dry-run event without changing a record.");
    }
    cancelResponseBody(response, "Integration diagnostic was rejected");
    return result("failed", `${id === "delivery" ? "Mail" : "CRM"} gateway rejected the authenticated dry-run check (HTTP ${response.status}).`);
  } catch (error) {
    const timedOut = error instanceof ResponseBoundaryError
      && (error.code === "header_timeout" || error.code === "body_timeout");
    return result("failed", timedOut
      ? `${id === "delivery" ? "Mail" : "CRM"} gateway did not respond before the connection test timed out.`
      : `${id === "delivery" ? "Mail" : "CRM"} gateway could not be reached.`);
  }
}

export async function runIntegrationLiveTest(
  source: IntegrationStatusSource,
  id: IntegrationId,
): Promise<IntegrationLiveTest> {
  const summary = getIntegrationSummary(source, id);
  if (!summary.testable) throw new IntegrationNotTestableError(summary.detail);

  switch (id) {
    case "docuseal": return testDocuSeal(source);
    case "scanner": return testScanner(source);
    case "delivery": return testGateway(source, "delivery");
    case "crm": return testGateway(source, "crm");
  }
}

export class IntegrationNotTestableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationNotTestableError";
  }
}
