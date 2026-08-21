import { sha256Hex } from "./document-security";

export type AgreementEventCanonicalData = {
  id: string;
  workspaceId: string;
  agreementId: number;
  sequence: number;
  type: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actor: string;
  detail: string;
  createdAt: string;
  previousHash: string | null;
  /** Added for governed agent mutations; null/omitted retains the legacy hash format. */
  sourceAgentPlanId?: string | null;
};

export type AgreementEventChainRow = AgreementEventCanonicalData & {
  eventHash: string | null;
};

function legacyAgreementEventFields(event: AgreementEventCanonicalData) {
  return {
    id: event.id,
    workspaceId: event.workspaceId,
    agreementId: event.agreementId,
    sequence: event.sequence,
    type: event.type,
    actorUserId: event.actorUserId,
    actorEmail: event.actorEmail,
    actor: event.actor,
    detail: event.detail,
    createdAt: event.createdAt,
    previousHash: event.previousHash,
  };
}

export function canonicalAgreementEvent(event: AgreementEventCanonicalData): string {
  const legacyFields = legacyAgreementEventFields(event);
  // Preserve byte-for-byte verification for pre-attribution human events. New
  // agent events opt into an extended canonical form by carrying a plan ID.
  return event.sourceAgentPlanId === null || event.sourceAgentPlanId === undefined
    ? JSON.stringify(legacyFields)
    : JSON.stringify({ ...legacyFields, sourceAgentPlanId: event.sourceAgentPlanId });
}

export async function computeAgreementEventHash(event: AgreementEventCanonicalData): Promise<string> {
  return sha256Hex(canonicalAgreementEvent(event));
}

export async function verifyAgreementEventChain(
  rows: readonly AgreementEventChainRow[],
): Promise<{ valid: boolean; checked: number; firstInvalidSequence: number | null; headHash: string | null }> {
  const ordered = [...rows].sort((left, right) => left.sequence - right.sequence);
  let previousHash: string | null = null;
  let checked = 0;

  for (const event of ordered) {
    const expectedSequence = checked + 1;
    if (event.sequence !== expectedSequence || event.previousHash !== previousHash || !event.eventHash) {
      return { valid: false, checked, firstInvalidSequence: event.sequence, headHash: previousHash };
    }
    const expected = await computeAgreementEventHash(event);
    if (expected !== event.eventHash) {
      return { valid: false, checked, firstInvalidSequence: event.sequence, headHash: previousHash };
    }
    previousHash = event.eventHash;
    checked += 1;
  }

  return { valid: true, checked, firstInvalidSequence: null, headHash: previousHash };
}
