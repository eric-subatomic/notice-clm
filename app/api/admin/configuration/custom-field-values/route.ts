import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import { customFieldDefinitions, customFieldValues } from "../../../../../db/schema";
import { authorizeApiRequest } from "../../../../lib/api";
import { executeEnterpriseMutation, enterpriseRouteError, parseEnterpriseListQuery } from "../../../../lib/enterprise-api";
import {
  assertBoundedJson,
  EnterpriseError,
  isUniqueConstraintError,
  nextTimestampAfter,
  validateTypedFieldValue,
} from "../../../../lib/enterprise-domain";
import { requireCustomFieldResource } from "../../../../lib/enterprise-references";
import { customFieldResourceTypeSchema, customFieldValueDeleteSchema, customFieldValuePutSchema } from "../../../../lib/enterprise-validation";
import { apiJson } from "../../../../lib/http";
import { parseJson } from "../../../../lib/validation";

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin");
  if (!auth.ok) return auth.response;
  try {
    const query = parseEnterpriseListQuery(request);
    const url = new URL(request.url);
    const parsedType = customFieldResourceTypeSchema.safeParse(url.searchParams.get("resourceType"));
    const resourceId = url.searchParams.get("resourceId")?.trim();
    if (!parsedType.success || !resourceId || resourceId.length > 200) {
      throw new EnterpriseError(400, "invalid_query", "resourceType and a bounded resourceId are required.");
    }
    await ensureStorageSchema();
    const db = getDb();
    await requireCustomFieldResource(db, auth.context.workspace.id, parsedType.data, resourceId);
    const values = await db.select().from(customFieldValues).where(and(
      eq(customFieldValues.workspaceId, auth.context.workspace.id), eq(customFieldValues.resourceType, parsedType.data),
      eq(customFieldValues.resourceId, resourceId),
    )).orderBy(desc(customFieldValues.updatedAt)).limit(query.limit);
    return apiJson({ customFieldValues: values, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Custom field values could not be loaded.");
  }
}

export async function PUT(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, customFieldValuePutSchema, 40_000);
    assertBoundedJson(input.value, { maxBytes: 32_768 });
    await ensureStorageSchema();
    const db = getDb();
    const [definition] = await db.select().from(customFieldDefinitions).where(and(
      eq(customFieldDefinitions.workspaceId, auth.context.workspace.id), eq(customFieldDefinitions.id, input.definitionId),
      eq(customFieldDefinitions.resourceType, input.resourceType), eq(customFieldDefinitions.status, "active"),
      eq(customFieldDefinitions.version, input.definitionVersion),
    )).limit(1);
    if (!definition) throw new EnterpriseError(409, "custom_field_definition_changed", "The custom field definition changed. Reload before saving a value.");
    await requireCustomFieldResource(db, auth.context.workspace.id, input.resourceType, input.resourceId);
    validateTypedFieldValue(definition, input.value);
    const [current] = await db.select().from(customFieldValues).where(and(
      eq(customFieldValues.workspaceId, auth.context.workspace.id), eq(customFieldValues.definitionId, input.definitionId),
      eq(customFieldValues.resourceType, input.resourceType), eq(customFieldValues.resourceId, input.resourceId),
    )).limit(1);
    if (current && input.expectedUpdatedAt === null) throw new EnterpriseError(409, "version_conflict", "The custom field value already exists. Reload before retrying.");
    if (!current && input.expectedUpdatedAt !== null) throw new EnterpriseError(409, "version_conflict", "The custom field value no longer exists. Reload before retrying.");
    if (current && current.updatedAt !== input.expectedUpdatedAt) throw new EnterpriseError(409, "version_conflict", "The custom field value changed. Reload before retrying.");
    const now = current ? nextTimestampAfter(current.updatedAt) : new Date().toISOString();
    const saved = {
      id: current?.id ?? crypto.randomUUID(), workspaceId: auth.context.workspace.id,
      definitionId: input.definitionId, resourceType: input.resourceType, resourceId: input.resourceId,
      valueJson: input.value, updatedByUserId: auth.context.user.id, updatedAt: now,
    };
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: saved.workspaceId, actor: auth.context.user, type: current ? "CustomFieldValueUpdated" : "CustomFieldValueCreated",
        detail: { action: current ? "custom_field_value.updated" : "custom_field_value.created", customFieldId: definition.id, resourceType: input.resourceType, resourceId: input.resourceId },
        steps: [
          {
            statement: db.update(customFieldDefinitions).set({ updatedAt: definition.updatedAt }).where(and(
              eq(customFieldDefinitions.workspaceId, definition.workspaceId), eq(customFieldDefinitions.id, definition.id),
              eq(customFieldDefinitions.version, definition.version), eq(customFieldDefinitions.status, "active"),
            )),
            guardOperation: "custom-field-value.definition-fence",
          },
          ...(current ? [{
            statement: db.update(customFieldValues).set({ valueJson: input.value, updatedByUserId: saved.updatedByUserId, updatedAt: now }).where(and(
              eq(customFieldValues.workspaceId, saved.workspaceId), eq(customFieldValues.id, current.id), eq(customFieldValues.updatedAt, current.updatedAt),
            )), guardOperation: "custom-field-value.update",
          }] : [{ statement: db.insert(customFieldValues).values(saved) }]),
        ],
        createdAt: now,
      });
    } catch (error) {
      if (isUniqueConstraintError(error, ["custom_field_values.workspace_id", "custom_field_values.definition_id", "custom_field_values.resource_type", "custom_field_values.resource_id"])) {
        throw new EnterpriseError(409, "version_conflict", "The custom field value changed. Reload before retrying.");
      }
      throw error;
    }
    return apiJson({ customFieldValue: saved, requestId: auth.requestId }, { status: current ? 200 : 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The custom field value could not be saved.");
  }
}

