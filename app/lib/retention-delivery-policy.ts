import type { OutboxDeliverySink, OutboxDeliveryStatus } from "../../db/schema";

export type DeletionTombstoneEvent = Readonly<{
  status: string;
  payload: Record<string, unknown>;
}>;

export type DeletionTombstoneDelivery = Readonly<{
  sink: OutboxDeliverySink;
  status: OutboxDeliveryStatus;
}>;

export type CrmDeliveryLedgerEntry = Readonly<{
  eventId: string;
  topic: string;
  payload: Record<string, unknown>;
  status: OutboxDeliveryStatus;
  crmProvider: "hubspot" | "salesforce" | "custom" | null;
  crmMappingVersion: string | null;
  crmDestinationFingerprint: string | null;
}>;

export type DeletionDeliveryGate = Readonly<{
  ready: boolean;
  code:
    | "ready"
    | "current_tombstone_missing"
    | "delivery_sink_missing"
    | "crm_cleanup_required"
    | "sink_delivery_incomplete"
    | "event_finalization_incomplete";
  reason: string;
}>;

/** Return each immutable CRM profile that received a projection without a
 * same-profile tombstone at an equal or later aggregate version. Legacy rows
 * without a complete profile remain deliberately unresolved. */
export function unresolvedCrmDeliveryProfiles(entries: readonly CrmDeliveryLedgerEntry[]): string[] {
  const projections = entries.filter((entry) => entry.topic !== "agreement.deleted");
  const tombstones = entries.filter((entry) => entry.topic === "agreement.deleted" && entry.status === "accepted");
  const unresolved = new Set<string>();

  for (const projection of projections) {
    const projectionVersion = ledgerAggregateVersion(projection);
    const profile = profileKey(projection);
    if (!profile || projectionVersion === null) {
      unresolved.add(`legacy:${projection.eventId}`);
      continue;
    }
    const resolved = tombstones.some((tombstone) => {
      const tombstoneVersion = ledgerAggregateVersion(tombstone);
      return profileKey(tombstone) === profile
        && tombstoneVersion !== null
        && tombstoneVersion >= projectionVersion;
    });
    if (!resolved) unresolved.add(profile);
  }
  return [...unresolved].sort();
}

function ledgerAggregateVersion(entry: CrmDeliveryLedgerEntry): number | null {
  const projection = entry.payload.crmAgreement;
  const value = entry.topic === "agreement.deleted"
    ? entry.payload.aggregateVersion ?? entry.payload.version
    : typeof projection === "object" && projection !== null && !Array.isArray(projection)
      ? (projection as Record<string, unknown>).version
      : null;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function profileKey(entry: CrmDeliveryLedgerEntry): string | null {
  if (
    !entry.crmProvider
    || !entry.crmMappingVersion
    || !entry.crmDestinationFingerprint
    || !/^[a-f0-9]{64}$/i.test(entry.crmDestinationFingerprint)
  ) return null;
  return `${entry.crmProvider}:${entry.crmMappingVersion}:${entry.crmDestinationFingerprint}`;
}

/**
 * A hard purge may erase its deletion event only after every sink persisted for
 * the exact current deletion epoch has a durable gateway receipt. CRM
 * projections are tracked independently by immutable destination profile; each
 * profile must have a later accepted tombstone before local evidence is erased.
 */
export function evaluateDeletionDeliveryGate(input: Readonly<{
  agreementId: number;
  version: number;
  deletedAt: string;
  unresolvedCrmProfiles: readonly string[];
  event: DeletionTombstoneEvent | null;
  deliveries: readonly DeletionTombstoneDelivery[];
}>): DeletionDeliveryGate {
  const payload = input.event?.payload;
  if (
    input.event === null
    || payload?.tombstone !== true
    || payload.agreementId !== input.agreementId
    || payload.version !== input.version
    || payload.aggregateVersion !== input.version
    || payload.deletedAt !== input.deletedAt
  ) {
    return {
      ready: false,
      code: "current_tombstone_missing",
      reason: "the current deletion epoch has no exact canonical tombstone; run the administrator CRM resync procedure",
    };
  }

  const bySink = new Map(input.deliveries.map((delivery) => [delivery.sink, delivery]));
  if (!bySink.has("delivery")) {
    return {
      ready: false,
      code: "delivery_sink_missing",
      reason: "the current deletion tombstone has no durable delivery-gateway receipt state; run the administrator resync procedure",
    };
  }
  if (input.unresolvedCrmProfiles.length > 0) {
    return {
      ready: false,
      code: "crm_cleanup_required",
      reason: `${input.unresolvedCrmProfiles.length} historical CRM projection or destination-profile evidence item${input.unresolvedCrmProfiles.length === 1 ? " is" : "s are"} unresolved; restore each known exact profile and queue an administrator tombstone resync, while legacy unprofiled evidence requires separate downstream reconciliation`,
    };
  }
  if (input.deliveries.some((delivery) => delivery.status !== "accepted")) {
    return {
      ready: false,
      code: "sink_delivery_incomplete",
      reason: "the current deletion tombstone still has a pending or dead required sink",
    };
  }
  if (input.event.status !== "processed") {
    return {
      ready: false,
      code: "event_finalization_incomplete",
      reason: "the current deletion tombstone receipts have not been finalized by the outbox runner",
    };
  }
  return { ready: true, code: "ready", reason: "all persisted deletion-tombstone sinks have durable gateway receipts" };
}
