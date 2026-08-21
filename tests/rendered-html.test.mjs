import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("builds the general-purpose Notice CLM and release metadata", async () => {
  const [layout, page, css, worker, nextConfig] = await Promise.all([
    source("../app/layout.tsx"),
    source("../app/page.tsx"),
    source("../app/globals.css"),
    source("../dist/server/index.js"),
    source("../next.config.ts"),
  ]);

  assert.match(layout, /Notice — Agreement Operations/i);
  assert.match(layout, /Agreements that move/i);
  assert.match(page, /Sell-side/);
  assert.match(page, /Buy-side/);
  assert.match(page, /Corporate/);
  for (const stage of ["Intake", "Draft", "Review", "Negotiation", "Signature", "Active"]) {
    assert.match(page, new RegExp(`"${stage}"`));
  }
  for (const view of ["Today", "Agreements", "Approvals", "Signatures", "Obligations", "Templates", "Language library", "Integrations", "Setup & access"]) {
    assert.match(page, new RegExp(view, "i"));
  }
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /\.agreement-row \{ min-width: 0/);
  assert.doesNotMatch(css, /font-size:\s*[6-9]px/);
  assert.match(worker, /vinext/);
  assert.match(nextConfig, /frame-src 'none'/);
  assert.doesNotMatch(nextConfig, /docuseal\.(?:com|eu)/i);
  assert.doesNotMatch(page, /Your site is taking shape/i);
  assert.match(page, /Live verified/);
  assert.match(page, /Live test required/);
});

test("presents DocuSeal compatibility and live evidence without overstating agent authority", async () => {
  const [setup, docuseal, runtime] = await Promise.all([
    source("../app/components/enterprise-setup.tsx"),
    source("../app/lib/docuseal.ts"),
    source("../app/lib/integration-runtime.ts"),
  ]);

  assert.match(setup, /LATEST DOCUSEAL COMPATIBILITY/);
  assert.doesNotMatch(setup, /AI-NATIVE SIGNATURE INTEGRATION/);
  assert.match(setup, /lastTest\?\.status === "passed" \? "Live verified"/);
  assert.match(docuseal, /name: "load_template"/);
  assert.match(docuseal, /template_id: configuration\.templateId/);
  assert.match(docuseal, /signerRolesMatchTemplate\(expectedRoles, loaded\.data\.roles\)/);
  assert.match(runtime, /Mutation tools were not called/);
});

test("covers production identity, intake, drafting, approval, signing, records, and evidence boundaries", async () => {
  const [page, agreementRoute, importRoute, operationsRoute, signatureRoute, webhookRoute, reconciliation, retentionRoute, readinessRoute, membershipRoute, schema, ensure, packageJson] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/api/agreements/route.ts"),
    source("../app/api/documents/import/route.ts"),
    source("../app/api/operations/route.ts"),
    source("../app/api/signatures/route.ts"),
    source("../app/api/webhooks/docuseal/route.ts"),
    source("../app/lib/docuseal-reconciliation.ts"),
    source("../app/api/jobs/retention/route.ts"),
    source("../app/api/readiness/route.ts"),
    source("../app/api/admin/memberships/route.ts"),
    source("../db/schema.ts"),
    source("../db/ensure.ts"),
    source("../package.json"),
  ]);

  assert.match(page, /Start from template/);
  assert.match(page, /UPLOAD CONTRACT/);
  assert.match(page, /Accept/);
  assert.match(page, /Reject/);
  assert.match(page, /Request changes/);
  assert.match(page, /Mark complete/);
  assert.match(page, /SUGGESTED TAGS/);
  assert.match(page, /Local signature simulation/);
  assert.doesNotMatch(page, /DocusealForm|docuseal\.com\/d\/[A-Za-z0-9_-]+/i);
  assert.match(page, /Salesforce/);
  assert.match(page, /HubSpot/);
  assert.match(page, /Custom CRM/);
  assert.match(page, /New approved clause/);
  assert.match(page, /Command search/);
  assert.match(page, /value=\{dateField \? dateInputValue\(analysis\.extracted\[field\]\) : analysis\.extracted\[field\]\}/);
  assert.doesNotMatch(page, /extractionCoverage|extraction coverage|Core terms align with the playbook|Starter playbook applied/);
  assert.doesNotMatch(importRoute, /extractionCoverage/);
  assert.match(agreementRoute, /authorizeApiRequest\(request, "agreement:create"/);
  assert.match(agreementRoute, /db\.batch/);
  assert.match(agreementRoute, /prepareAgreementSnapshot/);
  assert.match(importRoute, /DOCUMENTS\.put/);
  assert.match(importRoute, /inspectDocument/);
  assert.match(importRoute, /import\("unpdf"\)/);
  assert.match(importRoute, /import\("mammoth"\)/);
  assert.match(importRoute, /riskFlags/);
  assert.match(operationsRoute, /approvalRequests/);
  assert.match(operationsRoute, /obligations/);
  assert.match(operationsRoute, /agreementEvents/);
  assert.match(signatureRoute, /createDocuSealSubmission/);
  assert.match(webhookRoute, /claimWebhookReceipt/);
  assert.match(webhookRoute, /verifyDocuSealWebhook/);
  assert.match(reconciliation, /downloadDocuSealArtifact/);
  assert.match(retentionRoute, /getJobRunnerSecret/);
  assert.match(retentionRoute, /legalHold/);
  assert.match(readinessRoute, /workspace:admin/);
  assert.match(membershipRoute, /prepareWorkspaceEvent/);
  assert.match(schema, /approval_requests/);
  assert.match(schema, /obligations/);
  assert.match(schema, /agreement_events/);
  assert.match(schema, /workspace_memberships/);
  assert.match(schema, /workspace_events/);
  assert.match(schema, /webhook_receipts/);
  assert.match(schema, /idx_obligations_status_due_date/);
  assert.match(ensure, /PRAGMA table_info/);
  assert.match(ensure, /PRAGMA optimize/);
  assert.doesNotMatch(packageJson, /@docuseal\/react/);
  assert.match(packageJson, /test:api/);
  assert.match(packageJson, /typecheck/);
});

