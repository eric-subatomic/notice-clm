import assert from "node:assert/strict";
import test from "node:test";
import { canRescanDocument, isDocumentReadable } from "../app/lib/document-access";

test("evaluation scan bypass never becomes production trust", () => {
  assert.equal(isDocumentReadable("evaluation-bypassed", "evaluation"), true);
  assert.equal(isDocumentReadable("evaluation-bypassed", "production"), false);
  assert.equal(isDocumentReadable("clean", "production"), true);
  assert.equal(canRescanDocument("evaluation-bypassed", "production"), true);
  assert.equal(canRescanDocument("evaluation-bypassed", "evaluation"), false);
});