export async function DELETE(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, customFieldValueDeleteSchema, 12_000);
    await ensureStorageSchema();
    const db = getDb();
    const [definition] = await db.select().from(customFieldDefinitions).where(and(
      eq(customFieldDefinitions.workspaceId, auth.context.workspace.id), eq(customFieldDefinitions.id, input.definitionId),
      eq(customFieldDefinitions.resourceType, input.resourceType), eq(customFieldDefinitions.version, input.definitionVersion),
    )).limit(1);
    if (!definition) throw new EnterpriseError(409, "custom_field_definition_changed", "The custom field definition changed. Reload before removing a value.");
    if (definition.required && definition.status === "active") throw new EnterpriseError(409, "required_field_value", "An active required custom field value cannot be removed.");
    const [current] = await db.select().from(customFieldValues).where(and(
      eq(customFieldValues.workspaceId, auth.context.workspace.id), eq(customFieldValues.definitionId, input.definitionId),
      eq(customFieldValues.resourceType, input.resourceType), eq(customFieldValues.resourceId, input.resourceId),
    )).limit(1);
    if (!current) throw new EnterpriseError(404, "custom_field_value_not_found", "Custom field value was not found.");
    if (current.updatedAt !== input.expectedUpdatedAt) throw new EnterpriseError(409, "version_conflict", "The custom field value changed. Reload before retrying.");
    const now = new Date().toISOString();
    await executeEnterpriseMutation(db, {
      workspaceId: current.workspaceId, actor: auth.context.user, type: "CustomFieldValueDeleted",
      detail: { action: "custom_field_value.deleted", customFieldId: definition.id, resourceType: input.resourceType, resourceId: input.resourceId, reason: input.reason },
      steps: [
        {
          statement: db.update(customFieldDefinitions).set({ updatedAt: definition.updatedAt }).where(and(
            eq(customFieldDefinitions.workspaceId, definition.workspaceId), eq(customFieldDefinitions.id, definition.id),
            eq(customFieldDefinitions.version, definition.version),
          )),
          guardOperation: "custom-field-value.definition-fence",
        },
        { statement: db.delete(customFieldValues).where(and(
          eq(customFieldValues.workspaceId, current.workspaceId), eq(customFieldValues.id, current.id), eq(customFieldValues.updatedAt, current.updatedAt),
        )), guardOperation: "custom-field-value.delete" },
      ], createdAt: now,
    });
    return apiJson({ deleted: true, id: current.id, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The custom field value could not be removed.");
  }
}
