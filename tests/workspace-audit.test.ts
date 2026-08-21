import assert from "node:assert/strict";
import test from "node:test";
import { computeWorkspaceEventHash, verifyWorkspaceEventChain, type WorkspaceEventChainRow } from "../app/lib/workspace-audit";

async function event(sequence: number, previousHash: string | null): Promise<WorkspaceEventChainRow> {
  const data = {
    id: `event-${sequence}`,
    workspaceId: "workspace-one",
    sequence,
    type: "Membership",
    actorUserId: "admin-one",
    actorEmail: "admin@firm.test",
    actor: "Admin User",
    subjectUserId: "member-one",
    subjectEmail: "member@firm.test",
    detail: `Membership change ${sequence}`,
    previousHash,
    createdAt: `2026-08-01T00:00:0${sequence}.000Z`,
  };
  return { ...data, eventHash: await computeWorkspaceEventHash(data) };
}

test("workspace access events form a verifiable server-attributed chain", async () => {
  const first = await event(1, null);
  const second = await event(2, first.eventHash);
  assert.deepEqual(await verifyWorkspaceEventChain([second, first]), {
    valid: true,
    checked: 2,
    firstInvalidSequence: null,
    headHash: second.eventHash,
  });
});

test("workspace audit verification rejects changed membership evidence", async () => {
  const first = await event(1, null);
  const second = await event(2, first.eventHash);
  assert.equal((await verifyWorkspaceEventChain([first, { ...second, detail: "tampered" }])).valid, false);
});
