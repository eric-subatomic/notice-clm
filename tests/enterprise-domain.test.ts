import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBoundedJson,
  assertDistinctPublisher,
  assertExpectedVersion,
  assertLifecycleTransition,
  counterpartyDedupeKey,
  enterpriseContentDigest,
  EnterpriseError,
  normalizeCounterpartyDomain,
  validateDefinitionOptions,
  validateIntakeAnswers,
  validateTypedFieldValue,
} from "../app/lib/enterprise-domain";
import {
  approvalAuthorityCreateSchema,
  intakeFormSchema,
  intakeFormPatchSchema,
  templatePatchSchema,
  workflowPatchSchema,
} from "../app/lib/enterprise-validation";

function expectEnterpriseError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof EnterpriseError && error.code === code);
}

test("counterparty dedupe keys are server-normalized and choose strong identifiers", () => {
  assert.equal(normalizeCounterpartyDomain(" HTTPS://WWW.Example.COM:443/contracts "), "example.com");
  assert.equal(
    counterpartyDedupeKey({ legalName: "Acme, Inc.", domain: "https://www.ACME.example/path" }),
    counterpartyDedupeKey({ legalName: "Different display", domain: "acme.example." }),
  );
  assert.equal(
    counterpartyDedupeKey({ legalName: "Acme", jurisdiction: "Delaware", registrationNumber: " 12-34 " }),
    counterpartyDedupeKey({ legalName: "ACME HOLDINGS", jurisdiction: "DELAWARE", registrationNumber: "1234" }),
  );
  assert.equal(
    counterpartyDedupeKey({ legalName: "Acme", externalId: " CRM-001 " }),
    counterpartyDedupeKey({ legalName: "Other", externalId: "crm 001" }),
  );
});

test("bounded JSON rejects excess depth, unsafe keys, and oversized content", () => {
  assert.doesNotThrow(() => assertBoundedJson({ fields: [{ key: "name" }] }, { maxBytes: 1_000 }));
  expectEnterpriseError(() => assertBoundedJson({ a: { b: { c: true } } }, { maxBytes: 1_000, maxDepth: 1 }), "json_too_deep");
  expectEnterpriseError(() => assertBoundedJson(JSON.parse('{"__proto__":{"polluted":true}}'), { maxBytes: 1_000 }), "unsafe_json_key");
  expectEnterpriseError(() => assertBoundedJson({ body: "x".repeat(200) }, { maxBytes: 50 }), "json_too_large");
});

test("canonical enterprise content digests are stable across object key order and change with content", async () => {
  const first = await enterpriseContentDigest({ b: [2, 1], a: { z: true, y: "value" } });
  const reordered = await enterpriseContentDigest({ a: { y: "value", z: true }, b: [2, 1] });
  const changed = await enterpriseContentDigest({ a: { y: "changed", z: true }, b: [2, 1] });
  assert.equal(first, reordered);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, changed);
});

test("optimistic versions, strict lifecycle, and independent publication fail closed", () => {
  assert.doesNotThrow(() => assertExpectedVersion(3, 3));
  expectEnterpriseError(() => assertExpectedVersion(3, 2), "version_conflict");
  assert.doesNotThrow(() => assertLifecycleTransition("draft", "published"));
  assert.doesNotThrow(() => assertLifecycleTransition("published", "retired"));
  expectEnterpriseError(() => assertLifecycleTransition("draft", "retired"), "invalid_lifecycle_transition");
  expectEnterpriseError(() => assertLifecycleTransition("retired", "published"), "invalid_lifecycle_transition");
  expectEnterpriseError(() => assertDistinctPublisher("creator", "creator"), "independent_review_required");
  assert.doesNotThrow(() => assertDistinctPublisher("creator", "reviewer"));
});

test("custom field values enforce declared types and option membership", () => {
  assert.doesNotThrow(() => validateDefinitionOptions("single_select", ["Low", "High"]));
  expectEnterpriseError(() => validateDefinitionOptions("text", ["not-allowed"]), "invalid_field_options");
  assert.doesNotThrow(() => validateTypedFieldValue({ dataType: "number", options: [], required: true }, 42));
  assert.doesNotThrow(() => validateTypedFieldValue({ dataType: "number", options: [], required: true }, 42.5));
  expectEnterpriseError(() => validateTypedFieldValue({ dataType: "number", options: [], required: true }, Number.POSITIVE_INFINITY), "custom_field_type_mismatch");
  assert.doesNotThrow(() => validateTypedFieldValue({ dataType: "date", options: [], required: true }, "2028-02-29"));
  expectEnterpriseError(() => validateTypedFieldValue({ dataType: "date", options: [], required: true }, "2027-02-29"), "custom_field_type_mismatch");
  assert.doesNotThrow(() => validateTypedFieldValue({ dataType: "multi_select", options: ["A", "B"], required: true }, ["A", "B"]));
  expectEnterpriseError(() => validateTypedFieldValue({ dataType: "multi_select", options: ["A", "B"], required: true }, ["A", "A"]), "custom_field_type_mismatch");
});

test("intake drafts accept partial typed answers but submission requires every required field", () => {
  const parsed = intakeFormSchema.parse({
    fields: [
      { key: "request_name", label: "Request name", type: "text", required: true, options: [] },
      { key: "urgent", label: "Urgent", type: "boolean", required: false, options: [] },
    ],
  });
  assert.doesNotThrow(() => validateIntakeAnswers(parsed, { urgent: true }, { requireComplete: false }));
  expectEnterpriseError(() => validateIntakeAnswers(parsed, { urgent: true }, { requireComplete: true }), "invalid_intake_answer");
  expectEnterpriseError(() => validateIntakeAnswers(parsed, { request_name: "NDA", extra: "no" }, { requireComplete: true }), "unknown_intake_answer");
  assert.doesNotThrow(() => validateIntakeAnswers(parsed, { request_name: "NDA", urgent: false }, { requireComplete: true }));
});

test("publish, retire, and authority payloads require an explicit confirmation and reason", () => {
  const common = { id: "11111111-1111-4111-8111-111111111111", version: 1, reason: "Reviewed and approved" };
  assert.equal(workflowPatchSchema.safeParse({ action: "publish", ...common }).success, false);
  assert.equal(workflowPatchSchema.safeParse({ action: "publish", ...common, confirmed: true }).success, true);
  assert.equal(intakeFormPatchSchema.safeParse({ action: "retire", ...common, confirmed: true }).success, true);
  assert.equal(templatePatchSchema.safeParse({
    action: "retire_template", templateId: common.id, templateVersion: 1, reason: common.reason, confirmed: true,
  }).success, true);
  assert.equal(approvalAuthorityCreateSchema.safeParse({
    lane: "Finance", subjectType: "user", subjectId: common.id, currencyCode: "USD",
    amountLimitMinor: 100_00, reason: common.reason,
  }).success, false);
});
