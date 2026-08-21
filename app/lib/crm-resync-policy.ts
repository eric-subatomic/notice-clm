import type { CrmIntegrationProvider } from "./integration-events";
import { sha256Hex } from "./document-security";

export const crmResyncActions = ["projection", "tombstone", "legacy_cleanup_attestation"] as const;
export type CrmResyncAction = (typeof crmResyncActions)[number];

export const CRM_LEGACY_CLEANUP_CONFIRMATION = "I confirm every legacy CRM copy for this agreement was reconciled or deleted outside Notice.";
export const CRM_HISTORICAL_CLEANUP_CONFIRMATION = "I confirm this configured CRM profile is historical, the intended live profile is reconciled, and I will restore, retest, reproject, and verify it before resuming service.";

export type CrmProfileReceiptSummary = Readonly<{
  potentialProjectionVersion: number | null;
  acceptedTombstoneVersion: number | null;
}>;

export type CrmProfileReceiptState = CrmProfileReceiptSummary & Readonly<{
  newestUnresolvedAcceptedOtherProfileVersion: number | null;
  newestUnreconciledProfileMutationVersion: number | null;
}>;

export type CrmImmutableProfile = Readonly<{
  provider: string;
  mappingVersion: string;
  destinationFingerprint: string;
}>;

export type CrmProfileAggregateEvidence = CrmImmutableProfile & Readonly<{
  potentialProjectionVersion: number | null;
  acceptedProjectionVersion: number | null;
  acceptedTombstoneVersion: number | null;
  nonAcceptedMutationVersion: number | null;
}>;

export type CrmProfileDeliveryEvidence = Readonly<{
  operation: "projection" | "tombstone";
  version: number;
  status: "pending" | "accepted" | "dead";
}>;

export type LegacyCrmDeliveryProfile = Readonly<{
  crmProvider: string | null;
  crmMappingVersion: string | null;
  crmDestinationFingerprint: string | null;
}>;

export function isLegacyCrmDeliveryProfileIncomplete(delivery: LegacyCrmDeliveryProfile | null): boolean {
  return delivery === null
    || delivery.crmProvider === null
    || delivery.crmMappingVersion === null
    || delivery.crmDestinationFingerprint === null;
}

/**
 * An attestation resolves only the unprofiled CRM side effect it names. A
 * fully destination-bound receipt always retains normal delivery semantics.
 */
export function legacyAttestationResolvesCrmDelivery(
  attestationExists: boolean,
  delivery: LegacyCrmDeliveryProfile | null,
): boolean {
  return attestationExists && isLegacyCrmDeliveryProfileIncomplete(delivery);
}

/** Lost responses make every fully profile-bound projection attempt material. */
export function summarizeCrmProfileDeliveryEvidence(
  deliveries: readonly CrmProfileDeliveryEvidence[],
): CrmProfileReceiptSummary {
  let potentialProjectionVersion: number | null = null;
  let acceptedTombstoneVersion: number | null = null;
  for (const delivery of deliveries) {
    if (!Number.isSafeInteger(delivery.version) || delivery.version <= 0) continue;
    if (delivery.operation === "projection") {
      potentialProjectionVersion = Math.max(potentialProjectionVersion ?? 0, delivery.version);
    } else if (delivery.status === "accepted") {
      acceptedTombstoneVersion = Math.max(acceptedTombstoneVersion ?? 0, delivery.version);
    }
  }
  return Object.freeze({ potentialProjectionVersion, acceptedTombstoneVersion });
}

