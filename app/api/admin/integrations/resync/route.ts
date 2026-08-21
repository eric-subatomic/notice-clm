import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import {
  agreementEvents,
  agreements,
  agreementVersions,
  crmLegacyCleanupAttestations,
  mutationGuards,
  outboxDeliveries,
  outboxEvents,
} from "../../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../../lib/api";
import {
  decodeCrmResyncCursor,
  encodeCrmResyncCursor,
  evaluateCrmResyncEligibility,
  crmLegacyEventPayloadSha256,
  summarizeCrmProfileReceiptState,
  CRM_HISTORICAL_CLEANUP_CONFIRMATION,
  CRM_LEGACY_CLEANUP_CONFIRMATION,
  type CrmResyncAction,
  type CrmProfileAggregateEvidence,
  type CrmProfileReceiptState,
} from "../../../../lib/crm-resync-policy";
import { crmDestinationFingerprint } from "../../../../lib/delivery";
import { loadCurrentIntegrationDiagnostics } from "../../../../lib/integration-diagnostics";
import {
  agreementSelectionForCrmProvider,
  crmProviderForAgreementSelection,
  prepareAgreementDeletedIntegrationEvent,
  prepareAgreementUpdatedIntegrationEvent,
} from "../../../../lib/integration-events";
import { getIntegrationSummary, type IntegrationStatusSource } from "../../../../lib/integration-status";
import { apiError, apiJson } from "../../../../lib/http";
import {
  prepareAgreementEvent,
  prepareAgreementSnapshot,
  prepareOutboxEvent,
} from "../../../../lib/persistence";
import { getCrmConfiguration, type CrmGatewayConfiguration } from "../../../../lib/providers";
import { parseJson } from "../../../../lib/validation";

export const dynamic = "force-dynamic";

const commonResyncShape = {
  agreementId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  reason: z.string().trim().min(3).max(500),
} as const;
const resyncSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("projection"), ...commonResyncShape }).strict(),
  z.object({
    action: z.literal("tombstone"),
    ...commonResyncShape,
    historicalCleanupConfirmed: z.literal(true).optional(),
    historicalCleanupConfirmation: z.literal(CRM_HISTORICAL_CLEANUP_CONFIRMATION).optional(),
  }).strict(),
  z.object({
    action: z.literal("legacy_cleanup_attestation"),
    ...commonResyncShape,
    legacyCleanupConfirmed: z.literal(true),
    legacyCleanupConfirmation: z.literal(CRM_LEGACY_CLEANUP_CONFIRMATION),
  }).strict(),
]);

const PAGE_SIZE = 50;
const CRM_PROJECTION_TOPICS = [
  "agreement.created",
  "agreement.updated",
  "agreement.stage_changed",
  "signature.completed",
] as const;
const CRM_MUTATION_TOPICS = [...CRM_PROJECTION_TOPICS, "agreement.deleted"] as const;
// Every evidence row is inserted with its own transactional predicate and
// immediately checked mutation guard (two D1 batch statements per row).
const LEGACY_ATTESTATION_MAX_EVENTS = 20;
// D1 permits at most 100 bound parameters in a statement. Both page-level
// evidence queries bind each agreement ID once through crmAgreementKey. The
// profile queries have seven additional binds while the legacy query has six,
// so the worst case is 57.
const D1_MAX_BINDS_PER_STATEMENT = 100;
const CRM_PROFILE_PAGE_FIXED_BINDS = 7;
const CRM_LEGACY_PAGE_FIXED_BINDS = 6;
// The largest attestation-batch statement is final guard cleanup: workspace,
// the aggregate guard, and one evidence guard per row (22 binds at the cap).
const LEGACY_ATTESTATION_CLEANUP_FIXED_BINDS = 2;
const LEGACY_ATTESTATION_MAX_STATEMENT_BINDS = LEGACY_ATTESTATION_CLEANUP_FIXED_BINDS
  + LEGACY_ATTESTATION_MAX_EVENTS;
if (PAGE_SIZE + Math.max(CRM_PROFILE_PAGE_FIXED_BINDS, CRM_LEGACY_PAGE_FIXED_BINDS) > D1_MAX_BINDS_PER_STATEMENT) {
  throw new Error("CRM resync page exceeds the D1 statement bind limit");
}
if (LEGACY_ATTESTATION_MAX_STATEMENT_BINDS > D1_MAX_BINDS_PER_STATEMENT) {
  throw new Error("Legacy CRM cleanup exceeds the D1 statement bind limit");
}
const crmAgreementKey = sql<string>`case
  when ${outboxEvents.topic} = 'signature.completed' then case
    when json_valid(${outboxEvents.payload}) then cast(json_extract(${outboxEvents.payload}, '$.agreementId') as text)
  end
  when ${outboxEvents.aggregateType} = 'agreement' then ${outboxEvents.aggregateId}
end`;

