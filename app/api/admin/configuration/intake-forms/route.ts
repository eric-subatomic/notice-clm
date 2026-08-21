import { and, desc, eq, exists, isNull, notExists } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import { governedTemplates, governedTemplateVersions, intakeForms, intakeSubmissions } from "../../../../../db/schema";
import { authorizeApiRequest } from "../../../../lib/api";
import { executeEnterpriseMutation, enterpriseRouteError, parseEnterpriseListQuery } from "../../../../lib/enterprise-api";
import {
  assertDistinctPublisher,
  assertExpectedVersion,
  assertLifecycleTransition,
  enterpriseContentDigest,
  EnterpriseError,
  isUniqueConstraintError,
  omitEnterpriseProperties,
} from "../../../../lib/enterprise-domain";
import { requirePublishedConfigurationReferences } from "../../../../lib/enterprise-references";
import { intakeFormCreateSchema, intakeFormPatchSchema } from "../../../../lib/enterprise-validation";
import { apiJson } from "../../../../lib/http";
import { parseJson } from "../../../../lib/validation";

type IntakeFormContent = Readonly<{
  name: string;
  description: string;
  formSchema: Record<string, unknown>;
  templateId: string | null;
  templateVersionId: string | null;
  workflowDefinitionId: string | null;
}>;

function formContent(form: IntakeFormContent) {
  return {
    name: form.name,
    description: form.description,
    formSchema: form.formSchema,
    templateId: form.templateId,
    templateVersionId: form.templateVersionId,
    workflowDefinitionId: form.workflowDefinitionId,
  };
}

