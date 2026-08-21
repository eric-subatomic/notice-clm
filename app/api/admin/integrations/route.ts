import { env } from "cloudflare:workers";
import { z } from "zod";
import { ensureStorageSchema } from "../../../../db/ensure";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import { apiError, apiJson } from "../../../lib/http";
import {
  attachCurrentIntegrationDiagnostics,
  loadCurrentIntegrationDiagnostics,
  recordIntegrationDiagnostic,
} from "../../../lib/integration-diagnostics";
import { IntegrationNotTestableError, runIntegrationLiveTest } from "../../../lib/integration-runtime";
import {
  getIntegrationSummaries,
  getIntegrationSummary,
  integrationIds,
  type IntegrationStatusSource,
} from "../../../lib/integration-status";
import { parseJson } from "../../../lib/validation";

export const dynamic = "force-dynamic";

const liveTestSchema = z.object({
  provider: z.enum(integrationIds),
}).strict();

function source(): IntegrationStatusSource {
  return env as unknown as IntegrationStatusSource;
}
export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "integration:manage");
  if (!auth.ok) return auth.response;

  try {
    await ensureStorageSchema();
    const runtimeSource = source();
    const diagnostics = await loadCurrentIntegrationDiagnostics(auth.context.workspace.id, runtimeSource);
    return apiJson({
      integrations: attachCurrentIntegrationDiagnostics(getIntegrationSummaries(runtimeSource), diagnostics),
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Integration status could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "integration:manage", { limit: 12 });
  if (!auth.ok) return auth.response;

  try {
    const input = await parseJson(request, liveTestSchema, 8_000);
    await ensureStorageSchema();
    const runtimeSource = source();
    const summary = getIntegrationSummary(runtimeSource, input.provider);
    if (!summary.testable) {
      return apiError("integration_not_testable", summary.detail, {
        status: 409,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }

    const lastTest = await runIntegrationLiveTest(runtimeSource, input.provider);
    await recordIntegrationDiagnostic({
      workspaceId: auth.context.workspace.id,
      testedByUserId: auth.context.user.id,
      source: runtimeSource,
      id: input.provider,
      result: lastTest,
    });
    return apiJson({
      integration: { ...summary, lastTest },
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    if (error instanceof IntegrationNotTestableError) {
      return apiError("integration_not_testable", error.message, { status: 409, requestId: auth.requestId });
    }
    return handleRouteError(error, auth.requestId, "The integration connection test could not be completed.");
  }
}
