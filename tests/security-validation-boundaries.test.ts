import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  agreementDetailsPatchSchema,
  agreementPatchSchema,
  agreementTransitionSchema,
  documentLinkSchema,
  documentVersionSchema,
  operationMutationSchema,
  parseJson,
  readBoundedBody,
  RequestValidationError,
} from "../app/lib/validation";

test("JSON parsing fails before reading a declared oversize body and reports malformed input safely", async () => {
  const oversized = new Request("https://notice.test/api/agreements", {
    method: "POST",
    headers: { "content-length": "101" },
    body: "{}",
  });
  await assert.rejects(
    parseJson(oversized, agreementTransitionSchema, 100),
    (error) => error instanceof RequestValidationError && error.issues[0]?.message === "Maximum JSON body size is 100 bytes",
  );

  const malformed = new Request("https://notice.test/api/agreements", {
    method: "POST",
    body: "{not-json",
  });
  await assert.rejects(
    parseJson(malformed, agreementTransitionSchema),
    (error) => error instanceof RequestValidationError && error.message === "Request body must be valid JSON",
  );
});

test("bounded streaming stops chunked bodies before unbounded buffering", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(60));
      controller.enqueue(new Uint8Array(60));
      controller.close();
    },
  });
  const request = new Request("https://notice.test/api/webhook", {
    method: "POST",
    body: stream,
    // Node requires this marker for a streamed request; Workers ignores it.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(
    readBoundedBody(request, 100),
    (error) => error instanceof RequestValidationError
      && error.status === 413
      && error.code === "payload_too_large",
  );
});

test("JSON parsing also enforces the actual UTF-8 body size when Content-Length is absent", async () => {
  const body = JSON.stringify({ id: 1, version: 1, toStage: "Draft", padding: "€".repeat(50) });
  const request = new Request("https://notice.test/api/agreements", { method: "POST", body });
  await assert.rejects(
    parseJson(request, agreementTransitionSchema, 100),
    (error) => error instanceof RequestValidationError && error.message === "Request body is too large",
  );
});

test("agreement detail edits strip server-owned lifecycle, tenant, and actor fields", () => {
  const parsed = agreementDetailsPatchSchema.parse({
    id: 42,
    version: 7,
    party: " Orchid Systems ",
    stage: "Active",
    approvalStatus: "Approved",
    signatureStatus: "Completed",
    workspaceId: "caller-workspace",
    updatedByUserId: "caller-user",
  });

  assert.deepEqual(parsed, { id: 42, version: 7, party: "Orchid Systems" });
  assert.equal(agreementDetailsPatchSchema.safeParse({ id: 42, version: 7, stage: "Active" }).success, false);
  assert.equal(agreementDetailsPatchSchema.safeParse({
    id: 42,
    version: 7,
    party: "Orchid Systems",
    nextAction: "Overwrite a derived negotiation queue",
  }).success, false);
  assert.equal(agreementDetailsPatchSchema.safeParse({ id: 42, version: 7, nextAction: "Caller-owned queue" }).success, false);
  assert.equal(agreementPatchSchema.safeParse({ id: 42, version: 7, owner: "Legal", nextAction: "Caller-owned queue" }).success, false);
  assert.equal(agreementDetailsPatchSchema.safeParse({ id: 42, version: 0, party: "Orchid" }).success, false);
});

test("agreement detail commits fence the server-derived queue projection", async () => {
  const route = await readFile(new URL("../app/api/agreements/route.ts", import.meta.url), "utf8");
  const patch = route.slice(route.indexOf("export async function PATCH"), route.indexOf("export async function DELETE"));
  assert.match(patch, /eq\(agreements\.version, version\)[\s\S]*eq\(agreements\.nextAction, current\.nextAction\)/);
  assert.match(patch, /isMutationGuardConflict\(error\)[\s\S]*"version_conflict"/);
});

test("workflow transitions require supported stages and positive optimistic versions", () => {
  assert.deepEqual(agreementTransitionSchema.parse({ id: "12", version: 3, toStage: "Signature" }), {
    id: 12,
    version: 3,
    toStage: "Signature",
  });
  assert.equal(agreementTransitionSchema.safeParse({ id: 12, version: 0, toStage: "Signature" }).success, false);
  assert.equal(agreementTransitionSchema.safeParse({ id: 12, version: 3, toStage: "Archived" }).success, false);
});

test("approval and obligation operations reject caller attribution and require durable evidence", () => {
  const decision = operationMutationSchema.parse({
    entity: "approval",
    action: "decide",
    record: {
      id: "0f4b7972-679a-4a9e-a240-8c61ea137e9c",
      status: "Approved",
      comment: "Approved within mandate",
      version: 2,
      basisHash: "b".repeat(64),
      documentVersion: 4,
      documentSha256: "d".repeat(64),
      confirmed: true,
      approverUserId: "caller-selected-user",
      actor: "Caller-selected actor",
    },
  });
  assert.deepEqual(decision, {
    entity: "approval",
    action: "decide",
    record: {
      id: "0f4b7972-679a-4a9e-a240-8c61ea137e9c",
      status: "Approved",
      comment: "Approved within mandate",
      version: 2,
      basisHash: "b".repeat(64),
      documentVersion: 4,
      documentSha256: "d".repeat(64),
      confirmed: true,
    },
  });

  assert.equal(operationMutationSchema.safeParse({
    entity: "obligation",
    action: "complete",
    record: { id: "0f4b7972-679a-4a9e-a240-8c61ea137e9c", evidence: "   ", version: 1 },
  }).success, false);
  assert.equal(operationMutationSchema.safeParse({
    entity: "approval",
    action: "decide",
    record: { id: "not-a-uuid", status: "Approved", version: 1 },
  }).success, false);
});

test("document links and draft versions enforce identifiers, concurrency, types, and content bounds", () => {
  assert.deepEqual(documentLinkSchema.parse({
    documentId: "0f4b7972-679a-4a9e-a240-8c61ea137e9c",
    agreementId: "9",
    workspaceId: "caller-workspace",
  }), {
    documentId: "0f4b7972-679a-4a9e-a240-8c61ea137e9c",
    agreementId: 9,
  });

  assert.deepEqual(documentVersionSchema.parse({
    content: "Draft agreement",
    contentType: "text/markdown",
    label: " Legal draft ",
    expectedAgreementVersion: 4,
    createdByUserId: "caller-user",
  }), {
    content: "Draft agreement",
    contentType: "text/markdown",
    label: "Legal draft",
    expectedAgreementVersion: 4,
  });
  assert.equal(documentVersionSchema.safeParse({
    content: "Draft",
    contentType: "text/html",
    label: "Draft",
    expectedAgreementVersion: 1,
  }).success, false);
  assert.equal(documentVersionSchema.safeParse({
    content: "",
    contentType: "text/plain",
    label: "Draft",
    expectedAgreementVersion: 1,
  }).success, false);
  assert.equal(documentVersionSchema.safeParse({
    content: "Draft",
    contentType: "text/plain",
    label: "Draft",
    expectedAgreementVersion: -1,
  }).success, false);
});