async function withDigest<T extends IntakeFormContent>(form: T) {
  return { ...form, contentSha256: await enterpriseContentDigest(formContent(form), 70_000) };
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin");
  if (!auth.ok) return auth.response;
  try {
    const query = parseEnterpriseListQuery(request);
    await ensureStorageSchema();
    const conditions = [eq(intakeForms.workspaceId, auth.context.workspace.id)];
    if (query.id) conditions.push(eq(intakeForms.id, query.id));
    if (query.status === "draft" || query.status === "published" || query.status === "retired") conditions.push(eq(intakeForms.status, query.status));
    else if (query.status) throw new EnterpriseError(400, "invalid_query", "Unsupported intake form status.");
    const rows = await getDb().select().from(intakeForms).where(and(...conditions)).orderBy(desc(intakeForms.updatedAt)).limit(query.limit);
    const forms = await Promise.all(rows.map(withDigest));
    return apiJson({ intakeForms: forms, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Intake forms could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, intakeFormCreateSchema, 80_000);
    await ensureStorageSchema();
    const db = getDb();
    await requirePublishedConfigurationReferences(db, auth.context.workspace.id, input);
    const now = new Date().toISOString();
    const form = {
      id: crypto.randomUUID(), workspaceId: auth.context.workspace.id, version: 1,
      name: input.name, description: input.description, status: "draft" as const,
      formSchema: input.formSchema, templateId: input.templateId, templateVersionId: null,
      workflowDefinitionId: input.workflowDefinitionId,
      createdByUserId: auth.context.user.id, createdAt: now, updatedByUserId: auth.context.user.id, updatedAt: now,
    };
    const contentSha256 = await enterpriseContentDigest(formContent(form), 70_000);
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: form.workspaceId, actor: auth.context.user, type: "IntakeFormCreated",
        detail: { action: "intake_form.created", formId: form.id, version: 1, contentSha256 },
        steps: [{ statement: db.insert(intakeForms).values(form) }], createdAt: now,
      });
    } catch (error) {
      if (isUniqueConstraintError(error, ["intake_forms.workspace_id", "intake_forms.name"])) {
        throw new EnterpriseError(409, "intake_form_exists", "An intake form with that name already exists in this workspace.");
      }
      throw error;
    }
    return apiJson({ intakeForm: { ...form, contentSha256 }, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The intake form could not be created.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 40 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, intakeFormPatchSchema, 80_000);
    await ensureStorageSchema();
    const db = getDb();
    const [current] = await db.select().from(intakeForms).where(and(
      eq(intakeForms.workspaceId, auth.context.workspace.id), eq(intakeForms.id, input.id),
    )).limit(1);
    if (!current) throw new EnterpriseError(404, "intake_form_not_found", "Intake form was not found.");
    assertExpectedVersion(current.version, input.version);
    const now = new Date().toISOString();

    if (input.action === "update_draft") {
      if (current.status !== "draft") throw new EnterpriseError(409, "intake_form_immutable", "Published or retired intake form content cannot be changed.");
      const changes = omitEnterpriseProperties(input, ["action", "id", "version"]);
      const saved = {
        ...current, ...changes, templateVersionId: null,
        version: current.version + 1, updatedByUserId: auth.context.user.id, updatedAt: now,
      };
      await requirePublishedConfigurationReferences(db, current.workspaceId, saved);
      const contentSha256 = await enterpriseContentDigest(formContent(saved), 70_000);
      try {
        await executeEnterpriseMutation(db, {
          workspaceId: current.workspaceId, actor: auth.context.user, type: "IntakeFormUpdated",
          detail: { action: "intake_form.updated", formId: current.id, previousVersion: current.version, version: saved.version, contentSha256 },
          steps: [{ statement: db.update(intakeForms).set({
            ...changes, templateVersionId: null, version: saved.version,
            updatedByUserId: saved.updatedByUserId, updatedAt: now,
          }).where(and(
            eq(intakeForms.workspaceId, current.workspaceId), eq(intakeForms.id, current.id),
            eq(intakeForms.version, current.version), eq(intakeForms.status, "draft"),
          )), guardOperation: "intake-form.update-draft" }], createdAt: now,
        });
      } catch (error) {
        if (isUniqueConstraintError(error, ["intake_forms.workspace_id", "intake_forms.name"])) {
          throw new EnterpriseError(409, "intake_form_exists", "An intake form with that name already exists in this workspace.");
        }
        throw error;
      }
      return apiJson({ intakeForm: { ...saved, contentSha256 }, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }

    const nextStatus = input.action === "publish" ? "published" : "retired";
    assertLifecycleTransition(current.status, nextStatus);
    if (input.action === "retire") {
      const [pendingSubmission] = await db.select({ id: intakeSubmissions.id }).from(intakeSubmissions).where(and(
        eq(intakeSubmissions.workspaceId, current.workspaceId),
        eq(intakeSubmissions.formId, current.id),
        eq(intakeSubmissions.formVersion, current.version),
        eq(intakeSubmissions.status, "submitted"),
        isNull(intakeSubmissions.agreementId),
      )).limit(1);
      if (pendingSubmission) {
        throw new EnterpriseError(409, "intake_form_has_pending_submissions", "Convert or resolve every submitted request before retiring this intake form.");
      }
    }
    let templateVersionId = current.templateVersionId;
    if (input.action === "publish") {
      assertDistinctPublisher(current.createdByUserId, auth.context.user.id);
      const resolved = await requirePublishedConfigurationReferences(db, current.workspaceId, current);
      templateVersionId = resolved.templateVersionId;
    }
    const lifecycleForm = { ...current, templateVersionId };
    const contentSha256 = await enterpriseContentDigest(formContent(lifecycleForm), 70_000);
    const version = current.version + 1;
    await executeEnterpriseMutation(db, {
      workspaceId: current.workspaceId, actor: auth.context.user,
      type: input.action === "publish" ? "IntakeFormPublished" : "IntakeFormRetired",
      detail: { action: input.action === "publish" ? "intake_form.published" : "intake_form.retired", formId: current.id, reason: input.reason, previousVersion: current.version, version, contentSha256 },
      steps: [{ statement: db.update(intakeForms).set({
        status: nextStatus, templateVersionId, version, updatedByUserId: auth.context.user.id, updatedAt: now,
      }).where(and(
        eq(intakeForms.workspaceId, current.workspaceId), eq(intakeForms.id, current.id),
        eq(intakeForms.version, current.version), eq(intakeForms.status, current.status),
        input.action === "publish" && current.templateId && templateVersionId ? exists(
          db.select({ id: governedTemplateVersions.id }).from(governedTemplateVersions).innerJoin(governedTemplates, and(
            eq(governedTemplates.workspaceId, governedTemplateVersions.workspaceId),
            eq(governedTemplates.id, governedTemplateVersions.templateId),
          )).where(and(
            eq(governedTemplateVersions.workspaceId, current.workspaceId),
            eq(governedTemplateVersions.id, templateVersionId),
            eq(governedTemplateVersions.templateId, current.templateId),
            eq(governedTemplateVersions.status, "published"),
            eq(governedTemplates.status, "published"),
            eq(governedTemplates.currentPublishedVersion, governedTemplateVersions.version),
          )).limit(1)
        ) : undefined,
        input.action === "retire" ? notExists(db.select({ id: intakeSubmissions.id }).from(intakeSubmissions).where(and(
          eq(intakeSubmissions.workspaceId, current.workspaceId),
          eq(intakeSubmissions.formId, current.id),
          eq(intakeSubmissions.formVersion, current.version),
          eq(intakeSubmissions.status, "submitted"),
          isNull(intakeSubmissions.agreementId),
        )).limit(1)) : undefined,
      )), guardOperation: `intake-form.${input.action}` }], createdAt: now,
    });
    return apiJson({ intakeForm: { ...current, status: nextStatus, templateVersionId, version, updatedByUserId: auth.context.user.id, updatedAt: now, contentSha256 }, requestId: auth.requestId }, {
      requestId: auth.requestId, headers: auth.headers,
    });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The intake form could not be changed.");
  }
}
