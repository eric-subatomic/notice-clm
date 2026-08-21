import { env } from "cloudflare:workers";
import { authorizeApiRequest } from "../../lib/api";
import { apiJson } from "../../lib/http";
import {
  attachCurrentIntegrationDiagnostics,
  loadCurrentIntegrationDiagnostics,
  requireCurrentIntegrationDiagnostics,
} from "../../lib/integration-diagnostics";
import { getIntegrationSummaries } from "../../lib/integration-status";
import { evaluateProductionReadiness, type ReadinessSource } from "../../lib/readiness";

export const dynamic = "force-dynamic";

/**
 * Machine-readable production preflight.
 *
 * The response never includes configuration values or credentials. A failing
 * production gate intentionally returns 503 so deployment checks can stop a
 * release instead of treating the report as informational.
 */
export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin");
  if (!auth.ok) return auth.response;
  const runtimeSource = env as unknown as ReadinessSource;
  const diagnostics = await loadCurrentIntegrationDiagnostics(auth.context.workspace.id, runtimeSource);
  const summaries = attachCurrentIntegrationDiagnostics(getIntegrationSummaries(runtimeSource), diagnostics);
  const readiness = requireCurrentIntegrationDiagnostics(evaluateProductionReadiness(runtimeSource), summaries);
  return apiJson(readiness, { status: readiness.readyForProduction ? 200 : 503, requestId: auth.requestId, headers: auth.headers });
}