test("protects first-time drafting, navigation, and saved-version export invariants", async () => {
  const [page, css, guide] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/globals.css"),
    source("../docs/USER_GUIDE.md"),
  ]);

  // An inserted clause must build on the current browser editor buffer, including
  // insertions launched from the global approved-clause library.
  assert.match(page, /editing\s*\?\s*documentEditText\s*:\s*selectedDraft/);
  assert.match(page, /function insertClauseFromLibrary/);
  assert.match(page, /insertClauseFromLibrary\(clause\.id\)/);
  assert.match(page, /navigateNow\("workspace"\)/);

  // Unsaved work is guarded for in-app navigation, cancellation, agreement
  // changes, and browser close/refresh. Downloads use durable content only.
  assert.match(page, /const documentDirty = editing && documentEditText !== documentEditBaseText/);
  assert.match(page, /window\.addEventListener\("beforeunload", warnBeforeUnload\)/);
  assert.match(page, /requestDraftDecision\(discardDocumentEdit\)/);
  assert.match(page, /pendingDraftActionRef/);
  assert.match(page, /Save version and continue/);
  assert.match(page, /Discard changes/);
  assert.match(page, /if \(editing\) return notifyError\("Save or discard your edits before downloading/);
  assert.match(page, /selectedDraft\.content/);
  assert.doesNotMatch(page, /const body = editing\s*\?\s*documentEditText/);
  assert.match(page, /Download saved draft \(\.txt\)/);
  assert.match(page, /SHA-256 \$\{selectedDraft\.sha256\}/);

  // Creation leaves approval routing as an explicit post-review action. Starter
  // and imported paper must not create immediately stale approval work.
  const createAgreement = page.slice(page.indexOf("async function createAgreementAfterGuard"), page.indexOf("function addImportedAgreement"));
  const importAgreement = page.slice(page.indexOf("async function addImportedAgreementAfterGuard"), page.indexOf("async function addClause"));
  assert.ok(createAgreement.length > 0 && importAgreement.length > 0);
  assert.doesNotMatch(createAgreement, /requestRequiredApprovals/);
  assert.doesNotMatch(importAgreement, /requestRequiredApprovals/);
  assert.match(createAgreement, /Review and negotiate the exact paper first, then explicitly request/);
  assert.match(importAgreement, /negotiate the exact paper first, then explicitly request/);
  assert.match(page, /function openGenerator\(\)[\s\S]*requestDraftDecision/);
  assert.match(page, /function openImport\(\)[\s\S]*requestDraftDecision/);
  assert.match(page, /function createAgreement\(\)[\s\S]*requestDraftDecision/);
  assert.match(page, /function addImportedAgreement\(\)[\s\S]*requestDraftDecision/);
  assert.doesNotMatch(page, /onClick=\{\(\) => setImportOpen\(true\)\}/);

  // Core contracts remain usable when supporting resources fail independently.
  const agreementLoad = page.indexOf('requestJson<AgreementPagePayload>("/api/agreements")');
  const optionalLoad = page.indexOf("await Promise.allSettled([");
  assert.ok(agreementLoad >= 0 && optionalLoad > agreementLoad);
  assert.match(page, /Some supporting data could not load/);
  assert.match(page, /Retry supporting data/);

  // The human register binds pagination to the full server-side query instead
  // of filtering only the currently loaded browser page.
  assert.match(page, /loadedSavedAgreementsRef/);
  assert.match(page, /registerSavedAgreementsRef/);
  assert.match(page, /agreementCursorRef/);
  assert.match(page, /agreementPageInFlightRef/);
  assert.match(page, /mergeAgreementPages\(registerSavedAgreementsRef\.current, incoming\)/);
  assert.match(page, /agreementListUrl\(controls, cursor\)/);
  assert.match(page, /parameters\.set\("q", query\)/);
  assert.match(page, /parameters\.set\("side", controls\.side\)/);
  assert.match(page, /parameters\.set\("stage", controls\.stage\)/);
  assert.match(page, /parameters\.set\("risk", controls\.risk\)/);
  assert.match(page, /parameters\.set\("sort", controls\.sort\)/);
  assert.match(page, /nextCursor === cursor/);
  assert.match(page, /Loaded \$\{agreementSavedLoadedCount\} of \$\{agreementTotalMatched\} matching saved agreements/);
  assert.match(page, /Search and filters already cover the full saved register/);
  assert.match(page, /updatedAt: typeof input\.updatedAt === "string" \? input\.updatedAt : ""/);
  assert.match(page, /agreementUpdatedTimestamp\(right\) - agreementUpdatedTimestamp\(left\) \|\| right\.id - left\.id/);
  assert.match(page, /canonicalAgreementValueMinor\(right\) - canonicalAgreementValueMinor\(left\)/);
  assert.match(page, /formatAgreementMoney\(agreement\)/);
  assert.doesNotMatch(page, /money\.format\(agreement\.value\)/);
  assert.match(page, /Load more agreements/);
  assert.match(css, /\.agreement-pagination/);

  // Keyboard and responsive navigation expose conventional accessible state.
  assert.match(page, /closest\("input, textarea, select, \[contenteditable='true'\]"\)/);
  assert.match(page, /role="tablist"/);
  assert.match(page, /aria-controls=\{`agreement-panel-\$\{tab\}`\}/);
  assert.match(page, /role="tabpanel"/);
  assert.match(page, /event\.key === "ArrowRight"/);
  assert.match(page, /aria-expanded=\{mobileNavOpen\}/);
  assert.match(page, /inert=\{compactNavigation && !mobileNavOpen\}/);
  assert.match(page, /className="stage-rail" role="region" tabIndex=\{0\} aria-label=\{`Contract lifecycle stages\. Current stage: \$\{selected\.stage\}`\}/);
  assert.match(page, /className="map-table" role="region" tabIndex=\{0\} aria-label="Canonical CRM projection field map"/);
  assert.match(css, /\.stage-rail:focus-visible, \.map-table:focus-visible/);

  // Small contract-paper metadata and redlines retain AA contrast on the same
  // paper backgrounds at desktop and compact widths.
  assert.match(css, /\.paper-top \{[^}]*color: var\(--muted\)/);
  assert.match(css, /\.contract-paper del \{[^}]*color: #82483d;[^}]*background: #ffe1d9;[^}]*text-decoration-color: #82483d/);
  assert.match(css, /\.signature-lines span \{[^}]*color: var\(--muted\)/);
  assert.match(css, /\.contract-paper > footer \{[^}]*color: var\(--muted\)/);

  // The signed-in identity is discoverable and operable, including an explicit
  // production Access logout. Evaluation mode never presents a fake logout.
  assert.doesNotMatch(page, /aria-haspopup="menu"/);
  assert.match(page, /aria-expanded=\{userMenuOpen\}/);
  assert.match(page, /role="region" aria-label="Account and workspace"/);
  assert.match(page, /href="\/cdn-cgi\/access\/logout"/);
  assert.match(page, /Evaluation session/);
  assert.match(page, /userMenuButtonRef\.current\?\.focus\(\)/);
  assert.match(css, /\.user-menu-popover/);

  // First-use copy, status tones, readable inputs, and touch targets stay public-release friendly.
  assert.match(page, /Upload a contract/);
  assert.match(page, /Start from template/);
  assert.match(page, /Review & redlines/);
  assert.match(page, /FirstUseChecklist/);
  assert.match(page, /toast\.tone === "error" \? "alert" : "status"/);
  assert.match(css, /\.clm-toast\.error/);
  assert.match(css, /\.first-use-checklist/);
  assert.match(css, /\.first-use-checklist \{ width: min\(1000px, 100%\);[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.first-use-checklist \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.agreement-actions button \{ min-height: 44px/);
  assert.match(css, /\.document-text-editor[^}]*font-size: 14px/);
  assert.match(css, /input, select, textarea[^}]*font-size: 16px/);

  assert.match(guide, /Download saved draft \(\.txt\).*exports only the exact durable version/s);
  assert.match(guide, /Save \/ Discard \/ Stay/);
  assert.doesNotMatch(guide, /export uses the loaded saved version, or the unsaved editor text/i);
});

test("keeps production contract upload keyboard-operable and announces scanning", async () => {
  const [page, styles] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/globals.css"),
  ]);
  assert.match(page, /id="import-document-file" className="visually-hidden-file" type="file"/);
  assert.match(page, /label htmlFor="import-document-file">Choose document<\/label>/);
  assert.match(page, /id="import-upload-help"/);
  assert.match(page, /className="scan-state" role="status" aria-live="polite" aria-busy="true"/);
  assert.match(styles, /\.visually-hidden-file:focus-visible \+ label/);
  assert.doesNotMatch(styles, /\.import-drop label input\s*\{[^}]*display:\s*none/);
});

