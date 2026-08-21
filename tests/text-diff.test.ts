import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COMPARISON_LINES,
  MAX_COMPARISON_TEXT_CHARACTERS,
  TextComparisonBoundaryError,
  compareTextLines,
} from "../app/lib/text-diff";

test("line comparison is deterministic and preserves line attribution", () => {
  const result = compareTextLines("one\ntwo\nthree", "one\nsecond\nthree\nfour");
  assert.equal(result.mode, "exact");
  assert.deepEqual({ unchanged: result.unchanged, removed: result.removed, added: result.added }, { unchanged: 2, removed: 1, added: 2 });
  assert.deepEqual(result.lines, [
    { kind: "unchanged", text: "one", baseLine: 1, proposedLine: 1 },
    { kind: "removed", text: "two", baseLine: 2, proposedLine: null },
    { kind: "added", text: "second", baseLine: null, proposedLine: 2 },
    { kind: "unchanged", text: "three", baseLine: 3, proposedLine: 3 },
    { kind: "added", text: "four", baseLine: null, proposedLine: 4 },
  ]);
});

test("large matrices are explicit coarse comparisons, never no-change results", () => {
  const base = Array.from({ length: 1_300 }, (_, index) => `base-${index}`).join("\n");
  const proposed = Array.from({ length: 1_300 }, (_, index) => `proposed-${index}`).join("\n");
  const result = compareTextLines(base, proposed);
  assert.equal(result.mode, "coarse");
  assert.equal(result.unchanged, 0);
  assert.equal(result.removed, 1_300);
  assert.equal(result.added, 1_300);
});

test("comparison enforces bounded text and line counts", () => {
  assert.throws(
    () => compareTextLines("x".repeat(MAX_COMPARISON_TEXT_CHARACTERS + 1), "x"),
    (error) => error instanceof TextComparisonBoundaryError,
  );
  assert.throws(
    () => compareTextLines(Array(MAX_COMPARISON_LINES + 1).fill("x").join("\n"), "x"),
    (error) => error instanceof TextComparisonBoundaryError,
  );
});
