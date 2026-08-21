import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { intakeForms } from "../../../../db/schema";
import { authorizeApiRequest } from "../../../lib/api";
import { enterpriseRouteError, parseEnterpriseListQuery } from "../../../lib/enterprise-api";
import { enterpriseContentDigest, EnterpriseError } from "../../../lib/enterprise-domain";
import { apiJson } from "../../../lib/http";

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:read");
  if (!auth.ok) return auth.response;
  try {
    const query = parseEnterpriseListQuery(request);
    if (query.status && query.status !== "published") throw new EnterpriseError(400, "invalid_query", "Only published intake forms are available here.");
    await ensureStorageSchema();
    const conditions = [eq(intakeForms.workspaceId, auth.context.workspace.id), eq(intakeForms.status, "published")];
    if (query.id) conditions.push(eq(intakeForms.id, query.id));
    const rows = await getDb().select({
      id: intakeForms.id, version: intakeForms.version, name: intakeForms.name, description: intakeForms.description,
      formSchema: intakeForms.formSchema, templateId: intakeForms.templateId,
      templateVersionId: intakeForms.templateVersionId,
      workflowDefinitionId: intakeForms.workflowDefinitionId, updatedAt: intakeForms.updatedAt,
    }).from(intakeForms).where(and(...conditions)).orderBy(desc(intakeForms.updatedAt)).limit(query.limit);
    const forms = await Promise.all(rows.map(async (form) => ({
      ...form,
      contentSha256: await enterpriseContentDigest({
        name: form.name, description: form.description, formSchema: form.formSchema,
        templateId: form.templateId, templateVersionId: form.templateVersionId,
        workflowDefinitionId: form.workflowDefinitionId,
      }, 70_000),
    })));
    return apiJson({ intakeForms: forms, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Published intake forms could not be loaded.");
  }
}
