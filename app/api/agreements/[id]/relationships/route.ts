import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import {
  agreementParties,
  agreementRelationships,
  agreements,
  counterparties,
  legalEntities,
} from "../../../../../db/schema";
import { authorizeApiRequest } from "../../../../lib/api";
import { executeEnterpriseMutation, enterpriseRouteError } from "../../../../lib/enterprise-api";
import { databaseErrorMessage, EnterpriseError, isUniqueConstraintError } from "../../../../lib/enterprise-domain";
import { apiJson } from "../../../../lib/http";
import { parseJson } from "../../../../lib/validation";

const addSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add_party"),
    role: z.enum(["our_entity", "counterparty", "guarantor", "affiliate", "other"]),
    targetType: z.enum(["legal_entity", "counterparty"]),
    targetId: z.string().uuid(),
    primary: z.boolean().default(false),
  }).strict(),
  z.object({
    action: z.literal("add_relationship"),
    targetAgreementId: z.number().int().positive(),
    relationshipType: z.enum(["master", "amends", "order_under", "dpa_for", "renews", "supersedes", "related"]),
  }).strict(),
]);

const removeSchema = z.object({
  kind: z.enum(["party", "relationship"]),
  id: z.string().uuid(),
  reason: z.string().trim().min(8).max(500),
}).strict();

function parseAgreementId(value: string): number {
  const agreementId = Number(value);
  if (!Number.isSafeInteger(agreementId) || agreementId <= 0) {
    throw new EnterpriseError(404, "agreement_not_found", "Agreement was not found.");
  }
  return agreementId;
}

async function requireActiveAgreement(workspaceId: string, agreementId: number) {
  const [agreement] = await getDb().select({ id: agreements.id, party: agreements.party }).from(agreements).where(and(
    eq(agreements.workspaceId, workspaceId), eq(agreements.id, agreementId), isNull(agreements.deletedAt),
  )).limit(1);
  if (!agreement) throw new EnterpriseError(404, "agreement_not_found", "Agreement was not found.");
  return agreement;
}

function isWrappedUniqueConstraintError(error: unknown, fragments: readonly string[]): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (isUniqueConstraintError(current, fragments)) return true;
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return false;
}