const EMPTY_RECEIPT_STATE: CrmProfileReceiptState = Object.freeze({
  potentialProjectionVersion: null,
  acceptedTombstoneVersion: null,
  newestUnresolvedAcceptedOtherProfileVersion: null,
  newestUnreconciledProfileMutationVersion: null,
});

type LegacyProjectionEvidence = Readonly<{
  eventId: string;
  eventPayloadSha256: string;
  payload: Record<string, unknown>;
  providerSelection: "Salesforce" | "HubSpot" | "Custom CRM";
}>;

function legacyProviderSelection(payload: Record<string, unknown>): LegacyProjectionEvidence["providerSelection"] | null {
  const projection = payload.crmAgreement;
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) return null;
  const selection = (projection as Record<string, unknown>).crm;
  return selection === "Salesforce" || selection === "HubSpot" || selection === "Custom CRM" ? selection : null;
}

function legacyProfileIncomplete() {
  return or(
    isNull(outboxDeliveries.eventId),
    isNull(outboxDeliveries.crmProvider),
    isNull(outboxDeliveries.crmMappingVersion),
    isNull(outboxDeliveries.crmDestinationFingerprint),
  );
}

async function loadAgreementsWithUnattestedLegacyEvidence(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  agreementIds: readonly number[],
): Promise<ReadonlySet<string>> {
  if (agreementIds.length === 0) return new Set();
  const ids = agreementIds.map(String);
  const rows = await db.select({ agreementId: crmAgreementKey }).from(outboxEvents)
    .leftJoin(outboxDeliveries, and(
      eq(outboxDeliveries.workspaceId, outboxEvents.workspaceId),
      eq(outboxDeliveries.eventId, outboxEvents.id),
      eq(outboxDeliveries.sink, "crm"),
    )).leftJoin(crmLegacyCleanupAttestations, and(
      eq(crmLegacyCleanupAttestations.workspaceId, outboxEvents.workspaceId),
      eq(crmLegacyCleanupAttestations.eventId, outboxEvents.id),
    )).where(and(
      eq(outboxEvents.workspaceId, workspaceId),
      inArray(outboxEvents.topic, [...CRM_PROJECTION_TOPICS]),
      inArray(crmAgreementKey, ids),
      sql`json_valid(${outboxEvents.payload}) = 1`,
      sql`json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') in ('Salesforce', 'HubSpot', 'Custom CRM')`,
      legacyProfileIncomplete(),
      isNull(crmLegacyCleanupAttestations.eventId),
    )).groupBy(crmAgreementKey);
  return new Set(rows.map((row) => row.agreementId));
}

async function loadUnattestedLegacyProjectionEvidence(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  agreementId: number,
): Promise<Readonly<{ evidence: readonly LegacyProjectionEvidence[]; hasMore: boolean }>> {
  const rows = await db.select({
    eventId: outboxEvents.id,
    payload: outboxEvents.payload,
  }).from(outboxEvents).leftJoin(outboxDeliveries, and(
    eq(outboxDeliveries.workspaceId, outboxEvents.workspaceId),
    eq(outboxDeliveries.eventId, outboxEvents.id),
    eq(outboxDeliveries.sink, "crm"),
  )).leftJoin(crmLegacyCleanupAttestations, and(
    eq(crmLegacyCleanupAttestations.workspaceId, outboxEvents.workspaceId),
    eq(crmLegacyCleanupAttestations.eventId, outboxEvents.id),
  )).where(and(
    eq(outboxEvents.workspaceId, workspaceId),
    inArray(outboxEvents.topic, [...CRM_PROJECTION_TOPICS]),
    or(
      and(
        eq(outboxEvents.aggregateType, "agreement"),
        eq(outboxEvents.aggregateId, String(agreementId)),
      ),
      and(
        eq(outboxEvents.topic, "signature.completed"),
        sql`json_valid(${outboxEvents.payload}) = 1`,
        sql`cast(json_extract(${outboxEvents.payload}, '$.agreementId') as integer) = ${agreementId}`,
      ),
    ),
    sql`json_valid(${outboxEvents.payload}) = 1`,
    sql`json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') in ('Salesforce', 'HubSpot', 'Custom CRM')`,
    legacyProfileIncomplete(),
    isNull(crmLegacyCleanupAttestations.eventId),
  )).orderBy(outboxEvents.createdAt, outboxEvents.id).limit(LEGACY_ATTESTATION_MAX_EVENTS + 1);
  const hasMore = rows.length > LEGACY_ATTESTATION_MAX_EVENTS;
  const evidence: LegacyProjectionEvidence[] = [];
  for (const row of rows.slice(0, LEGACY_ATTESTATION_MAX_EVENTS)) {
    const providerSelection = legacyProviderSelection(row.payload);
    if (!providerSelection) continue;
    evidence.push(Object.freeze({
      eventId: row.eventId,
      eventPayloadSha256: await crmLegacyEventPayloadSha256(row.payload),
      payload: row.payload,
      providerSelection,
    }));
  }
  return Object.freeze({ evidence: Object.freeze(evidence), hasMore });
}

