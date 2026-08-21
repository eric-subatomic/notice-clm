import { createCrmAdapter } from "./providers";
import { D1ReceiptStore } from "./receipt-store";
import { CrmGatewayOperations, validateOperationsSecret } from "./operations";
import { CrmGatewayService, type ScheduledRunResult } from "./service";

export type CrmGatewayEnv = Record<string, unknown> & {
  CRM_DB: D1Database;
  NOTICE_INGRESS_SECRET: string;
  NOTICE_INGRESS_PREVIOUS_SECRET?: string;
  NOTICE_OPERATIONS_SECRET: string;
  NOTICE_CRM_MAPPING_VERSION?: string;
  NOTICE_CRM_TERMINAL_PAYLOAD_RETENTION_DAYS?: string;
  NOTICE_CRM_TERMINAL_METADATA_RETENTION_DAYS?: string;
};

export function createCrmGatewayService(env: CrmGatewayEnv): CrmGatewayService {
  return createCrmGatewayRuntime(env).service;
}

export function assertSuccessfulCrmGatewayScheduledRun(result: ScheduledRunResult): ScheduledRunResult {
  if (
    !Number.isSafeInteger(result.examined)
    || result.examined < 0
    || !Number.isSafeInteger(result.processingErrors)
    || result.processingErrors < 0
    || result.processingErrors > result.examined
  ) {
    throw new Error("CRM gateway scheduled result is invalid");
  }
  if (result.processingErrors > 0) {
    throw new Error("CRM gateway scheduled work left processing errors");
  }
  return result;
}

export function createCrmGatewayRuntime(env: CrmGatewayEnv) {
  validateDatabase(env.CRM_DB);
  const ingressSecret = validateIngressSecret(env.NOTICE_INGRESS_SECRET, false);
  const previousIngressSecret = validateIngressSecret(env.NOTICE_INGRESS_PREVIOUS_SECRET, true);
  const operationsSecret = validateOperationsSecret(env.NOTICE_OPERATIONS_SECRET);
  if (operationsSecret === ingressSecret || operationsSecret === previousIngressSecret) {
    throw new Error("CRM ingress and operations secrets must be distinct");
  }
  const mappingVersion = env.NOTICE_CRM_MAPPING_VERSION?.trim() || "v1";
  const terminalPayloadDays = retentionDays(env.NOTICE_CRM_TERMINAL_PAYLOAD_RETENTION_DAYS, 90);
  const terminalMetadataDays = retentionDays(env.NOTICE_CRM_TERMINAL_METADATA_RETENTION_DAYS, 365);
  if (terminalMetadataDays < terminalPayloadDays) {
    throw new Error("CRM terminal metadata retention must cover payload retention");
  }
  const store = new D1ReceiptStore(env.CRM_DB);
  const adapter = createCrmAdapter(env);
  const service = new CrmGatewayService({
    ingressSecrets: [ingressSecret, previousIngressSecret ?? ""],
    mappingVersion,
    store,
    adapter,
    terminalPayloadRetentionMs: terminalPayloadDays * 24 * 60 * 60_000,
    terminalMetadataRetentionMs: terminalMetadataDays * 24 * 60 * 60_000,
  });
  const operations = new CrmGatewayOperations({
    secret: operationsSecret,
    provider: adapter.provider,
    mappingVersion,
    store,
  });
  return Object.freeze({ service, operations, store });
}

export async function handleCrmGatewayRequest(
  request: Request,
  env: CrmGatewayEnv,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") {
    if (request.method !== "GET") return minimalError(405, "method_not_allowed");
    try {
      const runtime = createCrmGatewayRuntime(env);
      await runtime.store.checkReady();
      return minimalJson(200, { status: "ok" });
    } catch {
      return minimalJson(503, { status: "unhealthy" });
    }
  }

  if (url.pathname === "/v1/operations" || url.pathname.startsWith("/v1/operations/")) {
    try {
      return await createCrmGatewayRuntime(env).operations.handle(request);
    } catch {
      return minimalError(503, "gateway_unavailable");
    }
  }
  if (url.pathname !== "/v1/events") return minimalError(404, "not_found");

  try {
    return await createCrmGatewayRuntime(env).service.handleEvent(request, context);
  } catch {
    return minimalError(503, "gateway_unavailable");
  }
}

const worker = {
  async fetch(request: Request, env: CrmGatewayEnv, context: ExecutionContext): Promise<Response> {
    return handleCrmGatewayRequest(request, env, context);
  },

  async scheduled(
    _controller: ScheduledController,
    env: CrmGatewayEnv,
  ): Promise<void> {
    let service: CrmGatewayService;
    try {
      service = createCrmGatewayService(env);
    } catch {
      console.error("notice_crm_gateway_configuration_failed");
      throw new Error("CRM gateway scheduled configuration failed");
    }
    try {
      assertSuccessfulCrmGatewayScheduledRun(await service.runScheduled());
    } catch {
      console.error("notice_crm_gateway_scheduled_failed");
      throw new Error("CRM gateway scheduled work failed");
    }
  },
} satisfies ExportedHandler<CrmGatewayEnv>;

export default worker;

function minimalError(status: number, code: string): Response {
  return minimalJson(status, { error: { code } });
}

function minimalJson(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function validateDatabase(candidate: unknown): asserts candidate is D1Database {
  if (
    typeof candidate !== "object"
    || candidate === null
    || typeof (candidate as { prepare?: unknown }).prepare !== "function"
    || typeof (candidate as { batch?: unknown }).batch !== "function"
  ) throw new Error("CRM database binding is invalid");
}

function validateIngressSecret(candidate: unknown, optional: false): string;
function validateIngressSecret(candidate: unknown, optional: true): string | null;
function validateIngressSecret(candidate: unknown, optional: boolean): string | null {
  if (optional && (candidate === undefined || candidate === "")) return null;
  if (
    typeof candidate !== "string"
    || candidate.length < 32
    || candidate.length > 4_096
    || candidate.includes("\0")
  ) throw new Error("CRM ingress secret is invalid");
  return candidate;
}

function retentionDays(candidate: unknown, fallback: number): number {
  if (candidate === undefined || candidate === "") return fallback;
  if (typeof candidate !== "string" || !/^[1-9]\d{0,3}$/.test(candidate)) {
    throw new Error("CRM retention is invalid");
  }
  const days = Number(candidate);
  if (!Number.isSafeInteger(days) || days > 3_650) throw new Error("CRM retention is invalid");
  return days;
}