function isWrappedDatabaseMarker(error: unknown, marker: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (databaseErrorMessage(current).includes(marker)) return true;
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return false;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApiRequest(request, "agreement:read");
  if (!auth.ok) return auth.response;
  try {
    const agreementId = parseAgreementId((await context.params).id);
    await ensureStorageSchema();
    const workspaceId = auth.context.workspace.id;
    await requireActiveAgreement(workspaceId, agreementId);
    const db = getDb();
    const [allPartyRows, allRelationshipRows] = await Promise.all([
      db.select().from(agreementParties).where(and(
        eq(agreementParties.workspaceId, workspaceId), eq(agreementParties.agreementId, agreementId),
      )).orderBy(asc(agreementParties.id)).limit(201),
      db.select().from(agreementRelationships).where(and(
        eq(agreementRelationships.workspaceId, workspaceId),
        or(eq(agreementRelationships.sourceAgreementId, agreementId), eq(agreementRelationships.targetAgreementId, agreementId)),
        sql`exists (select 1 from agreements as source_agreement
          where source_agreement.workspace_id = ${agreementRelationships.workspaceId}
            and source_agreement.id = ${agreementRelationships.sourceAgreementId}
            and source_agreement.deleted_at is null)`,
        sql`exists (select 1 from agreements as target_agreement
          where target_agreement.workspace_id = ${agreementRelationships.workspaceId}
            and target_agreement.id = ${agreementRelationships.targetAgreementId}
            and target_agreement.deleted_at is null)`,
      )).orderBy(asc(agreementRelationships.id)).limit(201),
    ]);
    const partiesHasMore = allPartyRows.length > 200;
    const relationshipsHasMore = allRelationshipRows.length > 200;
    const partyRows = allPartyRows.slice(0, 200);
    const relationshipRows = allRelationshipRows.slice(0, 200);
    const legalEntityIds = partyRows.flatMap((row) => row.legalEntityId ? [row.legalEntityId] : []);
    const counterpartyIds = partyRows.flatMap((row) => row.counterpartyId ? [row.counterpartyId] : []);
    const relatedAgreementIds = Array.from(new Set(relationshipRows.flatMap((row) => [row.sourceAgreementId, row.targetAgreementId])));
    const [entityRows, counterpartyRows, relatedAgreements] = await Promise.all([
      legalEntityIds.length ? db.select({ id: legalEntities.id, displayName: legalEntities.displayName, legalName: legalEntities.legalName, status: legalEntities.status })
        .from(legalEntities).where(and(eq(legalEntities.workspaceId, workspaceId), inArray(legalEntities.id, legalEntityIds))) : Promise.resolve([]),
      counterpartyIds.length ? db.select({ id: counterparties.id, displayName: counterparties.displayName, legalName: counterparties.legalName, status: counterparties.status })
        .from(counterparties).where(and(eq(counterparties.workspaceId, workspaceId), inArray(counterparties.id, counterpartyIds))) : Promise.resolve([]),
      relatedAgreementIds.length ? db.select({ id: agreements.id, party: agreements.party, stage: agreements.stage, deletedAt: agreements.deletedAt })
        .from(agreements).where(and(
          eq(agreements.workspaceId, workspaceId), inArray(agreements.id, relatedAgreementIds), isNull(agreements.deletedAt),
        )) : Promise.resolve([]),
    ]);
    const entitiesById = new Map(entityRows.map((row) => [row.id, row]));
    const counterpartiesById = new Map(counterpartyRows.map((row) => [row.id, row]));
    const agreementsById = new Map(relatedAgreements.map((row) => [row.id, row]));
    return apiJson({
      parties: partyRows.map((row) => ({
        ...row,
        targetType: row.legalEntityId ? "legal_entity" : "counterparty",
        target: row.legalEntityId ? entitiesById.get(row.legalEntityId) ?? null : counterpartiesById.get(row.counterpartyId!) ?? null,
      })),
      relationships: relationshipRows.filter((row) => (
        agreementsById.has(row.sourceAgreementId) && agreementsById.has(row.targetAgreementId)
      )).map((row) => ({
        ...row,
        direction: row.sourceAgreementId === agreementId ? "outbound" : "inbound",
        sourceAgreement: agreementsById.get(row.sourceAgreementId) ?? null,
        targetAgreement: agreementsById.get(row.targetAgreementId) ?? null,
      })),
      page: {
        parties: { limit: 200, hasMore: partiesHasMore },
        relationships: { limit: 200, hasMore: relationshipsHasMore },
      },
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Agreement relationships could not be loaded.");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApiRequest(request, "agreement:update", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const agreementId = parseAgreementId((await context.params).id);
    const input = await parseJson(request, addSchema, 8_000);
    await ensureStorageSchema();
    const workspaceId = auth.context.workspace.id;
    await requireActiveAgreement(workspaceId, agreementId);
    const db = getDb();
    const now = new Date().toISOString();
    if (input.action === "add_party") {
      if ((input.role === "our_entity" && input.targetType !== "legal_entity")
        || (input.role === "counterparty" && input.targetType !== "counterparty")) {
        throw new EnterpriseError(422, "party_target_type_mismatch", "Our-entity roles require a legal entity, and counterparty roles require a counterparty.");
      }
      const targetRows = input.targetType === "legal_entity"
        ? await db.select({ id: legalEntities.id }).from(legalEntities).where(and(
            eq(legalEntities.workspaceId, workspaceId), eq(legalEntities.id, input.targetId), eq(legalEntities.status, "active"),
          )).limit(1)
        : await db.select({ id: counterparties.id }).from(counterparties).where(and(
            eq(counterparties.workspaceId, workspaceId), eq(counterparties.id, input.targetId), eq(counterparties.status, "active"),
          )).limit(1);
      if (!targetRows[0]) throw new EnterpriseError(404, "party_target_not_found", "Select an active party in this workspace.");
      const [duplicate] = await db.select({ id: agreementParties.id }).from(agreementParties).where(and(
        eq(agreementParties.workspaceId, workspaceId),
        eq(agreementParties.agreementId, agreementId),
        eq(agreementParties.role, input.role),
        input.targetType === "legal_entity" ? eq(agreementParties.legalEntityId, input.targetId) : isNull(agreementParties.legalEntityId),
        input.targetType === "counterparty" ? eq(agreementParties.counterpartyId, input.targetId) : isNull(agreementParties.counterpartyId),
      )).limit(1);
      if (duplicate) throw new EnterpriseError(409, "agreement_party_exists", "This party is already linked in that role.");
      if (input.primary) {
        const [currentPrimary] = await db.select({ id: agreementParties.id }).from(agreementParties).where(and(
          eq(agreementParties.workspaceId, workspaceId),
          eq(agreementParties.agreementId, agreementId),
          eq(agreementParties.role, input.role),
          eq(agreementParties.primary, true),
        )).limit(1);
        if (currentPrimary) throw new EnterpriseError(409, "agreement_party_exists", "This role already has a primary party.");
      }
      const party = {
        id: crypto.randomUUID(), workspaceId, agreementId, role: input.role,
        legalEntityId: input.targetType === "legal_entity" ? input.targetId : null,
        counterpartyId: input.targetType === "counterparty" ? input.targetId : null,
        primary: input.primary, createdByUserId: auth.context.user.id, createdAt: now,
      };
      try {
        await executeEnterpriseMutation(db, {
          workspaceId, actor: auth.context.user, type: "AgreementPartyAdded",
          detail: { action: "agreement_party.added", agreementId, partyId: party.id, role: party.role, targetType: input.targetType, targetId: input.targetId },
          steps: [{ statement: db.insert(agreementParties).values(party) }], createdAt: now,
        });
      } catch (error) {
        if (isWrappedDatabaseMarker(error, "duplicate_agreement_party") || isWrappedUniqueConstraintError(error, [
          "agreement_parties.workspace_id", "agreement_parties.agreement_id", "agreement_parties.role",
        ])) throw new EnterpriseError(409, "agreement_party_exists", "This party is already linked in that role, or the role already has a primary party.");
        throw error;
      }
      return apiJson({ party, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
    }
    if (input.targetAgreementId === agreementId) throw new EnterpriseError(400, "self_relationship", "An agreement cannot be related to itself.");
    await requireActiveAgreement(workspaceId, input.targetAgreementId);
    const relationship = {
      id: crypto.randomUUID(), workspaceId, sourceAgreementId: agreementId, targetAgreementId: input.targetAgreementId,
      relationshipType: input.relationshipType, createdByUserId: auth.context.user.id, createdAt: now,
    };
    try {
      await executeEnterpriseMutation(db, {
        workspaceId, actor: auth.context.user, type: "AgreementRelationshipAdded",
        detail: { action: "agreement_relationship.added", relationshipId: relationship.id, agreementId, targetAgreementId: input.targetAgreementId, relationshipType: input.relationshipType },
        steps: [{ statement: db.insert(agreementRelationships).values(relationship) }], createdAt: now,
      });
    } catch (error) {
      if (isWrappedUniqueConstraintError(error, [
        "agreement_relationships.workspace_id", "agreement_relationships.source_agreement_id",
        "agreement_relationships.target_agreement_id", "agreement_relationships.relationship_type",
      ])) throw new EnterpriseError(409, "agreement_relationship_exists", "This relationship already exists.");
      throw error;
    }
    return apiJson({ relationship, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The agreement relationship could not be added.");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApiRequest(request, "agreement:update", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const agreementId = parseAgreementId((await context.params).id);
    const input = await parseJson(request, removeSchema, 8_000);
    await ensureStorageSchema();
    const workspaceId = auth.context.workspace.id;
    await requireActiveAgreement(workspaceId, agreementId);
    const db = getDb();
    const now = new Date().toISOString();
    if (input.kind === "party") {
      await executeEnterpriseMutation(db, {
        workspaceId, actor: auth.context.user, type: "AgreementPartyRemoved",
        detail: { action: "agreement_party.removed", agreementId, partyId: input.id, reason: input.reason },
        steps: [{
          statement: db.delete(agreementParties).where(and(
            eq(agreementParties.workspaceId, workspaceId), eq(agreementParties.agreementId, agreementId), eq(agreementParties.id, input.id),
          )), guardOperation: "agreement-party.delete",
        }], createdAt: now,
      });
    } else {
      await executeEnterpriseMutation(db, {
        workspaceId, actor: auth.context.user, type: "AgreementRelationshipRemoved",
        detail: { action: "agreement_relationship.removed", agreementId, relationshipId: input.id, reason: input.reason },
        steps: [{
          statement: db.delete(agreementRelationships).where(and(
            eq(agreementRelationships.workspaceId, workspaceId), eq(agreementRelationships.id, input.id),
            or(eq(agreementRelationships.sourceAgreementId, agreementId), eq(agreementRelationships.targetAgreementId, agreementId)),
          )), guardOperation: "agreement-relationship.delete",
        }], createdAt: now,
      });
    }
    return apiJson({ deleted: true, kind: input.kind, id: input.id, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The agreement relationship could not be removed.");
  }
}
