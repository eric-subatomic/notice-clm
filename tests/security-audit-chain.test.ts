import assert from "node:assert/strict";
import test from "node:test";
import {
  computeAgreementEventHash,
  verifyAgreementEventChain,
  type AgreementEventChainRow,
} from "../app/lib/audit-chain";

async function createEvent(
  sequence: number,
  previousHash: string | null,
  overrides: Partial<AgreementEventChainRow> = {},
): Promise<AgreementEventChainRow> {
  const event: AgreementEventChainRow = {
    id: `event-${sequence}`,
    workspaceId: "orchid-firm",
    agreementId: 42,
    sequence,
    type: "Review",
    actorUserId: "user-123",
    actorEmail: "legal@orchid.test",
    actor: "Orchid Legal",
    detail: `Review event ${sequence}`,
    createdAt: `2026-08-01T12:00:0${sequence}.000Z`,
    previousHash,
    eventHash: null,
    ...overrides,
  };
  event.eventHash = await computeAgreementEventHash(event);
  return event;
}

async function threeEventChain(): Promise<AgreementEventChainRow[]> {
  const first = await createEvent(1, null);
  const second = await createEvent(2, first.eventHash);
  const third = await createEvent(3, second.eventHash);
  return [first, second, third];
}

test("a complete audit chain verifies independently of database return order", async () => {
  const chain = await threeEventChain();
  const result = await verifyAgreementEventChain([chain[2], chain[0], chain[1]]);
  assert.deepEqual(result, {
    valid: true,
    checked: 3,
    firstInvalidSequence: null,
    headHash: chain[2].eventHash,
  });
  assert.deepEqual(await verifyAgreementEventChain([]), {
    valid: true,
    checked: 0,
    firstInvalidSequence: null,
    headHash: null,
  });
});

test("audit verification detects altered evidence and reports the last trusted head", async () => {
  const chain = await threeEventChain();
  const tampered = chain.map((event) => ({ ...event }));
  tampered[1].detail = "Tampered after the event was recorded";

  assert.deepEqual(await verifyAgreementEventChain(tampered), {
    valid: false,
    checked: 1,
    firstInvalidSequence: 2,
    headHash: chain[0].eventHash,
  });
});

test("audit verification detects a removed middle record even when later hashes remain intact", async () => {
  const chain = await threeEventChain();
  assert.deepEqual(await verifyAgreementEventChain([chain[0], chain[2]]), {
    valid: false,
    checked: 1,
    firstInvalidSequence: 3,
    headHash: chain[0].eventHash,
  });
});

test("audit verification rejects duplicate, non-contiguous, and incorrectly linked sequences", async () => {
  const chain = await threeEventChain();
  const duplicate = { ...chain[1], id: "duplicate-event" };
  duplicate.eventHash = await computeAgreementEventHash(duplicate);
  const duplicateResult = await verifyAgreementEventChain([chain[0], chain[1], duplicate, chain[2]]);
  assert.equal(duplicateResult.valid, false);
  assert.equal(duplicateResult.firstInvalidSequence, 2);

  const wrongLink = { ...chain[1], previousHash: "0".repeat(64) };
  wrongLink.eventHash = await computeAgreementEventHash(wrongLink);
  assert.deepEqual(await verifyAgreementEventChain([chain[0], wrongLink]), {
    valid: false,
    checked: 1,
    firstInvalidSequence: 2,
    headHash: chain[0].eventHash,
  });

  const startsAtZero = await createEvent(0, null);
  assert.deepEqual(await verifyAgreementEventChain([startsAtZero]), {
    valid: false,
    checked: 0,
    firstInvalidSequence: 0,
    headHash: null,
  });
});

test("event hashes bind tenant, agreement, actor, time, and previous hash", async () => {
  const original = await createEvent(1, null);
  const fields: Array<keyof AgreementEventChainRow> = [
    "workspaceId",
    "agreementId",
    "actorUserId",
    "actorEmail",
    "actor",
    "detail",
    "createdAt",
    "previousHash",
    "sourceAgentPlanId",
  ];

  for (const field of fields) {
    const changed = { ...original, [field]: field === "agreementId" ? 43 : `changed-${field}` };
    assert.notEqual(await computeAgreementEventHash(changed), original.eventHash, `${field} must be hash-bound`);
  }
});

test("unmodified human and agent-attributed chains verify", async () => {
  const planId = "123e4567-e89b-42d3-a456-426614174000";
  const human = await createEvent(1, null, { sourceAgentPlanId: null });
  const agent = await createEvent(2, human.eventHash, { sourceAgentPlanId: planId });

  assert.equal((await verifyAgreementEventChain([human, agent])).valid, true);
});

test("adding agent attribution to a legacy-form human event invalidates the unchanged-head chain", async () => {
  const planId = "123e4567-e89b-42d3-a456-426614174000";
  const chain = await threeEventChain();
  const altered = chain.map((event) => ({ ...event }));
  altered[1].sourceAgentPlanId = planId;

  assert.equal(altered[2].eventHash, chain[2].eventHash);
  assert.deepEqual(await verifyAgreementEventChain(altered), {
    valid: false,
    checked: 1,
    firstInvalidSequence: 2,
    headHash: chain[0].eventHash,
  });
});

test("replacing or clearing current agent attribution invalidates the event", async () => {
  const firstPlanId = "123e4567-e89b-42d3-a456-426614174000";
  const secondPlanId = "223e4567-e89b-42d3-a456-426614174000";
  const attributed = await createEvent(1, null, { sourceAgentPlanId: firstPlanId });

  assert.notEqual(
    await computeAgreementEventHash({ ...attributed, sourceAgentPlanId: secondPlanId }),
    attributed.eventHash,
  );
  assert.equal((await verifyAgreementEventChain([
    { ...attributed, sourceAgentPlanId: secondPlanId },
  ])).valid, false);
  assert.equal((await verifyAgreementEventChain([
    { ...attributed, sourceAgentPlanId: null },
  ])).valid, false);
  assert.equal((await verifyAgreementEventChain([attributed])).valid, true);
});
