import { and, desc, eq, exists, inArray, isNull } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { intakeForms, intakeSubmissions } from "../../../../db/schema";
import { authorizeApiRequest } from "../../../lib/api";
import { executeEnterpriseMutation, enterpriseRouteError, parseEnterpriseListQuery } from "../../../lib/enterprise-api";
import { assertExpectedVersion, EnterpriseError, validateIntakeAnswers } from "../../../lib/enterprise-domain";
import { requirePinnedTemplateVersion } from "../../../lib/enterprise-references";
import { intakeFormSchema, intakeSubmissionCreateSchema, intakeSubmissionDeleteSchema, intakeSubmissionPatchSchema } from "../../../lib/enterprise-validation";
import { apiJson } from "../../../lib/http";
import { parseJson } from "../../../lib/validation";

type Database = ReturnType<typeof getDb>;

async function requirePublishedForm(db: Database, workspaceId: string, formId: string, version?: number) {
  const conditions = [
    eq(intakeForms.workspaceId, workspaceId), eq(intakeForms.id, formId), eq(intakeForms.status, "published"),
  ];
  if (version !== undefined) conditions.push(eq(intakeForms.version, version));
  const [form] = await db.select().from(intakeForms).where(and(...conditions)).limit(1);
  if (!form) throw new EnterpriseError(422, "published_intake_form_required", "The selected published intake form is unavailable or changed.");
  const schema = intakeFormSchema.safeParse(form.formSchema);
  if (!schema.success) throw new EnterpriseError(409, "invalid_published_form_schema", "The published intake form schema is invalid.");
  await requirePinnedTemplateVersion(db, workspaceId, form.templateId, form.templateVersionId);
  return { form, schema: schema.data };
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:read");
  if (!auth.ok) return auth.response;
  try {
    const query = parseEnterpriseListQuery(request);
    const url = new URL(request.url);
    const scopes = url.searchParams.getAll("scope");
    if (scopes.length > 1 || (scopes[0] !== undefined && scopes[0] !== "mine" && scopes[0] !== "review")) {
      throw new EnterpriseError(400, "invalid_query", "scope must be mine or review.");
    }
    const scope = scopes[0] ?? "mine";
    if (scope === "review" && auth.context.role !== "admin" && auth.context.role !== "legal") {
      throw new EnterpriseError(403, "intake_review_forbidden", "Only Legal or Admin members can review submitted intake requests.");
    }
    await ensureStorageSchema();
    const conditions = [eq(intakeSubmissions.workspaceId, auth.context.workspace.id)];
    if (scope === "mine") conditions.push(eq(intakeSubmissions.submittedByUserId, auth.context.user.id));
    else {
      if (query.status && query.status !== "submitted") {
        throw new EnterpriseError(400, "invalid_query", "The review scope contains submitted requests only.");
      }
      conditions.push(eq(intakeSubmissions.status, "submitted"), isNull(intakeSubmissions.agreementId));
    }
    if (query.id) conditions.push(eq(intakeSubmissions.id, query.id));
    if (scope === "mine" && (query.status === "draft" || query.status === "submitted" || query.status === "converted" || query.status === "rejected")) {
      conditions.push(eq(intakeSubmissions.status, query.status));
    } else if (scope === "mine" && query.status) throw new EnterpriseError(400, "invalid_query", "Unsupported intake submission status.");
    const db = getDb();
    const submissions = await db.select().from(intakeSubmissions).where(and(...conditions))
      .orderBy(desc(intakeSubmissions.updatedAt)).limit(query.limit);
    const formIds = [...new Set(submissions.map((submission) => submission.formId))];
    const forms = formIds.length === 0 ? [] : await db.select({
      id: intakeForms.id,
      templateVersionId: intakeForms.templateVersionId,
    }).from(intakeForms).where(and(
      eq(intakeForms.workspaceId, auth.context.workspace.id), inArray(intakeForms.id, formIds),
    )).limit(formIds.length);
    const templateVersionByForm = new Map(forms.map((form) => [form.id, form.templateVersionId]));
    const projected = submissions.map((submission) => ({
      ...submission,
      templateVersionId: templateVersionByForm.get(submission.formId) ?? null,
    }));
    return apiJson({ scope, intakeSubmissions: projected, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Your intake submissions could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:create", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, intakeSubmissionCreateSchema, 140_000);
    await ensureStorageSchema();
    const db = getDb();
    const { form, schema } = await requirePublishedForm(db, auth.context.workspace.id, input.formId);
    validateIntakeAnswers(schema, input.answers, { requireComplete: false });
    const now = new Date().toISOString();
    const submission = {
      id: crypto.randomUUID(), workspaceId: auth.context.workspace.id, formId: form.id, formVersion: form.version,
      version: 1, status: "draft" as const, answers: input.answers, submittedByUserId: auth.context.user.id,
      agreementId: null, createdAt: now, updatedAt: now, submittedAt: null, convertedAt: null,
    };
    await executeEnterpriseMutation(db, {
      workspaceId: submission.workspaceId, actor: auth.context.user, type: "IntakeSubmissionCreated",
      detail: { action: "intake_submission.created", submissionId: submission.id, formId: form.id, formVersion: form.version, version: 1 },
      steps: [{ statement: db.insert(intakeSubmissions).values(submission) }], createdAt: now,
    });
    return apiJson({ intakeSubmission: { ...submission, templateVersionId: form.templateVersionId }, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The intake submission draft could not be created.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:create", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, intakeSubmissionPatchSchema, 140_000);
    const isReviewerDecision = input.action === "reject";
    if (isReviewerDecision && auth.context.role !== "admin" && auth.context.role !== "legal") {
      throw new EnterpriseError(403, "intake_review_forbidden", "Only Legal or Admin members can reject a submitted intake request.");
    }
    await ensureStorageSchema();
    const db = getDb();
    const currentConditions = [
      eq(intakeSubmissions.workspaceId, auth.context.workspace.id), eq(intakeSubmissions.id, input.id),
    ];
    if (!isReviewerDecision) currentConditions.push(eq(intakeSubmissions.submittedByUserId, auth.context.user.id));
    const [current] = await db.select().from(intakeSubmissions).where(and(...currentConditions)).limit(1);
    if (!current) throw new EnterpriseError(404, "intake_submission_not_found", "Intake submission was not found.");
    assertExpectedVersion(current.version, input.version);
    if (isReviewerDecision) {
      if (current.status !== "submitted" || current.agreementId !== null) {
        throw new EnterpriseError(409, "intake_submission_not_reviewable", "Only an unconverted submitted intake request can be rejected.");
      }
      const now = new Date().toISOString();
      const version = current.version + 1;
      const patch = { status: "rejected" as const, updatedAt: now, version };
      await executeEnterpriseMutation(db, {
        workspaceId: current.workspaceId, actor: auth.context.user, type: "IntakeSubmissionRejected",
        detail: {
          action: "intake_submission.rejected", submissionId: current.id, formId: current.formId,
          formVersion: current.formVersion, reason: input.reason, previousVersion: current.version, version,
        },
        steps: [{ statement: db.update(intakeSubmissions).set(patch).where(and(
          eq(intakeSubmissions.workspaceId, current.workspaceId), eq(intakeSubmissions.id, current.id),
          eq(intakeSubmissions.version, current.version), eq(intakeSubmissions.status, "submitted"),
          isNull(intakeSubmissions.agreementId),
        )), guardOperation: "intake-submission.reject" }], createdAt: now,
      });
      const [form] = await db.select({ templateVersionId: intakeForms.templateVersionId }).from(intakeForms).where(and(
        eq(intakeForms.workspaceId, current.workspaceId), eq(intakeForms.id, current.formId),
      )).limit(1);
      return apiJson({
        intakeSubmission: { ...current, ...patch, templateVersionId: form?.templateVersionId ?? null },
        requestId: auth.requestId,
      }, { requestId: auth.requestId, headers: auth.headers });
    }
    if (current.status !== "draft") throw new EnterpriseError(409, "intake_submission_immutable", "A submitted intake record cannot be changed.");
    const { form, schema } = await requirePublishedForm(db, current.workspaceId, current.formId, current.formVersion);
    const answers = input.answers ?? current.answers;
    validateIntakeAnswers(schema, answers, { requireComplete: input.action === "submit" });
    const now = new Date().toISOString();
    const version = current.version + 1;
    const patch = input.action === "submit"
      ? { answers, status: "submitted" as const, submittedAt: now, updatedAt: now, version }
      : { answers, updatedAt: now, version };
    await executeEnterpriseMutation(db, {
      workspaceId: current.workspaceId, actor: auth.context.user,
      type: input.action === "submit" ? "IntakeSubmissionSubmitted" : "IntakeSubmissionUpdated",
      detail: { action: input.action === "submit" ? "intake_submission.submitted" : "intake_submission.updated", submissionId: current.id, formId: current.formId, formVersion: current.formVersion, previousVersion: current.version, version },
      steps: [{ statement: db.update(intakeSubmissions).set(patch).where(and(
        eq(intakeSubmissions.workspaceId, current.workspaceId), eq(intakeSubmissions.id, current.id),
        eq(intakeSubmissions.submittedByUserId, auth.context.user.id), eq(intakeSubmissions.version, current.version),
        eq(intakeSubmissions.status, "draft"),
        input.action === "submit" ? exists(db.select({ id: intakeForms.id }).from(intakeForms).where(and(
          eq(intakeForms.workspaceId, current.workspaceId),
          eq(intakeForms.id, current.formId),
          eq(intakeForms.version, current.formVersion),
          eq(intakeForms.status, "published"),
        )).limit(1)) : undefined,
      )), guardOperation: `intake-submission.${input.action}` }], createdAt: now,
    });
    return apiJson({ intakeSubmission: { ...current, ...patch, templateVersionId: form.templateVersionId }, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The intake submission could not be changed.");
  }
}

export async function DELETE(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:create", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, intakeSubmissionDeleteSchema, 10_000);
    await ensureStorageSchema();
    const db = getDb();
    const [current] = await db.select().from(intakeSubmissions).where(and(
      eq(intakeSubmissions.workspaceId, auth.context.workspace.id), eq(intakeSubmissions.id, input.id),
      eq(intakeSubmissions.submittedByUserId, auth.context.user.id),
    )).limit(1);
    if (!current) throw new EnterpriseError(404, "intake_submission_not_found", "Intake submission was not found.");
    assertExpectedVersion(current.version, input.version);
    if (current.status !== "draft") throw new EnterpriseError(409, "intake_submission_immutable", "A submitted intake record cannot be removed.");
    const now = new Date().toISOString();
    await executeEnterpriseMutation(db, {
      workspaceId: current.workspaceId, actor: auth.context.user, type: "IntakeSubmissionDeleted",
      detail: { action: "intake_submission.deleted", submissionId: current.id, formId: current.formId, formVersion: current.formVersion, reason: input.reason, version: current.version },
      steps: [{ statement: db.delete(intakeSubmissions).where(and(
        eq(intakeSubmissions.workspaceId, current.workspaceId), eq(intakeSubmissions.id, current.id),
        eq(intakeSubmissions.submittedByUserId, auth.context.user.id), eq(intakeSubmissions.version, current.version),
        eq(intakeSubmissions.status, "draft"),
      )), guardOperation: "intake-submission.delete-draft" }], createdAt: now,
    });
    return apiJson({ deleted: true, id: current.id, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The intake submission draft could not be removed.");
  }
}
