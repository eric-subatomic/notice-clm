import { and, desc, eq, inArray, max, notExists } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import { governedTemplateCreationReceipts, governedTemplates, governedTemplateVersions, intakeForms, languageBlocks } from "../../../../../db/schema";
import { authorizeApiRequest } from "../../../../lib/api";
import {
  canonicalConfigurationCreationIdempotencyKey,
  configurationCreationKeyDigest,
  configurationCreationRequestDigest,
} from "../../../../lib/configuration-creation-idempotency";
import { executeEnterpriseMutation, enterpriseRouteError, parseEnterpriseListQuery } from "../../../../lib/enterprise-api";
import {
  assertDistinctPublisher,
  assertExpectedVersion,
  assertLifecycleTransition,
  EnterpriseError,
  isUniqueConstraintError,
  omitEnterpriseProperties,
} from "../../../../lib/enterprise-domain";
import { templatePatchSchema, templatePostSchema } from "../../../../lib/enterprise-validation";
import {
  governedTemplateContentDigest,
  GovernedTemplateRuntimeError,
  validateGovernedTemplateArtifact,
} from "../../../../lib/governed-template-runtime";
import { apiJson } from "../../../../lib/http";
import { parseJson } from "../../../../lib/validation";

type Database = ReturnType<typeof getDb>;

async function requireLanguageBlocks(db: Database, workspaceId: string, ids: readonly number[]): Promise<void> {
  if (new Set(ids).size !== ids.length) throw new EnterpriseError(400, "duplicate_language_block", "Language block IDs must be unique.");
  if (ids.length === 0) return;
  const rows = await db.select({ id: languageBlocks.id }).from(languageBlocks).where(and(
    eq(languageBlocks.workspaceId, workspaceId), inArray(languageBlocks.id, [...ids]),
  )).limit(ids.length);
  if (rows.length !== ids.length) throw new EnterpriseError(422, "invalid_language_block_reference", "Every language block must exist in this workspace.");
}

async function versionDigest(input: Readonly<{ body: string; variableSchema: Record<string, unknown>; languageBlockIds: number[] }>) {
  return governedTemplateContentDigest(input);
}

function requireValidTemplateArtifact(body: string, variableSchema: unknown, status: 400 | 409): void {
  try {
    validateGovernedTemplateArtifact({ body, variableSchema }, status);
  } catch (error) {
    if (error instanceof GovernedTemplateRuntimeError) {
      throw new EnterpriseError(error.status, error.code, error.message);
    }
    throw error;
  }
}

