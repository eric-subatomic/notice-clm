import { handleRouteError } from "../../../lib/api";
import { canonicalJsonDigest } from "../../../lib/agent-governance";
import { apiJson } from "../../../lib/http";
import {
  ACTION_CATALOG_VERSION,
  AGENT_API_SCHEMA_VERSION,
  actionCatalogPolicyMetadata,
  authorizeV1ReadRequest,
  buildActionCatalog,
} from "../../../lib/service-principal-auth";

export async function GET(request: Request) {
  const auth = await authorizeV1ReadRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const actions = auth.actor.kind === "human"
      ? buildActionCatalog({ kind: "human", permissions: auth.actor.context.permissions })
      : buildActionCatalog({ kind: "service", context: auth.actor.context });
    const catalogDigest = await canonicalJsonDigest({
      schemaVersion: AGENT_API_SCHEMA_VERSION,
      catalogVersion: ACTION_CATALOG_VERSION,
      // The registry digest is stable across callers; actor-specific authority
      // remains visible in the response but is not part of catalog identity.
      actions: actionCatalogPolicyMetadata(actions),
    });
    const actor = auth.actor.kind === "human"
      ? {
        kind: "human" as const,
        userId: auth.actor.context.user.id,
        workspaceId: auth.actor.context.workspace.id,
        role: auth.actor.context.role,
      }
      : {
        kind: "service" as const,
        principalId: auth.actor.context.principal.id,
        principalName: auth.actor.context.principal.name,
        principalVersion: auth.actor.context.principal.version,
        workspaceId: auth.actor.context.workspace.id,
        identitySource: auth.actor.context.identitySource,
      };
    return apiJson({
      schemaVersion: AGENT_API_SCHEMA_VERSION,
      catalogVersion: ACTION_CATALOG_VERSION,
      catalogDigest,
      actor,
      actions,
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "The governed action catalog could not be loaded.");
  }
}
