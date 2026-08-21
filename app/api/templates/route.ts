import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { ensureStorageSchema } from "../../../db/ensure";
import { governedTemplates, governedTemplateVersions } from "../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../lib/api";
import { apiError, apiJson } from "../../lib/http";

const PUBLISHED_TEMPLATE_LIMIT = 200;

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:read");
  if (!auth.ok) return auth.response;
  try {
    if ([...new URL(request.url).searchParams].length > 0) {
      return apiError("invalid_query", "The published template list does not accept query parameters.", {
        status: 400,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }
    await ensureStorageSchema();
    const db = getDb();
    const rows = await db.select({
      id: governedTemplates.id,
      version: governedTemplates.version,
      name: governedTemplates.name,
      description: governedTemplates.description,
      agreementType: governedTemplates.agreementType,
      side: governedTemplates.side,
      status: governedTemplates.status,
      currentPublishedVersion: governedTemplates.currentPublishedVersion,
      publishedVersion: {
        id: governedTemplateVersions.id,
        templateId: governedTemplateVersions.templateId,
        version: governedTemplateVersions.version,
        status: governedTemplateVersions.status,
        body: governedTemplateVersions.body,
        variableSchema: governedTemplateVersions.variableSchema,
        languageBlockIds: governedTemplateVersions.languageBlockIds,
        contentSha256: governedTemplateVersions.contentSha256,
        changeSummary: governedTemplateVersions.changeSummary,
        createdByUserId: governedTemplateVersions.createdByUserId,
        createdAt: governedTemplateVersions.createdAt,
        reviewedByUserId: governedTemplateVersions.reviewedByUserId,
        reviewedAt: governedTemplateVersions.reviewedAt,
      },
    }).from(governedTemplates).innerJoin(governedTemplateVersions, and(
      eq(governedTemplateVersions.workspaceId, governedTemplates.workspaceId),
      eq(governedTemplateVersions.templateId, governedTemplates.id),
      eq(governedTemplateVersions.version, governedTemplates.currentPublishedVersion),
      eq(governedTemplateVersions.status, "published"),
    )).where(and(
      eq(governedTemplates.workspaceId, auth.context.workspace.id),
      eq(governedTemplates.status, "published"),
    )).orderBy(asc(governedTemplates.name), asc(governedTemplates.id)).limit(PUBLISHED_TEMPLATE_LIMIT);
    return apiJson({ templates: rows, requestId: auth.requestId }, {
      requestId: auth.requestId,
      headers: auth.headers,
    });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Published governed templates could not be loaded.");
  }
}
