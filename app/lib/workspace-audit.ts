import { sha256Hex } from "./document-security";

export type WorkspaceEventCanonicalData = {
  id: string;
  workspaceId: string;
  sequence: number;
  type: string;
  actorUserId: string;
  actorEmail: string;
  actor: string;
  subjectUserId: string | null;
  subjectEmail: string | null;
  detail: string;
  previousHash: string | null;
  createdAt: string;
};

export type WorkspaceEventChainRow = WorkspaceEventCanonicalData & { eventHash: string | null };

export function canonicalWorkspaceEvent(event: WorkspaceEventCanonicalData): string {
  return JSON.stringify({
    id: event.id,
    workspaceId: event.workspaceId,
    sequence: event.sequence,
    type: event.type,
    actorUserId: event.actorUserId,
    actorEmail: event.actorEmail,
    actor: event.actor,
    subjectUserId: event.subjectUserId,
    subjectEmail: event.subjectEmail,
    detail: event.detail,
    previousHash: event.previousHash,
    createdAt: event.createdAt,
  });
}

export function computeWorkspaceEventHash(event: WorkspaceEventCanonicalData): Promise<string> {
  return sha256Hex(canonicalWorkspaceEvent(event));
}

export async function verifyWorkspaceEventChain(rows: readonly WorkspaceEventChainRow[]) {
  const ordered = [...rows].sort((left, right) => left.sequence - right.sequence);
  let previousHash: string | null = null;
  let checked = 0;
  for (const event of ordered) {
    if (event.sequence !== checked + 1 || event.previousHash !== previousHash || !event.eventHash) {
      return { valid: false, checked, firstInvalidSequence: event.sequence, headHash: previousHash };
    }
    if (await computeWorkspaceEventHash(event) !== event.eventHash) {
      return { valid: false, checked, firstInvalidSequence: event.sequence, headHash: previousHash };
    }
    previousHash = event.eventHash;
    checked += 1;
  }
  return { valid: true, checked, firstInvalidSequence: null, headHash: previousHash };
}
