import { and, eq, exists, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../../../db";
import { ensureStorageSchema } from "../../../../../../db/ensure";
import {
  agreementEvents,
  agreements,
  agreementVersions,
  counterparties,
  governedTemplates,
  governedTemplateVersions,
  intakeForms,
  intakeSubmissions,
  legalEntities,
  outboxEvents,
  users,
  workflowDefinitions,
  workspaceMemberships,
} from "../../../../../../db/schema";
import { authorizeApiRequest } from "../../../../../lib/api";
import { executeEnterpriseMutation, enterpriseRouteError } from "../../../../../lib/enterprise-api";
import { enterpriseContentDigest, EnterpriseError } from "../../../../../lib/enterprise-domain";
import { requireActiveWorkspaceMember } from "../../../../../lib/enterprise-references";
import { intakeSubmissionConvertSchema } from "../../../../../lib/enterprise-validation";
import { apiJson } from "../../../../../lib/http";
import { configuredCrmSelectionError } from "../../../../../lib/crm-selection";
import {
  crmAgreementProjection,
  prepareIntegrationOutboxEvent,
} from "../../../../../lib/integration-events";
import { minorUnitsFromWholeUnits, wholeUnitProjection } from "../../../../../lib/money";
import {
  isMutationGuardConflict,
  prepareAgreementEvent,
  prepareAgreementSnapshot,
  prepareOutboxEvent,
} from "../../../../../lib/persistence";
import { parseJson } from "../../../../../lib/validation";
import { governedWorkflowSnapshot } from "../../../../../lib/workflow-policy";

type Database = ReturnType<typeof getDb>;
type ConversionProjection = Readonly<{
  submissionId: string;
  agreementId: number;
  submissionVersion: number;
  status: "converted";
  convertedAt: string;
}>;

const submissionIdSchema = z.string().uuid().transform((value) => value.toLowerCase());

function newAgreementId(): number {
  const random = crypto.getRandomValues(new Uint16Array(1))[0] % 1_000;
  return Date.now() * 1_000 + random;
}

function agreementInitials(party: string): string {
  return party.split(/\s+/).filter(Boolean).map((word) => word[0]).join("").slice(0, 3).toUpperCase() || "NA";
}

async function convertedProjection(
  db: Database,
  workspaceId: string,
  submissionId: string,
): Promise<ConversionProjection | null> {
  const [submission] = await db.select({
    id: intakeSubmissions.id,
    version: intakeSubmissions.version,
    status: intakeSubmissions.status,
    agreementId: intakeSubmissions.agreementId,
    convertedAt: intakeSubmissions.convertedAt,
  }).from(intakeSubmissions).where(and(
    eq(intakeSubmissions.workspaceId, workspaceId),
    eq(intakeSubmissions.id, submissionId),
  )).limit(1);
  if (!submission || submission.status !== "converted") return null;
  if (submission.agreementId === null || submission.convertedAt === null) {
    throw new EnterpriseError(409, "intake_conversion_incomplete", "This intake conversion is incomplete and requires administrator review.");
  }
  const [agreement] = await db.select({ id: agreements.id }).from(agreements).where(and(
    eq(agreements.workspaceId, workspaceId),
    eq(agreements.id, submission.agreementId),
  )).limit(1);
  if (!agreement) {
    throw new EnterpriseError(409, "intake_conversion_incomplete", "This intake conversion is incomplete and requires administrator review.");
  }
  return {
    submissionId: submission.id,
    agreementId: submission.agreementId,
    submissionVersion: submission.version,
    status: "converted",
    convertedAt: submission.convertedAt,
  };
}

function conversionResponse(
  projection: ConversionProjection,
  requestId: string,
  headers: Headers,
  replay: boolean,
): Response {
  const responseHeaders = new Headers(headers);
  if (replay) responseHeaders.set("Idempotency-Replayed", "true");
  return apiJson({ conversion: projection, replay, requestId }, {
    status: replay ? 200 : 201,
    requestId,
    headers: responseHeaders,
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApiRequest(request, "agreement:create", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    if (auth.context.role !== "admin" && auth.context.role !== "legal") {
      throw new EnterpriseError(403, "intake_conversion_forbidden", "Only Legal or Admin members can convert submitted intake requests.");
    }
    const parsedSubmissionId = submissionIdSchema.safeParse((await context.params).id);
    if (!parsedSubmissionId.success) {
      throw new EnterpriseError(404, "intake_submission_not_found", "Intake submission was not found.");
    }
    const submissionId = parsedSubmissionId.data;
    await ensureStorageSchema();
    const db = getDb();
    const replay = await convertedProjection(db, auth.context.workspace.id, submissionId);
    if (replay) return conversionResponse(replay, auth.requestId, auth.headers, true);

    const input = await parseJson(request, intakeSubmissionConvertSchema, 32_000);
    const crmSelectionError = configuredCrmSelectionError(input.agreement.crm, auth.requestId, auth.headers);
    if (crmSelectionError) return crmSelectionError;
    const [submission] = await db.select().from(intakeSubmissions).where(and(
      eq(intakeSubmissions.workspaceId, auth.context.workspace.id),
      eq(intakeSubmissions.id, submissionId),
    )).limit(1);
    if (!submission) throw new EnterpriseError(404, "intake_submission_not_found", "Intake submission was not found.");
    if (submission.status === "converted") {
      const winner = await convertedProjection(db, submission.workspaceId, submissionId);
      if (winner) return conversionResponse(winner, auth.requestId, auth.headers, true);
    }
    if (submission.status !== "submitted" || submission.agreementId !== null) {
      throw new EnterpriseError(409, "intake_submission_not_convertible", "Only a submitted, unconverted intake record can be converted.");
    }
    if (submission.version !== input.version) {
      throw new EnterpriseError(409, "version_conflict", "The intake submission changed. Reload it before conversion.");
    }
    if (submission.formVersion !== input.formVersion) {
      throw new EnterpriseError(409, "intake_configuration_changed", "The reviewed intake form version no longer matches this submission.");
    }

    const [form] = await db.select().from(intakeForms).where(and(
      eq(intakeForms.workspaceId, submission.workspaceId),
      eq(intakeForms.id, submission.formId),
      eq(intakeForms.version, submission.formVersion),
      eq(intakeForms.status, "published"),
    )).limit(1);
    if (!form) {
      throw new EnterpriseError(409, "intake_configuration_changed", "The exact published intake form is no longer available for conversion.");
    }
    if (form.templateVersionId !== input.templateVersionId || form.workflowDefinitionId !== input.workflowDefinitionId) {
      throw new EnterpriseError(409, "intake_configuration_changed", "The reviewed template or workflow pin does not match the submitted intake record.");
    }
    if ((form.templateId === null) !== (form.templateVersionId === null)) {
      throw new EnterpriseError(409, "intake_configuration_changed", "The intake form's governed template pin is incomplete.");
    }

    const [templateVersion] = form.templateVersionId === null ? [undefined] : await db.select({
      id: governedTemplateVersions.id,
      templateId: governedTemplateVersions.templateId,
      body: governedTemplateVersions.body,
      variableSchema: governedTemplateVersions.variableSchema,
      languageBlockIds: governedTemplateVersions.languageBlockIds,
      contentSha256: governedTemplateVersions.contentSha256,
      agreementType: governedTemplates.agreementType,
      side: governedTemplates.side,
    }).from(governedTemplateVersions).innerJoin(governedTemplates, and(
      eq(governedTemplates.workspaceId, governedTemplateVersions.workspaceId),
      eq(governedTemplates.id, governedTemplateVersions.templateId),
    )).where(and(
      eq(governedTemplateVersions.workspaceId, submission.workspaceId),
      eq(governedTemplateVersions.id, form.templateVersionId),
      eq(governedTemplateVersions.templateId, form.templateId!),
      eq(governedTemplateVersions.status, "published"),
      eq(governedTemplates.status, "published"),
    )).limit(1);
    if (form.templateVersionId !== null && !templateVersion) {
      throw new EnterpriseError(409, "intake_configuration_changed", "The exact governed template version is no longer available.");
    }
    if (templateVersion) {
      const contentSha256 = await enterpriseContentDigest({
        body: templateVersion.body,
        variableSchema: templateVersion.variableSchema,
        languageBlockIds: templateVersion.languageBlockIds,
      }, 600_000);
      if (contentSha256 !== templateVersion.contentSha256) {
        throw new EnterpriseError(409, "content_digest_mismatch", "The governed template version no longer matches its immutable digest.");
      }
      if (templateVersion.side !== input.agreement.side || templateVersion.agreementType !== input.agreement.type) {
        throw new EnterpriseError(422, "template_agreement_mismatch", "The agreement type and side must match the intake form's exact governed template version.");
      }
    }

    const [workflowDefinition] = form.workflowDefinitionId === null ? [undefined] : await db.select({
      id: workflowDefinitions.id,
      definition: workflowDefinitions.definition,
      definitionSha256: workflowDefinitions.definitionSha256,
    }).from(workflowDefinitions).where(and(
      eq(workflowDefinitions.workspaceId, submission.workspaceId),
      eq(workflowDefinitions.id, form.workflowDefinitionId),
      eq(workflowDefinitions.status, "published"),
    )).limit(1);
    if (form.workflowDefinitionId !== null && !workflowDefinition) {
      throw new EnterpriseError(409, "intake_configuration_changed", "The exact governed workflow definition is no longer available.");
    }

    const ownerUserId = input.agreement.ownerUserId ?? auth.context.user.id;
    const owner = await requireActiveWorkspaceMember(db, submission.workspaceId, ownerUserId);
    const [[counterparty], [legalEntity]] = await Promise.all([
      input.agreement.primaryCounterpartyId
        ? db.select({ id: counterparties.id, displayName: counterparties.displayName }).from(counterparties).where(and(
            eq(counterparties.workspaceId, submission.workspaceId),
            eq(counterparties.id, input.agreement.primaryCounterpartyId),
            eq(counterparties.status, "active"),
          )).limit(1)
        : Promise.resolve([]),
      input.agreement.legalEntityId
        ? db.select({ id: legalEntities.id }).from(legalEntities).where(and(
            eq(legalEntities.workspaceId, submission.workspaceId),
            eq(legalEntities.id, input.agreement.legalEntityId),
            eq(legalEntities.status, "active"),
          )).limit(1)
        : Promise.resolve([]),
    ]);
    if (input.agreement.primaryCounterpartyId && !counterparty) {
      throw new EnterpriseError(422, "active_counterparty_required", "Select an active counterparty from this workspace.");
    }
    if (input.agreement.legalEntityId && !legalEntity) {
      throw new EnterpriseError(422, "active_legal_entity_required", "Select an active legal entity from this workspace.");
    }
    const valueMinor = input.agreement.valueMinor
      ?? minorUnitsFromWholeUnits(input.agreement.value, input.agreement.currencyCode);
    const legacyValue = input.agreement.valueMinor === undefined
      ? input.agreement.value
      : wholeUnitProjection(input.agreement.valueMinor, input.agreement.currencyCode);
    const party = counterparty?.displayName ?? input.agreement.party;
    const side = templateVersion?.side ?? input.agreement.side;
    const agreementType = templateVersion?.agreementType ?? input.agreement.type;
    const workflowPolicy = workflowDefinition ? await governedWorkflowSnapshot(workflowDefinition.definition, {
      side,
      type: agreementType,
      department: input.agreement.department,
      risk: "Unassessed",
      riskDisposition: null,
      value: legacyValue,
      valueMinor,
      currencyCode: input.agreement.currencyCode,
    }) : null;
    if (workflowDefinition && workflowPolicy?.policySha256 !== workflowDefinition.definitionSha256) {
      throw new EnterpriseError(409, "workflow_digest_mismatch", "The published workflow no longer matches its immutable digest.");
    }

    const now = new Date().toISOString();
    const agreementId = newAgreementId();
    const agreement: typeof agreements.$inferSelect = {
      id: agreementId,
      workspaceId: submission.workspaceId,
      version: 1,
      party,
      initials: agreementInitials(party),
      side,
      type: agreementType,
      value: legacyValue,
      valueMinor,
      currencyCode: input.agreement.currencyCode,
      stage: "Intake",
      owner: owner.displayName,
      ownerUserId,
      primaryCounterpartyId: input.agreement.primaryCounterpartyId,
      legalEntityId: input.agreement.legalEntityId,
      governedTemplateVersionId: form.templateVersionId,
      workflowDefinitionId: form.workflowDefinitionId,
      workflowPolicySha256: workflowPolicy?.policySha256 ?? null,
      workflowApprovalLanes: workflowPolicy?.approvalLanes ?? null,
      nextAction: "Add a source document or create a working paper",
      due: input.agreement.due,
      crm: input.agreement.crm,
      crmRecord: input.agreement.crm === "None" ? "" : input.agreement.crmRecord,
      tags: input.agreement.tags,
      updated: now,
      createdAt: now,
      updatedAt: now,
      createdByUserId: auth.context.user.id,
      updatedByUserId: auth.context.user.id,
      legalHold: false,
      retentionUntil: null,
      deletedAt: null,
      department: input.agreement.department,
      risk: "Unassessed",
      riskDisposition: null,
      riskBasisHash: null,
      riskDocumentVersion: null,
      riskDocumentSha256: null,
      riskDecisionReason: null,
      riskDecidedByUserId: null,
      riskDecidedAt: null,
      approvalStatus: "Required",
      signatureStatus: "Not sent",
      effectiveDate: input.agreement.effectiveDate,
      expirationDate: input.agreement.expirationDate,
    };
    const event = await prepareAgreementEvent(db, {
      workspaceId: submission.workspaceId,
      agreementId,
      type: "Created",
      detail: `Converted submitted intake form ${submission.formId} version ${submission.formVersion}. Reason: ${input.reason}`,
      actor: auth.context.user,
      createdAt: now,
    });
    const snapshot = {
      ...await prepareAgreementSnapshot(agreement, auth.context.user.id, event.id),
      createdAt: now,
    };
    const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
      workspaceId: submission.workspaceId,
      topic: "agreement.created",
      aggregateType: "agreement",
      aggregateId: String(agreementId),
      payload: {
        agreementId,
        version: agreement.version,
        aggregateVersion: agreement.version,
        causationId: auth.requestId,
        crmAgreement: crmAgreementProjection(agreement),
      },
    }));
    const nextSubmissionVersion = submission.version + 1;
    const formPinCondition = exists(db.select({ id: intakeForms.id }).from(intakeForms).where(and(
      eq(intakeForms.workspaceId, submission.workspaceId),
      eq(intakeForms.id, submission.formId),
      eq(intakeForms.version, submission.formVersion),
      eq(intakeForms.status, "published"),
      form.templateId === null
        ? isNull(intakeForms.templateId)
        : eq(intakeForms.templateId, form.templateId),
      form.templateVersionId === null
        ? isNull(intakeForms.templateVersionId)
        : eq(intakeForms.templateVersionId, form.templateVersionId),
      form.workflowDefinitionId === null
        ? isNull(intakeForms.workflowDefinitionId)
        : eq(intakeForms.workflowDefinitionId, form.workflowDefinitionId),
    )));
    const templatePinCondition = templateVersion ? exists(db.select({ id: governedTemplateVersions.id })
      .from(governedTemplateVersions).innerJoin(governedTemplates, and(
        eq(governedTemplates.workspaceId, governedTemplateVersions.workspaceId),
        eq(governedTemplates.id, governedTemplateVersions.templateId),
      )).where(and(
        eq(governedTemplateVersions.workspaceId, submission.workspaceId),
        eq(governedTemplateVersions.id, templateVersion.id),
        eq(governedTemplateVersions.templateId, templateVersion.templateId),
        eq(governedTemplateVersions.status, "published"),
        eq(governedTemplateVersions.contentSha256, templateVersion.contentSha256),
        eq(governedTemplates.status, "published"),
        eq(governedTemplates.side, side),
        eq(governedTemplates.agreementType, agreementType),
      ))) : undefined;
    const workflowPinCondition = workflowDefinition ? exists(db.select({ id: workflowDefinitions.id })
      .from(workflowDefinitions).where(and(
        eq(workflowDefinitions.workspaceId, submission.workspaceId),
        eq(workflowDefinitions.id, workflowDefinition.id),
        eq(workflowDefinitions.status, "published"),
        eq(workflowDefinitions.definitionSha256, workflowDefinition.definitionSha256),
      ))) : undefined;
    const ownerCondition = exists(db.select({ userId: workspaceMemberships.userId })
      .from(workspaceMemberships).innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
        eq(workspaceMemberships.workspaceId, submission.workspaceId),
        eq(workspaceMemberships.userId, ownerUserId),
        eq(workspaceMemberships.status, "active"),
        eq(users.status, "active"),
        eq(users.displayName, owner.displayName),
      )));
    const counterpartyCondition = counterparty ? exists(db.select({ id: counterparties.id }).from(counterparties).where(and(
      eq(counterparties.workspaceId, submission.workspaceId),
      eq(counterparties.id, counterparty.id),
      eq(counterparties.status, "active"),
      eq(counterparties.displayName, counterparty.displayName),
    ))) : undefined;
    const legalEntityCondition = legalEntity ? exists(db.select({ id: legalEntities.id }).from(legalEntities).where(and(
      eq(legalEntities.workspaceId, submission.workspaceId),
      eq(legalEntities.id, legalEntity.id),
      eq(legalEntities.status, "active"),
    ))) : undefined;

    try {
      await executeEnterpriseMutation(db, {
        workspaceId: submission.workspaceId,
        actor: auth.context.user,
        type: "IntakeSubmissionConverted",
        detail: {
          action: "intake_submission.converted",
          submissionId,
          formId: submission.formId,
          formVersion: submission.formVersion,
          templateVersionId: form.templateVersionId,
          workflowDefinitionId: form.workflowDefinitionId,
          agreementId,
          reason: input.reason,
          previousVersion: submission.version,
          version: nextSubmissionVersion,
        },
        steps: [
          {
            statement: db.update(intakeSubmissions).set({
              status: "converted",
              agreementId,
              convertedAt: now,
              updatedAt: now,
              version: nextSubmissionVersion,
            }).where(and(
              eq(intakeSubmissions.workspaceId, submission.workspaceId),
              eq(intakeSubmissions.id, submission.id),
              eq(intakeSubmissions.formId, submission.formId),
              eq(intakeSubmissions.formVersion, submission.formVersion),
              eq(intakeSubmissions.version, submission.version),
              eq(intakeSubmissions.status, "submitted"),
              isNull(intakeSubmissions.agreementId),
              formPinCondition,
              templatePinCondition,
              workflowPinCondition,
              ownerCondition,
              counterpartyCondition,
              legalEntityCondition,
            )),
            guardOperation: "intake-submission.convert",
          },
          { statement: db.insert(agreements).values(agreement) },
          { statement: db.insert(agreementEvents).values(event) },
          { statement: db.insert(agreementVersions).values(snapshot) },
          { statement: db.insert(outboxEvents).values(outbox) },
        ],
        createdAt: now,
      });
    } catch (error) {
      if (!isMutationGuardConflict(error)) throw error;
      const winner = await convertedProjection(db, submission.workspaceId, submissionId);
      if (winner) return conversionResponse(winner, auth.requestId, auth.headers, true);
      throw new EnterpriseError(409, "version_conflict", "The intake submission or one of its governed references changed before conversion. Reload and review it again.");
    }

    return conversionResponse({
      submissionId,
      agreementId,
      submissionVersion: nextSubmissionVersion,
      status: "converted",
      convertedAt: now,
    }, auth.requestId, auth.headers, false);
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The intake submission could not be converted.");
  }
}
