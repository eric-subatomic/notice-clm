import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "../../db";
import {
  agreements,
  counterparties,
  governedTemplateVersions,
  governedTemplates,
  legalEntities,
  users,
  workflowDefinitions,
  workspaceGroups,
  workspaceMemberships,
} from "../../db/schema";
import { EnterpriseError } from "./enterprise-domain";

type Database = ReturnType<typeof getDb>;

export async function requireActiveWorkspaceMember(db: Database, workspaceId: string, userId: string) {
  const [member] = await db.select({
    userId: workspaceMemberships.userId,
    role: workspaceMemberships.role,
    email: users.email,
    displayName: users.displayName,
  }).from(workspaceMemberships).innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
    eq(workspaceMemberships.workspaceId, workspaceId),
    eq(workspaceMemberships.userId, userId),
    eq(workspaceMemberships.status, "active"),
    eq(users.status, "active"),
  )).limit(1);
  if (!member) throw new EnterpriseError(422, "active_member_required", "The selected user is not an active member of this workspace.");
  return member;
}

export async function requireActiveAuthoritySubject(
  db: Database,
  workspaceId: string,
  subjectType: "user" | "group",
  subjectId: string,
): Promise<void> {
  if (subjectType === "user") {
    await requireActiveWorkspaceMember(db, workspaceId, subjectId);
    return;
  }
  const [group] = await db.select({ id: workspaceGroups.id }).from(workspaceGroups).where(and(
    eq(workspaceGroups.workspaceId, workspaceId), eq(workspaceGroups.id, subjectId), eq(workspaceGroups.status, "active"),
  )).limit(1);
  if (!group) throw new EnterpriseError(422, "active_group_required", "The selected group is not active in this workspace.");
}

export async function requireCustomFieldResource(
  db: Database,
  workspaceId: string,
  resourceType: "agreement" | "counterparty" | "legal_entity",
  resourceId: string,
): Promise<void> {
  if (resourceType === "agreement") {
    const numericId = Number(resourceId);
    if (!Number.isSafeInteger(numericId) || numericId < 1) {
      throw new EnterpriseError(422, "invalid_resource_reference", "Agreement resource ID must be a positive integer.");
    }
    const [record] = await db.select({ id: agreements.id }).from(agreements).where(and(
      eq(agreements.workspaceId, workspaceId), eq(agreements.id, numericId), isNull(agreements.deletedAt),
    )).limit(1);
    if (!record) throw new EnterpriseError(422, "invalid_resource_reference", "The agreement is unavailable in this workspace.");
    return;
  }
  if (resourceType === "counterparty") {
    const [record] = await db.select({ id: counterparties.id }).from(counterparties).where(and(
      eq(counterparties.workspaceId, workspaceId), eq(counterparties.id, resourceId), eq(counterparties.status, "active"),
    )).limit(1);
    if (!record) throw new EnterpriseError(422, "invalid_resource_reference", "The counterparty is unavailable in this workspace.");
    return;
  }
  const [record] = await db.select({ id: legalEntities.id }).from(legalEntities).where(and(
    eq(legalEntities.workspaceId, workspaceId), eq(legalEntities.id, resourceId), eq(legalEntities.status, "active"),
  )).limit(1);
  if (!record) throw new EnterpriseError(422, "invalid_resource_reference", "The legal entity is not active in this workspace.");
}

export async function requirePublishedConfigurationReferences(
  db: Database,
  workspaceId: string,
  input: Readonly<{ templateId: string | null; workflowDefinitionId: string | null }>,
): Promise<{ templateVersionId: string | null }> {
  let templateVersionId: string | null = null;
  if (input.templateId) {
    const [template] = await db.select({
      id: governedTemplates.id,
      currentPublishedVersion: governedTemplates.currentPublishedVersion,
    }).from(governedTemplates).where(and(
      eq(governedTemplates.workspaceId, workspaceId), eq(governedTemplates.id, input.templateId),
      eq(governedTemplates.status, "published"), isNotNull(governedTemplates.currentPublishedVersion),
    )).limit(1);
    if (!template) throw new EnterpriseError(422, "published_template_required", "The selected template is not published in this workspace.");
    const [version] = await db.select({ id: governedTemplateVersions.id }).from(governedTemplateVersions).where(and(
      eq(governedTemplateVersions.workspaceId, workspaceId),
      eq(governedTemplateVersions.templateId, template.id),
      eq(governedTemplateVersions.version, template.currentPublishedVersion!),
      eq(governedTemplateVersions.status, "published"),
    )).limit(1);
    if (!version) throw new EnterpriseError(422, "published_template_version_required", "The selected template's current published version is unavailable.");
    templateVersionId = version.id;
  }
  if (input.workflowDefinitionId) {
    const [workflow] = await db.select({ id: workflowDefinitions.id }).from(workflowDefinitions).where(and(
      eq(workflowDefinitions.workspaceId, workspaceId), eq(workflowDefinitions.id, input.workflowDefinitionId),
      eq(workflowDefinitions.status, "published"),
    )).limit(1);
    if (!workflow) throw new EnterpriseError(422, "published_workflow_required", "The selected workflow is not published in this workspace.");
  }
  return { templateVersionId };
}

export async function requirePinnedTemplateVersion(
  db: Database,
  workspaceId: string,
  templateId: string | null,
  templateVersionId: string | null,
): Promise<void> {
  if (templateId === null) {
    if (templateVersionId !== null) throw new EnterpriseError(409, "invalid_template_version_pin", "An intake form without a template cannot have a template version pin.");
    return;
  }
  if (!templateVersionId) throw new EnterpriseError(409, "template_version_pin_required", "The published intake form is missing its exact template version pin.");
  const [version] = await db.select({ id: governedTemplateVersions.id }).from(governedTemplateVersions).where(and(
    eq(governedTemplateVersions.workspaceId, workspaceId), eq(governedTemplateVersions.id, templateVersionId),
    eq(governedTemplateVersions.templateId, templateId), eq(governedTemplateVersions.status, "published"),
  )).limit(1);
  if (!version) throw new EnterpriseError(409, "invalid_template_version_pin", "The intake form's exact published template version is unavailable.");
}