function sameLegacyEvidence(
  left: readonly LegacyProjectionEvidence[],
  right: readonly LegacyProjectionEvidence[],
): boolean {
  const serialize = (rows: readonly LegacyProjectionEvidence[]) => JSON.stringify(
    [...rows].sort((a, b) => a.eventId.localeCompare(b.eventId)).map((row) => [
      row.eventId,
      row.eventPayloadSha256,
      row.providerSelection,
    ]),
  );
  return serialize(left) === serialize(right);
}

async function loadProfileReceiptStates(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  agreementIds: readonly number[],
  configuration: CrmGatewayConfiguration,
): Promise<Readonly<{
  fingerprint: string;
  states: ReadonlyMap<string, CrmProfileReceiptState>;
}>> {
  const fingerprint = await crmDestinationFingerprint(configuration);
  if (agreementIds.length === 0) return { fingerprint, states: new Map() };
  const projectionVersion = sql<number | null>`max(case when json_valid(${outboxEvents.payload}) then case
    when ${outboxEvents.topic} in ('agreement.created', 'agreement.updated', 'agreement.stage_changed', 'signature.completed')
      and (
        (${outboxDeliveries.crmProvider} = 'hubspot' and json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') = 'HubSpot')
        or (${outboxDeliveries.crmProvider} = 'salesforce' and json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') = 'Salesforce')
        or (${outboxDeliveries.crmProvider} = 'custom' and json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') = 'Custom CRM')
      )
    then cast(json_extract(${outboxEvents.payload}, '$.crmAgreement.version') as integer)
  end end)`;
  const acceptedProjectionVersion = sql<number | null>`max(case when json_valid(${outboxEvents.payload}) then case
    when ${outboxDeliveries.status} = 'accepted'
      and ${outboxEvents.topic} in ('agreement.created', 'agreement.updated', 'agreement.stage_changed', 'signature.completed')
      and (
        (${outboxDeliveries.crmProvider} = 'hubspot' and json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') = 'HubSpot')
        or (${outboxDeliveries.crmProvider} = 'salesforce' and json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') = 'Salesforce')
        or (${outboxDeliveries.crmProvider} = 'custom' and json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') = 'Custom CRM')
      )
    then cast(json_extract(${outboxEvents.payload}, '$.crmAgreement.version') as integer)
  end end)`;
  const nonAcceptedMutationVersion = sql<number | null>`max(case when json_valid(${outboxEvents.payload})
    and ${outboxDeliveries.status} <> 'accepted' then case
      when ${outboxEvents.topic} in ('agreement.created', 'agreement.updated', 'agreement.stage_changed', 'signature.completed')
        and (
          (${outboxDeliveries.crmProvider} = 'hubspot' and json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') = 'HubSpot')
          or (${outboxDeliveries.crmProvider} = 'salesforce' and json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') = 'Salesforce')
          or (${outboxDeliveries.crmProvider} = 'custom' and json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') = 'Custom CRM')
        )
      then cast(json_extract(${outboxEvents.payload}, '$.crmAgreement.version') as integer)
      when ${outboxEvents.topic} = 'agreement.deleted'
        and (
          (${outboxDeliveries.crmProvider} = 'hubspot' and json_extract(${outboxEvents.payload}, '$.crm') = 'HubSpot')
          or (${outboxDeliveries.crmProvider} = 'salesforce' and json_extract(${outboxEvents.payload}, '$.crm') = 'Salesforce')
          or (${outboxDeliveries.crmProvider} = 'custom' and json_extract(${outboxEvents.payload}, '$.crm') = 'Custom CRM')
        )
      then cast(json_extract(${outboxEvents.payload}, '$.version') as integer)
    end end)`;
  const tombstoneVersion = sql<number | null>`max(case when json_valid(${outboxEvents.payload}) then case
    when ${outboxEvents.topic} = 'agreement.deleted'
      and ${outboxDeliveries.status} = 'accepted'
      and (
        (${outboxDeliveries.crmProvider} = 'hubspot' and json_extract(${outboxEvents.payload}, '$.crm') = 'HubSpot')
        or (${outboxDeliveries.crmProvider} = 'salesforce' and json_extract(${outboxEvents.payload}, '$.crm') = 'Salesforce')
        or (${outboxDeliveries.crmProvider} = 'custom' and json_extract(${outboxEvents.payload}, '$.crm') = 'Custom CRM')
      )
    then cast(json_extract(${outboxEvents.payload}, '$.version') as integer)
  end end)`;
  const profileRows = await db.select({
    agreementId: crmAgreementKey,
    provider: outboxDeliveries.crmProvider,
    mappingVersion: outboxDeliveries.crmMappingVersion,
    destinationFingerprint: outboxDeliveries.crmDestinationFingerprint,
    potentialProjectionVersion: projectionVersion,
    acceptedProjectionVersion,
    acceptedTombstoneVersion: tombstoneVersion,
    nonAcceptedMutationVersion,
  }).from(outboxDeliveries).innerJoin(outboxEvents, and(
    eq(outboxEvents.id, outboxDeliveries.eventId),
    eq(outboxEvents.workspaceId, outboxDeliveries.workspaceId),
  )).where(and(
    eq(outboxDeliveries.workspaceId, workspaceId),
    eq(outboxDeliveries.sink, "crm"),
    isNotNull(outboxDeliveries.crmProvider),
    isNotNull(outboxDeliveries.crmMappingVersion),
    isNotNull(outboxDeliveries.crmDestinationFingerprint),
    inArray(outboxEvents.topic, [...CRM_MUTATION_TOPICS]),
    inArray(crmAgreementKey, agreementIds.map(String)),
  )).groupBy(
    crmAgreementKey,
    outboxDeliveries.crmProvider,
    outboxDeliveries.crmMappingVersion,
    outboxDeliveries.crmDestinationFingerprint,
  );

  const unreconciledVersion = sql<number | null>`max(case when json_valid(${outboxEvents.payload}) then case
    when (
      (${outboxEvents.topic} in ('agreement.created', 'agreement.updated', 'agreement.stage_changed', 'signature.completed')
        and json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') in ('Salesforce', 'HubSpot', 'Custom CRM'))
      or (${outboxEvents.topic} = 'agreement.deleted'
        and json_extract(${outboxEvents.payload}, '$.crm') in ('Salesforce', 'HubSpot', 'Custom CRM'))
    )
      and ${crmLegacyCleanupAttestations.eventId} is null
      and (
        ${outboxDeliveries.eventId} is null
        or ${outboxDeliveries.crmProvider} is null
        or ${outboxDeliveries.crmMappingVersion} is null
        or ${outboxDeliveries.crmDestinationFingerprint} is null
      )
    then case when ${outboxEvents.topic} = 'agreement.deleted'
      then cast(json_extract(${outboxEvents.payload}, '$.version') as integer)
      else cast(json_extract(${outboxEvents.payload}, '$.crmAgreement.version') as integer)
    end
  end end)`;
  const unreconciledRows = await db.select({
    agreementId: crmAgreementKey,
    newestUnreconciledProfileMutationVersion: unreconciledVersion,
  }).from(outboxEvents).leftJoin(outboxDeliveries, and(
    eq(outboxDeliveries.workspaceId, outboxEvents.workspaceId),
    eq(outboxDeliveries.eventId, outboxEvents.id),
    eq(outboxDeliveries.sink, "crm"),
  )).leftJoin(crmLegacyCleanupAttestations, and(
    eq(crmLegacyCleanupAttestations.workspaceId, outboxEvents.workspaceId),
    eq(crmLegacyCleanupAttestations.eventId, outboxEvents.id),
  )).where(and(
    eq(outboxEvents.workspaceId, workspaceId),
    inArray(outboxEvents.topic, [...CRM_MUTATION_TOPICS]),
    inArray(crmAgreementKey, agreementIds.map(String)),
  )).groupBy(crmAgreementKey);

  const unreconciledByAgreement = new Map(unreconciledRows.map((row) => [
    row.agreementId,
    row.newestUnreconciledProfileMutationVersion ?? null,
  ]));
  const profilesByAgreement = new Map<string, typeof profileRows>();
  for (const row of profileRows) {
    const rows = profilesByAgreement.get(row.agreementId) ?? [];
    rows.push(row);
    profilesByAgreement.set(row.agreementId, rows);
  }
  const states = new Map<string, CrmProfileReceiptState>();
  for (const agreementId of agreementIds.map(String)) {
    const profiles = profilesByAgreement.get(agreementId) ?? [];
    states.set(agreementId, summarizeCrmProfileReceiptState(
      profiles as readonly CrmProfileAggregateEvidence[],
      {
        provider: configuration.provider,
        mappingVersion: configuration.mappingVersion,
        destinationFingerprint: fingerprint,
      },
      unreconciledByAgreement.get(agreementId) ?? null,
    ));
  }
  return {
    fingerprint,
    states,
  };
}