test("keeps navigation, approval, date, and signature gates explicit in the rendered client", async () => {
  const [page, css] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/globals.css"),
  ]);

  // Stable query parameters are validated against loaded records, canonicalized,
  // and applied for reload plus browser back/forward navigation.
  assert.match(page, /url\.searchParams\.set\("view", state\.view\)/);
  assert.match(page, /url\.searchParams\.set\("agreement", String\(state\.selectedId\)\)/);
  assert.match(page, /url\.searchParams\.set\("tab", state\.workspaceTab\)/);
  assert.match(page, /agreements\.find\(\(item\) => item\.id === requestedId\)/);
  assert.match(page, /window\.history\[mode === "replace" \? "replaceState" : "pushState"\]/);
  assert.match(page, /window\.addEventListener\("popstate", handlePopState\)/);
  assert.match(page, /return \{ view: "agreements", selectedId: fallbackSelectedId, workspaceTab: "document", valid: false \}/);

  // The compact navigation is a modal dialog, isolates the background, traps
  // focus, closes on Escape/scrim, and restores the opener.
  assert.match(page, /role=\{compactNavigation \? "dialog" : undefined\}/);
  assert.match(page, /aria-modal=\{compactNavigation && mobileNavOpen \? true : undefined\}/);
  assert.match(page, /className="clm-main" aria-hidden=\{compactNavigation && mobileNavOpen \? true : undefined\} inert=\{compactNavigation && mobileNavOpen\}/);
  assert.match(page, /event\.key !== "Tab"/);
  assert.match(page, /mobileNavWasOpenRef\.current/);
  assert.match(page, /className="nav-scrim"[\s\S]*onClick=\{\(\) => setMobileNavOpen\(false\)\}/);

  // Approval decisions are reviewed rather than fired from queue buttons. A
  // reason, confirmation, and exact recorded basis are included in the request.
  assert.match(page, /openApprovalDecision\(approval, "Changes requested"\)/);
  assert.match(page, /openApprovalDecision\(approval, "Approved"\)/);
  assert.match(page, /RECORDED APPROVAL DECISION/);
  assert.match(page, /!approvalDecisionReason\.trim\(\) \|\| !approvalDecisionConfirmed/);
  for (const field of ["reason", "confirmed", "basisHash", "documentVersion", "documentSha256"]) {
    assert.match(page, new RegExp(`${field}:`));
  }
  assert.match(css, /\.approval-basis-review/);
  assert.match(css, /\.approval-confirmation/);

  // Contract and import date editing use constrained date controls, and the
  // generated draft's primary action always advances to a distinct workspace.
  assert.match(page, /DetailField label="Effective date" type="date"/);
  assert.match(page, /DetailField label="Expiration date" type="date"/);
  assert.match(page, /type=\{dateField \? "date" : "text"\}/);
  assert.match(page, /<span>First due date \*<\/span><input[^>]+type="date"[^>]+value=\{obligationDue\}/);
  assert.match(page, /Continue to contract details/);
  assert.match(page, /This evaluation contract is illustrative and is not persisted/);
  assert.match(page, /record: \{ agreementId: agreement\.id, due: todayIsoDate\(\) \}/);
  assert.match(page, /action: "assess"/);
  assert.match(page, /basisHash: basis\.basisHash/);
  assert.match(page, /workflowBasis: WorkflowBasis \| null/);
  const saveDetails = page.slice(page.indexOf("async function saveDetails"), page.indexOf("async function assessRisk"));
  assert.doesNotMatch(saveDetails, /risk:\s*detailsDraft\.risk/);

  // Provider completion stages signed evidence. Activation has a separate,
  // exact-basis, human-confirmed API action and cannot happen in simulation.
  assert.match(page, /completed_review_required/);
  assert.match(page, /action: "review_completed"/);
  assert.match(page, /FINAL_SIGNATURE_REVIEW_CONFIRMATION/);
  assert.match(page, /finalArtifactSha256: packet\.finalArtifactSha256/);
  assert.match(page, /Review the final signed artifact before activation/);
  assert.match(page, /stage: "Signature", signatureStatus: "completed_review_required"/);
  assert.doesNotMatch(page, /Evaluation signature simulation complete/);
});

