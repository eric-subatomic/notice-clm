import { agentOpenApiDocument } from "../../../lib/agent-openapi";
import { apiJson, createRequestId } from "../../../lib/http";

export async function GET() {
  const requestId = createRequestId();
  return apiJson(agentOpenApiDocument, { requestId });
}