function evidenceVersion(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Collapse immutable profile aggregates into the conservative evidence used by
 * the repair policy. A later accepted same-profile tombstone fences earlier
 * failed work, but a later pending/dead projection or tombstone remains
 * ambiguous. Accepted projections on another profile count only while that
 * profile has not itself been fenced by an accepted tombstone.
 */
export function summarizeCrmProfileReceiptState(
  profiles: readonly CrmProfileAggregateEvidence[],
  currentProfile: CrmImmutableProfile,
  newestUnboundOrIncompleteMutationVersion: number | null,
): CrmProfileReceiptState {
  const isCurrent = (profile: CrmImmutableProfile) => (
    profile.provider === currentProfile.provider
    && profile.mappingVersion === currentProfile.mappingVersion
    && profile.destinationFingerprint === currentProfile.destinationFingerprint
  );
  const current = profiles.find(isCurrent);
  let newestUnresolvedAcceptedOtherProfileVersion: number | null = null;
  let newestUnreconciledProfileMutationVersion = evidenceVersion(newestUnboundOrIncompleteMutationVersion);

  for (const profile of profiles) {
    const acceptedTombstone = evidenceVersion(profile.acceptedTombstoneVersion);
    const nonAcceptedMutation = evidenceVersion(profile.nonAcceptedMutationVersion);
    if (
      nonAcceptedMutation !== null
      && (acceptedTombstone === null || acceptedTombstone < nonAcceptedMutation)
    ) {
      newestUnreconciledProfileMutationVersion = Math.max(
        newestUnreconciledProfileMutationVersion ?? 0,
        nonAcceptedMutation,
      );
    }
    if (isCurrent(profile)) continue;
    const acceptedProjection = evidenceVersion(profile.acceptedProjectionVersion);
    if (
      acceptedProjection !== null
      && (acceptedTombstone === null || acceptedTombstone < acceptedProjection)
    ) {
      newestUnresolvedAcceptedOtherProfileVersion = Math.max(
        newestUnresolvedAcceptedOtherProfileVersion ?? 0,
        acceptedProjection,
      );
    }
  }

  return Object.freeze({
    potentialProjectionVersion: evidenceVersion(current?.potentialProjectionVersion ?? null),
    acceptedTombstoneVersion: evidenceVersion(current?.acceptedTombstoneVersion ?? null),
    newestUnresolvedAcceptedOtherProfileVersion,
    newestUnreconciledProfileMutationVersion,
  });
}

export type CrmResyncEligibility = Readonly<{
  actions: readonly CrmResyncAction[];
  historicalCleanup: boolean;
  blockedByUnreconciledMutation: boolean;
  blockedByHistoricalReactivation: boolean;
}>;

/**
 * Decide which explicit repair operations are safe for the currently tested,
 * immutable CRM destination profile.
 *
 * An active record may be projected only to its own selected provider. A
 * tombstone may represent a real soft deletion for that provider, or clean up
 * a former current-profile projection after the agreement stopped targeting
 * that provider. Provider equality alone cannot establish that a restored
 * mapping/destination is still active: an exact profile with an older
 * projection is historical once a strictly newer, accepted, still-unfenced
 * projection exists on another immutable profile. Newer unbound or
 * nonaccepted mutation work blocks that inference until it is reconciled.
 * Reactivating a previously used and fenced historical profile while another
 * accepted profile remains live is deliberately outside this repair path.
 */
export function evaluateCrmResyncEligibility(input: Readonly<{
  agreementProvider: CrmIntegrationProvider | null;
  deletedAt: string | null;
  profileProvider: CrmIntegrationProvider;
  receipts: CrmProfileReceiptState;
}>): CrmResyncEligibility {
  const providerMatches = input.agreementProvider === input.profileProvider;
  const exactProjectionVersion = input.receipts.potentialProjectionVersion;
  const exactProjectionUnresolved = exactProjectionVersion !== null && (
    input.receipts.acceptedTombstoneVersion === null
    || input.receipts.acceptedTombstoneVersion < exactProjectionVersion
  );
  const blockedByUnreconciledMutation = input.deletedAt === null
    && providerMatches
    && input.receipts.newestUnreconciledProfileMutationVersion !== null
    && (
      exactProjectionVersion === null
      || input.receipts.newestUnreconciledProfileMutationVersion > exactProjectionVersion
    );
  const supersededByAcceptedProfile = exactProjectionVersion !== null
    && input.receipts.newestUnresolvedAcceptedOtherProfileVersion !== null
    && input.receipts.newestUnresolvedAcceptedOtherProfileVersion > exactProjectionVersion;
  const historicalProjectionUnresolved = exactProjectionUnresolved && (
    !providerMatches
    || (supersededByAcceptedProfile && !blockedByUnreconciledMutation)
  );
  const blockedByHistoricalReactivation = input.deletedAt === null
    && providerMatches
    && exactProjectionVersion !== null
    && !exactProjectionUnresolved
    && input.receipts.newestUnresolvedAcceptedOtherProfileVersion !== null;
  const projection = input.deletedAt === null
    && providerMatches
    && !historicalProjectionUnresolved
    && !blockedByUnreconciledMutation
    && !blockedByHistoricalReactivation;
  const tombstone = (input.deletedAt !== null && providerMatches) || historicalProjectionUnresolved;
  return Object.freeze({
    actions: Object.freeze([
      ...(projection ? ["projection" as const] : []),
      ...(tombstone ? ["tombstone" as const] : []),
    ]),
    historicalCleanup: historicalProjectionUnresolved,
    blockedByUnreconciledMutation,
    blockedByHistoricalReactivation,
  });
}

export type CrmResyncCursor = Readonly<{ updatedAt: string; id: number }>;

export function encodeCrmResyncCursor(cursor: CrmResyncCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeCrmResyncCursor(candidate: string | null): CrmResyncCursor | null {
  if (candidate === null) return null;
  if (candidate.length < 1 || candidate.length > 256 || !/^[A-Za-z0-9_-]+$/.test(candidate)) {
    throw new TypeError("CRM resync cursor is invalid");
  }
  try {
    const base64 = candidate.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const value: unknown = JSON.parse(decoded);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "id,updatedAt"
      || typeof record.updatedAt !== "string"
      || record.updatedAt.length < 20
      || record.updatedAt.length > 64
      || !Number.isFinite(Date.parse(record.updatedAt))
      || !Number.isSafeInteger(record.id)
      || (record.id as number) <= 0
    ) throw new TypeError();
    return Object.freeze({ updatedAt: record.updatedAt, id: record.id as number });
  } catch {
    throw new TypeError("CRM resync cursor is invalid");
  }
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalJsonValue(nested)]));
  }
  throw new TypeError("Legacy CRM event payload is not canonical JSON");
}

/** Bind an attestation to sorted-key canonical JSON of the persisted payload. */
export async function crmLegacyEventPayloadSha256(payload: Record<string, unknown>): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalJsonValue(payload)));
}