test("exposes governed enterprise work without overstating repository evidence", async () => {
  const [page, surfaces, setup, css] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/components/enterprise-surfaces.tsx"),
    source("../app/components/enterprise-setup.tsx"),
    source("../app/globals.css"),
  ]);

  // The decision queue comes before portfolio context and does not render false
  // zeroes while either server response is pending.
  assert.ok(surfaces.indexOf(">Workspace work queue<") < surfaces.indexOf(">Portfolio insights<"));
  assert.match(surfaces, /Building portfolio insights/);
  assert.match(surfaces, /Work queue unavailable/);
  assert.match(surfaces, /This queue is clear/);
  assert.match(surfaces, /\/api\/reports\/portfolio/);
  assert.match(surfaces, /\/api\/work-items/);
  assert.match(surfaces, /insertion-fenced ordering in a live queue/);
  assert.match(surfaces, /Refresh after acting to see new or changed work/);
  assert.doesNotMatch(surfaces, /stable snapshot|without duplicating/);
  assert.match(surfaces, /const workRequestRef = useRef\(0\)/);
  assert.match(surfaces, /requestId !== workRequestRef\.current/);

  // Repository fragments are registered extractor evidence, not canonical-text
  // verification or an automatic contract mutation.
  assert.match(surfaces, /REGISTERED CITATIONS/);
  assert.match(surfaces, /caller-asserted source-text digest/);
  assert.match(surfaces, /Verify this registered quote against the protected working paper/);
  assert.match(surfaces, /sourceTextSha256/);
  assert.match(surfaces, /className="proposal-citation"/);
  assert.match(surfaces, /Asserted source \{citation\.sourceTextSha256\.slice/);
  assert.doesNotMatch(surfaces, /Find the exact clause|EXACT CITATIONS|Review suggestions against exact citations/);

  // Intake review is role/scope gated. Conversion and rejection both use the
  // exact submission version, while rejection needs a visible reason and check.
  assert.match(surfaces, /scope=review&status=submitted&limit=100/);
  assert.match(surfaces, /reviewSubmissionIds\.has\(activeSubmissionId\)/);
  assert.match(surfaces, /action: "reject"/);
  assert.match(surfaces, /rejectReason\.trim\(\)\.length < 8/);
  assert.match(surfaces, /rejectConfirmed/);
  assert.match(surfaces, /Request rejected/);
  assert.match(surfaces, /This immutable request remains in your history/);
  assert.match(surfaces, /The new contract starts in Intake/);

  // Setup covers versioned group membership, governed lifecycle controls, and
  // human-readable policy builders rather than ordinary-user JSON editors.
  assert.match(setup, /action: "add_member"/);
  assert.match(setup, /action: "remove_member"/);
  assert.match(setup, /groupVersion: group\.version/);
  assert.match(setup, /Draft next version of \{template\.name\}/);
  assert.match(setup, /status=\{publishable \? "draft" : template\.status\}/);
  assert.match(setup, /Draft next version of \{playbook\.name\}/);
  assert.match(setup, /\/playbooks\?id=\$\{encodeURIComponent\(playbook\.id\)\}/);
  assert.match(setup, /action: "publish_version"/);
  assert.match(setup, /action: "retire_playbook"/);
  assert.match(setup, /Always-required lane/);
  assert.match(setup, /Preferred clause text/);

  // Saved register views and typed, race-safe agreement custom values have
  // complete UI consumers with confirmation-gated removal.
  assert.match(page, /AgreementSavedViewsBar/);
  assert.match(page, /AgreementCustomFieldsPanel/);
  assert.match(surfaces, /resourceType=agreements/);
  assert.match(surfaces, /definitionVersion: definition\.version/);
  assert.match(surfaces, /expectedUpdatedAt: current\?\.updatedAt \?\? null/);
  assert.match(surfaces, /Remove saved view/);
  assert.match(surfaces, /Remove value/);
  assert.match(surfaces, /I reviewed the exact link and intend to remove it/);
  assert.match(surfaces, /kind: pendingRemoval\.kind, id: pendingRemoval\.id, reason: removalReason\.trim\(\)/);
  assert.match(setup, /lifecycleReason\.trim\(\)\.length < 8/);
  assert.match(setup, /I reviewed the selected record and understand the effect on future use/);
  assert.match(css, /\.saved-views-bar/);
  assert.match(css, /\.agreement-custom-fields/);

  // Narrow layouts retain the fully scrolling navigation and clause filters.
  assert.match(css, /\.clm-sidebar \{ height: 100dvh; max-height: 100dvh; overflow-y: auto/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.library-filters \{ display: flex/);
  assert.match(css, /body \{[^}]*overflow-x: hidden/);
});

test("renders recurring obligations as governed schedules and evidence-bound occurrences", async () => {
  const [page, css] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/globals.css"),
  ]);

  // The operations response is consumed as separate schedules, occurrences,
  // evidence, and eligible owners instead of inferring recurrence from labels.
  for (const field of ["obligationSchedules", "obligationEvidence", "eligibleObligationOwners"]) {
    assert.match(page, new RegExp(field));
  }
  assert.match(page, /Each row is a dated occurrence/);
  assert.match(page, /Occurrence #\{obligation\.occurrenceNumber \?\? 1\}/);
  assert.match(page, /Owner repair needed/);
  assert.match(page, /Evidence retained/);
  assert.match(page, /View evidence/);

  // Creation binds a canonical UUID retry key to one exact request body and
  // sends the explicit recurrence, timezone, reminders, source, owner, and
  // human confirmation required by the v17 backend contract.
  assert.match(page, /OBLIGATION_CREATION_RECOVERY_KEY/);
  assert.match(page, /obligationCreationBodyRef/);
  assert.match(page, /"idempotency-key": creationKey/);
  assert.match(page, /Protected retry ready/);
  assert.match(page, /Retry exact schedule/);
  assert.match(page, /unit: "month" as const, interval: 3/);
  assert.match(page, /Calendar timezone \*/);
  assert.match(page, /supportedValuesOf\("timeZone"\)/);
  assert.match(page, /obligationDue < obligationCalendarDateInTimeZone\(obligationTimeZone\)/);
  assert.match(page, /min=\{obligationRecurrence === "once" \? undefined : obligationCalendarDateInTimeZone\(obligationTimeZone\)\}/);
  assert.match(page, /obligationCalendarDateInTimeZone\(obligation\.timezone \?\? "Etc\/UTC"\)/);
  assert.match(page, /Reminder lead times \*/);
  assert.match(page, /source: obligationSource\.trim\(\)/);
  assert.match(page, /ownerUserId: obligationOwnerUserId/);
  assert.match(page, /confirmed: true/);

  // Human fulfillment and schedule controls send their exact safety fields.
  assert.match(page, /action: "complete"[\s\S]*confirmed: true/);
  assert.match(page, /action: "reassign"[\s\S]*includeOpenOccurrences: true,[\s\S]*confirmed: true/);
  assert.match(page, /action: "schedule_status"[\s\S]*status: nextStatus,[\s\S]*confirmed: true/);
  assert.match(page, /Existing open occurrences are unaffected and remain due in the queue/);
  assert.match(page, /Ending clears the future cursor and cannot be reversed/);
  assert.match(page, /This completion cannot be reopened or edited/);

  // Evaluation copy never claims that browser-only samples are durable or run
  // reminders, and dense controls collapse cleanly on phone layouts.
  assert.match(page, /Evaluation schedule created only in this browser/);
  assert.match(page, /No durable evidence, digest, reminder, or audit event was created/);
  assert.match(css, /\.obligation-metrics \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.obligation-recovery, \.schedule-action-picker \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.complete-obligation, \.evidence-button \{ width: 100%; min-height: 44px/);
});

test("exposes selected direction, template, and risk choices to assistive technology", async () => {
  const [page, styles] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/globals.css"),
  ]);
  assert.match(page, /className="direction-grid" role="group" aria-labelledby="contract-direction-label"/);
  assert.match(page, /aria-pressed=\{newSide === side\}/);
  assert.match(page, /className="template-list" role="group" aria-labelledby="starter-template-label"/);
  assert.match(page, /aria-pressed=\{!newGovernedTemplateVersionId && newTemplate === template\}/);
  assert.match(page, /className="risk-selector" role="group" aria-labelledby="risk-level-label"/);
  assert.match(page, /aria-pressed=\{riskAssessmentLevel === risk\}/);
  assert.match(page, /aria-pressed=\{obligationFilter === filter\}/);
  assert.match(page, /className="library-filters" role="group" aria-labelledby="library-collections-label"/);
  assert.match(page, /aria-pressed=\{libraryCollection === item\}/);
  assert.match(page, /className="profile-choice" role="group" aria-labelledby="negotiation-profile-label"/);
  assert.match(page, /aria-pressed=\{clauseProfile === profile\}/);
  assert.match(page, /<DetailSelect label="Contract direction"/);
  assert.match(page, /value: "Sell-side", label: "Customer contract"/);
  assert.match(page, /value: "Buy-side", label: "Supplier contract"/);
  assert.match(page, /value: "Corporate", label: "Company contract"/);
  assert.match(page, /<DetailSelect label="CRM connection"/);
  assert.match(page, /value: "None", label: "No CRM sync"/);
  assert.match(page, /value: "Salesforce", label: "Salesforce", disabled: !connections\.Salesforce/);
  assert.match(page, /value: "HubSpot", label: "HubSpot", disabled: !connections\.HubSpot/);
  assert.match(page, /function DetailSelect[\s\S]*<select value=\{value\} disabled=\{readOnly\}/);
  assert.doesNotMatch(page, /<DetailField label="(?:Contract direction|CRM connection)"/);
  assert.match(page, /aria-pressed=\{showRedlines\}/);
  assert.match(page, /aria-current=\{newStep === 1 \? "step" : undefined\}/);
  assert.match(page, /field === "side" \? <select value=\{directionConfirmed \? analysis\.extracted\.side : ""\}/);
  assert.match(page, /<option value="Sell-side">Customer contract<\/option>/);
  assert.match(page, /disabled=\{busy \|\| !documentUsable \|\| !directionConfirmed \|\| !typeConfirmed\}/);
  assert.match(styles, /\.details-grid input, \.details-grid select/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.import-file \{ grid-template-columns: 44px minmax\(0, 1fr\)/);
  assert.match(styles, /\.import-file > i \{ width: fit-content; grid-column: 1 \/ -1/);
  assert.ok((page.match(/data-modal-focus-fallback/g) ?? []).length >= 2);
  assert.match(page, /if \(document\.querySelector\("\[role='dialog'\]\[aria-modal='true'\]"\)\) return/);
  assert.match(page, /element !== document\.body[\s\S]*element !== document\.documentElement/);
  assert.match(page, /element\.matches\("button, input, select, textarea, a\[href\]/);
  assert.match(page, /const target = available\(previous\) \? previous : fallback/);
});

test("renders the authenticated production review exchange without overstating automation", async () => {
  const [page, css, route, service, textDiff] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/globals.css"),
    source("../app/api/agreements/[id]/negotiation/route.ts"),
    source("../app/lib/negotiation-service.ts"),
    source("../app/lib/text-diff.ts"),
  ]);
  const negotiationUi = page.slice(page.indexOf("type NegotiationRoundStatus"), page.indexOf("function MetricCard"));
  assert.ok(negotiationUi.length > 0);

  // Production loads the selected agreement's authenticated exchange only when
  // its changes tab is mounted. Evaluation keeps the labeled synthetic sample.
  assert.match(page, /workspaceTab === "changes"/);
  assert.match(page, /sessionMode === "production" \? <ProductionNegotiationPanel/);
  assert.match(page, /key=\{selected\.id\}/);
  assert.match(page, /const endpoint = `\/api\/agreements\/\$\{agreement\.id\}\/negotiation`/);
  assert.match(page, /requestNegotiation<NegotiationState>\(endpoint\)/);
  assert.match(page, /selectedIsSeedEvaluation \? <div[^>]+changes-workspace/);

  // The three-step flow is backed by the complete mutation vocabulary and every
  // write remains inside document-management UI plus server authorization.
  for (const label of ["Prepare & share", "Await return", "Review & promote"]) {
    assert.match(page, new RegExp(label.replace("&", "&")));
  }
  for (const action of ["prepare", "send", "attest_manual_send", "rotate_portal", "upload", "promote_submission", "close"]) {
    assert.match(page, new RegExp(`(?:action:\\s*\\"${action}\\"|form\\.append\\(\\"action\\",\\s*\\"${action}\\"\\))`));
  }
  assert.match(page, /action: "mark_ready" \| "reject_submission"/);
  assert.match(page, /JSON\.stringify\(\{ action, submissionId: selectedSubmission\.id, note: decisionNote\.trim\(\) \}\)/);
  assert.match(route, /POST[\s\S]*authorizeApiRequest\(request, "document:manage"/);
  assert.match(route, /GET[\s\S]*authorizeApiRequest\(request, "document:read"/);
  assert.match(page, /Only a member with document-management permission can prepare, send, decide, upload, promote, rotate, or close/);

  // Preparation is tied to either the exact saved working draft or, when no
  // working version exists, an eligible clean uploaded source. Sends stay
  // locked to the prepared recipient and conflicts force reconciliation.
  assert.match(page, /workingDraftBasisReady = savedDraft\?\.status === "ready" && Boolean\(savedDraft\.sha256\)/);
  assert.match(page, /savedDraft\?\.status === "none"[\s\S]*source\.scanStatus === "clean"/);
  assert.match(page, /prepareEligible = !documentDirty && \(workingDraftBasisReady \|\| Boolean\(cleanSourceBasis\)\)/);
  assert.match(page, /Download exact source/);
  assert.match(page, /Save or discard the current editor changes before preparing/);
  assert.match(page, /expectedAgreementVersion: state\.agreementVersion/);
  assert.match(page, /recipientEmail: activeRound\.counterpartyEmail/);
  assert.match(page, /Recipient \(locked when prepared\)/);
  assert.match(page, /status === 409 \|\| error\.status === 410/);
  assert.match(page, /await onReconcileAgreement/);
  assert.match(page, /await refreshNegotiationState/);
  assert.match(page, /tab === "changes" && selectedIsSeedEvaluation/);
  assert.match(page, /deriveWorkspaceAction\(\{/);
  assert.match(page, /workspacePrimaryAction\.kind === "counterparty_exchange"/);
  assert.doesNotMatch(page, /if \(selected\.stage === "Negotiation"\) return openWorkspaceTab/);

  // Exact file identity is visible and verified before download. Upload sends
  // exactly one file and optional reviewed text remains bound to that submission.
  assert.match(page, /outboundDocument\?\.fileName/);
  assert.match(page, /Full file SHA-256/);
  assert.match(page, /X-Document-SHA256/i);
  assert.match(page, /responseSha256 !== expectedSha256/);
  assert.match(page, /\/api\/documents\/\$\{documentId\}/);
  assert.equal(page.match(/form\.append\("file", uploadFile\)/g)?.length, 1);
  assert.match(page, /form\.append\("reviewedText", uploadReviewedText\)/);
  assert.match(route, /files\.length !== 1/);
  assert.match(route, /reviewedText: oneString\(form, "reviewedText"\)/);

  // Portal plaintext appears only from a fresh mutation result. The state API
  // exposes a scoped active alias to managers without leaking secret material.
  assert.match(page, /setIssuedPortal\(envelope\?\.portalUrl/);
  assert.match(page, /setIssuedPortal\(\{ url: result\.portalUrl/);
  assert.doesNotMatch(page, /state\??\.[A-Za-z]*portalUrl/);
  assert.match(page, /does not retain or redisplay its plaintext/);
  assert.match(page, /Temporary portal URL \(shown once\)/);
  assert.match(page, /An upload does not consume it/);
  assert.match(page, /Rotation immediately invalidates the old URL/);
  assert.match(service, /const activeEmailDomain = canManage \?/);
  assert.match(service, /void aliasCode/);
  assert.match(service, /void activeKey/);
  assert.doesNotMatch(negotiationUi, /aliasCode|activeKey|portalTokenHash/);

  // Every return state has explicit operational guidance. Word binaries are
  // never claimed to be parsed, and only a ready current-round submission can promote.
  for (const status of ["sender_review", "quarantined", "rejected", "late", "no_attachment", "promoted", "ready"]) {
    assert.match(page, new RegExp(`status === \\"${status}\\"`));
  }
  assert.match(page, /does not parse or prove tracked changes/);
  assert.match(page, /Review tracked changes in Microsoft Word/);
  assert.match(page, /Rescan quarantined file/);
  assert.match(page, /selectedDocumentScanStatus === "clean"/);
  assert.match(page, /Download exact returned file for review/);
  assert.match(page, /inactive email aliases and expired portals do not accept a late return/);
  assert.match(page, /activeSubmission\?\.status === "ready" && activeRoundIsLatest/);
  assert.match(page, /preferredNegotiationSubmission\(next\)/);
  assert.match(page, /submission\.roundId === state\.activeRound\?\.id/);
  assert.match(page, /retained\.roundId === next\.activeRound\?\.id/);
  assert.match(page, /Required decision or verification note/);
  assert.match(page, /Required human-review note/);
  assert.match(page, /invalidates prior approvals and signature readiness/);

  // Delivery language distinguishes queueing, provider acceptance, manual
  // attestation, and terminal failure without claiming counterparty receipt.
  assert.match(page, /deliveryState: NegotiationDeliveryState/);
  assert.match(page, /Gateway accepted/);
  assert.match(page, /does not prove counterparty receipt/);
  assert.match(page, /Gateway did not accept/);
  assert.match(page, /The terminal event must not be resent/);
  assert.match(page, /A return or response is already recorded for this round/);
  assert.match(page, /Close the round, confirm the counterparty details, and prepare a fresh round/);
  assert.match(page, /activeRound\.deliveryState !== "dead"/);
  assert.match(page, /managerBusy \|\| deliveryFinalizationPending/);
  assert.match(page, /Promotion waits for gateway finalization/);
  assert.match(page, /deliveryFinalizationPending \|\| !closeNote\.trim\(\)/);
  assert.match(page, /error\.code === "malware_detected"/);
  assert.match(page, /Notice recorded it as rejected/);

  // Counterparty messages use a configuration-aware secure-link default, show
  // the assembled delivery semantics, and remain locked behind their separate
  // production acceptance gate.
  assert.match(page, /const portalOnlySendMessage = `Please use the secure link/);
  assert.match(page, /const replyEnabledSendMessage = `Please use the secure link/);
  assert.match(page, /Notice reply capture is not configured for this round/);
  assert.match(page, /Notice reply capture is off — return through the secure portal/);
  assert.match(page, /Scoped portal URL and authenticated review-copy metadata; no attachment bytes/);
  assert.match(page, /Notice does not claim the file is attached/);
  assert.match(page, /Notice temporarily retains its plaintext in the protected delivery event/);
  assert.match(page, /!state\.negotiationMailAccepted/);
  assert.match(service, /getNegotiationDeliveryConfiguration\(\)/);

  // Review text and notes are cached per submission and every path out of the
  // review workspace is guarded, including browser close or refresh.
  assert.match(page, /reviewDraftCacheRef/);
  assert.match(page, /cacheCurrentReviewDraft\(\)/);
  assert.match(page, /refreshCachedReviewDraftDirty\(submission\.id\)/);
  assert.match(page, /UNSUBMITTED REVIEW WORK/);
  assert.match(page, /requestNegotiationDraftDecision\(action\)/);
  assert.match(page, /window\.addEventListener\("beforeunload", preventUnsubmittedReviewLoss\)/);
  assert.match(page, /setRefreshRequired\(true\)/);
  assert.match(page, /stateRecovered = agreementRecovered && negotiationRecovered/);
  assert.match(page, /if \(!stateRecovered\) setRefreshRequired\(true\)/);
  assert.match(page, /stateRecovered && error instanceof NegotiationRequestError && error\.status === 409/);

  // Comparison inputs and claims stay deliberately narrow: current saved text
  // against user-reviewed text, in-browser, with an explicit coarse fallback.
  assert.match(page, /compareTextLines\(savedDraft\.content, reviewedText\)/);
  assert.match(page, /Current saved draft ↔ your reviewed text/);
  assert.match(page, /does not inspect the returned binary or make a legal, policy, risk, or no-change verdict/);
  assert.match(page, /does not prove the returned file is unchanged or acceptable/);
  assert.match(textDiff, /mode: "exact" \| "coarse"/);
  assert.match(textDiff, /MAX_EXACT_MATRIX_CELLS/);

  // Status changes use the single global live region (the local action card is
  // visual only, avoiding duplicate announcements), controls meet touch sizing,
  // and the dense evidence layout collapses to one column on phones.
  assert.match(page, /aria-busy=\{loading \|\| managerBusy\}/);
  assert.match(page, /role=\{toast\.tone === "error" \? "alert" : "status"\}/);
  assert.match(page, /aria-live=\{toast\.tone === "error" \? "assertive" : "polite"\}/);
  assert.match(page, /setActionMessage\(\{ text, tone \}\);[\s\S]*notify\(text, tone\)/);
  assert.doesNotMatch(negotiationUi, /role=\{actionMessage/);
  assert.match(css, /\.production-negotiation button[^}]*min-height: 44px/);
  assert.match(css, /\.negotiation-form\.two-column, \.share-round-grid, \.negotiation-round-facts, \.negotiation-side, \.comparison-counts \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.negotiation-submissions dl \{ grid-template-columns: 1fr; \}/);
});

test("keeps product positioning and fixtures general-purpose", async () => {
  const files = await Promise.all([
    source("../app/page.tsx"),
    source("../app/layout.tsx"),
    source("../app/api/documents/import/route.ts"),
    source("../PRODUCT_BRIEF.md"),
    source("../MARKET_SURVEY.md"),
  ]);
  const combined = files.join("\n");
  const readme = await source("../README.md");

  assert.match(combined, /general-purpose agreement operations/i);
  assert.match(readme, /general-purpose contract lifecycle management/i);
  assert.match(combined, /57 commercially relevant products/i);
  assert.match(combined, /Ironclad/i);
  assert.match(combined, /local signing simulation/i);
  assert.doesNotMatch(combined, /embedded public (?:surface|form)|public embedded sample/i);
  assert.doesNotMatch(`${combined}\n${readme}`, /wealth[- ]management|investment management|\badviser\b|\badvisor\b/i);
  assert.doesNotMatch(files.slice(0, 3).join("\n"), /hardcoded-ria|single-client-tenant/i);
});