async function loadLatestBoundProjectionCrmRecord(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  agreementId: number,
  configuration: CrmGatewayConfiguration,
  fingerprint: string,
): Promise<string | null> {
  const selection = agreementSelectionForCrmProvider(configuration.provider);
  const version = sql<number>`cast(json_extract(${outboxEvents.payload}, '$.crmAgreement.version') as integer)`;
  const [row] = await db.select({ payload: outboxEvents.payload }).from(outboxDeliveries).innerJoin(outboxEvents, and(
    eq(outboxEvents.id, outboxDeliveries.eventId),
    eq(outboxEvents.workspaceId, outboxDeliveries.workspaceId),
  )).where(and(
    eq(outboxDeliveries.workspaceId, workspaceId),
    eq(outboxDeliveries.sink, "crm"),
    eq(outboxDeliveries.crmProvider, configuration.provider),
    eq(outboxDeliveries.crmMappingVersion, configuration.mappingVersion),
    eq(outboxDeliveries.crmDestinationFingerprint, fingerprint),
    inArray(outboxEvents.topic, [...CRM_PROJECTION_TOPICS]),
    or(
      and(
        eq(outboxEvents.aggregateType, "agreement"),
        eq(outboxEvents.aggregateId, String(agreementId)),
      ),
      and(
        eq(outboxEvents.topic, "signature.completed"),
        sql`json_valid(${outboxEvents.payload}) = 1`,
        sql`cast(json_extract(${outboxEvents.payload}, '$.agreementId') as integer) = ${agreementId}`,
      ),
    ),
    sql`json_valid(${outboxEvents.payload}) = 1`,
    sql`json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') = ${selection}`,
    sql`json_type(${outboxEvents.payload}, '$.crmAgreement.version') = 'integer'`,
  )).orderBy(desc(version), desc(outboxEvents.createdAt), desc(outboxEvents.id)).limit(1);
  const projection = row?.payload.crmAgreement;
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) return null;
  const crmRecord = (projection as Record<string, unknown>).crmRecord;
  return typeof crmRecord === "string" && crmRecord.length <= 500 ? crmRecord : "";
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "integration:manage");
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(request.url);
    const parameters = [...url.searchParams.keys()];
    if (parameters.some((name) => name !== "cursor") || url.searchParams.getAll("cursor").length > 1) {
      return apiError("invalid_query", "Only one CRM resync cursor is accepted.", {
        status: 400,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }
    let cursor;
    try {
      cursor = decodeCrmResyncCursor(url.searchParams.get("cursor"));
    } catch {
      return apiError("invalid_cursor", "The CRM resync page cursor is invalid.", {
        status: 400,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }
    await ensureStorageSchema();
    const db = getDb();
    const rows = await db.select({
      id: agreements.id,
      version: agreements.version,
      party: agreements.party,
      crm: agreements.crm,
      deletedAt: agreements.deletedAt,
      updatedAt: agreements.updatedAt,
    }).from(agreements).where(and(
      eq(agreements.workspaceId, auth.context.workspace.id),
      cursor ? or(
        lt(agreements.updatedAt, cursor.updatedAt),
        and(eq(agreements.updatedAt, cursor.updatedAt), lt(agreements.id, cursor.id)),
      ) : undefined,
    )).orderBy(desc(agreements.updatedAt), desc(agreements.id)).limit(PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    const runtimeSource = env as unknown as IntegrationStatusSource;
    const summary = getIntegrationSummary(runtimeSource, "crm");
    const diagnostics = await loadCurrentIntegrationDiagnostics(auth.context.workspace.id, runtimeSource);
    const diagnosticPassed = diagnostics.crm?.status === "passed";
    const configuration = summary.configured && diagnosticPassed ? getCrmConfiguration() : null;
    const evidence = configuration
      ? await loadProfileReceiptStates(db, auth.context.workspace.id, page.map((row) => row.id), configuration)
      : null;
    const legacyAgreementIds = await loadAgreementsWithUnattestedLegacyEvidence(
      db,
      auth.context.workspace.id,
      page.map((row) => row.id),
    );
    const agreementsWithActions = page.map((row) => {
      const profileEligibility = configuration && evidence
        ? evaluateCrmResyncEligibility({
          agreementProvider: crmProviderForAgreementSelection(row.crm),
          deletedAt: row.deletedAt,
          profileProvider: configuration.provider,
          receipts: evidence.states.get(String(row.id)) ?? EMPTY_RECEIPT_STATE,
        })
        : null;
      const eligibleActions: CrmResyncAction[] = [...(profileEligibility?.actions ?? [])];
      if (legacyAgreementIds.has(String(row.id))) eligibleActions.push("legacy_cleanup_attestation");
      return {
        ...row,
        eligibleActions,
        historicalCleanup: profileEligibility?.historicalCleanup ?? false,
        resyncBlockedReason: profileEligibility?.blockedByUnreconciledMutation
          ? "A newer CRM projection or cleanup mutation has not acquired a durable accepted destination receipt. Run or reconcile the outbox before choosing a profile repair."
          : profileEligibility?.blockedByHistoricalReactivation
            ? "This previously used CRM profile was already cleaned while another accepted profile remains live. Create a new immutable profile revision for an approved rollback."
          : null,
      };
    });
    const last = page.at(-1);
    return apiJson({
      agreements: agreementsWithActions,
      nextCursor: rows.length > PAGE_SIZE && last
        ? encodeCrmResyncCursor({ updatedAt: last.updatedAt, id: last.id })
        : null,
      crm: {
        configured: summary.configured,
        diagnosticPassed,
        provider: summary.provider,
      },
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "CRM resync candidates could not be loaded.");
  }
}

/** Queue a tested-profile repair or record an explicit legacy-cleanup attestation. */
export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "integration:manage", { limit: 20 });
  if (!auth.ok) return auth.response;

  try {
    const input = await parseJson(request, resyncSchema, 8_000);
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    const [current] = await db.select().from(agreements).where(and(
      eq(agreements.workspaceId, workspaceId),
      eq(agreements.id, input.agreementId),
    )).limit(1);
    if (!current) {
      return apiError("agreement_not_found", "Agreement was not found.", {
        status: 404,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }
    if (current.version !== input.version) {
      return apiError("version_conflict", "Reload the agreement before queuing a CRM resync.", {
        status: 409,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }

    if (input.action === "legacy_cleanup_attestation") {
      const initialPage = await loadUnattestedLegacyProjectionEvidence(db, workspaceId, current.id);
      const initialEvidence = initialPage.evidence;
      if (initialEvidence.length === 0) {
        return apiError("legacy_cleanup_not_eligible", "No unattested, non-None CRM projection with missing destination metadata exists for this agreement.", {
          status: 409,
          requestId: auth.requestId,
          headers: auth.headers,
        });
      }

      const now = new Date().toISOString();
      const patch = {
        version: current.version + 1,
        updated: now,
        updatedAt: now,
        updatedByUserId: auth.context.user.id,
      };
      const saved: typeof agreements.$inferSelect = { ...current, ...patch };
      const providerSelections = [...new Set(initialEvidence.map((row) => row.providerSelection))].sort();
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: current.id,
        type: "Legacy CRM cleanup attested",
        detail: `Administrator attested external cleanup for ${initialEvidence.length} legacy CRM projection event${initialEvidence.length === 1 ? "" : "s"} with unknown destination metadata (${providerSelections.join(", ")}).${current.deletedAt === null ? "" : " A fresh exact-version canonical deletion tombstone was queued."} Reason: ${input.reason}`,
        actor: auth.context.user,
        createdAt: now,
      });
      const snapshot = await prepareAgreementSnapshot(saved, auth.context.user.id, event.id);
      const deletionOutbox = current.deletedAt === null ? null : prepareOutboxEvent(
        prepareAgreementDeletedIntegrationEvent({
          agreement: saved,
          deletedAt: current.deletedAt,
          causationId: auth.requestId,
        }),
      );
      // Re-read and re-hash the immutable source payloads immediately before
      // insertion so each attestation is bound to current database evidence.
      const verifiedPage = await loadUnattestedLegacyProjectionEvidence(db, workspaceId, current.id);
      const verifiedEvidence = verifiedPage.evidence;
      if (
        initialPage.hasMore !== verifiedPage.hasMore
        || !sameLegacyEvidence(initialEvidence, verifiedEvidence)
      ) {
        return apiError("legacy_cleanup_evidence_changed", "Legacy CRM evidence changed while the attestation was prepared. Reload before retrying.", {
          status: 409,
          requestId: auth.requestId,
          headers: auth.headers,
        });
      }
      const guardId = crypto.randomUUID();
      const attestationGuardIds: string[] = [];
      const attestationCommands = verifiedEvidence.flatMap((row) => {
        const attestationGuardId = crypto.randomUUID();
        attestationGuardIds.push(attestationGuardId);
        return [
          db.insert(crmLegacyCleanupAttestations).select(db.select({
            workspaceId: sql<string>`${workspaceId}`.as("workspace_id"),
            agreementId: sql<number>`${current.id}`.as("agreement_id"),
            eventId: outboxEvents.id,
            eventPayloadSha256: sql<string>`${row.eventPayloadSha256}`.as("event_payload_sha256"),
            providerSelection: sql<LegacyProjectionEvidence["providerSelection"]>`${row.providerSelection}`.as("provider_selection"),
            reason: sql<string>`${input.reason}`.as("reason"),
            attestedByUserId: sql<string>`${auth.context.user.id}`.as("attested_by_user_id"),
            createdAt: sql<string>`${now}`.as("created_at"),
          }).from(outboxEvents).leftJoin(outboxDeliveries, and(
            eq(outboxDeliveries.workspaceId, outboxEvents.workspaceId),
            eq(outboxDeliveries.eventId, outboxEvents.id),
            eq(outboxDeliveries.sink, "crm"),
          )).leftJoin(crmLegacyCleanupAttestations, and(
            eq(crmLegacyCleanupAttestations.workspaceId, outboxEvents.workspaceId),
            eq(crmLegacyCleanupAttestations.eventId, outboxEvents.id),
          )).where(and(
            eq(outboxEvents.workspaceId, workspaceId),
            eq(outboxEvents.id, row.eventId),
            eq(outboxEvents.payload, row.payload),
            inArray(outboxEvents.topic, [...CRM_PROJECTION_TOPICS]),
            eq(crmAgreementKey, String(current.id)),
            sql`json_valid(${outboxEvents.payload}) = 1`,
            sql`json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') = ${row.providerSelection}`,
            legacyProfileIncomplete(),
            isNull(crmLegacyCleanupAttestations.eventId),
          ))),
          db.insert(mutationGuards).values({
            id: attestationGuardId,
            workspaceId,
            operation: "integration.crm_legacy_cleanup_evidence",
            guardChanges: sql<number>`changes()`,
            createdAt: now,
          }),
        ];
      });
      const [result] = await db.batch([
        db.update(agreements).set(patch).where(and(
          eq(agreements.workspaceId, workspaceId),
          eq(agreements.id, current.id),
          eq(agreements.version, current.version),
          eq(agreements.nextAction, current.nextAction),
          ...(current.deletedAt === null
            ? [isNull(agreements.deletedAt)]
            : [eq(agreements.deletedAt, current.deletedAt)]),
        )),
        db.insert(mutationGuards).values({
          id: guardId,
          workspaceId,
          operation: "integration.crm_legacy_cleanup_attestation",
          guardChanges: sql<number>`changes()`,
          createdAt: now,
        }),
        db.insert(agreementEvents).values(event),
        db.insert(agreementVersions).values(snapshot),
        ...(deletionOutbox ? [db.insert(outboxEvents).values(deletionOutbox)] : []),
        ...attestationCommands,
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, workspaceId),
          inArray(mutationGuards.id, [guardId, ...attestationGuardIds]),
        )),
      ]);
      if (!result.meta.changes) {
        return apiError("version_conflict", "The agreement changed while legacy CRM cleanup was attested. Reload before retrying.", {
          status: 409,
          requestId: auth.requestId,
          headers: auth.headers,
        });
      }
      return apiJson({
        agreement: saved,
        auditEvent: { id: event.id, type: event.type },
        ...(deletionOutbox ? { event: {
          id: deletionOutbox.id,
          topic: deletionOutbox.topic,
          aggregateVersion: saved.version,
          status: deletionOutbox.status,
        } } : {}),
        crm: {
          action: input.action,
          attestedEvents: verifiedEvidence.length,
          hasMore: verifiedPage.hasMore,
          providerSelections,
          deliveryQueued: deletionOutbox !== null,
        },
        requestId: auth.requestId,
      }, { status: 201, requestId: auth.requestId, headers: auth.headers });
    }

    const runtimeSource = env as unknown as IntegrationStatusSource;
    const summary = getIntegrationSummary(runtimeSource, "crm");
    if (!summary.configured) {
      return apiError("crm_not_configured", "Enable, completely configure, and attest CRM synchronization before queuing a resync.", {
        status: 409,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }
    const diagnostics = await loadCurrentIntegrationDiagnostics(auth.context.workspace.id, runtimeSource);
    if (diagnostics.crm?.status !== "passed") {
      return apiError("crm_diagnostic_required", "Run a successful CRM connection test for the current provider, credentials, endpoint, and mapping before resyncing.", {
        status: 409,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }
    const configuration = getCrmConfiguration();
    if (!configuration) {
      return apiError("crm_not_configured", "Enable, completely configure, and attest CRM synchronization before queuing a resync.", {
        status: 409,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }

    const profileEvidence = await loadProfileReceiptStates(db, workspaceId, [current.id], configuration);
    const eligibility = evaluateCrmResyncEligibility({
      agreementProvider: crmProviderForAgreementSelection(current.crm),
      deletedAt: current.deletedAt,
      profileProvider: configuration.provider,
      receipts: profileEvidence.states.get(String(current.id)) ?? EMPTY_RECEIPT_STATE,
    });
    if (eligibility.blockedByUnreconciledMutation) {
      return apiError(
        "crm_projection_reconciliation_required",
        "A newer CRM projection or cleanup mutation has not acquired a durable accepted destination receipt. Run or reconcile the outbox before choosing a profile repair.",
        { status: 409, requestId: auth.requestId, headers: auth.headers },
      );
    }
    if (eligibility.blockedByHistoricalReactivation) {
      return apiError(
        "crm_profile_reactivation_not_supported",
        "This previously used CRM profile was already cleaned while another accepted profile remains live. Create and test a new immutable profile revision for an approved rollback.",
        { status: 409, requestId: auth.requestId, headers: auth.headers },
      );
    }
    if (!eligibility.actions.includes(input.action)) {
      return apiError(
        input.action === "projection" ? "crm_projection_not_eligible" : "crm_tombstone_not_eligible",
        input.action === "projection"
          ? "Only an active agreement that selects the current tested CRM provider can be projected."
          : "A tombstone requires either a deleted agreement targeting the current provider or an unresolved, fully bound projection attempt on this exact CRM destination profile.",
        { status: 409, requestId: auth.requestId, headers: auth.headers },
      );
    }
    if (
      input.action === "tombstone"
      && eligibility.historicalCleanup
      && (
        input.historicalCleanupConfirmed !== true
        || input.historicalCleanupConfirmation !== CRM_HISTORICAL_CLEANUP_CONFIRMATION
      )
    ) {
      return apiError(
        "crm_historical_cleanup_confirmation_required",
        "Confirm the controlled maintenance sequence and type the exact historical-profile cleanup sentence before queuing this tombstone.",
        { status: 409, requestId: auth.requestId, headers: auth.headers },
      );
    }

    const now = new Date().toISOString();
    const patch = {
      version: current.version + 1,
      updated: now,
      updatedAt: now,
      updatedByUserId: auth.context.user.id,
    };
    const saved: typeof agreements.$inferSelect = { ...current, ...patch };
    const isTombstone = input.action === "tombstone";
    const operationDescription = isTombstone
      ? eligibility.historicalCleanup ? "historical projection cleanup tombstone" : "deletion tombstone"
      : "agreement projection";
    const event = await prepareAgreementEvent(db, {
      workspaceId,
      agreementId: current.id,
      type: isTombstone ? "CRM tombstone resync" : "CRM projection resync",
      detail: `Administrator queued a fresh ${operationDescription} for CRM provider ${configuration.provider} mapping ${configuration.mappingVersion}.${eligibility.historicalCleanup ? " The operator explicitly confirmed the historical-profile maintenance and live-profile reprojection sequence." : ""} Reason: ${input.reason}`,
      actor: auth.context.user,
      createdAt: now,
    });
    const snapshot = await prepareAgreementSnapshot(saved, auth.context.user.id, event.id);
    let integrationEvent;
    if (isTombstone) {
      const historicalCrmRecord = eligibility.historicalCleanup
        ? await loadLatestBoundProjectionCrmRecord(
          db,
          workspaceId,
          current.id,
          configuration,
          profileEvidence.fingerprint,
        )
        : current.crmRecord;
      if (historicalCrmRecord === null) {
        return apiError("crm_tombstone_evidence_changed", "The historical projection delivery evidence changed; reload before retrying.", {
          status: 409,
          requestId: auth.requestId,
          headers: auth.headers,
        });
      }
      integrationEvent = prepareAgreementDeletedIntegrationEvent({
        agreement: {
          workspaceId,
          id: saved.id,
          version: saved.version,
          crm: agreementSelectionForCrmProvider(configuration.provider),
          crmRecord: historicalCrmRecord,
        },
        deletedAt: current.deletedAt ?? now,
        causationId: auth.requestId,
      });
    } else {
      integrationEvent = prepareAgreementUpdatedIntegrationEvent({
        agreement: saved,
        changedFields: ["crmProjection"],
        causationId: auth.requestId,
      });
    }
    const outbox = prepareOutboxEvent(integrationEvent);
    const guardId = crypto.randomUUID();
    const [result] = await db.batch([
      db.update(agreements).set(patch).where(and(
        eq(agreements.workspaceId, workspaceId),
        eq(agreements.id, current.id),
        eq(agreements.version, current.version),
        eq(agreements.nextAction, current.nextAction),
        ...(current.deletedAt === null
          ? [isNull(agreements.deletedAt)]
          : [eq(agreements.deletedAt, current.deletedAt)]),
      )),
      db.insert(mutationGuards).values({
        id: guardId,
        workspaceId,
        operation: isTombstone ? "integration.crm_tombstone_resync" : "integration.crm_projection_resync",
        guardChanges: sql<number>`changes()`,
        createdAt: now,
      }),
      db.insert(agreementEvents).values(event),
      db.insert(agreementVersions).values(snapshot),
      db.insert(outboxEvents).values(outbox),
      db.delete(mutationGuards).where(and(
        eq(mutationGuards.workspaceId, workspaceId),
        eq(mutationGuards.id, guardId),
      )),
    ]);
    if (!result.meta.changes) {
      return apiError("version_conflict", "The agreement changed while the CRM resync was queued. Reload before retrying.", {
        status: 409,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }

    return apiJson({
      agreement: saved,
      event: {
        id: outbox.id,
        topic: outbox.topic,
        aggregateVersion: saved.version,
        status: outbox.status,
      },
      crm: {
        provider: configuration.provider,
        mappingVersion: configuration.mappingVersion,
        action: input.action,
        historicalCleanup: isTombstone && eligibility.historicalCleanup,
        liveProfileReprojectionRequired: isTombstone && eligibility.historicalCleanup,
      },
      requestId: auth.requestId,
    }, { status: 202, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "The CRM resync could not be queued.");
  }
}
