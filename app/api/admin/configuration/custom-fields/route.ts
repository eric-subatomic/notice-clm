import { and, desc, eq, notExists } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import { customFieldDefinitions, customFieldValues } from "../../../../../db/schema";
import { authorizeApiRequest } from "../../../../lib/api";
import { executeEnterpriseMutation, enterpriseRouteError, parseEnterpriseListQuery } from "../../../../lib/enterprise-api";
import {
  assertExpectedVersion,
  EnterpriseError,
  isUniqueConstraintError,
  omitEnterpriseProperties,
  validateDefinitionOptions,
} from "../../../../lib/enterprise-domain";
import { customFieldCreateSchema, customFieldPatchSchema, customFieldResourceTypeSchema } from "../../../../lib/enterprise-validation";
import { apiJson } from "../../../../lib/http";
import { parseJson } from "../../../../lib/validation";

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin");
  if (!auth.ok) return auth.response;
  try {
    const query = parseEnterpriseListQuery(request);
    const url = new URL(request.url);
    const resourceTypeInput = url.searchParams.get("resourceType");
    const resourceType = resourceTypeInput ? customFieldResourceTypeSchema.safeParse(resourceTypeInput) : null;
    if (resourceType && !resourceType.success) throw new EnterpriseError(400, "invalid_query", "Unsupported custom field resource type.");
    await ensureStorageSchema();
    const conditions = [eq(customFieldDefinitions.workspaceId, auth.context.workspace.id)];
    if (query.id) conditions.push(eq(customFieldDefinitions.id, query.id));
    if (query.status === "active" || query.status === "retired") conditions.push(eq(customFieldDefinitions.status, query.status));
    else if (query.status) throw new EnterpriseError(400, "invalid_query", "Unsupported custom field status.");
    if (resourceType?.success) conditions.push(eq(customFieldDefinitions.resourceType, resourceType.data));
    const definitions = await getDb().select().from(customFieldDefinitions).where(and(...conditions))
      .orderBy(desc(customFieldDefinitions.updatedAt)).limit(query.limit);
    return apiJson({ customFields: definitions, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Custom field definitions could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, customFieldCreateSchema, 16_000);
    await ensureStorageSchema();
    const now = new Date().toISOString();
    const definition = {
      id: crypto.randomUUID(), workspaceId: auth.context.workspace.id, version: 1, ...input,
      status: "active" as const, createdByUserId: auth.context.user.id, createdAt: now,
      updatedByUserId: auth.context.user.id, updatedAt: now,
    };
    const db = getDb();
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: definition.workspaceId, actor: auth.context.user, type: "CustomFieldCreated",
        detail: { action: "custom_field.created", customFieldId: definition.id, resourceType: definition.resourceType, version: 1 },
        steps: [{ statement: db.insert(customFieldDefinitions).values(definition) }], createdAt: now,
      });
    } catch (error) {
      if (isUniqueConstraintError(error, ["custom_field_definitions.workspace_id", "custom_field_definitions.resource_type", "custom_field_definitions.key"])) {
        throw new EnterpriseError(409, "custom_field_exists", "That custom field key already exists for this resource type.");
      }
      throw error;
    }
    return apiJson({ customField: definition, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The custom field could not be created.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, customFieldPatchSchema, 16_000);
    await ensureStorageSchema();
    const db = getDb();
    const [current] = await db.select().from(customFieldDefinitions).where(and(
      eq(customFieldDefinitions.workspaceId, auth.context.workspace.id), eq(customFieldDefinitions.id, input.id),
    )).limit(1);
    if (!current) throw new EnterpriseError(404, "custom_field_not_found", "Custom field definition was not found.");
    assertExpectedVersion(current.version, input.version);
    if (current.status === "retired") throw new EnterpriseError(409, "custom_field_immutable", "A retired custom field cannot be changed.");
    const now = new Date().toISOString();
    if (input.action === "retire") {
      const version = current.version + 1;
      await executeEnterpriseMutation(db, {
        workspaceId: current.workspaceId, actor: auth.context.user, type: "CustomFieldRetired",
        detail: { action: "custom_field.retired", customFieldId: current.id, reason: input.reason, previousVersion: current.version, version },
        steps: [{ statement: db.update(customFieldDefinitions).set({
          status: "retired", version, updatedByUserId: auth.context.user.id, updatedAt: now,
        }).where(and(
          eq(customFieldDefinitions.workspaceId, current.workspaceId), eq(customFieldDefinitions.id, current.id),
          eq(customFieldDefinitions.version, current.version), eq(customFieldDefinitions.status, "active"),
        )), guardOperation: "custom-field.retire" }], createdAt: now,
      });
      return apiJson({ customField: { ...current, status: "retired", version, updatedByUserId: auth.context.user.id, updatedAt: now }, requestId: auth.requestId }, {
        requestId: auth.requestId, headers: auth.headers,
      });
    }

    const changes = omitEnterpriseProperties(input, ["action", "id", "version"]);
    const nextOptions = changes.options ?? current.options;
    validateDefinitionOptions(current.dataType, nextOptions);
    if (changes.options !== undefined || changes.required !== undefined) {
      const [value] = await db.select({ id: customFieldValues.id }).from(customFieldValues).where(and(
        eq(customFieldValues.workspaceId, current.workspaceId), eq(customFieldValues.definitionId, current.id),
      )).limit(1);
      if (value) throw new EnterpriseError(409, "custom_field_values_require_migration", "Remove or migrate existing values before changing field options or required status.");
    }
    const saved = { ...current, ...changes, version: current.version + 1, updatedByUserId: auth.context.user.id, updatedAt: now };
    await executeEnterpriseMutation(db, {
      workspaceId: current.workspaceId, actor: auth.context.user, type: "CustomFieldUpdated",
      detail: { action: "custom_field.updated", customFieldId: current.id, previousVersion: current.version, version: saved.version },
      steps: [{ statement: db.update(customFieldDefinitions).set({
        ...changes, version: saved.version, updatedByUserId: saved.updatedByUserId, updatedAt: now,
      }).where(and(
        eq(customFieldDefinitions.workspaceId, current.workspaceId), eq(customFieldDefinitions.id, current.id),
        eq(customFieldDefinitions.version, current.version), eq(customFieldDefinitions.status, "active"),
        changes.options !== undefined || changes.required !== undefined
          ? notExists(db.select({ id: customFieldValues.id }).from(customFieldValues).where(and(
              eq(customFieldValues.workspaceId, current.workspaceId),
              eq(customFieldValues.definitionId, current.id),
            )).limit(1))
          : undefined,
      )), guardOperation: "custom-field.update" }], createdAt: now,
    });
    return apiJson({ customField: saved, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The custom field could not be updated.");
  }
}
