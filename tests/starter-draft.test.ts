import assert from "node:assert/strict";
import test from "node:test";
import { assembleStarterDraft, starterDraftSummary } from "../app/lib/starter-draft";

test("starter drafts deterministically assemble confirmed business data and lane roles", () => {
  const input = {
    organization: "Northstar Industries",
    party: "Orchid Systems",
    side: "Buy-side" as const,
    type: "Vendor Services Agreement",
    effectiveDate: "2026-10-01",
    governingLaw: "Delaware",
  };
  const draft = assembleStarterDraft(input);

  assert.match(draft, /^VENDOR SERVICES AGREEMENT/);
  assert.match(draft, /Northstar Industries \("Customer"\) and Orchid Systems \("Provider"\)/);
  assert.match(draft, /as of 2026-10-01/);
  assert.match(draft, /laws of Delaware/);
  assert.match(draft, /7\. Governing law/);
  assert.match(draft, /REPOSITORY STARTER — HUMAN REVIEW REQUIRED/);
  assert.match(draft, /has not applied workspace-approved language or company policy/);
  assert.equal(draft, assembleStarterDraft(input));
});

test("starter drafts retain explicit placeholders instead of inventing missing legal data", () => {
  const draft = assembleStarterDraft({
    organization: "Notice Demo",
    party: "Example Counterparty",
    side: "Corporate",
    type: "Mutual NDA",
  });

  assert.match(draft, /\[Effective date to be confirmed\]/);
  assert.match(draft, /\[Governing law to be confirmed\]/);
  assert.match(draft, /Notice Demo \("Company"\) and Example Counterparty \("Counterparty"\)/);
});

test("starter drafts use type-appropriate example sections", () => {
  const nda = assembleStarterDraft({
    organization: "Northstar Industries",
    party: "Orchid Systems",
    side: "Sell-side",
    type: "Mutual NDA",
    governingLaw: "New York",
  });
  assert.match(nda, /1\. Purpose/);
  assert.match(nda, /3\. Use and protection/);
  assert.doesNotMatch(nda, /Fees and payment/);
  assert.doesNotMatch(nda, /Data Processing Addendum/);

  const employment = assembleStarterDraft({
    organization: "Northstar Industries",
    party: "Jordan Lee",
    side: "Corporate",
    type: "Employment Agreement",
    governingLaw: "California",
  });
  assert.match(employment, /Northstar Industries \("Company"\) and Jordan Lee \("Employee"\)/);
  assert.match(employment, /1\. Role and start date/);
  assert.doesNotMatch(employment, /order form/);
});

test("board consent is presented as a corporate action rather than a two-party services agreement", () => {
  const consent = assembleStarterDraft({
    organization: "Northstar Industries",
    party: "Acquisition of Orchid Systems",
    side: "Corporate",
    type: "Board Consent",
  });
  assert.match(consent, /undersigned directors of Northstar Industries/);
  assert.match(consent, /1\. Background/);
  assert.doesNotMatch(consent, /entered into.*by and between/);
  assert.doesNotMatch(consent, /Fees and payment/);
  assert.match(starterDraftSummary("Board Consent"), /corporate-record example sections/);
});
