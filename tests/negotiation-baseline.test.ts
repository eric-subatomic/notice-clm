import assert from "node:assert/strict";
import test from "node:test";
import {
  isEligibleNegotiationBaseRole,
  negotiationBaselineReference,
} from "../app/lib/negotiation-baseline";

test("working-version baseline stores only its version locator", () => {
  assert.deepEqual(
    negotiationBaselineReference({ kind: "working_version", version: 7, documentId: null }),
    { baseDocumentVersion: 7, baseDocumentId: null },
  );
});

test("source-document baseline stores only its document locator", () => {
  assert.deepEqual(
    negotiationBaselineReference({ kind: "source_document", version: null, documentId: "doc-source-1" }),
    { baseDocumentVersion: null, baseDocumentId: "doc-source-1" },
  );
});

test("baseline locators fail closed when their selected locator is invalid", () => {
  assert.throws(
    () => negotiationBaselineReference({ kind: "working_version", version: 0, documentId: null }),
    /positive version number/,
  );
  assert.throws(
    () => negotiationBaselineReference({ kind: "source_document", version: null, documentId: "  " }),
    /document id/,
  );
});

test("only an intentional initial source can be used as the fallback round baseline", () => {
  assert.equal(isEligibleNegotiationBaseRole("initial_source"), true);
  for (const unsafe of ["counterparty_return", "outbound_round", "signed_artifact", "supporting"]) {
    assert.equal(isEligibleNegotiationBaseRole(unsafe), false, `${unsafe} must not become an implicit baseline`);
  }
});
