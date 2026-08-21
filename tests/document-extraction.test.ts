import assert from "node:assert/strict";
import test from "node:test";
import { extractDocumentMetadata } from "../app/lib/document-extraction";

test("document extraction returns review suggestions without a fabricated accuracy percentage", () => {
  const analysis = extractDocumentMetadata(
    "Customer will pay Net 30. This agreement renews automatically. Liability is three times the fees. Delaware governing law.",
    "Orchid Systems — Customer MSA.txt",
  );

  assert.equal(analysis.extracted.counterparty, "Orchid Systems");
  assert.equal(analysis.extracted.paymentTerms, "Net 30");
  assert.equal(analysis.extracted.governingLaw, "Delaware");
  assert.ok(analysis.tags.includes("Liability multiplier detected"));
  assert.ok(analysis.riskFlags.some((flag) => flag.includes("approved position")));
  assert.equal("extractionCoverage" in analysis, false);
});

test("heuristic review flags do not claim a playbook pass or policy violation", () => {
  const analysis = extractDocumentMetadata(
    "This agreement is exclusive and assignment requires counterparty consent.",
    "Partner agreement.txt",
  );

  assert.ok(analysis.riskFlags.length >= 2);
  for (const flag of analysis.riskFlags) {
    assert.doesNotMatch(flag, /aligns with|exceeds the standard|policy (?:pass|fail)/i);
  }
});

test("missing readable text produces blank manual-review fields instead of filename guesses", () => {
  const analysis = extractDocumentMetadata("   \n", "Vendor Master Services Agreement.pdf");

  assert.deepEqual(analysis.tags, []);
  assert.deepEqual(analysis.riskFlags, []);
  assert.deepEqual(analysis.extracted, {
    side: "",
    type: "",
    governingLaw: "",
    paymentTerms: "",
    renewalNotice: "",
    counterparty: "",
    agreementValue: "",
    effectiveDate: "",
    expirationDate: "",
    liabilityCap: "",
  });
});
