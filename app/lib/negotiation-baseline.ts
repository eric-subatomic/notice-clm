export type NegotiationBaseline =
  | Readonly<{ kind: "working_version"; version: number; documentId: null }>
  | Readonly<{ kind: "source_document"; version: null; documentId: string }>;

export const NEGOTIATION_BASE_SOURCE_ROLES = ["initial_source"] as const;

export function isEligibleNegotiationBaseRole(role: string): boolean {
  return (NEGOTIATION_BASE_SOURCE_ROLES as readonly string[]).includes(role);
}

/**
 * The database deliberately stores one and only one baseline locator. Keeping
 * this conversion exhaustive prevents a working-version id from accidentally
 * being persisted beside its version number (and vice versa).
 */
export function negotiationBaselineReference(baseline: NegotiationBaseline): Readonly<{
  baseDocumentVersion: number | null;
  baseDocumentId: string | null;
}> {
  if (baseline.kind === "working_version") {
    if (!Number.isSafeInteger(baseline.version) || baseline.version <= 0) {
      throw new RangeError("Working-version baselines require a positive version number.");
    }
    return { baseDocumentVersion: baseline.version, baseDocumentId: null };
  }
  if (!baseline.documentId.trim()) throw new RangeError("Source-document baselines require a document id.");
  return { baseDocumentVersion: null, baseDocumentId: baseline.documentId };
}