async function replayInitialTemplateCreation(db: Database, input: Readonly<{
  workspaceId: string;
  userId: string;
  keyDigest: string;
  requestSha256: string;
  requestId: string;
  headers: HeadersInit;
}>): Promise<Response | null> {
  const [receipt] = await db.select().from(governedTemplateCreationReceipts).where(and(
    eq(governedTemplateCreationReceipts.workspaceId, input.workspaceId),
    eq(governedTemplateCreationReceipts.userId, input.userId),
    eq(governedTemplateCreationReceipts.idempotencyKeySha256, input.keyDigest),
  )).limit(1);
  if (!receipt) return null;
  if (receipt.requestSha256 !== input.requestSha256) {
    throw new EnterpriseError(409, "idempotency_key_conflict", "This template-creation key was already used for different governed paper.");
  }
  const [[template], [templateVersion]] = await Promise.all([
    db.select().from(governedTemplates).where(and(
      eq(governedTemplates.workspaceId, input.workspaceId),
      eq(governedTemplates.id, receipt.templateId),
    )).limit(1),
    db.select().from(governedTemplateVersions).where(and(
      eq(governedTemplateVersions.workspaceId, input.workspaceId),
      eq(governedTemplateVersions.templateId, receipt.templateId),
      eq(governedTemplateVersions.id, receipt.templateVersionId),
      eq(governedTemplateVersions.version, 1),
    )).limit(1),
  ]);
  if (!template || !templateVersion) {
    throw new EnterpriseError(409, "idempotency_target_unavailable", "The prior template-creation receipt no longer has its exact governed targets.");
  }
  const headers = new Headers(input.headers);
  headers.set("Idempotency-Replayed", "true");
  return apiJson({ template, templateVersion, replay: true, requestId: input.requestId }, {
    requestId: input.requestId,
    headers,
  });
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin");
  if (!auth.ok) return auth.response;
  try {
    const query = parseEnterpriseListQuery(request);
    await ensureStorageSchema();
    const db = getDb();
    const conditions = [eq(governedTemplates.workspaceId, auth.context.workspace.id)];
    if (query.id) conditions.push(eq(governedTemplates.id, query.id));
    if (query.status === "draft" || query.status === "published" || query.status === "retired") conditions.push(eq(governedTemplates.status, query.status));
    else if (query.status) throw new EnterpriseError(400, "invalid_query", "Unsupported template status.");
    const templates = await db.select().from(governedTemplates).where(and(...conditions))
      .orderBy(desc(governedTemplates.updatedAt)).limit(query.limit);
    const templateIds = templates.map((template) => template.id);
    const versions = templateIds.length === 0 ? [] : await db.select().from(governedTemplateVersions).where(and(
      eq(governedTemplateVersions.workspaceId, auth.context.workspace.id), inArray(governedTemplateVersions.templateId, templateIds),
    )).orderBy(desc(governedTemplateVersions.createdAt)).limit(Math.min(query.limit * 5, 500));
    return apiJson({ templates, versions, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Governed templates could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, templatePostSchema, 620_000);
    await ensureStorageSchema();
    const db = getDb();
    const now = new Date().toISOString();
    if (input.action === "create_with_version") {
      const rawIdempotencyKey = request.headers.get("idempotency-key");
      if (rawIdempotencyKey === null) {
        throw new EnterpriseError(400, "idempotency_key_required", "A canonical UUID Idempotency-Key is required for atomic template creation.");
      }
      const idempotencyKey = canonicalConfigurationCreationIdempotencyKey(rawIdempotencyKey);
      if (!idempotencyKey) {
        throw new EnterpriseError(400, "invalid_idempotency_key", "Idempotency-Key must be one canonical lowercase UUID.");
      }
      const [keyDigest, requestSha256] = await Promise.all([
        configurationCreationKeyDigest({
          kind: "governed_template",
          workspaceId: auth.context.workspace.id,
          userId: auth.context.user.id,
          idempotencyKey,
        }),
        configurationCreationRequestDigest("governed_template", input, 620_000),
      ]);
      const replay = await replayInitialTemplateCreation(db, {
        workspaceId: auth.context.workspace.id,
        userId: auth.context.user.id,
        keyDigest,
        requestSha256,
        requestId: auth.requestId,
        headers: auth.headers,
      });
      if (replay) return replay;
      requireValidTemplateArtifact(input.body, input.variableSchema, 400);
      await requireLanguageBlocks(db, auth.context.workspace.id, input.languageBlockIds);
      const contentSha256 = await versionDigest(input);

      const template = {
        id: crypto.randomUUID(), workspaceId: auth.context.workspace.id, version: 1,
        name: input.name, description: input.description, agreementType: input.agreementType, side: input.side,
        status: "draft" as const, currentPublishedVersion: null, createdByUserId: auth.context.user.id,
        createdAt: now, updatedByUserId: auth.context.user.id, updatedAt: now,
      };
      const templateVersion = {
        id: crypto.randomUUID(), workspaceId: template.workspaceId, templateId: template.id, version: 1,
        status: "draft" as const, body: input.body, variableSchema: input.variableSchema,
        languageBlockIds: input.languageBlockIds, contentSha256, changeSummary: input.changeSummary,
        createdByUserId: auth.context.user.id, createdAt: now, reviewedByUserId: null, reviewedAt: null,
      };
      try {
        await executeEnterpriseMutation(db, {
          workspaceId: template.workspaceId, actor: auth.context.user, type: "GovernedTemplateInitialized",
          detail: {
            action: "governed_template.initial_version_created",
            templateId: template.id,
            versionId: templateVersion.id,
            semanticVersion: 1,
            contentSha256,
          },
          steps: [
            { statement: db.insert(governedTemplates).values(template) },
            { statement: db.insert(governedTemplateVersions).values(templateVersion) },
            { statement: db.insert(governedTemplateCreationReceipts).values({
              workspaceId: template.workspaceId,
              userId: auth.context.user.id,
              idempotencyKeySha256: keyDigest,
              requestSha256,
              templateId: template.id,
              templateVersionId: templateVersion.id,
              createdAt: now,
            }) },
          ],
          createdAt: now,
        });
      } catch (error) {
        const concurrentReplay = await replayInitialTemplateCreation(db, {
          workspaceId: template.workspaceId,
          userId: auth.context.user.id,
          keyDigest,
          requestSha256,
          requestId: auth.requestId,
          headers: auth.headers,
        });
        if (concurrentReplay) return concurrentReplay;
        if (isUniqueConstraintError(error, ["governed_templates.workspace_id", "governed_templates.name"])) {
          throw new EnterpriseError(409, "template_exists", "A governed template with that name already exists in this workspace.");
        }
        throw error;
      }
      const headers = new Headers(auth.headers);
      headers.set("Idempotency-Replayed", "false");
      return apiJson({ template, templateVersion, replay: false, requestId: auth.requestId }, {
        status: 201,
        requestId: auth.requestId,
        headers,
      });
    }
    const [template] = await db.select().from(governedTemplates).where(and(
      eq(governedTemplates.workspaceId, auth.context.workspace.id), eq(governedTemplates.id, input.templateId),
    )).limit(1);
    if (!template) throw new EnterpriseError(404, "template_not_found", "Governed template was not found.");
    assertExpectedVersion(template.version, input.templateVersion);
    if (template.status === "retired") throw new EnterpriseError(409, "template_retired", "A retired template cannot receive another version.");
    requireValidTemplateArtifact(input.body, input.variableSchema, 400);
    await requireLanguageBlocks(db, template.workspaceId, input.languageBlockIds);
    const [latest] = await db.select({ version: max(governedTemplateVersions.version) }).from(governedTemplateVersions).where(and(
      eq(governedTemplateVersions.workspaceId, template.workspaceId), eq(governedTemplateVersions.templateId, template.id),
    ));
    const semanticVersion = (latest?.version ?? 0) + 1;
    const contentSha256 = await versionDigest(input);
    const artifact = {
      id: crypto.randomUUID(), workspaceId: template.workspaceId, templateId: template.id, version: semanticVersion,
      status: "draft" as const, body: input.body, variableSchema: input.variableSchema,
      languageBlockIds: input.languageBlockIds, contentSha256, changeSummary: input.changeSummary,
      createdByUserId: auth.context.user.id, createdAt: now, reviewedByUserId: null, reviewedAt: null,
    };
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: template.workspaceId, actor: auth.context.user, type: "GovernedTemplateVersionCreated",
        detail: { action: "governed_template.version_created", templateId: template.id, versionId: artifact.id, semanticVersion, contentSha256 },
        steps: [
          { statement: db.insert(governedTemplateVersions).values(artifact) },
          { statement: db.update(governedTemplates).set({ version: template.version + 1, updatedByUserId: auth.context.user.id, updatedAt: now }).where(and(
            eq(governedTemplates.workspaceId, template.workspaceId), eq(governedTemplates.id, template.id),
            eq(governedTemplates.version, template.version),
          )), guardOperation: "governed-template.version-create" },
        ], createdAt: now,
      });
    } catch (error) {
      if (isUniqueConstraintError(error, ["governed_template_versions.workspace_id", "governed_template_versions.template_id", "governed_template_versions.version"])) {
        throw new EnterpriseError(409, "version_conflict", "Another template version was created. Reload before retrying.");
      }
      throw error;
    }
    return apiJson({ templateVersion: artifact, templateVersionToken: template.version + 1, requestId: auth.requestId }, {
      status: 201, requestId: auth.requestId, headers: auth.headers,
    });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The governed template mutation could not be completed.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 40 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, templatePatchSchema, 16_000);
    await ensureStorageSchema();
    const db = getDb();
    const templateId = input.action === "update_template" ? input.id : input.templateId;
    const expectedVersion = input.action === "update_template" ? input.version : input.templateVersion;
    const [template] = await db.select().from(governedTemplates).where(and(
      eq(governedTemplates.workspaceId, auth.context.workspace.id), eq(governedTemplates.id, templateId),
    )).limit(1);
    if (!template) throw new EnterpriseError(404, "template_not_found", "Governed template was not found.");
    assertExpectedVersion(template.version, expectedVersion);
    const now = new Date().toISOString();

    if (input.action === "update_template") {
      if (template.status === "retired") throw new EnterpriseError(409, "template_immutable", "A retired template cannot be changed.");
      const changes = omitEnterpriseProperties(input, ["action", "id", "version"]);
      const scopeChanged = (changes.side !== undefined && changes.side !== template.side)
        || (changes.agreementType !== undefined && changes.agreementType !== template.agreementType);
      if (scopeChanged) {
        const [existingVersion] = await db.select({ id: governedTemplateVersions.id }).from(governedTemplateVersions).where(and(
          eq(governedTemplateVersions.workspaceId, template.workspaceId),
          eq(governedTemplateVersions.templateId, template.id),
        )).limit(1);
        if (existingVersion) {
          throw new EnterpriseError(409, "template_scope_immutable", "Template type and side cannot change after its first governed version is created.");
        }
      }
      const saved = { ...template, ...changes, version: template.version + 1, updatedByUserId: auth.context.user.id, updatedAt: now };
      try {
        await executeEnterpriseMutation(db, {
          workspaceId: template.workspaceId, actor: auth.context.user, type: "GovernedTemplateUpdated",
          detail: { action: "governed_template.updated", templateId: template.id, previousVersion: template.version, version: saved.version },
          steps: [{ statement: db.update(governedTemplates).set({
            ...changes, version: saved.version, updatedByUserId: saved.updatedByUserId, updatedAt: now,
          }).where(and(
            eq(governedTemplates.workspaceId, template.workspaceId), eq(governedTemplates.id, template.id),
            eq(governedTemplates.version, template.version),
          )), guardOperation: "governed-template.update" }], createdAt: now,
        });
      } catch (error) {
        if (isUniqueConstraintError(error, ["governed_templates.workspace_id", "governed_templates.name"])) {
          throw new EnterpriseError(409, "template_exists", "A governed template with that name already exists in this workspace.");
        }
        throw error;
      }
      return apiJson({ template: saved, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }

    if (input.action === "retire_template") {
      assertLifecycleTransition(template.status, "retired");
      const [publishedForm] = await db.select({ id: intakeForms.id }).from(intakeForms).where(and(
        eq(intakeForms.workspaceId, template.workspaceId), eq(intakeForms.templateId, template.id), eq(intakeForms.status, "published"),
      )).limit(1);
      if (publishedForm) throw new EnterpriseError(409, "template_in_use", "Retire published intake forms that use this template before retiring it.");
      if (template.currentPublishedVersion === null) throw new EnterpriseError(409, "published_template_version_required", "The template has no published version to retire.");
      const [artifact] = await db.select({ contentSha256: governedTemplateVersions.contentSha256 }).from(governedTemplateVersions).where(and(
        eq(governedTemplateVersions.workspaceId, template.workspaceId), eq(governedTemplateVersions.templateId, template.id),
        eq(governedTemplateVersions.version, template.currentPublishedVersion), eq(governedTemplateVersions.status, "published"),
      )).limit(1);
      if (!artifact) throw new EnterpriseError(409, "published_template_version_required", "The template's published artifact is unavailable.");
      const version = template.version + 1;
      await executeEnterpriseMutation(db, {
        workspaceId: template.workspaceId, actor: auth.context.user, type: "GovernedTemplateRetired",
        detail: { action: "governed_template.retired", templateId: template.id, reason: input.reason, contentSha256: artifact.contentSha256, previousVersion: template.version, version },
        steps: [{ statement: db.update(governedTemplates).set({
          status: "retired", version, updatedByUserId: auth.context.user.id, updatedAt: now,
        }).where(and(
          eq(governedTemplates.workspaceId, template.workspaceId), eq(governedTemplates.id, template.id),
          eq(governedTemplates.version, template.version), eq(governedTemplates.status, "published"),
          notExists(db.select({ id: intakeForms.id }).from(intakeForms).where(and(
            eq(intakeForms.workspaceId, template.workspaceId),
            eq(intakeForms.templateId, template.id),
            eq(intakeForms.status, "published"),
          )).limit(1)),
        )), guardOperation: "governed-template.retire" }], createdAt: now,
      });
      return apiJson({ template: { ...template, status: "retired", version, updatedByUserId: auth.context.user.id, updatedAt: now }, requestId: auth.requestId }, {
        requestId: auth.requestId, headers: auth.headers,
      });
    }

    if (template.status === "retired") throw new EnterpriseError(409, "template_immutable", "A retired template cannot publish a version.");
    const [artifact] = await db.select().from(governedTemplateVersions).where(and(
      eq(governedTemplateVersions.workspaceId, template.workspaceId), eq(governedTemplateVersions.templateId, template.id),
      eq(governedTemplateVersions.id, input.versionId),
    )).limit(1);
    if (!artifact) throw new EnterpriseError(404, "template_version_not_found", "Template version was not found.");
    if (template.currentPublishedVersion !== null && artifact.version <= template.currentPublishedVersion) {
      throw new EnterpriseError(409, "template_version_not_newer", "Only a newer template version can replace the current published version.");
    }
    assertLifecycleTransition(artifact.status, "published");
    assertDistinctPublisher(artifact.createdByUserId, auth.context.user.id);
    requireValidTemplateArtifact(artifact.body, artifact.variableSchema, 409);
    await requireLanguageBlocks(db, template.workspaceId, artifact.languageBlockIds);
    const verifiedDigest = await versionDigest(artifact);
    if (verifiedDigest !== artifact.contentSha256) throw new EnterpriseError(409, "content_digest_mismatch", "Template version content no longer matches its immutable digest.");
    const parentVersion = template.version + 1;
    await executeEnterpriseMutation(db, {
      workspaceId: template.workspaceId, actor: auth.context.user, type: "GovernedTemplatePublished",
      detail: { action: "governed_template.published", templateId: template.id, versionId: artifact.id, semanticVersion: artifact.version, reason: input.reason, contentSha256: artifact.contentSha256 },
      steps: [
        { statement: db.update(governedTemplateVersions).set({ status: "published", reviewedByUserId: auth.context.user.id, reviewedAt: now }).where(and(
          eq(governedTemplateVersions.workspaceId, artifact.workspaceId), eq(governedTemplateVersions.id, artifact.id), eq(governedTemplateVersions.status, "draft"),
        )), guardOperation: "governed-template.publish-version" },
        { statement: db.update(governedTemplates).set({
          status: "published", currentPublishedVersion: artifact.version, version: parentVersion,
          updatedByUserId: auth.context.user.id, updatedAt: now,
        }).where(and(
          eq(governedTemplates.workspaceId, template.workspaceId), eq(governedTemplates.id, template.id), eq(governedTemplates.version, template.version),
        )), guardOperation: "governed-template.publish-parent" },
      ], createdAt: now,
    });
    return apiJson({
      template: { ...template, status: "published", currentPublishedVersion: artifact.version, version: parentVersion, updatedByUserId: auth.context.user.id, updatedAt: now },
      templateVersion: { ...artifact, status: "published", reviewedByUserId: auth.context.user.id, reviewedAt: now },
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The governed template could not be updated.");
  }
}
