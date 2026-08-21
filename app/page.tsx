"use client";

import {
  ChangeEvent,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { assembleStarterDraft, starterDraftSummary } from "./lib/starter-draft";
import { compareTextLines, type TextDiffResult } from "./lib/text-diff";
import { deriveWorkspaceAction, isActiveNegotiationQueueAction } from "./lib/workspace-action";
import { FINAL_SIGNATURE_REVIEW_CONFIRMATION } from "./lib/signature-evidence";
import {
  AgreementCustomFieldsPanel,
  AgreementRelationshipsPanel,
  AgreementSavedViewsBar,
  IntakeWorkspace,
  PortfolioWorkspace,
  RepositoryIntelligenceWorkspace,
} from "./components/enterprise-surfaces";
import {
  EnterpriseSetupCenter,
  type EnterpriseCounterparty,
  type EnterpriseLegalEntity,
  type EnterpriseSetupSection,
  type EnterpriseTemplate,
  type EnterpriseTemplateVersion,
  type EnterpriseWorkflow,
} from "./components/enterprise-setup";

type View = "today" | "portfolio" | "agreements" | "intake" | "approvals" | "signatures" | "obligations" | "repository" | "library" | "templates" | "integrations" | "admin" | "workspace";
type AgreementSide = "Sell-side" | "Buy-side" | "Corporate";
type Stage = "Intake" | "Draft" | "Review" | "Negotiation" | "Signature" | "Active";
type Risk = "Unassessed" | "Low" | "Medium" | "High";
type ChangeStatus = "open" | "accepted" | "rejected";
type WorkspaceTab = "document" | "changes" | "details" | "activity";
type ReturnView = Exclude<View, "workspace">;
type ToastTone = "success" | "error" | "info";
type ToastMessage = { message: string; tone: ToastTone };
type ApprovalDecisionStatus = "Approved" | "Changes requested";
type UrlNavigationState = { view: View; selectedId: number; workspaceTab: WorkspaceTab; valid: boolean };

const GENERATED_CREATION_RECOVERY_KEY = "notice:agreement-creation:generated";
const IMPORTED_CREATION_RECOVERY_KEY = "notice:agreement-creation:imported";
const OBLIGATION_CREATION_RECOVERY_KEY = "notice:obligation-schedule-creation";

type GeneratedCreationRecovery = {
  workspaceId: string;
  userId: string;
  idempotencyKey: string;
  side: AgreementSide;
  party: string;
  value: string;
  currencyCode: string;
  template: string;
  governedTemplateVersionId: string;
  workflowDefinitionId: string;
  ownerUserId: string;
  primaryCounterpartyId: string;
  legalEntityId: string;
  templateVariables: Record<string, string>;
  crm: Agreement["crm"];
  department: string;
  owner: string;
  governingLaw: string;
  requestBody: string;
};

type ImportedCreationRecovery = {
  workspaceId: string;
  userId: string;
  idempotencyKey: string;
  phase: "uploading" | "uploaded" | "agreement-attempted" | "linking";
  name: string;
  analysis?: ImportAnalysis;
  requestBody?: string;
  agreementId?: number;
};

type ObligationRecurrenceChoice = "once" | "week" | "month" | "quarter" | "year";

type ObligationCreationRecovery = {
  workspaceId: string;
  userId: string;
  idempotencyKey: string;
  requestBody: string;
  agreementId: number;
  title: string;
  source: string;
  dueDate: string;
  ownerUserId: string;
  recurrence: ObligationRecurrenceChoice;
  timezone: string;
  reminderLeadDays: number[];
  endDate: string;
};

type Agreement = {
  id: number;
  version?: number;
  party: string;
  initials: string;
  side: AgreementSide;
  type: string;
  value: number;
  valueMinor?: number;
  currencyCode?: string;
  stage: Stage;
  owner: string;
  ownerUserId?: string | null;
  primaryCounterpartyId?: string | null;
  legalEntityId?: string | null;
  governedTemplateVersionId?: string | null;
  workflowDefinitionId?: string | null;
  nextAction: string;
  due: string;
  crm: "Salesforce" | "HubSpot" | "Custom CRM" | "None";
  crmRecord: string;
  tags: string[];
  updated: string;
  updatedAt?: string;
  department: string;
  risk: Risk;
  approvalStatus: "Not required" | "Required" | "Pending" | "Approved" | "Changes requested";
  signatureStatus: "Not sent" | "Preparing" | "Sent" | "Partially signed" | "completed_review_required" | "Completed";
  effectiveDate: string;
  expirationDate: string;
};

type AgreementListSort = "Updated" | "Value" | "Risk";
type AgreementListControls = {
  q: string;
  side: "All" | AgreementSide;
  stage: "All" | Stage;
  risk: "All" | Risk;
  sort: AgreementListSort;
};

type AgreementPagePayload = {
  agreements: Agreement[];
  totalMatched?: number;
  nextCursor?: string | null;
  hasMore?: boolean;
};

type ClauseBlock = {
  id: number;
  version?: number;
  title: string;
  category: string;
  profile: "Standard" | "Fallback" | "Strict";
  summary: string;
  language: string;
  uses: number;
};

type Approval = {
  id: string;
  version?: number;
  agreementId: number;
  role: string;
  requestedByUserId?: string | null;
  approver: string;
  approverUserId?: string | null;
  status: "Pending" | "Approved" | "Changes requested";
  basisHash?: string;
  documentVersion?: number;
  documentSha256?: string;
  comment?: string | null;
  due: string;
  createdAt: string;
};

type SignaturePacket = {
  id: string;
  version: number;
  agreementId: number;
  status: string;
  signers: Array<{ role?: string; email?: string; name?: string; submitterId?: string | number | null; status?: string }>;
  documentVersion: number;
  documentSha256: string;
  basisHash?: string;
  evidenceDocumentId?: string | null;
  finalArtifactSha256?: string | null;
  completedAt?: string | null;
  activeKey?: string | null;
  createdAt: string;
  updatedAt: string;
};

type SignaturePartyInput = { role: string; name: string; email: string };

type Obligation = {
  id: string;
  version?: number;
  agreementId: number;
  scheduleId?: string | null;
  occurrenceNumber?: number;
  title: string;
  dueDate: string;
  owner: string;
  ownerUserId?: string | null;
  status: "Open" | "Complete";
  cadence: string;
  source: string;
  timezone?: string;
  reminderLeadDays?: number[];
  nextReminderDate?: string | null;
  completionEvidence?: string | null;
  completedByUserId?: string | null;
  completedAt?: string | null;
  evaluationOnly?: boolean;
};

type ObligationSchedule = {
  id: string;
  agreementId: number;
  version: number;
  title: string;
  source: string;
  owner: string;
  ownerUserId: string | null;
  timezone: string;
  recurrenceUnit: "once" | "week" | "month" | "year";
  recurrenceInterval: number;
  anchorDate: string;
  endDate: string | null;
  reminderLeadDays: number[];
  status: "active" | "paused" | "ended";
  nextOccurrenceNumber: number | null;
  nextOccurrenceDate: string | null;
  nextMaterializationDate: string | null;
  createdAt?: string;
  updatedAt?: string;
  evaluationOnly?: boolean;
};

type ObligationEvidence = {
  id: string;
  agreementId: number;
  obligationId: string;
  evidenceText: string;
  evidenceSha256: string | null;
  submittedByUserId: string | null;
  overrideReason: string | null;
  provenance: "native" | "legacy_v16" | "evaluation";
  createdAt: string;
  evaluationOnly?: boolean;
};

type EligibleObligationOwner = {
  userId: string;
  displayName: string;
  role: SessionData["role"];
};

type OperationsPayload = {
  approvals: Approval[];
  obligations: Obligation[];
  obligationSchedules: ObligationSchedule[];
  obligationEvidence: ObligationEvidence[];
  eligibleObligationOwners: EligibleObligationOwner[];
  events: AuditEvent[];
};

type AuditEvent = {
  id: string;
  agreementId: number;
  type: string;
  actor: string;
  detail: string;
  createdAt: string;
  sequence?: number;
  eventHash?: string | null;
};

type ImportAnalysis = {
  documentId?: string;
  extractionMode: string;
  scanStatus?: string;
  tags: string[];
  riskFlags: string[];
  extracted: {
    side: string;
    type: string;
    governingLaw: string;
    paymentTerms: string;
    renewalNotice: string;
    counterparty: string;
    agreementValue: string;
    effectiveDate: string;
    expirationDate: string;
    liabilityCap: string;
  };
};

type DocumentUploadResult = {
  document: {
    id: string;
    fileName: string;
    extractionMode: string;
    scanStatus: string;
    tags: string[];
    riskFlags: string[];
    extracted: ImportAnalysis["extracted"];
  };
};

type SessionData = {
  mode: "evaluation" | "production";
  workspace: { id: string; slug: string; name: string };
  user: { id: string; email: string; displayName: string };
  role: "admin" | "legal" | "approver" | "requester" | "viewer";
  permissions: string[];
};

type ReadinessData = {
  readyForProduction: boolean;
  code: { ready: boolean; checks: Array<{ id: string; label: string; status: string; message: string; remediation?: string }> };
  customer: { ready: boolean; checks: Array<{ id: string; label: string; status: string; message: string; remediation?: string }> };
};

type WorkspaceMember = {
  userId: string;
  email: string;
  displayName: string;
  identityProvider: string;
  role: SessionData["role"];
  membershipStatus: "active" | "disabled";
};

type PublishedTemplate = Pick<EnterpriseTemplate, "id" | "version" | "name" | "description" | "agreementType" | "side" | "status" | "currentPublishedVersion"> & {
  publishedVersion: EnterpriseTemplateVersion;
};

type AgentActionId =
  | "agreement.read"
  | "approval.request";

type AgentPrincipal = {
  id: string;
  name: string;
  issuer: string;
  commonName: string;
  status: "active" | "disabled";
  version: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
};

type AgentGrant = {
  id: string;
  principalId: string;
  delegatorUserId: string;
  status: "active" | "revoked";
  actionIds: string[];
  resourceConstraints: { resources: Array<{ type: string; ids: string[] }> };
  policyVersion: string;
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type AgentPlanSummary = {
  id: string;
  principalId: string;
  grantId: string;
  actionId: string;
  target: { type: string; id: string };
  status: string;
  riskTier: "low" | "medium" | "high" | "critical";
  planSha256: string;
  expectedVersion: number | null;
  basisHash: string | null;
  blockers: Array<Record<string, unknown>>;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

type AgentPlanDetail = AgentPlanSummary & {
  durableStatus: string;
  review: {
    evaluatedAt: string;
    effectiveStatus: string;
    eligible: boolean;
    blockers: Array<{ code: string; message: string }>;
    currentBasis: Record<string, unknown> | null;
  };
  input: Record<string, unknown>;
  inputSha256: string;
  workingDocument: { version: number; sha256: string } | null;
  policyVersion: string;
  before: Record<string, unknown> | null;
  proposedDiff: Record<string, unknown>;
  provenance: Record<string, unknown>;
  decision: Record<string, unknown> | null;
  execution: Record<string, unknown> | null;
};

type IntegrationStatus = {
  id: string;
  label: string;
  provider?: string;
  configured: boolean;
  required?: boolean;
  testable?: boolean;
  detail?: string;
  lastTest?: { status: "passed" | "failed"; testedAt: string; detail: string } | null;
  selectedOcrProfile?: {
    execution: "customer-hosted-scanner-gateway";
    modelId: string;
    profileId: string;
  } | null;
};

type CrmResyncAction = "projection" | "tombstone" | "legacy_cleanup_attestation";

const CRM_LEGACY_CLEANUP_CONFIRMATION = "I confirm every legacy CRM copy for this agreement was reconciled or deleted outside Notice.";
const CRM_HISTORICAL_CLEANUP_CONFIRMATION = "I confirm this configured CRM profile is historical, the intended live profile is reconciled, and I will restore, retest, reproject, and verify it before resuming service.";

const agentDelegableAgreementActions: ReadonlyArray<{ id: AgentActionId; label: string }> = [
  { id: "agreement.read", label: "Read agreement" },
  { id: "approval.request", label: "Propose approval routing" },
];

type CrmResyncCandidate = {
  id: number;
  version: number;
  party: string;
  crm: Agreement["crm"];
  deletedAt: string | null;
  updatedAt: string;
  eligibleActions: CrmResyncAction[];
  historicalCleanup: boolean;
  resyncBlockedReason: string | null;
};

type RetentionPolicy = {
  id: number;
  version: number;
  legalHold: boolean;
  retentionUntil: string | null;
  deletedAt?: string | null;
};

type DraftLoadState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "ready"; content: string; version: number; sha256?: string }
  | { status: "error"; message: string };

type WorkflowBasis = {
  agreementVersion: number;
  riskAssessment: { basisHash: string; documentVersion: number; documentSha256: string };
  approval: { basisHash: string; documentVersion: number; documentSha256: string };
};

type DocumentVersionSummary = {
  version: number;
  sha256?: string;
};

type SourceDocumentSummary = {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  scanStatus: string;
  createdAt: string;
};

type NegotiationDocumentSummary = {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  scanStatus?: string;
};

type NegotiationRoundStatus = "prepared" | "outbound" | "returned" | "review" | "resolved" | "closed";
type NegotiationDeliveryState = "not_queued" | "queued" | "processing" | "accepted" | "dead" | "manual_recorded";
type NegotiationRound = {
  id: string;
  agreementId: number;
  roundNumber: number;
  status: NegotiationRoundStatus;
  counterpartyEmail: string | null;
  counterpartyName: string | null;
  baseDocumentVersion: number | null;
  baseDocumentId: string | null;
  baseSha256: string;
  outboundDocumentId: string;
  outboundSha256: string;
  outboundDocument?: NegotiationDocumentSummary | null;
  portalExpiresAt: string | null;
  portalEnabled: boolean;
  emailAddress: string | null;
  deliveryMethod: "manual" | "email_gateway" | "portal" | null;
  deliveryState: NegotiationDeliveryState;
  providerMessageId: string | null;
  resolvedDocumentVersion: number | null;
  resolvedSha256: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
};

type NegotiationSubmissionStatus = "ready" | "sender_review" | "quarantined" | "rejected" | "promoted" | "late" | "no_attachment";
type NegotiationSubmission = {
  id: string;
  agreementId: number;
  roundId: string;
  source: "email" | "portal" | "manual";
  status: NegotiationSubmissionStatus;
  senderEmail: string | null;
  senderName: string | null;
  providerMessageId: string | null;
  documentId: string | null;
  documentSha256: string | null;
  document?: NegotiationDocumentSummary | null;
  reviewTextAvailable: boolean;
  reviewTextSha256: string | null;
  reviewTextSize: number | null;
  reviewTextProvenance: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
};

type NegotiationComparison = {
  id: string;
  roundId: string;
  submissionId: string;
  baseSha256: string | null;
  proposedSha256: string | null;
  baseTextSha256: string | null;
  proposedTextSha256: string | null;
  provenance: string | null;
  status: "ready" | "manual_required" | "accepted" | "rejected" | "superseded";
  decisionNote: string | null;
  resultingDocumentVersion: number | null;
  resultingSha256: string | null;
  createdAt: string;
  updatedAt: string;
};

type NegotiationState = {
  agreementVersion: number;
  latestRound: NegotiationRound | null;
  activeRound: NegotiationRound | null;
  rounds: NegotiationRound[];
  submissions: NegotiationSubmission[];
  comparisons: NegotiationComparison[];
  deliveryConfigured: boolean;
  negotiationMailAccepted: boolean;
  inboundEmailConfigured: boolean;
  portalEnabled: boolean;
  requestId?: string;
};

type IssuedPortalLink = {
  url: string;
  expiresAt: string | null;
  source: "prepare" | "send" | "rotate";
};

const stages: Stage[] = ["Intake", "Draft", "Review", "Negotiation", "Signature", "Active"];
const FINANCE_APPROVAL_THRESHOLD_USD = 100_000;
const workspaceTabs: WorkspaceTab[] = ["document", "changes", "details", "activity"];
const workspaceTabLabels: Record<WorkspaceTab, string> = {
  document: "Working draft",
  changes: "Review & redlines",
  details: "Contract details",
  activity: "History & comments",
};
const zeroDecimalCurrencies = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const threeDecimalCurrencies = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

function currencyMinorDigits(currencyCode: string) {
  const code = currencyCode.trim().toUpperCase();
  return zeroDecimalCurrencies.has(code) ? 0 : threeDecimalCurrencies.has(code) ? 3 : 2;
}

function amountToMinor(value: string | number, currencyCode: string) {
  const numeric = typeof value === "number" ? value : Number(value.replaceAll(",", "").trim() || 0);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const minor = Math.round(numeric * (10 ** currencyMinorDigits(currencyCode)));
  return Number.isSafeInteger(minor) ? minor : null;
}

function minorToAmount(valueMinor: number | undefined, currencyCode: string | undefined, legacyValue = 0) {
  if (Number.isSafeInteger(valueMinor)) return (valueMinor ?? 0) / (10 ** currencyMinorDigits(currencyCode ?? "USD"));
  return legacyValue;
}

function formatAgreementMoney(agreement: Pick<Agreement, "value" | "valueMinor" | "currencyCode">) {
  const code = agreement.currencyCode ?? "USD";
  const amount = minorToAmount(agreement.valueMinor, code, agreement.value);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code, maximumFractionDigits: currencyMinorDigits(code) }).format(amount);
  } catch {
    return `${code} ${amount.toLocaleString("en-US")}`;
  }
}

const defaultAgreementListControls: AgreementListControls = {
  q: "",
  side: "All",
  stage: "All",
  risk: "All",
  sort: "Updated",
};

function agreementListSearch(controls: AgreementListControls, cursor?: string | null) {
  const parameters = new URLSearchParams();
  const query = controls.q.trim();
  if (query) parameters.set("q", query);
  if (controls.side !== "All") parameters.set("side", controls.side);
  if (controls.stage !== "All") parameters.set("stage", controls.stage);
  if (controls.risk !== "All") parameters.set("risk", controls.risk);
  parameters.set("sort", controls.sort);
  if (cursor) parameters.set("cursor", cursor);
  return parameters.toString();
}

function agreementListUrl(controls: AgreementListControls, cursor?: string | null) {
  return `/api/agreements?${agreementListSearch(controls, cursor)}`;
}

function agreementListKey(controls: AgreementListControls) {
  return agreementListSearch(controls);
}

function canonicalAgreementValueMinor(agreement: Pick<Agreement, "value" | "valueMinor" | "currencyCode">) {
  return Number.isSafeInteger(agreement.valueMinor)
    ? agreement.valueMinor ?? 0
    : amountToMinor(agreement.value, agreement.currencyCode ?? "USD") ?? 0;
}

function agreementUpdatedTimestamp(agreement: Pick<Agreement, "updatedAt">) {
  const timestamp = agreement.updatedAt ? Date.parse(agreement.updatedAt) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function agreementMatchesListControls(agreement: Agreement, controls: AgreementListControls) {
  const query = controls.q.trim().toLowerCase();
  return (controls.side === "All" || agreement.side === controls.side)
    && (controls.stage === "All" || agreement.stage === controls.stage)
    && (controls.risk === "All" || agreement.risk === controls.risk)
    && (!query || [
      agreement.party,
      agreement.type,
      agreement.owner,
      agreement.department,
      agreement.crm,
      agreement.stage,
      agreement.side,
      ...agreement.tags,
    ].join(" ").toLowerCase().includes(query));
}

function compareAgreements(left: Agreement, right: Agreement, sort: AgreementListSort) {
  if (sort === "Value") {
    const currencyOrder = (left.currencyCode ?? "USD").localeCompare(right.currencyCode ?? "USD");
    if (currencyOrder !== 0) return currencyOrder;
    const valueOrder = canonicalAgreementValueMinor(right) - canonicalAgreementValueMinor(left);
    return valueOrder || right.id - left.id;
  }
  if (sort === "Risk") {
    const riskRank: Record<Risk, number> = { High: 3, Medium: 2, Low: 1, Unassessed: -1 };
    return riskRank[right.risk] - riskRank[left.risk] || right.id - left.id;
  }
  return agreementUpdatedTimestamp(right) - agreementUpdatedTimestamp(left) || right.id - left.id;
}

function visibleAgreementRows(rows: Agreement[], controls: AgreementListControls) {
  return rows
    .filter((agreement) => agreementMatchesListControls(agreement, controls))
    .sort((left, right) => compareAgreements(left, right, controls.sort));
}

function contractDirectionLabel(side: AgreementSide) {
  return side === "Sell-side" ? "Customer contract" : side === "Buy-side" ? "Supplier contract" : "Company contract";
}

const seedAgreements: Agreement[] = [
  {
    id: 1,
    party: "Helio Systems",
    initials: "HS",
    side: "Sell-side",
    type: "Master Services Agreement",
    value: 240000,
    stage: "Negotiation",
    owner: "Maya Chen",
    nextAction: "Resolve 2 open redlines",
    due: "Today",
    crm: "Salesforce",
    crmRecord: "Helio — Enterprise expansion",
    tags: ["Customer", "MSA", "Auto-renew", "DPA attached"],
    updated: "12 min ago",
    department: "Sales",
    risk: "High",
    approvalStatus: "Pending",
    signatureStatus: "Not sent",
    effectiveDate: "Aug 15, 2026",
    expirationDate: "Aug 14, 2027",
  },
  {
    id: 2,
    party: "Northstar Cloud",
    initials: "NC",
    side: "Buy-side",
    type: "Software Subscription Agreement",
    value: 144000,
    stage: "Review",
    owner: "Jon Bell",
    nextAction: "Finance approval",
    due: "Today",
    crm: "Custom CRM",
    crmRecord: "VEN-1048",
    tags: ["Supplier", "SaaS", "Auto-renew", "Security review"],
    updated: "28 min ago",
    department: "IT",
    risk: "Medium",
    approvalStatus: "Pending",
    signatureStatus: "Not sent",
    effectiveDate: "Sep 1, 2026",
    expirationDate: "Aug 31, 2027",
  },
  {
    id: 3,
    party: "Aster Labs",
    initials: "AL",
    side: "Sell-side",
    type: "Order Form",
    value: 96000,
    stage: "Signature",
    owner: "Priya Shah",
    nextAction: "Counterparty signature",
    due: "Tomorrow",
    crm: "HubSpot",
    crmRecord: "Aster Labs — Platform",
    tags: ["Customer", "Order form", "Annual", "EU data"],
    updated: "1 hr ago",
    department: "Sales",
    risk: "Low",
    approvalStatus: "Approved",
    signatureStatus: "Partially signed",
    effectiveDate: "Aug 10, 2026",
    expirationDate: "Aug 9, 2027",
  },
  {
    id: 4,
    party: "Meridian Data",
    initials: "MD",
    side: "Buy-side",
    type: "Data License Agreement",
    value: 78000,
    stage: "Active",
    owner: "Leon Wu",
    nextAction: "Renewal decision",
    due: "27 days",
    crm: "None",
    crmRecord: "—",
    tags: ["Supplier", "Data", "Auto-renew", "90-day notice"],
    updated: "Yesterday",
    department: "Product",
    risk: "Medium",
    approvalStatus: "Approved",
    signatureStatus: "Completed",
    effectiveDate: "Nov 1, 2025",
    expirationDate: "Oct 31, 2026",
  },
  {
    id: 5,
    party: "Lumen Freight",
    initials: "LF",
    side: "Sell-side",
    type: "Mutual NDA",
    value: 0,
    stage: "Draft",
    owner: "Iris Meyer",
    nextAction: "Complete deal data",
    due: "Friday",
    crm: "Salesforce",
    crmRecord: "Lumen Freight — Discovery",
    tags: ["Customer", "NDA", "Mutual", "2-year term"],
    updated: "Yesterday",
    department: "Sales",
    risk: "Low",
    approvalStatus: "Not required",
    signatureStatus: "Not sent",
    effectiveDate: "",
    expirationDate: "",
  },
  {
    id: 6,
    party: "Atlas Shield",
    initials: "AS",
    side: "Buy-side",
    type: "Professional Services Agreement",
    value: 110000,
    stage: "Signature",
    owner: "Maya Chen",
    nextAction: "Our signature",
    due: "Friday",
    crm: "Custom CRM",
    crmRecord: "VEN-1081",
    tags: ["Supplier", "Security", "DPA", "SOC 2"],
    updated: "2 days ago",
    department: "Security",
    risk: "Medium",
    approvalStatus: "Approved",
    signatureStatus: "Sent",
    effectiveDate: "Aug 20, 2026",
    expirationDate: "Aug 19, 2027",
  },
  {
    id: 7,
    party: "Nimbus Partners",
    initials: "NP",
    side: "Corporate",
    type: "Partnership Agreement",
    value: 350000,
    stage: "Review",
    owner: "Jon Bell",
    nextAction: "Tax review",
    due: "Monday",
    crm: "HubSpot",
    crmRecord: "Nimbus — Strategic alliance",
    tags: ["Corporate", "Partnership", "Exclusivity", "Revenue share"],
    updated: "3 days ago",
    department: "Strategy",
    risk: "High",
    approvalStatus: "Pending",
    signatureStatus: "Not sent",
    effectiveDate: "Sep 15, 2026",
    expirationDate: "Sep 14, 2028",
  },
  {
    id: 8,
    party: "Vale Talent",
    initials: "VT",
    side: "Corporate",
    type: "Recruiting Services Agreement",
    value: 42000,
    stage: "Intake",
    owner: "Iris Meyer",
    nextAction: "Assign legal owner",
    due: "Next week",
    crm: "None",
    crmRecord: "—",
    tags: ["Corporate", "People", "Contingent fee"],
    updated: "4 days ago",
    department: "People",
    risk: "Low",
    approvalStatus: "Not required",
    signatureStatus: "Not sent",
    effectiveDate: "",
    expirationDate: "",
  },
];

const seedAgreementIds = new Set(seedAgreements.map((agreement) => agreement.id));

function seedAgreementIdSubset(agreements: Agreement[]) {
  return new Set(agreements.filter((agreement) => seedAgreementIds.has(agreement.id)).map((agreement) => agreement.id));
}

function sameAgreementIds(left: ReadonlySet<number>, right: ReadonlySet<number>) {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function mergeAgreementIds(current: ReadonlySet<number>, incoming: ReadonlySet<number>) {
  if ([...incoming].every((id) => current.has(id))) return current;
  return new Set([...current, ...incoming]);
}

const seedClauses: ClauseBlock[] = [
  { id: 1, title: "Liability cap", category: "Risk", profile: "Standard", summary: "12 months of fees; standard carve-outs", language: "Each party’s aggregate liability will not exceed the fees paid or payable in the twelve months preceding the claim, except for fraud, willful misconduct, confidentiality, or infringement obligations.", uses: 84 },
  { id: 2, title: "Payment terms", category: "Commercial", profile: "Standard", summary: "Net 30; undisputed invoices", language: "Customer will pay all undisputed amounts within thirty (30) days after receipt of a valid invoice. The parties will work in good faith to resolve disputed amounts promptly.", uses: 112 },
  { id: 3, title: "Termination for convenience", category: "Termination", profile: "Fallback", summary: "30 days’ notice after initial term", language: "Following the Initial Term, either party may terminate this Agreement for convenience upon thirty (30) days’ prior written notice.", uses: 37 },
  { id: 4, title: "Security incident notice", category: "Data & security", profile: "Strict", summary: "Notice within 24 hours", language: "Provider will notify Customer without undue delay, and in no event later than twenty-four (24) hours, after confirming a Security Incident affecting Customer Data.", uses: 51 },
  { id: 5, title: "Mutual confidentiality", category: "Confidentiality", profile: "Standard", summary: "3 years; trade secrets survive", language: "Each party will protect the other party’s Confidential Information using at least reasonable care and will use it only to perform under this Agreement.", uses: 136 },
  { id: 6, title: "Auto-renewal notice", category: "Renewal", profile: "Standard", summary: "12-month renewal; 60-day notice", language: "This Agreement renews automatically for successive twelve-month terms unless either party gives written notice of non-renewal at least sixty (60) days before the end of the then-current term.", uses: 69 },
  { id: 7, title: "Data processing addendum", category: "Data & security", profile: "Standard", summary: "Controller/processor obligations", language: "Processor will process Personal Data only on documented instructions, maintain appropriate safeguards, and assist Controller with applicable data-subject and regulator requests.", uses: 74 },
  { id: 8, title: "Assignment", category: "Corporate", profile: "Fallback", summary: "Affiliate and change-of-control transfer", language: "Either party may assign this Agreement to an Affiliate or in connection with a merger, reorganization, or sale of substantially all relevant assets upon written notice.", uses: 42 },
];

const seedApprovals: Approval[] = [
  { id: "approval-1", agreementId: 1, role: "Legal", approver: "Maya Chen", status: "Pending", due: "Today", createdAt: "2026-08-01T08:40:00.000Z" },
  { id: "approval-2", agreementId: 2, role: "Finance", approver: "Jon Bell", status: "Pending", due: "Today", createdAt: "2026-08-01T08:15:00.000Z" },
  { id: "approval-3", agreementId: 7, role: "Tax", approver: "Elena Rossi", status: "Pending", due: "Monday", createdAt: "2026-07-31T15:20:00.000Z" },
  { id: "approval-4", agreementId: 3, role: "Revenue", approver: "Priya Shah", status: "Approved", due: "Completed", createdAt: "2026-07-31T10:00:00.000Z" },
];

const seedObligations: Obligation[] = [
  { id: "obligation-1", agreementId: 4, scheduleId: "evaluation-schedule-1", occurrenceNumber: 1, title: "Send non-renewal notice", dueDate: "Aug 28, 2026", owner: "Leon Wu", status: "Open", cadence: "Annual", source: "§ 8.2 Renewal", timezone: "America/Detroit", reminderLeadDays: [30, 7, 0], evaluationOnly: true },
  { id: "obligation-2", agreementId: 6, scheduleId: "evaluation-schedule-2", occurrenceNumber: 1, title: "Collect updated SOC 2 report", dueDate: "Sep 12, 2026", owner: "Maya Chen", status: "Open", cadence: "Annual", source: "Security Schedule § 4", timezone: "America/New_York", reminderLeadDays: [14, 0], evaluationOnly: true },
  { id: "obligation-3", agreementId: 1, scheduleId: "evaluation-schedule-3", occurrenceNumber: 2, title: "Confirm usage true-up", dueDate: "Oct 1, 2026", owner: "Priya Shah", status: "Open", cadence: "Quarterly", source: "Order Form § 3", timezone: "America/Los_Angeles", reminderLeadDays: [7, 0], evaluationOnly: true },
  { id: "obligation-4", agreementId: 2, scheduleId: "evaluation-schedule-4", occurrenceNumber: 1, title: "Review price uplift", dueDate: "Jun 30, 2026", owner: "Jon Bell", status: "Complete", cadence: "Annual", source: "Order Form § 5", timezone: "Etc/UTC", reminderLeadDays: [30, 0], completionEvidence: "Evaluation sample: pricing review recorded in FIN-204.", completedAt: "2026-06-18T14:00:00.000Z", evaluationOnly: true },
];

const seedObligationSchedules: ObligationSchedule[] = [
  { id: "evaluation-schedule-1", agreementId: 4, version: 1, title: "Send non-renewal notice", source: "§ 8.2 Renewal", owner: "Leon Wu", ownerUserId: null, timezone: "America/Detroit", recurrenceUnit: "year", recurrenceInterval: 1, anchorDate: "2026-08-28", endDate: null, reminderLeadDays: [30, 7, 0], status: "active", nextOccurrenceNumber: 2, nextOccurrenceDate: "2027-08-28", nextMaterializationDate: "2027-07-29", evaluationOnly: true },
  { id: "evaluation-schedule-2", agreementId: 6, version: 1, title: "Collect updated SOC 2 report", source: "Security Schedule § 4", owner: "Maya Chen", ownerUserId: "evaluation-owner-maya", timezone: "America/New_York", recurrenceUnit: "year", recurrenceInterval: 1, anchorDate: "2026-09-12", endDate: null, reminderLeadDays: [14, 0], status: "active", nextOccurrenceNumber: 2, nextOccurrenceDate: "2027-09-12", nextMaterializationDate: "2027-08-29", evaluationOnly: true },
  { id: "evaluation-schedule-3", agreementId: 1, version: 1, title: "Confirm usage true-up", source: "Order Form § 3", owner: "Priya Shah", ownerUserId: "evaluation-owner-priya", timezone: "America/Los_Angeles", recurrenceUnit: "month", recurrenceInterval: 3, anchorDate: "2026-07-01", endDate: null, reminderLeadDays: [7, 0], status: "active", nextOccurrenceNumber: 3, nextOccurrenceDate: "2027-01-01", nextMaterializationDate: "2026-12-25", evaluationOnly: true },
  { id: "evaluation-schedule-4", agreementId: 2, version: 1, title: "Review price uplift", source: "Order Form § 5", owner: "Jon Bell", ownerUserId: "evaluation-owner-jon", timezone: "Etc/UTC", recurrenceUnit: "year", recurrenceInterval: 1, anchorDate: "2026-06-30", endDate: null, reminderLeadDays: [30, 0], status: "active", nextOccurrenceNumber: 2, nextOccurrenceDate: "2027-06-30", nextMaterializationDate: "2027-05-31", evaluationOnly: true },
];

const seedObligationEvidence: ObligationEvidence[] = [
  { id: "evaluation-evidence-1", agreementId: 2, obligationId: "obligation-4", evidenceText: "Evaluation sample: pricing review recorded in FIN-204.", evidenceSha256: null, submittedByUserId: null, overrideReason: null, provenance: "evaluation", createdAt: "2026-06-18T14:00:00.000Z", evaluationOnly: true },
];

const seedEvents: AuditEvent[] = [
  { id: "event-1", agreementId: 1, type: "Redline", actor: "Sample counterparty counsel", detail: "Evaluation sample: proposed a 2× fees liability cap.", createdAt: "12 min ago" },
  { id: "event-2", agreementId: 1, type: "Comment", actor: "Maya Chen", detail: "Asked Finance to confirm the commercial exposure.", createdAt: "26 min ago" },
  { id: "event-3", agreementId: 1, type: "Version", actor: "Notice", detail: "Created version 4 from the counterparty draft.", createdAt: "Yesterday" },
  { id: "event-4", agreementId: 3, type: "Signature", actor: "Priya Shah", detail: "Signed on behalf of Acme, Inc.", createdAt: "1 hr ago" },
];

const sampleImportAnalysis: ImportAnalysis = {
  extractionMode: "Plain-text extraction",
  scanStatus: "evaluation-bypassed",
  tags: ["Sell-side", "MSA", "Auto-renew", "Delaware law", "Data terms", "Liability multiplier detected"],
  riskFlags: ["Liability language needs comparison with the workspace's approved position."],
  extracted: {
    side: "Sell-side",
    type: "Master Services Agreement",
    governingLaw: "Delaware",
    paymentTerms: "Net 30",
    renewalNotice: "60 days",
    counterparty: "Orchid Systems",
    agreementValue: "$168,000",
    effectiveDate: "August 15, 2026",
    expirationDate: "August 14, 2027",
    liabilityCap: "three times",
  },
};

const templatesBySide: Record<AgreementSide, string[]> = {
  "Sell-side": ["Master Services Agreement", "Order Form", "Mutual NDA", "Data Processing Addendum"],
  "Buy-side": ["Software Subscription Agreement", "Professional Services Agreement", "Supplier Services Agreement", "Data Processing Addendum"],
  Corporate: ["Employment Agreement", "Partnership Agreement", "Lease Amendment", "Board Consent"],
};

const templateDetails = [
  ["Master Services Agreement", "Sell-side", "Core commercial terms", "Commercial"],
  ["Order Form", "Sell-side", "Ordering and pricing terms", "Commercial"],
  ["Software Subscription Agreement", "Buy-side", "Subscription and security terms", "Procurement"],
  ["Professional Services Agreement", "Buy-side", "Scope and delivery terms", "Procurement"],
  ["Mutual NDA", "Corporate", "Mutual confidentiality terms", "Legal"],
  ["Employment Agreement", "Corporate", "Employment starter terms", "People"],
];

function normalizeAgreement(input: Partial<Agreement> & { id: number; party: string; type: string }): Agreement {
  const legacySide = input.side as string | undefined;
  const legacyStage = input.stage as string | undefined;
  const side: AgreementSide = legacySide === "Customer" ? "Sell-side" : legacySide === "Supplier" ? "Buy-side" : legacySide === "Corporate" ? "Corporate" : legacySide === "Buy-side" ? "Buy-side" : "Sell-side";
  const stage: Stage = legacyStage === "Internal review" ? "Review" : legacyStage === "Counterparty" ? "Negotiation" : stages.includes(legacyStage as Stage) ? legacyStage as Stage : "Draft";
  const party = input.party;
  const type = input.type;
  return {
    id: input.id,
    version: input.version ?? 1,
    party,
    initials: party === input.party && input.initials ? input.initials : party.split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase(),
    side,
    type,
    value: Number(input.value) || 0,
    valueMinor: Number.isSafeInteger(input.valueMinor) ? input.valueMinor : amountToMinor(Number(input.value) || 0, input.currencyCode ?? "USD") ?? 0,
    currencyCode: input.currencyCode?.toUpperCase() ?? "USD",
    stage,
    owner: input.owner ?? "Unassigned",
    ownerUserId: input.ownerUserId ?? null,
    primaryCounterpartyId: input.primaryCounterpartyId ?? null,
    legalEntityId: input.legalEntityId ?? null,
    governedTemplateVersionId: input.governedTemplateVersionId ?? null,
    workflowDefinitionId: input.workflowDefinitionId ?? null,
    nextAction: input.nextAction ?? "Review agreement",
    due: input.due ?? "This week",
    crm: input.crm ?? "None",
    crmRecord: input.crmRecord ?? "—",
    tags: input.tags ?? [side],
    updated: input.updated ?? "Recently",
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : "",
    department: input.department ?? "Legal",
    risk: input.risk ?? "Unassessed",
    approvalStatus: input.approvalStatus ?? "Not required",
    signatureStatus: input.signatureStatus ?? "Not sent",
    effectiveDate: input.effectiveDate ?? "",
    expirationDate: input.expirationDate ?? "",
  };
}

function parseMoney(value: string) {
  return Number(value.replace(/[^0-9.-]/g, "")) || 0;
}

function mergeById<T extends { id: string | number }>(saved: T[], seed: T[]) {
  return [...saved, ...seed.filter((seedItem) => !saved.some((savedItem) => savedItem.id === seedItem.id))];
}

function mergeAgreementPages(current: Agreement[], incoming: Agreement[]) {
  const merged = [...current];
  const indexes = new Map(merged.map((agreement, index) => [agreement.id, index]));
  for (const agreement of incoming) {
    const existingIndex = indexes.get(agreement.id);
    if (existingIndex === undefined) {
      indexes.set(agreement.id, merged.length);
      merged.push(agreement);
    } else {
      merged[existingIndex] = agreement;
    }
  }
  return merged;
}

const emptyAgreement = normalizeAgreement({ id: 0, party: "No agreement selected", type: "Agreement" });

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as { error?: string | { code?: string; message?: string } } & T;
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
    const code = typeof payload.error === "object" ? payload.error?.code ?? null : null;
    throw new ApiRequestError(message ?? `Request failed with HTTP ${response.status}`, response.status, code);
  }
  return payload;
}

async function requestText(url: string): Promise<string> {
  const response = await fetch(url);
  if (response.ok) return response.text();
  const payload = await response.json().catch(() => ({})) as { error?: string | { message?: string } };
  const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
  throw new Error(message ?? `Request failed with HTTP ${response.status}`);
}

class DocumentUploadRecoveryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DocumentUploadRecoveryError";
  }
}

class NegotiationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "NegotiationRequestError";
  }
}

async function requestNegotiation<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as {
    error?: string | { code?: string; message?: string };
    requestId?: string;
  } & T;
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
    const code = typeof payload.error === "object" ? payload.error?.code : undefined;
    throw new NegotiationRequestError(
      message ?? `The review exchange request failed with HTTP ${response.status}.`,
      response.status,
      code ?? "request_failed",
      payload.requestId ?? response.headers.get("x-request-id"),
    );
  }
  return payload;
}

function humanNegotiationError(error: unknown): string {
  if (!(error instanceof NegotiationRequestError)) {
    return error instanceof Error ? error.message : "The review exchange request could not be completed.";
  }
  const support = error.requestId ? ` Support reference: ${error.requestId}.` : "";
  if (error.status === 400) return `Check the required names, addresses, notes, and reviewed text, then try again. ${error.message}${support}`;
  if (error.status === 409) return `This contract changed or the action is no longer eligible. Refresh the current record and review it before trying again. ${error.message}${support}`;
  if (error.status === 410) return `The saved file or exchange link is no longer available. Do not reuse an old link; refresh the round or prepare a new one. ${error.message}${support}`;
  if (error.status === 413) return `The file or reviewed text is larger than the accepted limit. ${error.message}${support}`;
  if (error.status === 422 && error.code === "malware_detected") return `The scanner rejected the returned file and Notice recorded it as rejected. Keep it out of the working draft and request a safe replacement. ${error.message}${support}`;
  if (error.status === 422) return `The returned file was not accepted as a usable submission. Keep it out of the working draft and review the security guidance. ${error.message}${support}`;
  return `${error.message}${support}`;
}

function formatNegotiationTime(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function fileNameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  }
  return /filename="([^"]+)"/i.exec(value)?.[1] ?? null;
}

const urlViews: View[] = ["today", "portfolio", "agreements", "intake", "approvals", "signatures", "obligations", "repository", "library", "templates", "integrations", "admin", "workspace"];
const enterpriseSetupSections = new Set<EnterpriseSetupSection>(["readiness", "entities", "counterparties", "groups", "custom-fields", "templates", "workflows", "authorities", "intake-forms", "playbooks", "agents"]);

function parseEnterpriseSetupSection(search: string): EnterpriseSetupSection {
  const requested = new URLSearchParams(search).get("section") as EnterpriseSetupSection | null;
  return requested && enterpriseSetupSections.has(requested) ? requested : "readiness";
}

function parseNavigationSearch(search: string, agreements: Agreement[], fallbackSelectedId = agreements[0]?.id ?? 0): UrlNavigationState {
  const params = new URLSearchParams(search);
  const requestedView = params.get("view");
  const view = requestedView && urlViews.includes(requestedView as View) ? requestedView as View : "today";
  const requestedTab = params.get("tab");
  const workspaceTab = requestedTab && workspaceTabs.includes(requestedTab as WorkspaceTab) ? requestedTab as WorkspaceTab : "document";
  if (view !== "workspace") {
    return { view, selectedId: fallbackSelectedId, workspaceTab, valid: !requestedView || requestedView === view };
  }
  const requestedId = Number(params.get("agreement"));
  const agreement = Number.isSafeInteger(requestedId) && requestedId > 0
    ? agreements.find((item) => item.id === requestedId)
    : undefined;
  if (!agreement) {
    return { view: "agreements", selectedId: fallbackSelectedId, workspaceTab: "document", valid: false };
  }
  return {
    view,
    selectedId: agreement.id,
    workspaceTab,
    valid: Boolean(requestedTab ? requestedTab === workspaceTab : true),
  };
}

function navigationHref(state: Pick<UrlNavigationState, "view" | "selectedId" | "workspaceTab">, setupSection?: EnterpriseSetupSection) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", state.view);
  if (state.view === "admin") url.searchParams.set("section", setupSection ?? parseEnterpriseSetupSection(url.search));
  else url.searchParams.delete("section");
  if (state.view === "workspace" && state.selectedId > 0) {
    url.searchParams.set("agreement", String(state.selectedId));
    url.searchParams.set("tab", state.workspaceTab);
  } else {
    url.searchParams.delete("agreement");
    url.searchParams.delete("tab");
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function dateInputValue(value: string) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function todayIsoDate() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function detectedObligationTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
  } catch {
    return "Etc/UTC";
  }
}

function obligationCalendarDateInTimeZone(timeZone: string, instant = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (values.year && values.month && values.day) return `${values.year}-${values.month}-${values.day}`;
  } catch {
    // A stale browser value falls back to UTC; the server still validates IANA input.
  }
  return instant.toISOString().slice(0, 10);
}

function supportedObligationTimeZones() {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (!supportedValuesOf) return [];
  try {
    return supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

function obligationRecurrenceRule(choice: ObligationRecurrenceChoice) {
  if (choice === "week") return { unit: "week" as const, interval: 1 };
  if (choice === "month") return { unit: "month" as const, interval: 1 };
  if (choice === "quarter") return { unit: "month" as const, interval: 3 };
  if (choice === "year") return { unit: "year" as const, interval: 1 };
  return { unit: "once" as const, interval: 1 };
}

function obligationRecurrenceLabel(schedule?: Pick<ObligationSchedule, "recurrenceUnit" | "recurrenceInterval"> | null, fallback = "One-time") {
  if (!schedule) return fallback;
  if (schedule.recurrenceUnit === "once") return "One-time";
  if (schedule.recurrenceUnit === "week" && schedule.recurrenceInterval === 1) return "Weekly";
  if (schedule.recurrenceUnit === "month" && schedule.recurrenceInterval === 1) return "Monthly";
  if (schedule.recurrenceUnit === "month" && schedule.recurrenceInterval === 3) return "Quarterly";
  if (schedule.recurrenceUnit === "year" && schedule.recurrenceInterval === 1) return "Annual";
  return `Every ${schedule.recurrenceInterval} ${schedule.recurrenceUnit}${schedule.recurrenceInterval === 1 ? "" : "s"}`;
}

function obligationDateSortValue(value: string) {
  const normalized = dateInputValue(value);
  if (!normalized) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(`${normalized}T12:00:00`);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function obligationDateLabel(value: string) {
  const normalized = dateInputValue(value);
  if (!normalized) return value;
  const parsed = new Date(`${normalized}T12:00:00`);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(parsed);
}

function obligationIsOverdue(obligation: Obligation) {
  if (obligation.status !== "Open") return false;
  const normalized = dateInputValue(obligation.dueDate);
  return Boolean(normalized && normalized < obligationCalendarDateInTimeZone(obligation.timezone ?? "Etc/UTC"));
}

export default function Home() {
  const [view, setView] = useState<View>("today");
  const [returnView, setReturnView] = useState<ReturnView>("agreements");
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [registerAgreements, setRegisterAgreements] = useState<Agreement[]>([]);
  const [persistedSeedAgreementIds, setPersistedSeedAgreementIds] = useState<ReadonlySet<number>>(() => new Set());
  const [agreementTotalMatched, setAgreementTotalMatched] = useState(0);
  const [agreementSavedLoadedCount, setAgreementSavedLoadedCount] = useState(0);
  const [agreementNextCursor, setAgreementNextCursor] = useState<string | null>(null);
  const [agreementPageBusy, setAgreementPageBusy] = useState(false);
  const [agreementPageError, setAgreementPageError] = useState("");
  const [agreementLoadedQueryKey, setAgreementLoadedQueryKey] = useState(agreementListKey(defaultAgreementListControls));
  const [workspaceAgreementTotalMatched, setWorkspaceAgreementTotalMatched] = useState(0);
  const [workspaceAgreementSavedLoadedCount, setWorkspaceAgreementSavedLoadedCount] = useState(0);
  const [workspaceAgreementHasMore, setWorkspaceAgreementHasMore] = useState(false);
  const [selectedId, setSelectedId] = useState(0);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("document");
  const [sideFilter, setSideFilter] = useState<"All" | AgreementSide>("All");
  const [stageFilter, setStageFilter] = useState<"All" | Stage>("All");
  const [riskFilter, setRiskFilter] = useState<"All" | Risk>("All");
  const [sort, setSort] = useState<AgreementListSort>("Updated");
  const [agreementQuery, setAgreementQuery] = useState("");
  const [globalQuery, setGlobalQuery] = useState("");
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newCreateBusy, setNewCreateBusy] = useState(false);
  const [newCreationRecoveryLocked, setNewCreationRecoveryLocked] = useState(false);
  const [newStep, setNewStep] = useState(1);
  const [newSide, setNewSide] = useState<AgreementSide>("Sell-side");
  const [newParty, setNewParty] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newCurrency, setNewCurrency] = useState("USD");
  const [newTemplate, setNewTemplate] = useState("Master Services Agreement");
  const [newGovernedTemplateVersionId, setNewGovernedTemplateVersionId] = useState("");
  const [newWorkflowDefinitionId, setNewWorkflowDefinitionId] = useState("");
  const [newOwnerUserId, setNewOwnerUserId] = useState("");
  const [newPrimaryCounterpartyId, setNewPrimaryCounterpartyId] = useState("");
  const [newLegalEntityId, setNewLegalEntityId] = useState("");
  const [newTemplateVariables, setNewTemplateVariables] = useState<Record<string, string>>({});
  const [newCrm, setNewCrm] = useState<Agreement["crm"]>("None");
  const [newDepartment, setNewDepartment] = useState("Sales");
  const [newOwner, setNewOwner] = useState("Current user");
  const [newLaw, setNewLaw] = useState("New York");
  const [importOpen, setImportOpen] = useState(false);
  const [importUploadBusy, setImportUploadBusy] = useState(false);
  const [importCreateBusy, setImportCreateBusy] = useState(false);
  const [importCreationRecoveryLocked, setImportCreationRecoveryLocked] = useState(false);
  const [importStep, setImportStep] = useState<"drop" | "scan" | "review">("drop");
  const [importName, setImportName] = useState("");
  const [importAnalysis, setImportAnalysis] = useState<ImportAnalysis>(sampleImportAnalysis);
  const [importError, setImportError] = useState("");
  const [signOpen, setSignOpen] = useState(false);
  const [signatureReview, setSignatureReview] = useState<{ agreementId: number; packetId: string } | null>(null);
  const [signatureReviewReason, setSignatureReviewReason] = useState("");
  const [signatureReviewConfirmed, setSignatureReviewConfirmed] = useState(false);
  const [signatureReviewBusy, setSignatureReviewBusy] = useState(false);
  const [evaluationSigningReady, setEvaluationSigningReady] = useState(false);
  const [clauses, setClauses] = useState<ClauseBlock[]>([]);
  const [clauseOpen, setClauseOpen] = useState(false);
  const [clauseTitle, setClauseTitle] = useState("Service credit remedy");
  const [clauseText, setClauseText] = useState("If monthly availability falls below the applicable service level, Customer may claim the service credits stated in the Order Form as a non-exclusive remedy.");
  const [clauseProfile, setClauseProfile] = useState<ClauseBlock["profile"]>("Standard");
  const [clauseQuery, setClauseQuery] = useState("");
  const [libraryCollection, setLibraryCollection] = useState("All language");
  const [showRedlines, setShowRedlines] = useState(true);
  const [editing, setEditing] = useState(false);
  const [documentEditText, setDocumentEditText] = useState("");
  const [documentEditBaseText, setDocumentEditBaseText] = useState("");
  const [draftDecisionOpen, setDraftDecisionOpen] = useState(false);
  const [draftDecisionBusy, setDraftDecisionBusy] = useState(false);
  const [negotiationDraftDirty, setNegotiationDraftDirty] = useState(false);
  const [negotiationDecisionOpen, setNegotiationDecisionOpen] = useState(false);
  const [documentDrafts, setDocumentDrafts] = useState<Record<number, DraftLoadState>>({});
  const [workflowBasisByAgreement, setWorkflowBasisByAgreement] = useState<Record<number, WorkflowBasis | null>>({});
  const [sourceDocumentsByAgreement, setSourceDocumentsByAgreement] = useState<Record<number, SourceDocumentSummary[]>>({});
  const [documentReloadToken, setDocumentReloadToken] = useState(0);
  const [changeStatusByAgreement, setChangeStatusByAgreement] = useState<Record<number, Record<number, ChangeStatus>>>({});
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [approvalDecision, setApprovalDecision] = useState<{ approval: Approval; status: ApprovalDecisionStatus } | null>(null);
  const [approvalDecisionReason, setApprovalDecisionReason] = useState("");
  const [approvalDecisionConfirmed, setApprovalDecisionConfirmed] = useState(false);
  const [approvalDecisionBusy, setApprovalDecisionBusy] = useState(false);
  const [signaturePackets, setSignaturePackets] = useState<SignaturePacket[]>([]);
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [obligationSchedules, setObligationSchedules] = useState<ObligationSchedule[]>([]);
  const [obligationEvidence, setObligationEvidence] = useState<ObligationEvidence[]>([]);
  const [eligibleObligationOwners, setEligibleObligationOwners] = useState<EligibleObligationOwner[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [comment, setComment] = useState("");
  const [connections, setConnections] = useState({ HubSpot: false, Salesforce: false, "Custom CRM": false });
  const [integrationPanel, setIntegrationPanel] = useState<"HubSpot" | "Salesforce" | "Custom CRM" | null>(null);
  const [obligationFilter, setObligationFilter] = useState<"Open" | "Complete" | "All">("Open");
  const [obligationOpen, setObligationOpen] = useState(false);
  const [obligationAgreementId, setObligationAgreementId] = useState(0);
  const [obligationTitle, setObligationTitle] = useState("");
  const [obligationDue, setObligationDue] = useState("");
  const [obligationSource, setObligationSource] = useState("");
  const [obligationOwnerUserId, setObligationOwnerUserId] = useState("");
  const [obligationRecurrence, setObligationRecurrence] = useState<ObligationRecurrenceChoice>("once");
  const [obligationTimeZone, setObligationTimeZone] = useState(() => detectedObligationTimeZone());
  const [obligationReminderLeadDays, setObligationReminderLeadDays] = useState<number[]>([7, 0]);
  const [obligationEndDate, setObligationEndDate] = useState("");
  const [obligationCreateConfirmed, setObligationCreateConfirmed] = useState(false);
  const [obligationCreateBusy, setObligationCreateBusy] = useState(false);
  const [obligationCreationRecoveryLocked, setObligationCreationRecoveryLocked] = useState(false);
  const [obligationCompletion, setObligationCompletion] = useState<Obligation | null>(null);
  const [obligationCompletionEvidence, setObligationCompletionEvidence] = useState("");
  const [obligationOverrideReason, setObligationOverrideReason] = useState("");
  const [obligationCompletionConfirmed, setObligationCompletionConfirmed] = useState(false);
  const [obligationCompletionBusy, setObligationCompletionBusy] = useState(false);
  const [obligationEvidenceReview, setObligationEvidenceReview] = useState<ObligationEvidence | null>(null);
  const [obligationScheduleManagement, setObligationScheduleManagement] = useState<ObligationSchedule | null>(null);
  const [obligationScheduleAction, setObligationScheduleAction] = useState<"reassign" | "pause" | "resume" | "end">("reassign");
  const [obligationScheduleOwnerUserId, setObligationScheduleOwnerUserId] = useState("");
  const [obligationScheduleReason, setObligationScheduleReason] = useState("");
  const [obligationScheduleConfirmed, setObligationScheduleConfirmed] = useState(false);
  const [obligationScheduleBusy, setObligationScheduleBusy] = useState(false);
  const [detailsDraft, setDetailsDraft] = useState<Agreement>(emptyAgreement);
  const [riskAssessmentLevel, setRiskAssessmentLevel] = useState<Exclude<Risk, "Unassessed">>("Low");
  const [riskAssessmentRationale, setRiskAssessmentRationale] = useState("");
  const [riskAssessmentConfirmed, setRiskAssessmentConfirmed] = useState(false);
  const [riskAssessmentBusy, setRiskAssessmentBusy] = useState(false);
  const [session, setSession] = useState<SessionData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [optionalLoadErrors, setOptionalLoadErrors] = useState<string[]>([]);
  const [optionalLoading, setOptionalLoading] = useState(false);
  const [optionalReloadToken, setOptionalReloadToken] = useState(0);
  const [completionEvidence, setCompletionEvidence] = useState("");
  const [signatureParties, setSignatureParties] = useState<SignaturePartyInput[]>([{ role: "Counterparty", name: "", email: "" }]);
  const [signatureProviderRoles, setSignatureProviderRoles] = useState<string[]>([]);
  const [readiness, setReadiness] = useState<ReadinessData | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [publishedTemplates, setPublishedTemplates] = useState<PublishedTemplate[]>([]);
  const [enterpriseLegalEntities, setEnterpriseLegalEntities] = useState<EnterpriseLegalEntity[]>([]);
  const [enterpriseCounterparties, setEnterpriseCounterparties] = useState<EnterpriseCounterparty[]>([]);
  const [enterpriseWorkflows, setEnterpriseWorkflows] = useState<EnterpriseWorkflow[]>([]);
  const [enterpriseChoicesLoading, setEnterpriseChoicesLoading] = useState(false);
  const [enterpriseChoicesError, setEnterpriseChoicesError] = useState("");
  const [enterpriseSetupSection, setEnterpriseSetupSection] = useState<EnterpriseSetupSection>("readiness");
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [crmResyncCandidates, setCrmResyncCandidates] = useState<CrmResyncCandidate[]>([]);
  const [crmResyncAction, setCrmResyncAction] = useState<CrmResyncAction>("projection");
  const [crmResyncAgreementId, setCrmResyncAgreementId] = useState(0);
  const [crmResyncNextCursor, setCrmResyncNextCursor] = useState<string | null>(null);
  const [crmResyncReason, setCrmResyncReason] = useState("Approved CRM reconciliation or cleanup");
  const [crmLegacyCleanupConfirmed, setCrmLegacyCleanupConfirmed] = useState(false);
  const [crmLegacyCleanupConfirmation, setCrmLegacyCleanupConfirmation] = useState("");
  const [crmHistoricalCleanupConfirmed, setCrmHistoricalCleanupConfirmed] = useState(false);
  const [crmHistoricalCleanupConfirmation, setCrmHistoricalCleanupConfirmation] = useState("");
  const [crmResyncBusy, setCrmResyncBusy] = useState(false);
  const [crmResyncPageBusy, setCrmResyncPageBusy] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [adminLoading, setAdminLoading] = useState(false);
  const [agentPrincipals, setAgentPrincipals] = useState<AgentPrincipal[]>([]);
  const [agentGrants, setAgentGrants] = useState<AgentGrant[]>([]);
  const [agentPlans, setAgentPlans] = useState<AgentPlanSummary[]>([]);
  const [agentPlanNextCursor, setAgentPlanNextCursor] = useState<string | null>(null);
  const [agentAdminBusy, setAgentAdminBusy] = useState(false);
  const [agentPlanPageBusy, setAgentPlanPageBusy] = useState(false);
  const [agentPrincipalName, setAgentPrincipalName] = useState("");
  const [agentPrincipalCommonName, setAgentPrincipalCommonName] = useState("");
  const [agentGrantPrincipalId, setAgentGrantPrincipalId] = useState("");
  const [agentGrantAgreementId, setAgentGrantAgreementId] = useState(0);
  const [agentGrantAction, setAgentGrantAction] = useState<AgentActionId>("agreement.read");
  const [agentGrantDays, setAgentGrantDays] = useState(7);
  const [agentAdminReason, setAgentAdminReason] = useState("Administrative agent-governance review");
  const [agentReviewPlan, setAgentReviewPlan] = useState<AgentPlanDetail | null>(null);
  const [agentReviewBusy, setAgentReviewBusy] = useState(false);
  const [agentReviewReason, setAgentReviewReason] = useState("");
  const [agentReviewConfirmed, setAgentReviewConfirmed] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<SessionData["role"]>("requester");
  const [identityReplacementMember, setIdentityReplacementMember] = useState<WorkspaceMember | null>(null);
  const [replacementIdentitySubject, setReplacementIdentitySubject] = useState("");
  const [replacementConfirmationEmail, setReplacementConfirmationEmail] = useState("");
  const [retentionPolicy, setRetentionPolicy] = useState<RetentionPolicy | null>(null);
  const [retentionReason, setRetentionReason] = useState("Records policy review");
  const [todayLabel] = useState(() => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date()).toUpperCase());
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [compactNavigation, setCompactNavigation] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userMenuButtonRef = useRef<HTMLButtonElement>(null);
  const contractRef = useRef<HTMLElement>(null);
  const mobileNavigationRef = useRef<HTMLElement>(null);
  const mobileMenuRef = useRef<HTMLButtonElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const mobileNavWasOpenRef = useRef(false);
  const urlNavigationReadyRef = useRef(false);
  const urlHistoryModeRef = useRef<"push" | "replace">("replace");
  const loadedSavedAgreementsRef = useRef<Agreement[]>([]);
  const registerSavedAgreementsRef = useRef<Agreement[]>([]);
  const isEvaluationAgreement = useCallback((id: number) => session?.mode === "evaluation"
    && !persistedSeedAgreementIds.has(id)
    && seedAgreementIds.has(id), [persistedSeedAgreementIds, session?.mode]);
  const agreementListControlsRef = useRef<AgreementListControls>(defaultAgreementListControls);
  const agreementCursorRef = useRef<string | null>(null);
  const agreementPageInFlightRef = useRef(false);
  const agreementPageRequestRef = useRef(0);
  const workspaceAgreementRequestRef = useRef(0);
  const pendingDraftActionRef = useRef<(() => void) | null>(null);
  const pendingNegotiationActionRef = useRef<(() => void) | null>(null);
  const openGeneratorActionRef = useRef<() => void>(() => undefined);
  const newCreateInFlightRef = useRef(false);
  const importCreateInFlightRef = useRef(false);
  const importUploadInFlightRef = useRef(false);
  const newCreationKeyRef = useRef("");
  const importCreationKeyRef = useRef("");
  const obligationCreationKeyRef = useRef("");
  const newCreationBodyRef = useRef("");
  const importCreationBodyRef = useRef("");
  const obligationCreationBodyRef = useRef("");
  const obligationCreateInFlightRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);

  const crmResyncEligibleCandidates = crmResyncCandidates.filter((candidate) =>
    candidate.eligibleActions.includes(crmResyncAction));
  const selectedCrmResyncCandidate = crmResyncCandidates.find((candidate) =>
    candidate.id === crmResyncAgreementId && candidate.eligibleActions.includes(crmResyncAction));
  const historicalCleanupConfirmationRequired = crmResyncAction === "tombstone"
    && selectedCrmResyncCandidate?.historicalCleanup === true;
  const crmResyncBlockedReasons = [...new Set(crmResyncCandidates
    .map((candidate) => candidate.resyncBlockedReason)
    .filter((reason): reason is string => Boolean(reason)))];
  const currentCrmIntegration = integrations.find((integration) => integration.id === "crm");
  const crmResyncReady = crmResyncAction === "legacy_cleanup_attestation"
    ? crmLegacyCleanupConfirmed && crmLegacyCleanupConfirmation === CRM_LEGACY_CLEANUP_CONFIRMATION
    : currentCrmIntegration?.configured === true
      && currentCrmIntegration.lastTest?.status === "passed"
      && (!historicalCleanupConfirmationRequired || (
        crmHistoricalCleanupConfirmed
        && crmHistoricalCleanupConfirmation === CRM_HISTORICAL_CLEANUP_CONFIRMATION
      ));
  const selected = agreements.find((agreement) => agreement.id === selectedId) ?? agreements[0] ?? emptyAgreement;
  const selectedSignaturePacket = signaturePackets.find((packet) => packet.agreementId === selected.id);
  const selectedSignatureInFlight = selectedSignaturePacket
    ? new Set(["creating", "pending", "partially_signed", "reconciling", "archived", "completed_review_required"]).has(selectedSignaturePacket.status)
    : selected.signatureStatus === "Sent" || selected.signatureStatus === "Partially signed";
  const selectedSignatureNeedsHumanReview = selectedSignaturePacket?.status === "completed_review_required";
  const selectedSignatureNeedsRecovery = Boolean(selectedSignaturePacket && (
    selectedSignaturePacket.status === "creating" ||
    (selectedSignaturePacket.status === "pending" && !new Set(["Sent", "Partially signed", "Completed"]).has(selected.signatureStatus))
  ));
  const selectedSignatureCanRefresh = Boolean(selectedSignaturePacket && new Set(["creating", "pending", "partially_signed", "reconciling", "archived"]).has(selectedSignaturePacket.status));
  const selectedSignatureCanBeAbandoned = Boolean(
    selectedSignaturePacket &&
    selectedSignaturePacket.status === "creating"
  );
  const selectedSignatureCanBeSuperseded = selectedSignaturePacket?.status === "archived";
  const selectedDraft = documentDrafts[selected.id];
  const selectedWorkflowBasis = workflowBasisByAgreement[selected.id] ?? null;
  const sessionMode = session?.mode;
  const selectedIsSeedEvaluation = isEvaluationAgreement(selected.id);
  const selectedDraftPending = Boolean(sessionMode && selected.id > 0 && !selectedIsSeedEvaluation && (!selectedDraft || selectedDraft.status === "loading"));
  const selectedHasImportedSource = selected.tags.includes("Imported source");
  const selectedNeedsWorkingCopy = !selectedIsSeedEvaluation && selectedDraft?.status === "none";
  const selectedSourceDocuments = sourceDocumentsByAgreement[selected.id] ?? [];
  const selectedChangeStatus: Record<number, ChangeStatus> = changeStatusByAgreement[selected.id]
    ?? (selectedIsSeedEvaluation && selected.id === 1 ? { 1: "open", 2: "open" } : {});
  const documentDirty = editing && documentEditText !== documentEditBaseText;
  const visibleDocumentContent = editing ? documentEditText : selectedDraft?.status === "ready" ? selectedDraft.content : "";
  const insertedClauses = clauses.filter((clause) => visibleDocumentContent.includes(clause.language)).map((clause) => clause.id);
  const hasStructuredChanges = Object.keys(selectedChangeStatus).length > 0;
  const openChanges = Object.values(selectedChangeStatus).filter((status) => status === "open").length;
  const pendingApprovals = approvals.filter((approval) => approval.status === "Pending").length;
  const activeObligations = obligations.filter((obligation) => obligation.status === "Open").length;
  const obligationScheduleById = useMemo(() => new Map(obligationSchedules.map((schedule) => [schedule.id, schedule])), [obligationSchedules]);
  const obligationEvidenceByOccurrence = useMemo(() => new Map(obligationEvidence.map((evidence) => [evidence.obligationId, evidence])), [obligationEvidence]);
  const sortedObligations = useMemo(() => [...obligations].sort((left, right) => {
    if (left.status !== right.status) return left.status === "Open" ? -1 : 1;
    const dueDifference = obligationDateSortValue(left.dueDate) - obligationDateSortValue(right.dueDate);
    if (dueDifference !== 0) return dueDifference;
    return (left.occurrenceNumber ?? 1) - (right.occurrenceNumber ?? 1);
  }), [obligations]);
  const overdueObligations = obligations.filter(obligationIsOverdue).length;
  const activeObligationSchedules = obligationSchedules.filter((schedule) => schedule.status === "active").length;
  const evidencedCompletions = obligations.filter((obligation) => obligation.status === "Complete" && (
    obligationEvidenceByOccurrence.has(obligation.id) || Boolean(obligation.completionEvidence)
  )).length;
  const managedScheduleOwnerEligible = Boolean(obligationScheduleManagement?.ownerUserId && eligibleObligationOwners.some(
    (owner) => owner.userId === obligationScheduleManagement.ownerUserId,
  ));
  const obligationTimeZoneOptions = useMemo(() => Array.from(new Set([
    obligationTimeZone,
    detectedObligationTimeZone(),
    "Etc/UTC",
    ...supportedObligationTimeZones(),
    "America/Detroit",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Paris",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Australia/Sydney",
  ])), [obligationTimeZone]);
  const permissions = new Set(session?.permissions ?? []);
  const canCreateAgreement = permissions.has("agreement:create");
  const canUpdateAgreement = permissions.has("agreement:update");
  const canRequestApprovals = permissions.has("approval:request");
  const canDecideApprovals = permissions.has("approval:decide");
  const canAssessRisk = permissions.has("risk:assess");
  const canWriteObligations = permissions.has("obligation:write");
  const canFulfillObligations = permissions.has("obligation:fulfill");
  const canWriteLanguage = permissions.has("language:write");
  const canReadDocuments = permissions.has("document:read");
  const canUploadDocuments = permissions.has("document:upload");
  const canManageDocuments = permissions.has("document:manage");
  const canAppendAudit = permissions.has("audit:append");
  const canReadAudit = permissions.has("audit:read");
  const canSendNotifications = permissions.has("notification:send");
  const canManageWorkspace = permissions.has("workspace:admin");
  const canManageIntegrations = permissions.has("integration:manage");
  const canImportAgreement = canCreateAgreement && canUploadDocuments;
  const canReviewCompletedSignature = canUpdateAgreement && canManageDocuments && (session?.role === "legal" || session?.role === "admin");
  const signatureReviewPacket = signatureReview
    ? signaturePackets.find((packet) => packet.id === signatureReview.packetId && packet.agreementId === signatureReview.agreementId)
    : undefined;
  const signatureReviewAgreement = signatureReview
    ? agreements.find((agreement) => agreement.id === signatureReview.agreementId)
    : undefined;
  const signatureReviewBasisComplete = Boolean(
    signatureReviewPacket?.status === "completed_review_required"
    && signatureReviewPacket.basisHash
    && signatureReviewPacket.documentVersion
    && signatureReviewPacket.documentSha256
    && signatureReviewPacket.evidenceDocumentId
    && signatureReviewPacket.finalArtifactSha256,
  );
  const canResolveChanges = canUpdateAgreement && canAppendAudit;
  const detailsDirty = detailsDraft.id === selected.id && (
    detailsDraft.party !== selected.party
    || detailsDraft.type !== selected.type
    || detailsDraft.side !== selected.side
    || detailsDraft.department !== selected.department
    || detailsDraft.value !== selected.value
    || detailsDraft.valueMinor !== selected.valueMinor
    || detailsDraft.currencyCode !== selected.currencyCode
    || detailsDraft.owner !== selected.owner
    || detailsDraft.ownerUserId !== selected.ownerUserId
    || detailsDraft.primaryCounterpartyId !== selected.primaryCounterpartyId
    || detailsDraft.legalEntityId !== selected.legalEntityId
    || detailsDraft.governedTemplateVersionId !== selected.governedTemplateVersionId
    || detailsDraft.workflowDefinitionId !== selected.workflowDefinitionId
    || detailsDraft.effectiveDate !== selected.effectiveDate
    || detailsDraft.expirationDate !== selected.expirationDate
    || detailsDraft.crm !== selected.crm
    || detailsDraft.crmRecord !== selected.crmRecord
  );
  const selectedStageIndex = stages.indexOf(selected.stage);
  const workspacePrimaryAction = deriveWorkspaceAction({
    stage: selected.stage,
    nextAction: selected.nextAction,
    approvalStatus: selected.approvalStatus,
    openChanges,
    canRequestApprovals,
    canUpdateAgreement,
    signatureInFlight: selectedSignatureInFlight,
    nextStage: selectedStageIndex >= 0 && selectedStageIndex < stages.length - 1 ? stages[selectedStageIndex + 1] : null,
  });
  const integrationStatusKnown = canManageIntegrations && integrations.length > 0;
  const stageCounts = stages.map((stage) => agreements.filter((agreement) => agreement.stage === stage).length);
  const largestStageCount = Math.max(1, ...stageCounts);
  const agreementEstatePartial = agreementNextCursor !== null || agreementSavedLoadedCount < agreementTotalMatched;
  const workspaceAgreementEstatePartial = workspaceAgreementHasMore || workspaceAgreementSavedLoadedCount < workspaceAgreementTotalMatched;
  const evaluationAgreementSampleCount = session?.mode === "evaluation"
    ? agreements.filter((agreement) => seedAgreementIds.has(agreement.id) && !persistedSeedAgreementIds.has(agreement.id)).length
    : 0;
  const agreementMetricScope = workspaceAgreementEstatePartial
    ? `Loaded workspace records · ${workspaceAgreementSavedLoadedCount} of ${workspaceAgreementTotalMatched} saved agreements`
    : evaluationAgreementSampleCount > 0
      ? `All saved records + ${evaluationAgreementSampleCount} browser samples`
      : "Full saved register";
  const agreementListControls = useMemo<AgreementListControls>(() => ({
    q: agreementQuery,
    side: sideFilter,
    stage: stageFilter,
    risk: riskFilter,
    sort,
  }), [agreementQuery, riskFilter, sideFilter, sort, stageFilter]);
  const agreementCurrentQueryKey = agreementListKey(agreementListControls);
  const agreementRegisterCurrent = agreementCurrentQueryKey === agreementLoadedQueryKey;
  const registerEvaluationSampleCount = session?.mode === "evaluation"
    ? registerAgreements.filter((agreement) => seedAgreementIds.has(agreement.id) && !persistedSeedAgreementIds.has(agreement.id)).length
    : 0;

  const filtered = useMemo(() => {
    if (!agreementRegisterCurrent) return [];
    return visibleAgreementRows(registerAgreements, agreementListControls);
  }, [agreementListControls, agreementRegisterCurrent, registerAgreements]);

  const globalResults = useMemo(() => {
    const q = globalQuery.trim().toLowerCase();
    if (!q) return agreements.slice(0, 5);
    return agreements.filter((agreement) => [agreement.party, agreement.type, agreement.owner, agreement.department, agreement.crm, agreement.stage, agreement.side, ...agreement.tags].join(" ").toLowerCase().includes(q)).slice(0, 7);
  }, [agreements, globalQuery]);

  const filteredClauses = useMemo(() => {
    const q = clauseQuery.toLowerCase().trim();
    return clauses.filter((clause) => {
      const collectionMatch = libraryCollection === "All language" || clause.category === libraryCollection;
      const queryMatch = !q || [clause.title, clause.category, clause.profile, clause.summary, clause.language].join(" ").toLowerCase().includes(q);
      return collectionMatch && queryMatch;
    });
  }, [clauseQuery, clauses, libraryCollection]);

  useEffect(() => {
    let alive = true;
    async function loadCoreWorkspace() {
      try {
        const sessionPayload = await requestJson<SessionData>("/api/session");
        const agreementPayload = await requestJson<AgreementPagePayload>("/api/agreements");
        if (!alive) return;
        setSession(sessionPayload);
        setNewOwner(sessionPayload.user.displayName);
        setNewOwnerUserId(sessionPayload.user.id);
        setEnterpriseSetupSection(parseEnterpriseSetupSection(window.location.search));
        const savedAgreements = mergeAgreementPages([], (agreementPayload.agreements ?? []).map((agreement) => normalizeAgreement(agreement)));
        const totalMatched = Number.isSafeInteger(agreementPayload.totalMatched) && (agreementPayload.totalMatched ?? -1) >= 0
          ? Math.max(agreementPayload.totalMatched ?? 0, savedAgreements.length)
          : savedAgreements.length;
        const nextCursor = agreementPayload.hasMore === true && typeof agreementPayload.nextCursor === "string" && agreementPayload.nextCursor
          ? agreementPayload.nextCursor
          : null;
        agreementPageRequestRef.current += 1;
        agreementPageInFlightRef.current = false;
        loadedSavedAgreementsRef.current = savedAgreements;
        setPersistedSeedAgreementIds(seedAgreementIdSubset(savedAgreements));
        registerSavedAgreementsRef.current = savedAgreements;
        agreementListControlsRef.current = defaultAgreementListControls;
        agreementCursorRef.current = nextCursor;
        setAgreementSavedLoadedCount(savedAgreements.length);
        setAgreementTotalMatched(totalMatched);
        setAgreementNextCursor(nextCursor);
        setAgreementLoadedQueryKey(agreementListKey(defaultAgreementListControls));
        setWorkspaceAgreementSavedLoadedCount(savedAgreements.length);
        setWorkspaceAgreementTotalMatched(totalMatched);
        setWorkspaceAgreementHasMore(agreementPayload.hasMore === true);
        setAgreementPageBusy(false);
        setAgreementPageError(agreementPayload.hasMore === true && !nextCursor
          ? "More saved agreements exist, but this page did not include a continuation cursor. Reload the register before relying on portfolio totals."
          : "");
        const agreementRows = sessionPayload.mode === "evaluation" ? mergeById(savedAgreements, seedAgreements) : savedAgreements;
        setRegisterAgreements(visibleAgreementRows(agreementRows, defaultAgreementListControls));
        const urlNavigation = parseNavigationSearch(window.location.search, agreementRows);
        urlHistoryModeRef.current = "replace";
        urlNavigationReadyRef.current = true;
        setAgreements(agreementRows);
        setView(urlNavigation.view);
        setWorkspaceTab(urlNavigation.workspaceTab);
        if (urlNavigation.view === "workspace") setReturnView("agreements");
        const initialAgreement = agreementRows.find((item) => item.id === urlNavigation.selectedId) ?? agreementRows[0];
        if (initialAgreement) {
          selectAgreementState(initialAgreement);
          setObligationAgreementId(agreementRows.find((item) => item.stage === "Active")?.id ?? agreementRows[0].id);
        }
      } catch (error) {
        if (alive) setLoadError(error instanceof Error ? error.message : "Workspace data could not be loaded.");
      } finally {
        if (alive) setLoading(false);
      }
    }
    void loadCoreWorkspace();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!session) return;
    for (const storageKey of [GENERATED_CREATION_RECOVERY_KEY, IMPORTED_CREATION_RECOVERY_KEY, OBLIGATION_CREATION_RECOVERY_KEY]) {
      try {
        const raw = window.sessionStorage.getItem(storageKey);
        if (!raw) continue;
        const recovery = JSON.parse(raw) as { workspaceId?: string; userId?: string };
        if (recovery.workspaceId !== session.workspace.id || recovery.userId !== session.user.id) {
          window.sessionStorage.removeItem(storageKey);
        }
      } catch {
        try { window.sessionStorage.removeItem(storageKey); } catch { /* Storage may be unavailable. */ }
      }
    }
  }, [session]);

  useEffect(() => {
    if (!sessionMode) return;
    let alive = true;
    async function loadOptionalWorkspaceData() {
      setOptionalLoading(true);
      const [languageResult, operationResult, signatureResult] = await Promise.allSettled([
        requestJson<{ languageBlocks: ClauseBlock[] }>("/api/language-blocks"),
        requestJson<OperationsPayload>("/api/operations"),
        requestJson<{ signaturePackets: SignaturePacket[] }>("/api/signatures"),
      ]);
      if (!alive) return;
      const failures: string[] = [];
      if (languageResult.status === "fulfilled") {
        setClauses(sessionMode === "evaluation" ? mergeById(languageResult.value.languageBlocks ?? [], seedClauses) : languageResult.value.languageBlocks ?? []);
      } else failures.push("approved language");
      if (operationResult.status === "fulfilled") {
        setApprovals(sessionMode === "evaluation" ? mergeById(operationResult.value.approvals ?? [], seedApprovals.filter((item) => isEvaluationAgreement(item.agreementId))) : operationResult.value.approvals ?? []);
        setObligations(sessionMode === "evaluation" ? mergeById(operationResult.value.obligations ?? [], seedObligations.filter((item) => isEvaluationAgreement(item.agreementId))) : operationResult.value.obligations ?? []);
        setObligationSchedules(sessionMode === "evaluation" ? mergeById(operationResult.value.obligationSchedules ?? [], seedObligationSchedules.filter((item) => isEvaluationAgreement(item.agreementId))) : operationResult.value.obligationSchedules ?? []);
        setObligationEvidence(sessionMode === "evaluation" ? mergeById(operationResult.value.obligationEvidence ?? [], seedObligationEvidence.filter((item) => isEvaluationAgreement(item.agreementId))) : operationResult.value.obligationEvidence ?? []);
        const loadedOwners = operationResult.value.eligibleObligationOwners ?? [];
        const evaluationOwner = sessionMode === "evaluation" && session && !loadedOwners.some((owner) => owner.userId === session.user.id)
          ? [{ userId: session.user.id, displayName: session.user.displayName, role: session.role }]
          : [];
        setEligibleObligationOwners([...loadedOwners, ...evaluationOwner]);
        setEvents(sessionMode === "evaluation" ? mergeById(operationResult.value.events ?? [], seedEvents.filter((item) => isEvaluationAgreement(item.agreementId))) : operationResult.value.events ?? []);
      } else failures.push("approvals, tasks, and history");
      if (signatureResult.status === "fulfilled") setSignaturePackets(signatureResult.value.signaturePackets ?? []);
      else failures.push("signature status");
      setOptionalLoadErrors(failures);
      setOptionalLoading(false);
    }
    void loadOptionalWorkspaceData();
    return () => { alive = false; };
  }, [isEvaluationAgreement, optionalReloadToken, session, sessionMode]);

  useEffect(() => {
    if (!sessionMode || !selected.id || !canReadDocuments || isEvaluationAgreement(selected.id)) return;
    let alive = true;

    async function loadLatestDocumentVersion() {
      setDocumentDrafts((current) => ({ ...current, [selected.id]: { status: "loading" } }));
      setWorkflowBasisByAgreement((current) => ({ ...current, [selected.id]: null }));
      setSourceDocumentsByAgreement((current) => ({ ...current, [selected.id]: [] }));
      try {
        const payload = await requestJson<{ versions: DocumentVersionSummary[]; sourceDocuments: SourceDocumentSummary[]; workflowBasis: WorkflowBasis | null }>(`/api/agreements/${selected.id}/versions`);
        const latest = payload.versions?.[0];
        if (!alive) return;
        setSourceDocumentsByAgreement((current) => ({ ...current, [selected.id]: payload.sourceDocuments ?? [] }));
        setWorkflowBasisByAgreement((current) => ({ ...current, [selected.id]: payload.workflowBasis ?? null }));
        if (!latest) {
          setDocumentDrafts((current) => ({ ...current, [selected.id]: { status: "none" } }));
          return;
        }
        const content = await requestText(`/api/agreements/${selected.id}/versions?version=${latest.version}`);
        if (alive) setDocumentDrafts((current) => ({ ...current, [selected.id]: { status: "ready", content, version: latest.version, sha256: latest.sha256 } }));
      } catch (error) {
        if (!alive) return;
        const message = error instanceof Error ? error.message : "The latest document version could not be loaded.";
        setDocumentDrafts((current) => ({ ...current, [selected.id]: { status: "error", message } }));
      }
    }

    void loadLatestDocumentVersion();
    return () => { alive = false; };
  }, [canReadDocuments, documentReloadToken, isEvaluationAgreement, selected.id, sessionMode]);

  useEffect(() => {
    if (!urlNavigationReadyRef.current) return;
    const nextHref = navigationHref({ view, selectedId, workspaceTab }, enterpriseSetupSection);
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const mode = urlHistoryModeRef.current;
    urlHistoryModeRef.current = "push";
    if (nextHref === currentHref) {
      if (mode === "replace") window.history.replaceState({ ...window.history.state, noticeNavigation: true }, "", nextHref);
      return;
    }
    window.history[mode === "replace" ? "replaceState" : "pushState"](
      { ...window.history.state, noticeNavigation: true },
      "",
      nextHref,
    );
  }, [enterpriseSetupSection, selectedId, view, workspaceTab]);

  const handleBrowserNavigation = useEffectEvent(() => {
    if (!urlNavigationReadyRef.current) return;
    function applyBrowserNavigation(next: UrlNavigationState) {
      const agreement = agreements.find((item) => item.id === next.selectedId);
      discardDocumentEdit();
      setView(next.view);
      setWorkspaceTab(next.workspaceTab);
      setEnterpriseSetupSection(parseEnterpriseSetupSection(window.location.search));
      setMobileNavOpen(false);
      if (agreement) {
        selectAgreementState(agreement);
      }
      if (next.view === "workspace") setReturnView("agreements");
      if ((next.view === "admin" || next.view === "integrations") && canManageWorkspace) void loadAdmin();
      if (next.view === "signatures") void reloadSignatures().catch(() => notifyError("Signature evidence could not be refreshed."));
    }
    function handlePopState() {
      const next = parseNavigationSearch(window.location.search, agreements, selectedId);
      if (!next.valid) urlHistoryModeRef.current = "replace";
      const apply = () => applyBrowserNavigation(next);
      if (documentDirty || (workspaceTab === "changes" && negotiationDraftDirty)) {
        window.history.pushState(
          { ...window.history.state, noticeNavigation: true },
          "",
          navigationHref({ view, selectedId, workspaceTab }, enterpriseSetupSection),
        );
        requestDraftDecision(apply);
        return;
      }
      apply();
    }
    handlePopState();
  });

  useEffect(() => {
    function handlePopState() {
      handleBrowserNavigation();
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("nav-open", mobileNavOpen);
    return () => document.body.classList.remove("nav-open");
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!userMenuOpen) return;
    function dismiss(event: MouseEvent) {
      if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
    }
    function keydown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
        userMenuButtonRef.current?.focus();
      }
    }
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("keydown", keydown);
    };
  }, [userMenuOpen]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 960px)");
    function updateNavigationMode() {
      setCompactNavigation(media.matches);
      if (!media.matches) setMobileNavOpen(false);
    }
    updateNavigationMode();
    media.addEventListener("change", updateNavigationMode);
    return () => media.removeEventListener("change", updateNavigationMode);
  }, []);

  useEffect(() => {
    if (!compactNavigation || !mobileNavOpen) {
      if (mobileNavWasOpenRef.current) {
        mobileNavWasOpenRef.current = false;
        window.requestAnimationFrame(() => mobileMenuRef.current?.focus());
      }
      return;
    }
    mobileNavWasOpenRef.current = true;
    mobileCloseRef.current?.focus();
    function handleNavigationKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileNavOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const navigation = mobileNavigationRef.current;
      if (!navigation) return;
      const focusable = Array.from(navigation.querySelectorAll<HTMLElement>(
        "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !navigation.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !navigation.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleNavigationKey);
    return () => window.removeEventListener("keydown", handleNavigationKey);
  }, [compactNavigation, mobileNavOpen]);

  useEffect(() => {
    if (!documentDirty && !importUploadBusy && !importCreateBusy) return;
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [documentDirty, importCreateBusy, importUploadBusy]);

  useEffect(() => {
    function handleKey(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      } else if (!typing && event.key.toLowerCase() === "n" && canCreateAgreement) {
        event.preventDefault();
        openGeneratorActionRef.current();
      } else if (!typing && event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [canCreateAgreement, session?.user.displayName]);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  function notify(message: string, tone?: ToastTone) {
    const normalized = message.toLowerCase();
    const resolvedTone = tone ?? ([
      "cannot", "could not", "does not allow", "failed", "not eligible", "not assigned",
      "not configured", "not found", "quarantined", "still loading", "before ", "add a ",
      "confirm ", "select an ", "requires ", "must ",
    ].some((signal) => normalized.includes(signal)) ? "error" : "success");
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast({ message, tone: resolvedTone });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, resolvedTone === "error" ? 6000 : 3200);
  }

  function notifyError(message: string) {
    notify(message, "error");
  }

  function notifyInfo(message: string) {
    notify(message, "info");
  }

  function canDecideApproval(approval: Approval) {
    if (!canDecideApprovals) return false;
    if (approval.requestedByUserId && approval.requestedByUserId === session?.user.id) return false;
    if (session?.role !== "approver") return true;
    if (approval.approverUserId === session.user.id) return true;
    return session.mode === "evaluation" && seedApprovals.some((item) => item.id === approval.id);
  }

  function canClaimApproval(approval: Approval) {
    return approval.status === "Pending" &&
      canDecideApprovals &&
      !approval.approverUserId &&
      Boolean(approval.requestedByUserId) &&
      approval.requestedByUserId !== session?.user.id;
  }

  function discardDocumentEdit() {
    setEditing(false);
    setDocumentEditText("");
    setDocumentEditBaseText("");
  }

  function selectAgreementState(agreement: Agreement) {
    setSelectedId(agreement.id);
    setDetailsDraft(agreement);
    setRiskAssessmentLevel(agreement.risk === "Unassessed" ? "Low" : agreement.risk);
    setRiskAssessmentRationale("");
    setRiskAssessmentConfirmed(false);
  }

  function requestNegotiationDraftDecision(action: () => void) {
    if (workspaceTab !== "changes" || !negotiationDraftDirty) {
      action();
      return;
    }
    pendingNegotiationActionRef.current = action;
    setNegotiationDecisionOpen(true);
  }

  function requestDraftDecision(action: () => void) {
    if (!documentDirty) {
      requestNegotiationDraftDecision(action);
      return;
    }
    pendingDraftActionRef.current = action;
    setDraftDecisionOpen(true);
  }

  function stayWithDraft() {
    pendingDraftActionRef.current = null;
    setDraftDecisionOpen(false);
  }

  function discardDraftAndContinue() {
    const action = pendingDraftActionRef.current;
    pendingDraftActionRef.current = null;
    setDraftDecisionOpen(false);
    discardDocumentEdit();
    if (action) requestNegotiationDraftDecision(action);
  }

  async function saveDraftAndContinue() {
    setDraftDecisionBusy(true);
    const saved = await saveDocumentVersion();
    setDraftDecisionBusy(false);
    if (!saved) return;
    const action = pendingDraftActionRef.current;
    pendingDraftActionRef.current = null;
    setDraftDecisionOpen(false);
    if (action) requestNegotiationDraftDecision(action);
  }

  function stayWithNegotiationDraft() {
    pendingNegotiationActionRef.current = null;
    setNegotiationDecisionOpen(false);
  }

  function discardNegotiationDraftAndContinue() {
    const action = pendingNegotiationActionRef.current;
    pendingNegotiationActionRef.current = null;
    setNegotiationDecisionOpen(false);
    setNegotiationDraftDirty(false);
    action?.();
  }

  function openWorkspaceTab(next: WorkspaceTab) {
    if (next === workspaceTab) return;
    requestDraftDecision(() => setWorkspaceTab(next));
  }

  function navigateNow(next: View) {
    setView(next);
    setMobileNavOpen(false);
    if ((next === "admin" || next === "integrations") && canManageWorkspace) void loadAdmin();
    if (next === "signatures") void reloadSignatures().catch(() => notifyError("Signature evidence could not be refreshed."));
  }

  function navigate(next: View) {
    if (view === "workspace" && next !== "workspace") {
      requestDraftDecision(() => navigateNow(next));
      return;
    }
    navigateNow(next);
  }

  function changeEnterpriseSetupSection(next: EnterpriseSetupSection) {
    if (!enterpriseSetupSections.has(next)) return;
    setEnterpriseSetupSection(next);
  }

  function exportSelectedAgreements() {
    const rows = agreements.filter((agreement) => selectedRows.includes(agreement.id));
    if (!rows.length) return;
    const safeCell = (value: string | number) => {
      const text = String(value);
      const protectedText = /^[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${protectedText.replaceAll('"', '""')}"`;
    };
    const header = ["Contract ID", "Counterparty", "Contract type", "Direction", "Stage", "Value", "Currency", "Risk", "Owner", "Next action"];
    const body = rows.map((agreement) => [agreement.id, agreement.party, agreement.type, agreement.side, agreement.stage, minorToAmount(agreement.valueMinor, agreement.currencyCode, agreement.value), agreement.currencyCode ?? "USD", agreement.risk, agreement.owner, agreement.nextAction]);
    const csv = [header, ...body].map((row) => row.map(safeCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `notice-contracts-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    notify(`${rows.length} selected contract${rows.length === 1 ? "" : "s"} exported to CSV.`);
  }

  function openAgreement(id: number, tab: WorkspaceTab = "document", origin?: ReturnView) {
    requestDraftDecision(() => {
      const agreement = agreements.find((item) => item.id === id);
      if (!agreement) {
        notifyError("That agreement is no longer available. The contract register has been kept open.");
        navigateNow("agreements");
        return;
      }
      selectAgreementState(agreement);
      discardDocumentEdit();
      setReturnView(origin ?? (view === "workspace" ? returnView : view));
      setWorkspaceTab(tab);
      navigateNow("workspace");
      if (canManageWorkspace) void loadRetentionPolicy(id);
    });
  }

  function returnFromAgreement() {
    navigate(returnView);
  }

  function resetGenerator() {
    newCreationKeyRef.current = crypto.randomUUID();
    newCreationBodyRef.current = "";
    setNewCreationRecoveryLocked(false);
    setNewStep(1);
    setNewSide("Sell-side");
    setNewParty("");
    setNewValue("");
    setNewCurrency("USD");
    setNewTemplate("Master Services Agreement");
    setNewGovernedTemplateVersionId("");
    setNewWorkflowDefinitionId("");
    setNewOwnerUserId(session?.user.id ?? "");
    setNewPrimaryCounterpartyId("");
    setNewLegalEntityId("");
    setNewTemplateVariables({});
    setNewCrm("None");
    setNewDepartment("Sales");
    setNewOwner(session?.user.displayName ?? "Current user");
    setNewLaw("New York");
  }

  function generatedCreationRecovery(): GeneratedCreationRecovery | null {
    try {
      const raw = window.sessionStorage.getItem(GENERATED_CREATION_RECOVERY_KEY);
      if (!raw) return null;
      const recovery = JSON.parse(raw) as GeneratedCreationRecovery;
      if (
        !session
        || recovery.workspaceId !== session.workspace.id
        || recovery.userId !== session.user.id
        || !recovery.idempotencyKey
        || !recovery.party
        || !recovery.requestBody
      ) {
        window.sessionStorage.removeItem(GENERATED_CREATION_RECOVERY_KEY);
        return null;
      }
      return recovery;
    } catch {
      return null;
    }
  }

  function importedCreationRecovery(): ImportedCreationRecovery | null {
    try {
      const raw = window.sessionStorage.getItem(IMPORTED_CREATION_RECOVERY_KEY);
      if (!raw) return null;
      const recovery = JSON.parse(raw) as ImportedCreationRecovery;
      const phaseValid = new Set(["uploading", "uploaded", "agreement-attempted", "linking"]).has(recovery.phase);
      const keyValid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(recovery.idempotencyKey ?? "");
      const uploadCommitted = recovery.phase !== "uploading";
      const agreementAttempted = recovery.phase === "agreement-attempted" || recovery.phase === "linking";
      if (
        !session
        || recovery.workspaceId !== session.workspace.id
        || recovery.userId !== session.user.id
        || !keyValid
        || !phaseValid
        || !recovery.name
        || (uploadCommitted && !recovery.analysis?.documentId)
        || (agreementAttempted && !recovery.requestBody)
        || (recovery.phase === "linking" && (!Number.isSafeInteger(recovery.agreementId) || (recovery.agreementId ?? 0) <= 0))
      ) {
        window.sessionStorage.removeItem(IMPORTED_CREATION_RECOVERY_KEY);
        return null;
      }
      return recovery;
    } catch {
      try { window.sessionStorage.removeItem(IMPORTED_CREATION_RECOVERY_KEY); } catch { /* Storage may be unavailable. */ }
      return null;
    }
  }

  function persistImportedCreationRecovery(recovery: Omit<ImportedCreationRecovery, "workspaceId" | "userId">) {
    if (!session) return;
    try {
      window.sessionStorage.setItem(IMPORTED_CREATION_RECOVERY_KEY, JSON.stringify({
        ...recovery,
        workspaceId: session.workspace.id,
        userId: session.user.id,
      } satisfies ImportedCreationRecovery));
    } catch {
      // The stable in-memory UUID still protects retries in the current tab.
    }
  }

  function analysisFromUpload(payload: DocumentUploadResult): ImportAnalysis {
    return {
      documentId: payload.document.id,
      extractionMode: payload.document.extractionMode,
      scanStatus: payload.document.scanStatus,
      tags: payload.document.tags,
      riskFlags: payload.document.riskFlags,
      extracted: payload.document.extracted,
    };
  }

  function applyCommittedImportUpload(name: string, idempotencyKey: string, payload: DocumentUploadResult) {
    const analysis = analysisFromUpload(payload);
    const storedName = payload.document.fileName || name;
    importCreationKeyRef.current = idempotencyKey;
    importCreationBodyRef.current = "";
    setImportCreationRecoveryLocked(false);
    setImportName(storedName);
    setImportAnalysis(analysis);
    setImportError("");
    setImportStep("review");
    persistImportedCreationRecovery({
      idempotencyKey,
      phase: "uploaded",
      name: storedName,
      analysis,
    });
  }

  async function recoverCommittedImportUpload(idempotencyKey: string): Promise<DocumentUploadResult | null> {
    const response = await fetch("/api/documents/import", {
      method: "GET",
      headers: { "idempotency-key": idempotencyKey },
    });
    const payload = await response.json().catch(() => ({})) as DocumentUploadResult & { error?: string | { message?: string } };
    if (response.status === 404) return null;
    if (!response.ok) {
      const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
      throw new DocumentUploadRecoveryError(message ?? `Upload recovery failed with HTTP ${response.status}`, response.status);
    }
    return payload;
  }

  function resetImportedIntake(error = "") {
    try { window.sessionStorage.removeItem(IMPORTED_CREATION_RECOVERY_KEY); } catch { /* Storage may be unavailable. */ }
    importCreationKeyRef.current = crypto.randomUUID();
    importCreationBodyRef.current = "";
    setImportCreationRecoveryLocked(false);
    setImportName("");
    setImportAnalysis(sampleImportAnalysis);
    setImportStep("drop");
    setImportError(error);
  }

  function discardImportedIntake() {
    if (importUploadInFlightRef.current || importCreateInFlightRef.current || importCreationBodyRef.current) return;
    resetImportedIntake();
    notifyInfo("The staged upload was released from this intake. Its protected bytes remain eligible for automatic cleanup after seven days.");
  }

  async function resumeImportedUpload(recovery: ImportedCreationRecovery) {
    if (importUploadInFlightRef.current) return;
    importUploadInFlightRef.current = true;
    setImportUploadBusy(true);
    setImportStep("scan");
    setImportError("");
    try {
      const payload = await recoverCommittedImportUpload(recovery.idempotencyKey);
      if (payload) {
        applyCommittedImportUpload(recovery.name, recovery.idempotencyKey, payload);
      } else {
        setImportStep("drop");
        setImportError("The earlier upload did not commit. Choose the same file to retry this protected intake, or close it and return later.");
      }
    } catch (error) {
      if (error instanceof DocumentUploadRecoveryError && error.status === 410) {
        resetImportedIntake("The staged upload expired. A new protected intake is ready; choose the source again.");
      } else {
        setImportStep("drop");
        setImportError(error instanceof Error ? error.message : "The earlier upload could not be recovered.");
      }
    } finally {
      importUploadInFlightRef.current = false;
      setImportUploadBusy(false);
    }
  }

  function closeGenerator() {
    if (newCreateInFlightRef.current) return;
    setNewOpen(false);
    if (!newCreationBodyRef.current && !generatedCreationRecovery()) resetGenerator();
  }

  function closeImport() {
    if (importUploadInFlightRef.current || importCreateInFlightRef.current) return;
    setImportOpen(false);
    if (!importCreationBodyRef.current && !importedCreationRecovery()) {
      setImportStep("drop");
      setImportError("");
    }
  }

  function openGenerator() {
    if (newCreateInFlightRef.current || importUploadInFlightRef.current || importCreateInFlightRef.current) return;
    if (!canCreateAgreement) return notifyError("Your workspace role does not allow agreement creation.");
    requestDraftDecision(() => {
      discardDocumentEdit();
      setWorkspaceTab("document");
      const recovery = generatedCreationRecovery();
      if (recovery) {
        newCreationKeyRef.current = recovery.idempotencyKey;
        newCreationBodyRef.current = recovery.requestBody;
        setNewCreationRecoveryLocked(true);
        setNewSide(recovery.side);
        setNewParty(recovery.party);
        setNewValue(recovery.value);
        setNewCurrency(recovery.currencyCode ?? "USD");
        setNewTemplate(recovery.template);
        setNewGovernedTemplateVersionId(recovery.governedTemplateVersionId ?? "");
        setNewWorkflowDefinitionId(recovery.workflowDefinitionId ?? "");
        setNewOwnerUserId(recovery.ownerUserId ?? session?.user.id ?? "");
        setNewPrimaryCounterpartyId(recovery.primaryCounterpartyId ?? "");
        setNewLegalEntityId(recovery.legalEntityId ?? "");
        setNewTemplateVariables(recovery.templateVariables ?? {});
        setNewCrm(recovery.crm);
        setNewDepartment(recovery.department);
        setNewOwner(recovery.owner);
        setNewLaw(recovery.governingLaw);
        setNewStep(3);
      } else if (newCreationBodyRef.current) {
        setNewCreationRecoveryLocked(true);
        setNewStep(3);
      } else {
        resetGenerator();
      }
      setNewOpen(true);
    });
  }

  useEffect(() => {
    openGeneratorActionRef.current = openGenerator;
  });

  function openImport() {
    if (newCreateInFlightRef.current || importUploadInFlightRef.current || importCreateInFlightRef.current) return;
    if (!canImportAgreement) return notifyError("Your workspace role does not allow document import and agreement creation.");
    requestDraftDecision(() => {
      discardDocumentEdit();
      setWorkspaceTab("document");
      const recovery = importedCreationRecovery();
      if (recovery) {
        importCreationKeyRef.current = recovery.idempotencyKey;
        importCreationBodyRef.current = recovery.requestBody ?? "";
        setImportCreationRecoveryLocked(Boolean(recovery.requestBody));
        setImportName(recovery.name);
        setImportError("");
        if (recovery.analysis) setImportAnalysis(recovery.analysis);
        if (recovery.phase === "uploading") {
          setImportStep("scan");
          void resumeImportedUpload(recovery);
        } else {
          setImportStep("review");
        }
      } else if (importCreationBodyRef.current) {
        setImportCreationRecoveryLocked(true);
        setImportStep("review");
      } else {
        importCreationKeyRef.current = crypto.randomUUID();
        importCreationBodyRef.current = "";
        setImportCreationRecoveryLocked(false);
        setImportName("");
        setImportAnalysis(sampleImportAnalysis);
        setImportError("");
        setImportStep("drop");
      }
      setImportOpen(true);
    });
  }

  function applyAgreement(record: Agreement) {
    const saved = normalizeAgreement(record);
    const persistedIndex = loadedSavedAgreementsRef.current.findIndex((agreement) => agreement.id === saved.id);
    const browserOnlyEvaluationSample = isEvaluationAgreement(saved.id) && persistedIndex < 0;
    if (!browserOnlyEvaluationSample) {
      const nextSaved = persistedIndex < 0
        ? [saved, ...loadedSavedAgreementsRef.current]
        : loadedSavedAgreementsRef.current.map((agreement, index) => index === persistedIndex ? saved : agreement);
      loadedSavedAgreementsRef.current = nextSaved;
      if (seedAgreementIds.has(saved.id)) {
        setPersistedSeedAgreementIds((current) => current.has(saved.id) ? current : new Set([...current, saved.id]));
      }
      setWorkspaceAgreementSavedLoadedCount(nextSaved.length);
      if (persistedIndex < 0) setWorkspaceAgreementTotalMatched((current) => Math.max(current + 1, nextSaved.length));

      const controls = agreementListControlsRef.current;
      const registerIndex = registerSavedAgreementsRef.current.findIndex((agreement) => agreement.id === saved.id);
      const appearsInRegister = agreementMatchesListControls(saved, controls);
      const nextRegisterSaved = appearsInRegister
        ? registerIndex < 0
          ? [saved, ...registerSavedAgreementsRef.current]
          : registerSavedAgreementsRef.current.map((agreement, index) => index === registerIndex ? saved : agreement)
        : registerSavedAgreementsRef.current.filter((agreement) => agreement.id !== saved.id);
      registerSavedAgreementsRef.current = nextRegisterSaved;
      setAgreementSavedLoadedCount(nextRegisterSaved.length);
      if (registerIndex < 0 && appearsInRegister) setAgreementTotalMatched((current) => Math.max(current + 1, nextRegisterSaved.length));
      if (registerIndex >= 0 && !appearsInRegister) setAgreementTotalMatched((current) => Math.max(0, current - 1));
    }
    setAgreements((current) => current.some((item) => item.id === saved.id)
      ? current.map((item) => item.id === saved.id ? saved : item)
      : [saved, ...current]);
    setRegisterAgreements((current) => {
      const controls = agreementListControlsRef.current;
      const next = agreementMatchesListControls(saved, controls)
        ? mergeAgreementPages(current, [saved])
        : current.filter((agreement) => agreement.id !== saved.id);
      return visibleAgreementRows(next, controls);
    });
    if (selectedId === saved.id) setDetailsDraft(saved);
    return saved;
  }

  function applyEvent(event?: AuditEvent | null) {
    if (!event) return;
    setEvents((current) => [event, ...current.filter((item) => item.id !== event.id)]);
  }

  const reloadAgreementRegister = useCallback(async (controls: AgreementListControls) => {
    const requestToken = agreementPageRequestRef.current + 1;
    const queryKey = agreementListKey(controls);
    agreementPageRequestRef.current = requestToken;
    agreementPageInFlightRef.current = true;
    agreementListControlsRef.current = controls;
    setAgreementPageBusy(true);
    setAgreementPageError("");
    try {
      const payload = await requestJson<AgreementPagePayload>(agreementListUrl(controls));
      if (requestToken !== agreementPageRequestRef.current || agreementListKey(agreementListControlsRef.current) !== queryKey) return;
      const saved = mergeAgreementPages([], (payload.agreements ?? []).map(normalizeAgreement));
      const savedSeedIds = seedAgreementIdSubset(saved);
      setPersistedSeedAgreementIds((current) => queryKey === agreementListKey(defaultAgreementListControls) && payload.hasMore !== true
        ? sameAgreementIds(current, savedSeedIds) ? current : savedSeedIds
        : mergeAgreementIds(current, savedSeedIds));
      const totalMatched = Number.isSafeInteger(payload.totalMatched) && (payload.totalMatched ?? -1) >= 0
        ? Math.max(payload.totalMatched ?? 0, saved.length)
        : saved.length;
      const nextCursor = payload.hasMore === true && typeof payload.nextCursor === "string" && payload.nextCursor
        ? payload.nextCursor
        : null;
      registerSavedAgreementsRef.current = saved;
      agreementCursorRef.current = nextCursor;
      setAgreementSavedLoadedCount(saved.length);
      setAgreementTotalMatched(totalMatched);
      setAgreementNextCursor(nextCursor);
      setAgreementLoadedQueryKey(queryKey);
      setAgreementPageError(payload.hasMore === true && !nextCursor
        ? "More matching agreements exist, but this page did not include a continuation cursor. Retry the register query before relying on its coverage."
        : "");
      const samples = session?.mode === "evaluation"
        ? seedAgreements.filter((agreement) => !persistedSeedAgreementIds.has(agreement.id) && agreementMatchesListControls(agreement, controls))
        : [];
      setRegisterAgreements(visibleAgreementRows(session?.mode === "evaluation" ? mergeById(saved, samples) : saved, controls));
      setAgreements((current) => mergeAgreementPages(current, saved));
    } catch (error) {
      if (requestToken === agreementPageRequestRef.current) {
        setAgreementPageError(error instanceof Error ? error.message : "The agreement register could not be loaded.");
      }
    } finally {
      if (requestToken === agreementPageRequestRef.current) {
        agreementPageInFlightRef.current = false;
        setAgreementPageBusy(false);
      }
    }
  }, [persistedSeedAgreementIds, session?.mode]);

  async function reloadAgreements() {
    const requestToken = workspaceAgreementRequestRef.current + 1;
    workspaceAgreementRequestRef.current = requestToken;
    try {
      const payload = await requestJson<AgreementPagePayload>("/api/agreements");
      if (requestToken !== workspaceAgreementRequestRef.current) {
        return session?.mode === "evaluation"
          ? mergeById(loadedSavedAgreementsRef.current, seedAgreements.filter((agreement) => !persistedSeedAgreementIds.has(agreement.id)))
          : loadedSavedAgreementsRef.current;
      }
      const saved = mergeAgreementPages([], (payload.agreements ?? []).map(normalizeAgreement));
      const totalMatched = Number.isSafeInteger(payload.totalMatched) && (payload.totalMatched ?? -1) >= 0
        ? Math.max(payload.totalMatched ?? 0, saved.length)
        : saved.length;
      const nextCursor = payload.hasMore === true && typeof payload.nextCursor === "string" && payload.nextCursor
        ? payload.nextCursor
        : null;
      loadedSavedAgreementsRef.current = saved;
      const savedSeedIds = seedAgreementIdSubset(saved);
      setPersistedSeedAgreementIds((current) => payload.hasMore === true
        ? mergeAgreementIds(current, savedSeedIds)
        : sameAgreementIds(current, savedSeedIds) ? current : savedSeedIds);
      setWorkspaceAgreementSavedLoadedCount(saved.length);
      setWorkspaceAgreementTotalMatched(totalMatched);
      setWorkspaceAgreementHasMore(payload.hasMore === true);
      const rows = session?.mode === "evaluation"
        ? mergeById(saved, seedAgreements.filter((agreement) => !persistedSeedAgreementIds.has(agreement.id)))
        : saved;
      setAgreements((currentRows) => mergeAgreementPages(rows, currentRows.filter((agreement) =>
        !seedAgreements.some((seed) => seed.id === agreement.id))));
      const current = rows.find((item) => item.id === selectedId) ?? agreements.find((item) => item.id === selectedId);
      if (current) setDetailsDraft(current);
      else if (view === "workspace") {
        urlHistoryModeRef.current = "replace";
        setView("agreements");
        setWorkspaceTab("document");
        const fallback = rows[0];
        if (fallback) selectAgreementState(fallback);
        else setSelectedId(0);
      }

      const controls = agreementListControlsRef.current;
      if (agreementListKey(controls) === agreementListKey(defaultAgreementListControls)) {
        agreementPageRequestRef.current += 1;
        agreementPageInFlightRef.current = false;
        registerSavedAgreementsRef.current = saved;
        agreementCursorRef.current = nextCursor;
        setAgreementSavedLoadedCount(saved.length);
        setAgreementTotalMatched(totalMatched);
        setAgreementNextCursor(nextCursor);
        setAgreementLoadedQueryKey(agreementListKey(controls));
        setAgreementPageBusy(false);
        setAgreementPageError(payload.hasMore === true && !nextCursor
          ? "More matching agreements exist, but this page did not include a continuation cursor. Retry the register query before relying on its coverage."
          : "");
        setRegisterAgreements(visibleAgreementRows(rows, controls));
      } else {
        await reloadAgreementRegister(controls);
      }
      return rows;
    } finally {
      if (requestToken === workspaceAgreementRequestRef.current
        && agreementListKey(agreementListControlsRef.current) === agreementListKey(defaultAgreementListControls)) {
        setAgreementPageBusy(false);
      }
    }
  }

  async function loadMoreAgreements() {
    const cursor = agreementCursorRef.current;
    const controls = agreementListControlsRef.current;
    const queryKey = agreementListKey(controls);
    if (!cursor || agreementPageInFlightRef.current || queryKey !== agreementLoadedQueryKey) return;
    agreementPageInFlightRef.current = true;
    const requestToken = agreementPageRequestRef.current + 1;
    agreementPageRequestRef.current = requestToken;
    setAgreementPageBusy(true);
    setAgreementPageError("");
    try {
      const payload = await requestJson<AgreementPagePayload>(agreementListUrl(controls, cursor));
      if (requestToken !== agreementPageRequestRef.current || agreementListKey(agreementListControlsRef.current) !== queryKey) return;
      const incoming = mergeAgreementPages([], (payload.agreements ?? []).map(normalizeAgreement));
      const nextCursor = payload.hasMore === true && typeof payload.nextCursor === "string" && payload.nextCursor
        ? payload.nextCursor
        : null;
      if (payload.hasMore === true && (!nextCursor || nextCursor === cursor)) {
        throw new Error("The server did not advance the agreement page cursor. Retry after reloading the register.");
      }
      const nextSaved = mergeAgreementPages(registerSavedAgreementsRef.current, incoming);
      const nextSavedSeedIds = seedAgreementIdSubset(nextSaved);
      setPersistedSeedAgreementIds((current) => queryKey === agreementListKey(defaultAgreementListControls) && payload.hasMore !== true
        ? sameAgreementIds(current, nextSavedSeedIds) ? current : nextSavedSeedIds
        : mergeAgreementIds(current, seedAgreementIdSubset(incoming)));
      const totalMatched = Number.isSafeInteger(payload.totalMatched) && (payload.totalMatched ?? -1) >= 0
        ? Math.max(payload.totalMatched ?? 0, nextSaved.length)
        : Math.max(agreementTotalMatched, nextSaved.length);
      registerSavedAgreementsRef.current = nextSaved;
      agreementCursorRef.current = nextCursor;
      setAgreementSavedLoadedCount(nextSaved.length);
      setAgreementTotalMatched(totalMatched);
      setAgreementNextCursor(nextCursor);
      const samples = session?.mode === "evaluation"
        ? seedAgreements.filter((agreement) => !persistedSeedAgreementIds.has(agreement.id) && agreementMatchesListControls(agreement, controls))
        : [];
      setRegisterAgreements(visibleAgreementRows(session?.mode === "evaluation" ? mergeById(nextSaved, samples) : nextSaved, controls));
      setAgreements((current) => mergeAgreementPages(current, incoming));
      if (queryKey === agreementListKey(defaultAgreementListControls)) {
        loadedSavedAgreementsRef.current = nextSaved;
        setWorkspaceAgreementSavedLoadedCount(nextSaved.length);
        setWorkspaceAgreementTotalMatched(totalMatched);
        setWorkspaceAgreementHasMore(payload.hasMore === true);
      }
    } catch (error) {
      if (requestToken === agreementPageRequestRef.current) {
        setAgreementPageError(error instanceof Error ? error.message : "More agreements could not be loaded.");
      }
    } finally {
      if (requestToken === agreementPageRequestRef.current) {
        agreementPageInFlightRef.current = false;
        setAgreementPageBusy(false);
      }
    }
  }

  useEffect(() => {
    agreementListControlsRef.current = agreementListControls;
    if (!session || agreementCurrentQueryKey === agreementLoadedQueryKey) return;
    const timer = window.setTimeout(() => {
      setSelectedRows([]);
      void reloadAgreementRegister(agreementListControls);
    }, agreementQuery.trim() ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [agreementCurrentQueryKey, agreementListControls, agreementLoadedQueryKey, agreementQuery, reloadAgreementRegister, session]);

  async function reconcileNegotiationMutation(returnedAgreement?: Agreement | null) {
    if (returnedAgreement) applyAgreement(returnedAgreement);
    const rows = await reloadAgreements();
    if (returnedAgreement) {
      const reloaded = rows.find((item) => item.id === returnedAgreement.id);
      if (!reloaded || (reloaded.version ?? 0) < (returnedAgreement.version ?? 0)) applyAgreement(returnedAgreement);
    }
    setDocumentReloadToken((value) => value + 1);
  }

  async function reloadOperations() {
    const payload = await requestJson<OperationsPayload>("/api/operations");
    setApprovals(session?.mode === "evaluation" ? mergeById(payload.approvals ?? [], seedApprovals.filter((item) => isEvaluationAgreement(item.agreementId))) : payload.approvals ?? []);
    setObligations(session?.mode === "evaluation" ? mergeById(payload.obligations ?? [], seedObligations.filter((item) => isEvaluationAgreement(item.agreementId))) : payload.obligations ?? []);
    setObligationSchedules(session?.mode === "evaluation" ? mergeById(payload.obligationSchedules ?? [], seedObligationSchedules.filter((item) => isEvaluationAgreement(item.agreementId))) : payload.obligationSchedules ?? []);
    setObligationEvidence(session?.mode === "evaluation" ? mergeById(payload.obligationEvidence ?? [], seedObligationEvidence.filter((item) => isEvaluationAgreement(item.agreementId))) : payload.obligationEvidence ?? []);
    const loadedOwners = payload.eligibleObligationOwners ?? [];
    const evaluationOwner = session?.mode === "evaluation" && !loadedOwners.some((owner) => owner.userId === session.user.id)
      ? [{ userId: session.user.id, displayName: session.user.displayName, role: session.role }]
      : [];
    setEligibleObligationOwners([...loadedOwners, ...evaluationOwner]);
    setEvents(session?.mode === "evaluation" ? mergeById(payload.events ?? [], seedEvents.filter((item) => isEvaluationAgreement(item.agreementId))) : payload.events ?? []);
  }

  async function reloadSignatures() {
    const payload = await requestJson<{ signaturePackets: SignaturePacket[] }>("/api/signatures");
    setSignaturePackets(payload.signaturePackets ?? []);
    return payload.signaturePackets ?? [];
  }

  async function recordEvent(agreementId: number, eventType: "Comment" | "Redline" | "Export", detail: string) {
    if (isEvaluationAgreement(agreementId)) {
      const event: AuditEvent = {
        id: crypto.randomUUID(),
        agreementId,
        type: eventType,
        actor: session?.user.displayName ?? "Evaluation user",
        detail,
        createdAt: "Just now",
      };
      applyEvent(event);
      return event;
    }
    const payload = await requestJson<{ event: AuditEvent }>("/api/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entity: "event", action: "comment", record: { agreementId, eventType, detail } }),
    });
    applyEvent(payload.event);
    return payload.event;
  }

  async function saveAgreementChange(id: number, patch: Partial<Agreement>) {
    const current = agreements.find((agreement) => agreement.id === id);
    if (!current) throw new Error("Agreement is no longer available.");
    if (isEvaluationAgreement(id)) {
      const saved = normalizeAgreement({ ...current, ...patch, version: (current.version ?? 1) + 1, updated: "Just now" });
      applyAgreement(saved);
      return { agreement: saved, unchanged: false };
    }
    const payload = await requestJson<{ agreement: Agreement; event: AuditEvent | null; unchanged?: boolean }>("/api/agreements", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, version: current.version ?? 1, ...patch }),
    });
    if (payload.event) applyEvent(payload.event);
    return { agreement: applyAgreement(payload.agreement), unchanged: payload.unchanged === true };
  }

  async function startImport(file?: File) {
    if (importUploadInFlightRef.current || importCreateInFlightRef.current) return;
    if (!canImportAgreement) return notify("Your workspace role does not allow document import and agreement creation.");
    if (!file && session?.mode !== "evaluation") return notify("Sample import is available only in evaluation mode.");
    if (importAnalysis.documentId || importCreationBodyRef.current) return notifyError("This intake already has a committed source. Finish or pause it before starting another upload.");
    const sampleText = "Customer Master Services Agreement with Orchid Systems. Effective date August 15, 2026. USD $168,000. Customer will pay Net 30. This Agreement renews automatically unless either party gives 60 days written non-renewal notice. Delaware governing law. Provider processes Customer Data. Liability is three times the fees.";
    const source = file ?? new File([sampleText], "Orchid Systems — Customer MSA.txt", { type: "text/plain" });
    const idempotencyKey = importCreationKeyRef.current || crypto.randomUUID();
    importCreationKeyRef.current = idempotencyKey;
    persistImportedCreationRecovery({
      idempotencyKey,
      phase: "uploading",
      name: source.name,
    });
    setImportError("");
    setImportName(source.name);
    setImportStep("scan");
    const form = new FormData();
    form.append("file", source);
    importUploadInFlightRef.current = true;
    setImportUploadBusy(true);
    try {
      const payload = await requestJson<DocumentUploadResult>("/api/documents/import", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: form,
      });
      applyCommittedImportUpload(source.name, idempotencyKey, payload);
    } catch (error) {
      // The POST may have committed before its response was lost. Resolve the
      // durable receipt with the same tenant/user-bound UUID before declaring
      // failure or allowing another upload under this intake.
      try {
        const recovered = await recoverCommittedImportUpload(idempotencyKey);
        if (recovered) {
          applyCommittedImportUpload(source.name, idempotencyKey, recovered);
          return;
        }
      } catch (recoveryError) {
        if (recoveryError instanceof DocumentUploadRecoveryError && recoveryError.status === 410) {
          const message = "The staged upload expired. A new protected intake is ready; choose the source again.";
          resetImportedIntake(message);
          notifyError(message);
          return;
        }
        // Keep the uploading recovery phase so a reload can retry the GET.
      }
      const message = error instanceof Error ? error.message : "Import analysis could not complete. Re-select the same file to retry safely.";
      setImportError(message);
      setImportStep("drop");
      notifyError(message);
      return;
    } finally {
      importUploadInFlightRef.current = false;
      setImportUploadBusy(false);
    }
  }

  function updateImportAnalysis(analysis: ImportAnalysis) {
    setImportAnalysis(analysis);
    const recovery = importedCreationRecovery();
    if (!recovery || recovery.phase !== "uploaded" || !analysis.documentId) return;
    persistImportedCreationRecovery({
      idempotencyKey: recovery.idempotencyKey,
      phase: "uploaded",
      name: importName,
      analysis,
    });
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void startImport(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void startImport(file);
  }

  async function requestRequiredApprovals(agreement: Agreement) {
    if (!canRequestApprovals) throw new Error("Your workspace role cannot request approval.");
    const payload = await requestJson<{ approvals: Approval[]; agreement: Agreement; event?: AuditEvent; createdRoles: string[] }>("/api/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entity: "approval",
        action: "ensure_required",
        record: { agreementId: agreement.id, due: todayIsoDate() },
      }),
    });
    applyAgreement(payload.agreement);
    applyEvent(payload.event);
    await reloadOperations();
    return payload;
  }

  function createAgreement() {
    if (newCreateInFlightRef.current) return;
    requestDraftDecision(() => void createAgreementAfterGuard());
  }

  async function createAgreementAfterGuard() {
    if (newCreateInFlightRef.current) return;
    if (!canCreateAgreement) return notify("Your workspace role does not allow agreement creation.");
    if (!newParty.trim()) return notify("Add a counterparty before generating the draft.");
    if (!/^[A-Z]{3}$/.test(newCurrency)) return notifyError("Choose a three-letter currency code.");
    const valueMinor = amountToMinor(newValue, newCurrency);
    if (valueMinor === null) return notifyError("Enter a valid non-negative contract value.");
    if (newCrm !== "None" && !connections[newCrm]) return notify(`Configure and test ${newCrm} before linking a record.`);
    const creationKey = newCreationKeyRef.current || crypto.randomUUID();
    newCreationKeyRef.current = creationKey;
    const requestBody = newCreationBodyRef.current || JSON.stringify({
      creationMode: "generated",
      party: newParty.trim(),
      side: newSide,
      type: newTemplate,
      value: Math.round(minorToAmount(valueMinor, newCurrency)),
      valueMinor,
      currencyCode: newCurrency,
      owner: newOwner,
      ownerUserId: newOwnerUserId || session?.user.id,
      ...(newPrimaryCounterpartyId ? { primaryCounterpartyId: newPrimaryCounterpartyId } : {}),
      ...(newLegalEntityId ? { legalEntityId: newLegalEntityId } : {}),
      ...(newGovernedTemplateVersionId ? { governedTemplateVersionId: newGovernedTemplateVersionId, templateVariables: newTemplateVariables } : {}),
      ...(newWorkflowDefinitionId ? { workflowDefinitionId: newWorkflowDefinitionId } : {}),
      due: "Today",
      crm: newCrm,
      crmRecord: newCrm === "None" ? "—" : `${newParty} — ${newTemplate}`,
      tags: [newSide, newTemplate === "Master Services Agreement" ? "MSA" : newTemplate, "Generated", newGovernedTemplateVersionId ? "Governed template" : "Starter template", "Human review required", `${newLaw} law`],
      department: newDepartment,
      effectiveDate: "",
      expirationDate: "",
      governingLaw: newLaw,
    });
    newCreationBodyRef.current = requestBody;
    setNewCreationRecoveryLocked(true);
    try {
      window.sessionStorage.setItem(GENERATED_CREATION_RECOVERY_KEY, JSON.stringify({
        workspaceId: session?.workspace.id ?? "",
        userId: session?.user.id ?? "",
        idempotencyKey: creationKey,
        side: newSide,
        party: newParty,
        value: newValue,
        currencyCode: newCurrency,
        template: newTemplate,
        governedTemplateVersionId: newGovernedTemplateVersionId,
        workflowDefinitionId: newWorkflowDefinitionId,
        ownerUserId: newOwnerUserId,
        primaryCounterpartyId: newPrimaryCounterpartyId,
        legalEntityId: newLegalEntityId,
        templateVariables: newTemplateVariables,
        crm: newCrm,
        department: newDepartment,
        owner: newOwner,
        governingLaw: newLaw,
        requestBody,
      } satisfies GeneratedCreationRecovery));
    } catch {
      // Retry safety remains active for this tab through the stable in-memory key.
    }
    newCreateInFlightRef.current = true;
    setNewCreateBusy(true);
    try {
      const payload = await requestJson<{ agreement: Agreement; documentVersion: DocumentVersionSummary | null; event: AuditEvent; replay: boolean }>("/api/agreements", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": creationKey },
        body: requestBody,
      });
      const saved = applyAgreement(payload.agreement);
      applyEvent(payload.event);
      if (payload.documentVersion) {
        const exactGeneratedContent = await requestText(`/api/agreements/${saved.id}/versions?version=${payload.documentVersion.version}`);
        setDocumentDrafts((current) => ({
          ...current,
          [saved.id]: { status: "ready", content: exactGeneratedContent, version: payload.documentVersion!.version, sha256: payload.documentVersion!.sha256 },
        }));
      }
      await Promise.all([reloadAgreements(), reloadOperations()]);
      discardDocumentEdit();
      selectAgreementState(saved);
      setNewOpen(false);
      setNewStep(1);
      setAgreementQuery("");
      setWorkspaceTab("document");
      setReturnView("agreements");
      setView("workspace");
      try { window.sessionStorage.removeItem(GENERATED_CREATION_RECOVERY_KEY); } catch { /* Best-effort reload recovery cleanup. */ }
      newCreationBodyRef.current = "";
      setNewCreationRecoveryLocked(false);
      newCreationKeyRef.current = crypto.randomUUID();
      notify(canRequestApprovals
        ? "Working draft created. Review and negotiate the exact paper first, then explicitly request the required approval work."
        : "Working draft created with approval required; an authorized member must route it after document review.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The contract could not be created.");
    } finally {
      newCreateInFlightRef.current = false;
      setNewCreateBusy(false);
    }
  }

  function addImportedAgreement() {
    if (importCreateInFlightRef.current) return;
    requestDraftDecision(() => void addImportedAgreementAfterGuard());
  }

  async function addImportedAgreementAfterGuard() {
    if (importCreateInFlightRef.current) return;
    if (!canImportAgreement) return notify("Your workspace role does not allow document import and agreement creation.");
    if (importAnalysis.scanStatus !== "clean" && !(session?.mode === "evaluation" && importAnalysis.scanStatus === "evaluation-bypassed")) {
      return notify("This document is quarantined until its production security scan passes.");
    }
    const sideValue = importAnalysis.extracted.side.trim();
    if (!["Sell-side", "Buy-side", "Corporate"].includes(sideValue)) {
      return notifyError("Confirm the contract direction as Customer contract, Supplier contract, or Company contract before creating the record.");
    }
    if (!importAnalysis.extracted.type.trim() || importAnalysis.extracted.type === "Not detected") {
      return notifyError("Confirm the contract type before creating the record.");
    }
    const side = sideValue as AgreementSide;
    const party = importAnalysis.extracted.counterparty || "Imported counterparty";
    const value = parseMoney(importAnalysis.extracted.agreementValue);
    const creationKey = importCreationKeyRef.current || crypto.randomUUID();
    importCreationKeyRef.current = creationKey;
    importCreateInFlightRef.current = true;
    setImportCreateBusy(true);
    try {
      if (!importCreationBodyRef.current) {
        const committedUpload = await recoverCommittedImportUpload(creationKey);
        if (!committedUpload || committedUpload.document.id !== importAnalysis.documentId) {
          throw new Error("The committed source upload could not be revalidated. Resume or restart the protected intake before creating an agreement.");
        }
      }
      const requestBody = importCreationBodyRef.current || JSON.stringify({
      creationMode: "imported",
      party,
      side,
      type: importAnalysis.extracted.type,
      value,
      valueMinor: amountToMinor(value, "USD") ?? 0,
      currencyCode: "USD",
      owner: session?.user.displayName ?? "Unassigned",
      ownerUserId: session?.user.id,
      due: "Today",
      crm: "None",
      crmRecord: "",
      tags: Array.from(new Set([...importAnalysis.tags, "Imported source"])),
      department: side === "Buy-side" ? "Procurement" : side === "Corporate" ? "Legal" : "Sales",
      effectiveDate: importAnalysis.extracted.effectiveDate === "Not detected" ? "" : dateInputValue(importAnalysis.extracted.effectiveDate),
      expirationDate: importAnalysis.extracted.expirationDate === "Not detected" ? "" : dateInputValue(importAnalysis.extracted.expirationDate),
      });
      importCreationBodyRef.current = requestBody;
      setImportCreationRecoveryLocked(true);
      persistImportedCreationRecovery({
        idempotencyKey: creationKey,
        phase: "agreement-attempted",
        name: importName,
        analysis: importAnalysis,
        requestBody,
      });
      const payload = await requestJson<{ agreement: Agreement; event: AuditEvent; replay: boolean }>("/api/agreements", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": creationKey },
        body: requestBody,
      });
      let saved = applyAgreement(payload.agreement);
      applyEvent(payload.event);
      persistImportedCreationRecovery({
        idempotencyKey: creationKey,
        phase: "linking",
        name: importName,
        analysis: importAnalysis,
        requestBody,
        agreementId: saved.id,
      });
      let sourceAlreadyLinked = false;
      if (importAnalysis.documentId) {
        const linkPayload = await requestJson<{ agreement?: Agreement; event?: AuditEvent; alreadyLinked?: boolean }>("/api/documents/import", {
          method: "PATCH",
          headers: { "content-type": "application/json", "idempotency-key": creationKey },
          body: JSON.stringify({ documentId: importAnalysis.documentId, agreementId: saved.id }),
        });
        sourceAlreadyLinked = linkPayload.alreadyLinked === true;
        if (linkPayload.agreement) saved = applyAgreement(linkPayload.agreement);
        applyEvent(linkPayload.event);
      }
      if (!sourceAlreadyLinked) {
        await recordEvent(saved.id, "Comment", `${importName} imported; automated field suggestions require human confirmation against the source.`);
      }
      const [reloadedAgreements] = await Promise.all([reloadAgreements(), reloadOperations()]);
      saved = reloadedAgreements.find((agreement) => agreement.id === saved.id) ?? saved;
      discardDocumentEdit();
      selectAgreementState(saved);
      setImportOpen(false);
      setImportStep("drop");
      setAgreementQuery("");
      setWorkspaceTab(importAnalysis.riskFlags.length ? "changes" : "details");
      setReturnView("agreements");
      setView("workspace");
      try { window.sessionStorage.removeItem(IMPORTED_CREATION_RECOVERY_KEY); } catch { /* Best-effort reload recovery cleanup. */ }
      importCreationBodyRef.current = "";
      setImportCreationRecoveryLocked(false);
      importCreationKeyRef.current = crypto.randomUUID();
      notify(canRequestApprovals
        ? "Contract uploaded. Confirm the source and negotiate the exact paper first, then explicitly request the required approval work."
        : "Contract uploaded with approval required; an authorized member must route it after source review.");
    } catch (error) {
      if ((error instanceof DocumentUploadRecoveryError || error instanceof ApiRequestError) && error.status === 410) {
        const message = "The staged upload expired before agreement creation was reserved. A new protected intake is ready.";
        resetImportedIntake(message);
        notifyError(message);
      } else {
        notifyError(error instanceof Error ? error.message : "The uploaded contract could not be added.");
      }
    } finally {
      importCreateInFlightRef.current = false;
      setImportCreateBusy(false);
    }
  }

  async function addClause() {
    if (!canWriteLanguage) return notify("Your workspace role does not allow language library changes.");
    if (!clauseTitle.trim() || !clauseText.trim()) return notify("Add a name and approved language first.");
    try {
      const payload = await requestJson<{ languageBlock: ClauseBlock }>("/api/language-blocks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: clauseTitle.trim(), category: "Commercial", profile: clauseProfile, summary: "Approved language block", language: clauseText.trim(), uses: 0 }),
      });
      setClauses((current) => [payload.languageBlock, ...current]);
      setClauseOpen(false);
      notify("Approved language block saved.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "Approved language could not be saved.");
    }
  }

  function insertClause(agreementId: number, id: number): boolean {
    if (!canManageDocuments) { notifyError("Your workspace role does not allow document changes."); return false; }
    if (agreementId !== selected.id) { notifyError("Open the contract before changing its working draft."); return false; }
    if (agreementId === selected.id && selectedDraftPending) { notifyError("Wait for the latest saved working draft to load."); return false; }
    if (agreementId === selected.id && selectedDraft?.status === "error") { notifyError("Resolve the document loading error before changing the working draft."); return false; }
    if (agreementId === selected.id && selectedHasImportedSource && selectedDraft?.status === "none") { notifyError("Create and review readable working text from the uploaded contract before inserting language."); return false; }
    const clause = clauses.find((item) => item.id === id);
    if (!clause) { notifyError("That approved language block is no longer available."); return false; }
    const currentContent = agreementId === selected.id
      ? editing
        ? documentEditText
        : selectedDraft?.status === "ready"
        ? selectedDraft.content
        : isEvaluationAgreement(agreementId)
          ? contractRef.current?.innerText.trim() ?? ""
          : assembleStarterDraft({
              organization: session?.workspace.name ?? "Our organization",
              party: selected.party,
              side: selected.side,
              type: selected.type,
              effectiveDate: selected.effectiveDate,
              governingLaw: selected.tags.find((tag) => tag.endsWith(" law"))?.slice(0, -4),
            })
      : "";
    if (currentContent.includes(clause.language)) { notifyInfo("That approved language is already in this working draft."); return false; }
    const appended = `${currentContent}${currentContent ? "\n\n" : ""}${clause.title.toUpperCase()}\n${clause.language}`;
    if (agreementId === selected.id) {
      if (!editing) setDocumentEditBaseText(currentContent);
      setDocumentEditText(appended);
      setEditing(true);
    }
    notifyInfo("Approved language added to the unsaved working draft. Save a version to make it durable and auditable.");
    return true;
  }

  function insertClauseFromLibrary(id: number) {
    if (!languageInsertionAgreement) return notifyError("Open a contract before adding approved language.");
    if (!insertClause(languageInsertionAgreement.id, id)) return;
    setReturnView("library");
    setWorkspaceTab("document");
    navigateNow("workspace");
  }

  async function resolveChange(id: number, status: ChangeStatus) {
    if (!canUpdateAgreement || !canAppendAudit) return notify("Your workspace role does not allow redline decisions.");
    if (!selectedIsSeedEvaluation) return notify("No structured redline decision is recorded for this production agreement.");
    const next = { ...selectedChangeStatus, [id]: status };
    const label = id === 1 ? "Liability cap" : "Payment terms";
    try {
      await recordEvent(selected.id, "Redline", `${status === "accepted" ? "Accepted" : "Rejected"} the ${label.toLowerCase()} change.`);
      if (Object.values(next).every((value) => value !== "open")) {
        await saveAgreementChange(selected.id, { nextAction: "Finalize negotiation", risk: "Medium" });
      }
      setChangeStatusByAgreement((current) => ({ ...current, [selected.id]: next }));
      notify(status === "accepted" ? "Change accepted and audit evidence recorded." : "Change rejected; standard language restored.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The redline decision could not be saved.");
    }
  }

  function openApprovalDecision(approval: Approval, status: ApprovalDecisionStatus) {
    if (!canDecideApproval(approval)) return notifyError("This approval is not assigned to you or your role cannot decide it.");
    setApprovalDecision({ approval, status });
    setApprovalDecisionReason("");
    setApprovalDecisionConfirmed(false);
  }

  function closeApprovalDecision() {
    if (approvalDecisionBusy) return;
    setApprovalDecision(null);
    setApprovalDecisionReason("");
    setApprovalDecisionConfirmed(false);
  }

  async function decideApproval(approval: Approval, status: ApprovalDecisionStatus, reason: string, confirmed: boolean) {
    if (!canDecideApproval(approval)) return notify("This approval is not assigned to you or your role cannot decide it.");
    const trimmedReason = reason.trim();
    if (!trimmedReason) return notifyError("Add a reason for this recorded approval decision.");
    if (!confirmed) return notifyError("Confirm that you reviewed the exact approval basis before submitting.");
    const evaluationSample = session?.mode === "evaluation" && seedApprovals.some((item) => item.id === approval.id);
    if (!evaluationSample && (!approval.basisHash || !approval.documentVersion || !approval.documentSha256)) {
      return notifyError("This approval is missing its exact immutable basis. Reload the queue and do not record a decision against inferred paper.");
    }
    setApprovalDecisionBusy(true);
    try {
      if (evaluationSample) {
        setApprovals((current) => current.map((item) => item.id === approval.id ? { ...item, status, comment: trimmedReason } : item));
        await recordEvent(approval.agreementId, "Comment", `${approval.role} evaluation approval ${status.toLowerCase()}: ${trimmedReason}`);
        closeApprovalDecision();
        notifyInfo("Evaluation decision and reason recorded locally. Production decisions bind the exact immutable paper on the server.");
        return;
      }
      const payload = await requestJson<{ approval: Approval; agreement: Agreement; event: AuditEvent }>("/api/operations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entity: "approval",
          action: "decide",
          record: {
            id: approval.id,
            version: approval.version ?? 1,
            status,
            comment: trimmedReason,
            reason: trimmedReason,
            confirmed: true,
            basisHash: approval.basisHash,
            documentVersion: approval.documentVersion,
            documentSha256: approval.documentSha256,
          },
        }),
      });
      setApprovals((current) => current.map((item) => item.id === approval.id ? payload.approval : item));
      applyAgreement(payload.agreement);
      applyEvent(payload.event);
      closeApprovalDecision();
      notify(status === "Approved"
        ? payload.agreement.approvalStatus === "Approved"
          ? "Approval recorded. Every required decision is complete."
          : "Approval recorded. Additional required decisions are still pending."
        : "Changes requested and routed to the owner.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The approval decision could not be recorded.");
    } finally {
      setApprovalDecisionBusy(false);
    }
  }

  async function claimApproval(approval: Approval) {
    if (!canClaimApproval(approval)) return notify("This approval cannot be claimed by the current user.");
    try {
      const payload = await requestJson<{ approval: Approval; event: AuditEvent }>("/api/operations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entity: "approval", action: "claim", record: { id: approval.id, version: approval.version ?? 1 } }),
      });
      setApprovals((current) => current.map((item) => item.id === approval.id ? payload.approval : item));
      applyEvent(payload.event);
      notify("Approval assigned to you. Review the current paper before deciding.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The approval could not be claimed.");
    }
  }

  function openObligationCompletion(obligation: Obligation) {
    const assignedOwner = Boolean(session?.user.id && obligation.ownerUserId === session.user.id);
    if (!canWriteObligations && !(canFulfillObligations && assignedOwner)) {
      return notify("Only the assigned owner or a Legal/Admin override can fulfill this obligation.");
    }
    setObligationCompletion(obligation);
    setObligationCompletionEvidence(completionEvidence);
    setObligationOverrideReason("");
    setObligationCompletionConfirmed(false);
  }

  function closeObligationCompletion() {
    if (obligationCompletionBusy) return;
    setObligationCompletion(null);
    setObligationCompletionEvidence("");
    setObligationOverrideReason("");
    setObligationCompletionConfirmed(false);
  }

  async function completeObligation() {
    const obligation = obligationCompletion;
    if (!obligation || obligationCompletionBusy) return;
    const evidence = obligationCompletionEvidence.trim();
    const assignedOwner = Boolean(session?.user.id && obligation.ownerUserId === session.user.id);
    const isOverride = !assignedOwner;
    if (!evidence) return notifyError("Describe the evidence that proves fulfillment.");
    if (!obligationCompletionConfirmed) return notifyError("Confirm that this evidence proves the exact occurrence before completing it.");
    if (isOverride && (!canWriteObligations || obligationOverrideReason.trim().length < 8)) {
      return notifyError("A Legal/Admin override requires a specific reason of at least 8 characters.");
    }
    if (!canWriteObligations && !(canFulfillObligations && assignedOwner)) {
      return notifyError("Your current role or assignment no longer permits this fulfillment.");
    }
    setObligationCompletionBusy(true);
    setCompletionEvidence(evidence);
    if (session?.mode === "evaluation" && obligation.evaluationOnly) {
      const recordedAt = new Date().toISOString();
      const evaluationEvidence: ObligationEvidence = {
        id: `evaluation-evidence-${crypto.randomUUID()}`,
        agreementId: obligation.agreementId,
        obligationId: obligation.id,
        evidenceText: evidence,
        evidenceSha256: null,
        submittedByUserId: session.user.id,
        overrideReason: isOverride ? obligationOverrideReason.trim() : null,
        provenance: "evaluation",
        createdAt: recordedAt,
        evaluationOnly: true,
      };
      setObligations((current) => current.map((item) => item.id === obligation.id ? {
        ...item,
        status: "Complete",
        completionEvidence: evidence,
        completedByUserId: session.user.id,
        completedAt: recordedAt,
        version: (item.version ?? 1) + 1,
      } : item));
      setObligationEvidence((current) => [evaluationEvidence, ...current.filter((item) => item.obligationId !== obligation.id)]);
      setObligationCompletion(null);
      setObligationCompletionEvidence("");
      setObligationOverrideReason("");
      setObligationCompletionConfirmed(false);
      setObligationEvidenceReview(evaluationEvidence);
      notifyInfo("Evaluation completion recorded only in this browser. No durable evidence, digest, reminder, or audit event was created.");
      setObligationCompletionBusy(false);
      return;
    }
    try {
      const payload = await requestJson<{ obligation: Obligation; evidence: ObligationEvidence; event: AuditEvent }>("/api/operations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entity: "obligation", action: "complete", record: {
          id: obligation.id,
          version: obligation.version ?? 1,
          evidence,
          ...(isOverride ? { overrideReason: obligationOverrideReason.trim() } : {}),
          confirmed: true,
        } }),
      });
      setObligations((current) => current.map((item) => item.id === obligation.id ? payload.obligation : item));
      setObligationEvidence((current) => [payload.evidence, ...current.filter((item) => item.obligationId !== obligation.id)]);
      applyEvent(payload.event);
      notify("Obligation marked complete with attributable evidence.");
      setObligationCompletion(null);
      setObligationCompletionEvidence("");
      setObligationOverrideReason("");
      setObligationCompletionConfirmed(false);
      setObligationEvidenceReview(payload.evidence);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The obligation could not be completed.");
    } finally {
      setObligationCompletionBusy(false);
    }
  }

  function obligationCreationRecovery(): ObligationCreationRecovery | null {
    try {
      const raw = window.sessionStorage.getItem(OBLIGATION_CREATION_RECOVERY_KEY);
      if (!raw) return null;
      const recovery = JSON.parse(raw) as ObligationCreationRecovery;
      const keyValid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(recovery.idempotencyKey ?? "");
      if (
        !session
        || recovery.workspaceId !== session.workspace.id
        || recovery.userId !== session.user.id
        || !keyValid
        || !recovery.requestBody
        || !Number.isSafeInteger(recovery.agreementId)
        || recovery.agreementId <= 0
      ) {
        window.sessionStorage.removeItem(OBLIGATION_CREATION_RECOVERY_KEY);
        return null;
      }
      return recovery;
    } catch {
      try { window.sessionStorage.removeItem(OBLIGATION_CREATION_RECOVERY_KEY); } catch { /* Storage may be unavailable. */ }
      return null;
    }
  }

  function resetObligationCreationForm() {
    const eligibleAgreements = agreements.filter((agreement) => agreement.stage === "Active" || agreement.signatureStatus === "Completed");
    const signedInOwner = eligibleObligationOwners.find((owner) => owner.userId === session?.user.id) ?? eligibleObligationOwners[0];
    setObligationAgreementId(eligibleAgreements[0]?.id ?? 0);
    setObligationTitle("");
    setObligationDue("");
    setObligationSource("");
    setObligationOwnerUserId(signedInOwner?.userId ?? "");
    setObligationRecurrence("once");
    setObligationTimeZone(detectedObligationTimeZone());
    setObligationReminderLeadDays([7, 0]);
    setObligationEndDate("");
    setObligationCreateConfirmed(false);
  }

  function clearObligationCreationRecovery(resetForm = true) {
    try { window.sessionStorage.removeItem(OBLIGATION_CREATION_RECOVERY_KEY); } catch { /* Storage may be unavailable. */ }
    obligationCreationKeyRef.current = crypto.randomUUID();
    obligationCreationBodyRef.current = "";
    setObligationCreationRecoveryLocked(false);
    if (resetForm) resetObligationCreationForm();
  }

  function openObligationCreator() {
    if (!canWriteObligations) return notifyError("Your workspace role does not allow obligation changes.");
    const recovery = obligationCreationRecovery();
    if (recovery) {
      obligationCreationKeyRef.current = recovery.idempotencyKey;
      obligationCreationBodyRef.current = recovery.requestBody;
      setObligationCreationRecoveryLocked(true);
      setObligationAgreementId(recovery.agreementId);
      setObligationTitle(recovery.title);
      setObligationSource(recovery.source);
      setObligationDue(recovery.dueDate);
      setObligationOwnerUserId(recovery.ownerUserId);
      setObligationRecurrence(recovery.recurrence);
      setObligationTimeZone(recovery.timezone);
      setObligationReminderLeadDays(recovery.reminderLeadDays);
      setObligationEndDate(recovery.endDate);
      setObligationCreateConfirmed(true);
    } else if (obligationCreationBodyRef.current) {
      setObligationCreationRecoveryLocked(true);
      setObligationCreateConfirmed(true);
    } else {
      clearObligationCreationRecovery();
    }
    setObligationOpen(true);
  }

  function closeObligationCreator() {
    if (obligationCreateBusy) return;
    setObligationOpen(false);
  }

  async function addObligation() {
    if (obligationCreateInFlightRef.current) return;
    if (!canWriteObligations) return notify("Your workspace role does not allow obligation changes.");
    if (!obligationAgreementId || !obligationTitle.trim() || !obligationDue.trim() || !obligationSource.trim()) {
      return notifyError("Choose an executed agreement and add the obligation, source, and first due date.");
    }
    if (!obligationOwnerUserId || !eligibleObligationOwners.some((owner) => owner.userId === obligationOwnerUserId)) {
      return notifyError("Choose an active eligible obligation owner.");
    }
    if (obligationReminderLeadDays.length === 0) return notifyError("Choose at least one reminder lead time.");
    if (!obligationCreateConfirmed) return notifyError("Confirm that you reviewed the obligation terms and schedule before creating it.");
    if (obligationRecurrence !== "once" && obligationDue < obligationCalendarDateInTimeZone(obligationTimeZone)) {
      return notifyError("A recurring schedule must begin today or later in its configured time zone.");
    }
    if (obligationRecurrence !== "once" && obligationEndDate && obligationEndDate < obligationDue) {
      return notifyError("The inclusive schedule end date cannot be before the first due date.");
    }
    const selectedAgreement = agreements.find((agreement) => agreement.id === obligationAgreementId);
    if (!selectedAgreement || (selectedAgreement.stage !== "Active" && selectedAgreement.signatureStatus !== "Completed")) {
      return notifyError("Select an active or completed agreement before creating post-signature work.");
    }
    const owner = eligibleObligationOwners.find((candidate) => candidate.userId === obligationOwnerUserId)!;
    const rule = obligationRecurrenceRule(obligationRecurrence);
    const reminderLeadDays = [...new Set(obligationReminderLeadDays)].sort((left, right) => right - left);
    const requestBody = obligationCreationBodyRef.current || JSON.stringify({
      entity: "obligation",
      action: "create",
      record: {
        agreementId: obligationAgreementId,
        title: obligationTitle.trim(),
        dueDate: obligationDue,
        ownerUserId: obligationOwnerUserId,
        source: obligationSource.trim(),
        recurrence: {
          ...rule,
          timezone: obligationTimeZone,
          reminderLeadDays,
          ...(obligationRecurrence !== "once" && obligationEndDate ? { endDate: obligationEndDate } : {}),
        },
        confirmed: true,
      },
    });
    const creationKey = obligationCreationKeyRef.current || crypto.randomUUID();
    obligationCreationKeyRef.current = creationKey;
    obligationCreationBodyRef.current = requestBody;

    if (session?.mode === "evaluation" && isEvaluationAgreement(obligationAgreementId)) {
      const scheduleId = `evaluation-schedule-${crypto.randomUUID()}`;
      const occurrenceId = `evaluation-obligation-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const schedule: ObligationSchedule = {
        id: scheduleId,
        agreementId: obligationAgreementId,
        version: 1,
        title: obligationTitle.trim(),
        source: obligationSource.trim(),
        owner: owner.displayName,
        ownerUserId: owner.userId,
        timezone: obligationTimeZone,
        recurrenceUnit: rule.unit,
        recurrenceInterval: rule.interval,
        anchorDate: obligationDue,
        endDate: obligationRecurrence !== "once" && obligationEndDate ? obligationEndDate : null,
        reminderLeadDays,
        status: rule.unit === "once" ? "ended" : "active",
        nextOccurrenceNumber: rule.unit === "once" ? null : 2,
        nextOccurrenceDate: null,
        nextMaterializationDate: null,
        createdAt: now,
        updatedAt: now,
        evaluationOnly: true,
      };
      const occurrence: Obligation = {
        id: occurrenceId,
        version: 1,
        agreementId: obligationAgreementId,
        scheduleId,
        occurrenceNumber: 1,
        title: schedule.title,
        dueDate: obligationDue,
        owner: owner.displayName,
        ownerUserId: owner.userId,
        status: "Open",
        cadence: obligationRecurrenceLabel(schedule),
        source: schedule.source,
        timezone: schedule.timezone,
        reminderLeadDays,
        nextReminderDate: null,
        evaluationOnly: true,
      };
      setObligationSchedules((current) => [schedule, ...current]);
      setObligations((current) => [occurrence, ...current]);
      clearObligationCreationRecovery();
      setObligationOpen(false);
      notifyInfo("Evaluation schedule created only in this browser. It will not run reminders, create future occurrences, or write audit evidence.");
      return;
    }

    setObligationCreationRecoveryLocked(true);
    try {
      window.sessionStorage.setItem(OBLIGATION_CREATION_RECOVERY_KEY, JSON.stringify({
        workspaceId: session?.workspace.id ?? "",
        userId: session?.user.id ?? "",
        idempotencyKey: creationKey,
        requestBody,
        agreementId: obligationAgreementId,
        title: obligationTitle,
        source: obligationSource,
        dueDate: obligationDue,
        ownerUserId: obligationOwnerUserId,
        recurrence: obligationRecurrence,
        timezone: obligationTimeZone,
        reminderLeadDays,
        endDate: obligationEndDate,
      } satisfies ObligationCreationRecovery));
    } catch {
      // The stable in-memory UUID and request body still protect retries in this tab.
    }
    obligationCreateInFlightRef.current = true;
    setObligationCreateBusy(true);
    try {
      const payload = await requestJson<{ schedule: ObligationSchedule; obligation: Obligation; event: AuditEvent; replay: boolean }>("/api/operations", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": creationKey },
        body: requestBody,
      });
      setObligationSchedules((current) => current.some((item) => item.id === payload.schedule.id)
        ? current.map((item) => item.id === payload.schedule.id ? payload.schedule : item)
        : [payload.schedule, ...current]);
      setObligations((current) => current.some((item) => item.id === payload.obligation.id)
        ? current.map((item) => item.id === payload.obligation.id ? payload.obligation : item)
        : [payload.obligation, ...current]);
      applyEvent(payload.event);
      clearObligationCreationRecovery();
      setObligationOpen(false);
      notify(payload.replay
        ? "The exact protected retry was recovered without creating a duplicate schedule."
        : "Obligation schedule and first occurrence created with attributable ownership.");
    } catch (error) {
      const ambiguous = !(error instanceof ApiRequestError) || error.status >= 500 || [408, 425, 429].includes(error.status);
      if (!ambiguous) clearObligationCreationRecovery(false);
      notifyError(error instanceof Error ? error.message : "The obligation could not be created.");
    } finally {
      obligationCreateInFlightRef.current = false;
      setObligationCreateBusy(false);
    }
  }

  function openObligationScheduleManagement(schedule: ObligationSchedule) {
    if (!canWriteObligations) return notifyError("Your workspace role does not allow schedule changes.");
    const defaultOwner = eligibleObligationOwners.find((owner) => owner.userId === session?.user.id)
      ?? eligibleObligationOwners.find((owner) => owner.userId !== schedule.ownerUserId)
      ?? eligibleObligationOwners[0];
    setObligationScheduleManagement(schedule);
    setObligationScheduleAction("reassign");
    setObligationScheduleOwnerUserId(defaultOwner?.userId ?? "");
    setObligationScheduleReason("");
    setObligationScheduleConfirmed(false);
  }

  function closeObligationScheduleManagement() {
    if (obligationScheduleBusy) return;
    setObligationScheduleManagement(null);
    setObligationScheduleReason("");
    setObligationScheduleConfirmed(false);
  }

  async function manageObligationSchedule() {
    const schedule = obligationScheduleManagement;
    if (!schedule || obligationScheduleBusy) return;
    const reason = obligationScheduleReason.trim();
    if (reason.length < 8) return notifyError("Add a specific schedule-change reason of at least 8 characters.");
    if (!obligationScheduleConfirmed) return notifyError("Confirm the exact schedule effect before applying it.");
    const reassigning = obligationScheduleAction === "reassign";
    const selectedOwner = eligibleObligationOwners.find((owner) => owner.userId === obligationScheduleOwnerUserId);
    if (reassigning && (!selectedOwner || selectedOwner.userId === schedule.ownerUserId)) {
      return notifyError("Choose a different active eligible owner for this schedule.");
    }
    if (obligationScheduleAction === "resume" && !managedScheduleOwnerEligible) {
      return notifyError("Reassign this schedule to an active eligible owner before resuming future work.");
    }
    const nextStatus = obligationScheduleAction === "pause" ? "paused"
      : obligationScheduleAction === "resume" ? "active"
        : obligationScheduleAction === "end" ? "ended"
          : schedule.status;
    setObligationScheduleBusy(true);
    if (session?.mode === "evaluation" && schedule.evaluationOnly) {
      const schedulePatch: ObligationSchedule = reassigning
        ? { ...schedule, ownerUserId: selectedOwner!.userId, owner: selectedOwner!.displayName, version: schedule.version + 1 }
        : { ...schedule, status: nextStatus, version: schedule.version + 1 };
      setObligationSchedules((current) => current.map((item) => item.id === schedule.id ? schedulePatch : item));
      if (reassigning) {
        setObligations((current) => current.map((item) => item.scheduleId === schedule.id && item.status === "Open"
          ? { ...item, ownerUserId: selectedOwner!.userId, owner: selectedOwner!.displayName, version: (item.version ?? 1) + 1 }
          : item));
      }
      setObligationScheduleManagement(null);
      setObligationScheduleBusy(false);
      notifyInfo("Evaluation schedule changed only in this browser. No durable owner, cursor, reminder, or audit event was changed.");
      return;
    }
    try {
      if (reassigning) {
        const payload = await requestJson<{ schedule: ObligationSchedule; updatedOpenOccurrences: Obligation[]; event: AuditEvent }>("/api/operations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entity: "obligation", action: "reassign", record: {
            scheduleId: schedule.id,
            version: schedule.version,
            newOwnerUserId: selectedOwner!.userId,
            reason,
            includeOpenOccurrences: true,
            confirmed: true,
          } }),
        });
        const returnedOccurrences = new Map(payload.updatedOpenOccurrences.map((occurrence) => [occurrence.id, occurrence]));
        setObligationSchedules((current) => current.map((item) => item.id === schedule.id ? payload.schedule : item));
        setObligations((current) => current.map((item) => returnedOccurrences.get(item.id) ?? item));
        applyEvent(payload.event);
        notify("Schedule and every open occurrence reassigned with an attributable reason.");
      } else {
        const payload = await requestJson<{ schedule: ObligationSchedule; event: AuditEvent }>("/api/operations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entity: "obligation", action: "schedule_status", record: {
            scheduleId: schedule.id,
            version: schedule.version,
            status: nextStatus,
            reason,
            confirmed: true,
          } }),
        });
        setObligationSchedules((current) => current.map((item) => item.id === schedule.id ? payload.schedule : item));
        applyEvent(payload.event);
        notify(nextStatus === "paused" ? "Future occurrence creation paused." : nextStatus === "active" ? "Future occurrence creation resumed." : "Schedule ended irreversibly.");
      }
      setObligationScheduleManagement(null);
      setObligationScheduleReason("");
      setObligationScheduleConfirmed(false);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The obligation schedule could not be changed.");
    } finally {
      setObligationScheduleBusy(false);
    }
  }

  async function saveDetails() {
    if (!canUpdateAgreement) return notify("Your workspace role does not allow agreement changes.");
    const effectiveDate = dateInputValue(detailsDraft.effectiveDate);
    const expirationDate = dateInputValue(detailsDraft.expirationDate);
    if (detailsDraft.effectiveDate && !effectiveDate) return notifyError("Choose a valid effective date or clear the field.");
    if (detailsDraft.expirationDate && !expirationDate) return notifyError("Choose a valid expiration date or clear the field.");
    if (effectiveDate && expirationDate && expirationDate < effectiveDate) return notifyError("Expiration date cannot be before the effective date.");
    const patch: Partial<Agreement> = {
      party: detailsDraft.party.trim() || selected.party,
      type: detailsDraft.type.trim() || selected.type,
      side: detailsDraft.side,
      department: detailsDraft.department.trim() || selected.department,
      value: Number.isFinite(detailsDraft.value) ? detailsDraft.value : selected.value,
      valueMinor: Number.isSafeInteger(detailsDraft.valueMinor) ? detailsDraft.valueMinor : selected.valueMinor,
      currencyCode: detailsDraft.currencyCode ?? selected.currencyCode ?? "USD",
      owner: detailsDraft.owner.trim() || selected.owner,
      ownerUserId: detailsDraft.ownerUserId ?? selected.ownerUserId ?? null,
      primaryCounterpartyId: detailsDraft.primaryCounterpartyId ?? null,
      legalEntityId: detailsDraft.legalEntityId ?? null,
      governedTemplateVersionId: detailsDraft.governedTemplateVersionId ?? null,
      workflowDefinitionId: detailsDraft.workflowDefinitionId ?? null,
      effectiveDate,
      expirationDate,
      crm: detailsDraft.crm,
      crmRecord: detailsDraft.crmRecord,
    };
    try {
      const result = await saveAgreementChange(selected.id, patch);
      if (!result.unchanged) setDocumentReloadToken((value) => value + 1);
      notify(result.unchanged ? "No changes to save." : "Agreement details saved.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "Contract details could not be saved.");
    }
  }

  async function assessRisk() {
    if (!canAssessRisk) return notifyError("Your workspace role cannot record risk assessments.");
    const rationale = riskAssessmentRationale.trim();
    if (!rationale) return notifyError("Add the rationale for this risk assessment.");
    if (!riskAssessmentConfirmed) return notifyError("Confirm that you reviewed the exact saved working paper before assessing risk.");
    if (detailsDirty) return notifyError("Save or discard the pending contract-detail changes before assessing the current record.");
    if (isEvaluationAgreement(selected.id)) {
      const result = await saveAgreementChange(selected.id, { risk: riskAssessmentLevel });
      await recordEvent(selected.id, "Comment", `Recorded a labeled evaluation ${riskAssessmentLevel.toLowerCase()} risk assessment: ${rationale}`);
      setRiskAssessmentRationale("");
      setRiskAssessmentConfirmed(false);
      notifyInfo(result.unchanged ? "The evaluation risk level was already selected." : "Evaluation risk assessment recorded locally without production evidence.");
      return;
    }
    const basis = selectedWorkflowBasis?.riskAssessment;
    if (!basis || selectedWorkflowBasis?.agreementVersion !== (selected.version ?? 1)) {
      return notifyError("Reload the exact current working-paper basis before assessing risk.");
    }
    setRiskAssessmentBusy(true);
    try {
      const payload = await requestJson<{ agreement: Agreement; event: AuditEvent; riskBasisHash: string }>("/api/operations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entity: "risk",
          action: "assess",
          record: {
            agreementId: selected.id,
            agreementVersion: selected.version ?? 1,
            level: riskAssessmentLevel,
            rationale,
            basisHash: basis.basisHash,
            documentVersion: basis.documentVersion,
            documentSha256: basis.documentSha256,
            confirmed: true,
          },
        }),
      });
      applyAgreement(payload.agreement);
      applyEvent(payload.event);
      setRiskAssessmentRationale("");
      setRiskAssessmentConfirmed(false);
      setDocumentReloadToken((value) => value + 1);
      notify(`${riskAssessmentLevel} risk assessment recorded against the exact saved paper.`);
    } catch (error) {
      await reloadAgreements().catch(() => undefined);
      setDocumentReloadToken((value) => value + 1);
      notifyError(error instanceof Error ? error.message : "The risk assessment could not be recorded.");
    } finally {
      setRiskAssessmentBusy(false);
    }
  }

  async function advanceStage(agreement = selected) {
    if (!canUpdateAgreement) return notify("Your workspace role does not allow stage changes.");
    const currentIndex = stages.indexOf(agreement.stage);
    if (currentIndex === stages.length - 1) return notify("This agreement is already active.");
    const nextStage = stages[currentIndex + 1];
    if (isEvaluationAgreement(agreement.id)) {
      applyAgreement({ ...agreement, stage: nextStage, version: (agreement.version ?? 1) + 1, nextAction: nextStage === "Signature" ? "Prepare signature packet" : `Complete ${nextStage.toLowerCase()}`, signatureStatus: nextStage === "Signature" ? "Preparing" : agreement.signatureStatus });
      notify(`Evaluation agreement moved to ${nextStage}.`);
      return;
    }
    try {
      const payload = await requestJson<{ agreement: Agreement; event: AuditEvent }>("/api/agreements/transition", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: agreement.id, version: agreement.version ?? 1, toStage: nextStage }),
      });
      applyAgreement(payload.agreement);
      applyEvent(payload.event);
      notify(`Agreement moved to ${nextStage}.`);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The contract could not be advanced.");
    }
  }

  function completeSignature() {
    if (session?.mode !== "evaluation") {
      setSignOpen(false);
      notifyInfo("Signing finished. Verified signed evidence must arrive and be reviewed by an authorized human before the agreement can activate.");
      return;
    }
    const reviewRequired: Agreement = { ...selected, stage: "Signature", signatureStatus: "completed_review_required", nextAction: "Review completed signature evidence", updated: "Just now" };
    applyAgreement(reviewRequired);
    setEvaluationSigningReady(false);
    setSignOpen(false);
    notifyInfo("Evaluation signed evidence is ready for a labeled human-review simulation. It did not activate the contract or create production evidence.");
  }

  async function addComment() {
    if (!canAppendAudit) return notify("Your workspace role does not allow audit comments.");
    if (!comment.trim()) return;
    try {
      await recordEvent(selected.id, "Comment", comment.trim());
      setComment("");
      notify("Comment added to the audit trail.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The comment could not be recorded.");
    }
  }

  function beginDocumentEdit() {
    if (!canManageDocuments) return notifyError("Your workspace role does not allow document changes.");
    if (selectedDraftPending) return notifyError("Wait for the latest saved working draft to load.");
    if (selectedDraft?.status === "error") return notifyError("Resolve the document loading error before creating another version.");
    const content = selectedDraft?.status === "ready"
      ? selectedDraft.content
      : selectedHasImportedSource
        ? `${selected.type.toUpperCase()}\n\n[Paste OCR output or human-verified text from the retained imported source here.]`
        : assembleStarterDraft({
            organization: session?.workspace.name ?? "Our organization",
            party: selected.party,
            side: selected.side,
            type: selected.type,
            effectiveDate: selected.effectiveDate,
            governingLaw: selected.tags.find((tag) => tag.endsWith(" law"))?.slice(0, -4),
          });
    if (!content) return notifyError("The working draft has no content to edit.");
    setDocumentEditBaseText(content);
    setDocumentEditText(content);
    setEditing(true);
  }

  function cancelDocumentEdit() {
    requestDraftDecision(discardDocumentEdit);
  }

  async function downloadSourceDocument(source: SourceDocumentSummary) {
    if (!canReadDocuments) return notify("Your workspace role does not allow document access.");
    try {
      const response = await fetch(`/api/documents/${source.id}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string | { message?: string } };
        const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
        throw new Error(message ?? "The imported source could not be downloaded.");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = source.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      if (canAppendAudit) void recordEvent(selected.id, "Export", `Downloaded source document ${source.fileName} (${source.sha256.slice(0, 12)}…).`).catch(() => undefined);
      notify("Protected source document downloaded.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The uploaded source could not be downloaded.");
    }
  }

  function downloadDraft() {
    if (!canReadDocuments) return notifyError("Your workspace role does not allow document access.");
    if (editing) return notifyError("Save or discard your edits before downloading. Notice downloads only the exact saved working draft.");
    if (selectedDraftPending) return notifyError("Wait for the latest saved working draft to load.");
    if (selectedDraft?.status === "error") return notifyError("The latest saved working draft must load before it can be downloaded.");
    if (selectedDraft?.status !== "ready") return notifyError(selectedHasImportedSource ? "This uploaded contract has no readable saved working draft to download yet." : "Create and save a working draft before downloading.");
    const body = selectedDraft.content;
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selected.party.replaceAll(" ", "-").toLowerCase()}-${selected.type.replaceAll(" ", "-").toLowerCase()}-v${selectedDraft.version}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    if (canAppendAudit) {
      const digest = selectedDraft.sha256 ? ` (${selectedDraft.sha256.slice(0, 12)}…)` : "";
      void recordEvent(selected.id, "Export", `Downloaded saved working draft v${selectedDraft.version}${digest}.`).catch((error) => notifyError(error instanceof Error ? error.message : "The download event could not be recorded."));
    }
    notify(canAppendAudit ? `Saved working draft v${selectedDraft.version} downloaded and recorded.` : `Saved working draft v${selectedDraft.version} downloaded with read-only access.`);
  }

  async function saveDocumentVersion(): Promise<boolean> {
    if (!canManageDocuments) { notifyError("Your workspace role does not allow document changes."); return false; }
    const content = documentEditText.trim();
    if (!content) { notifyError("The working draft has no content to save."); return false; }
    if (isEvaluationAgreement(selected.id)) {
      const version = selectedDraft?.status === "ready" ? selectedDraft.version + 1 : 1;
      setDocumentDrafts((current) => ({ ...current, [selected.id]: { status: "ready", content, version } }));
      discardDocumentEdit();
      notifyInfo("Evaluation edit saved locally. Production writes an immutable content version.");
      return true;
    }
    try {
      const payload = await requestJson<{ agreement: Agreement; event: AuditEvent; version: DocumentVersionSummary }>(`/api/agreements/${selected.id}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, contentType: "text/plain", label: "Working draft", expectedAgreementVersion: selected.version ?? 1 }),
      });
      applyAgreement(payload.agreement);
      applyEvent(payload.event);
      setDocumentDrafts((current) => ({ ...current, [selected.id]: { status: "ready", content, version: payload.version.version, sha256: payload.version.sha256 } }));
      setDocumentReloadToken((value) => value + 1);
      discardDocumentEdit();
      notify(`Working draft v${payload.version.version} was saved with immutable evidence.`);
      return true;
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The working draft could not be saved.");
      return false;
    }
  }

  async function sendReminders(kind: "approvals" | "obligations", ids?: string[]) {
    if (!canSendNotifications) return notify("Your workspace role does not allow reminder delivery.");
    try {
      const payload = await requestJson<{ queued: number; skipped: number }>("/api/reminders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, ids }),
      });
      notify(`${payload.queued} reminder${payload.queued === 1 ? "" : "s"} queued${payload.skipped ? `; ${payload.skipped} skipped because no member recipient is assigned` : ""}.`);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "Reminders could not be queued.");
    }
  }

  async function downloadAudit() {
    if (!canReadAudit) return notify("Your workspace role does not allow audit evidence access.");
    try {
      const response = await fetch(`/api/agreements/${selected.id}/audit`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: { message?: string } | string };
        throw new Error(typeof payload.error === "string" ? payload.error : payload.error?.message ?? "Audit export failed.");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `notice-agreement-${selected.id}-audit.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      notify("Integrity-verified audit evidence downloaded.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "Audit evidence could not be exported.");
    }
  }

  async function startSignaturePacket() {
    if (!canUpdateAgreement) return notify("Your workspace role does not allow signature packet changes.");
    const parties = signatureParties.map((party) => ({ role: party.role.trim(), name: party.name.trim(), email: party.email.trim() }));
    if (parties.some((party) => !party.role || !party.name || !party.email)) return notify("Add a role, name, and email for every signer.");
    const normalizedEmails = parties.map((party) => party.email.toLowerCase());
    if (new Set(normalizedEmails).size !== normalizedEmails.length) return notify("Each signer must use a unique email address.");
    if (session?.mode === "evaluation") {
      setEvaluationSigningReady(true);
      return;
    }
    try {
      const payload = await requestJson<{ embedSrc: string | null; signaturePacket: SignaturePacket; agreement: Agreement; event: AuditEvent }>("/api/signatures", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agreementId: selected.id, version: selected.version ?? 1, parties }),
      });
      applyAgreement(payload.agreement);
      applyEvent(payload.event);
      setSignaturePackets((current) => [payload.signaturePacket, ...current.filter((packet) => packet.id !== payload.signaturePacket.id)]);
      if (!payload.embedSrc) notify("Signature packet created. The signer will use the provider delivery flow.");
    } catch (error) {
      await Promise.allSettled([reloadSignatures(), reloadAgreements()]);
      notifyError(error instanceof Error ? error.message : "The signature packet could not be created.");
    }
  }

  async function reconcileSignaturePacket() {
    if (!selectedSignaturePacket || !selectedSignatureCanRefresh) return notify("This packet does not need provider reconciliation.");
    try {
      const payload = await requestJson<{ signaturePacket: SignaturePacket; agreement: Agreement; event?: AuditEvent; basisCurrent?: boolean; reconciled: boolean; providerStatus?: string }>("/api/signatures", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packetId: selectedSignaturePacket.id, version: selectedSignaturePacket.version }),
      });
      setSignaturePackets((current) => [payload.signaturePacket, ...current.filter((packet) => packet.id !== payload.signaturePacket.id)]);
      applyAgreement(payload.agreement);
      applyEvent(payload.event);
      notify(payload.signaturePacket.status === "completed_review_required"
        ? "Signed evidence is ready for required human review. The agreement remains in Signature until that review is recorded."
        : payload.basisCurrent === false
        ? "Provider packet recovered, but its working-paper basis needs operator review."
        : payload.reconciled
          ? `Provider packet reconciled${payload.providerStatus ? ` (${payload.providerStatus})` : ""}.`
          : `Provider packet is still ${payload.providerStatus ?? "pending"}.`);
    } catch (error) {
      await Promise.allSettled([reloadSignatures(), reloadAgreements()]);
      notifyError(error instanceof Error ? error.message : "The provider packet could not be reconciled.");
    }
  }

  function openSignatureEvidenceReview(agreement: Agreement, packet: SignaturePacket) {
    if (packet.status !== "completed_review_required") return notifyError("This signature packet is not awaiting completed-evidence review.");
    if (!canReviewCompletedSignature) return notifyError("Only an authorized Legal or Admin member with document-management access can complete signed-evidence review.");
    setSignOpen(false);
    setSignatureReview({ agreementId: agreement.id, packetId: packet.id });
    setSignatureReviewReason("");
    setSignatureReviewConfirmed(false);
  }

  function closeSignatureEvidenceReview() {
    if (signatureReviewBusy) return;
    setSignatureReview(null);
    setSignatureReviewReason("");
    setSignatureReviewConfirmed(false);
  }

  async function downloadSignatureEvidence(packet: SignaturePacket, agreement: Agreement) {
    if (!canReadDocuments || !packet.evidenceDocumentId) return notifyError("The protected final signed artifact is not available to your role.");
    try {
      const response = await fetch(`/api/documents/${packet.evidenceDocumentId}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string | { message?: string } };
        const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
        throw new Error(message ?? "The final signed artifact could not be downloaded.");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${agreement.party.replaceAll(" ", "-").toLowerCase()}-signed-evidence.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
      notifyInfo("Protected signed artifact downloaded. Verify its displayed SHA-256 before confirming review.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The final signed artifact could not be downloaded.");
    }
  }

  async function reviewCompletedSignatureEvidence() {
    const packet = signatureReviewPacket;
    const agreement = signatureReviewAgreement;
    const reason = signatureReviewReason.trim();
    if (!packet || !agreement || packet.status !== "completed_review_required") return notifyError("Refresh the signature queue before recording this review.");
    if (!canReviewCompletedSignature) return notifyError("Your current role cannot complete signed-evidence review.");
    if (!reason) return notifyError("Add a reason describing the completed-evidence review.");
    if (!signatureReviewConfirmed) return notifyError("Confirm review of the exact final artifact and approved basis.");
    if (!packet.basisHash || !packet.documentVersion || !packet.documentSha256 || !packet.evidenceDocumentId || !packet.finalArtifactSha256) {
      return notifyError("The packet is missing exact signed-evidence fields. Refresh provider state and do not activate it manually.");
    }
    setSignatureReviewBusy(true);
    try {
      const payload = await requestJson<{ signaturePacket: SignaturePacket; agreement: Agreement; event?: AuditEvent; reviewed: boolean; activated: boolean; reconciled: boolean }>("/api/signatures", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "review_completed",
          packetId: packet.id,
          version: packet.version,
          agreementVersion: agreement.version ?? 1,
          basisHash: packet.basisHash,
          documentVersion: packet.documentVersion,
          documentSha256: packet.documentSha256,
          evidenceDocumentId: packet.evidenceDocumentId,
          finalArtifactSha256: packet.finalArtifactSha256,
          confirmed: true,
          confirmation: FINAL_SIGNATURE_REVIEW_CONFIRMATION,
          reason,
        }),
      });
      setSignaturePackets((current) => [payload.signaturePacket, ...current.filter((candidate) => candidate.id !== payload.signaturePacket.id)]);
      applyAgreement(payload.agreement);
      applyEvent(payload.event);
      closeSignatureEvidenceReview();
      notify(payload.reviewed && payload.activated
        ? "Signed evidence review recorded. The agreement is now active."
        : "The review was recorded, but activation was not confirmed. Refresh before taking another action.");
    } catch (error) {
      await Promise.allSettled([reloadSignatures(), reloadAgreements()]);
      notifyError(error instanceof Error ? error.message : "The completed signature evidence review could not be recorded.");
    } finally {
      setSignatureReviewBusy(false);
    }
  }

  async function abandonUnmappedSignaturePacket() {
    if (!selectedSignaturePacket || !selectedSignatureCanBeAbandoned || !canManageWorkspace) return notify("This packet is not eligible for administrator release.");
    if (!window.confirm("Verify with DocuSeal and release this packet only if no provider submission exists?")) return;
    try {
      const payload = await requestJson<{ signaturePacket: SignaturePacket; agreement: Agreement; event?: AuditEvent; abandoned: boolean }>("/api/signatures", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packetId: selectedSignaturePacket.id, version: selectedSignaturePacket.version, action: "abandon_unmapped" }),
      });
      setSignaturePackets((current) => [payload.signaturePacket, ...current.filter((packet) => packet.id !== payload.signaturePacket.id)]);
      applyAgreement(payload.agreement);
      applyEvent(payload.event);
      notify(payload.abandoned ? "No provider submission was found; the retained packet was safely released." : "The packet was not released.");
    } catch (error) {
      await Promise.allSettled([reloadSignatures(), reloadAgreements()]);
      notifyError(error instanceof Error ? error.message : "The unmapped packet could not be released.");
    }
  }

  async function supersedeArchivedSignaturePacket() {
    if (!selectedSignaturePacket || !selectedSignatureCanBeSuperseded || !canManageWorkspace) return notify("This packet is not eligible for administrator supersession.");
    if (!window.confirm("Supersede this provider-confirmed archived packet and allow a replacement? Any later completion will be retained but will not activate the agreement.")) return;
    try {
      const payload = await requestJson<{ signaturePacket: SignaturePacket; agreement: Agreement; event?: AuditEvent; superseded: boolean }>("/api/signatures", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packetId: selectedSignaturePacket.id, version: selectedSignaturePacket.version, action: "supersede_archived" }),
      });
      setSignaturePackets((current) => [payload.signaturePacket, ...current.filter((packet) => packet.id !== payload.signaturePacket.id)]);
      applyAgreement(payload.agreement);
      applyEvent(payload.event);
      notify(payload.superseded ? "The archived packet was superseded; a replacement can now be prepared." : "The archived packet was not superseded.");
    } catch (error) {
      await Promise.allSettled([reloadSignatures(), reloadAgreements()]);
      notifyError(error instanceof Error ? error.message : "The archived packet could not be superseded.");
    }
  }

  async function openSigningRoom(agreement = selected) {
    if (!canUpdateAgreement) return notify("Your workspace role does not allow signature packet changes.");
    selectAgreementState(agreement);
    let signerRoles: string[] = [];
    const existingPacket = signaturePackets.find((packet) => packet.agreementId === agreement.id && new Set(["creating", "pending", "partially_signed", "reconciling", "archived", "completed_review_required"]).has(packet.status));
    if (session?.mode === "production" && !existingPacket) {
      try {
        const payload = await requestJson<{ signaturePackets: SignaturePacket[]; signerRoles: string[] }>("/api/signatures?include=provider_roles");
        setSignaturePackets(payload.signaturePackets);
        signerRoles = payload.signerRoles;
        if (signerRoles.length === 0) throw new Error("The configured DocuSeal template has no signer roles.");
      } catch (error) {
        notifyError(error instanceof Error ? error.message : "DocuSeal signer roles could not be loaded.");
        return;
      }
    }
    setSignatureProviderRoles(signerRoles);
    setSignatureParties(signerRoles.length > 0
      ? signerRoles.map((role) => ({ role, name: "", email: "" }))
      : [{ role: "Counterparty", name: "", email: "" }]);
    setEvaluationSigningReady(false);
    setSignOpen(true);
  }

  const loadEnterpriseChoices = useCallback(async () => {
    if (!session) return;
    setEnterpriseChoicesLoading(true);
    setEnterpriseChoicesError("");
    const canLoadAdminChoices = session.permissions.includes("workspace:admin");
    const results = await Promise.allSettled([
      requestJson<{ templates: PublishedTemplate[] }>("/api/templates"),
      ...(canLoadAdminChoices ? [
        requestJson<{ legalEntities: EnterpriseLegalEntity[] }>("/api/admin/configuration/legal-entities?limit=200"),
        requestJson<{ counterparties: EnterpriseCounterparty[] }>("/api/admin/configuration/counterparties?limit=200"),
        requestJson<{ workflows: EnterpriseWorkflow[] }>("/api/admin/configuration/workflows?limit=200"),
      ] : []),
    ]);
    if (results[0]?.status === "fulfilled") setPublishedTemplates(results[0].value.templates ?? []);
    if (canLoadAdminChoices) {
      const entityResult = results[1];
      const counterpartyResult = results[2];
      const workflowResult = results[3];
      if (entityResult?.status === "fulfilled") setEnterpriseLegalEntities((entityResult.value as { legalEntities: EnterpriseLegalEntity[] }).legalEntities ?? []);
      if (counterpartyResult?.status === "fulfilled") setEnterpriseCounterparties((counterpartyResult.value as { counterparties: EnterpriseCounterparty[] }).counterparties ?? []);
      if (workflowResult?.status === "fulfilled") setEnterpriseWorkflows((workflowResult.value as { workflows: EnterpriseWorkflow[] }).workflows ?? []);
    }
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") setEnterpriseChoicesError(failure.reason instanceof Error ? failure.reason.message : "Enterprise choices could not be loaded.");
    setEnterpriseChoicesLoading(false);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(() => void loadEnterpriseChoices(), 0);
    return () => window.clearTimeout(timer);
  }, [loadEnterpriseChoices, session]);

  async function loadAdmin() {
    setAdminLoading(true);
    setAdminError("");
    const readinessRequest = fetch("/api/readiness").then(async (response) => {
      const payload = await response.json() as ReadinessData & { error?: string };
      if (!response.ok && !payload.code && !payload.customer) throw new Error(payload.error ?? "Readiness could not be loaded.");
      return payload;
    });
    const results = await Promise.allSettled([
      readinessRequest,
      requestJson<{ members: WorkspaceMember[] }>("/api/admin/memberships"),
      requestJson<{ integrations: IntegrationStatus[] }>("/api/admin/integrations"),
      requestJson<{ agreements: CrmResyncCandidate[]; nextCursor: string | null }>("/api/admin/integrations/resync"),
      requestJson<{ principals: AgentPrincipal[] }>("/api/admin/agent-principals"),
      requestJson<{ grants: AgentGrant[] }>("/api/admin/agent-grants"),
      requestJson<{ plans: AgentPlanSummary[]; nextCursor: string | null }>("/api/admin/agent-plans?limit=25"),
    ]);
    if (results[0].status === "fulfilled") setReadiness(results[0].value);
    if (results[1].status === "fulfilled") setMembers(results[1].value.members ?? []);
    if (results[2].status === "fulfilled") {
      setIntegrations(results[2].value.integrations ?? []);
      const next = { HubSpot: false, Salesforce: false, "Custom CRM": false };
      for (const integration of results[2].value.integrations ?? []) {
        if (integration.id !== "crm" || !integration.configured) continue;
        if (integration.provider === "hubspot") next.HubSpot = true;
        if (integration.provider === "salesforce") next.Salesforce = true;
        if (integration.provider === "custom") next["Custom CRM"] = true;
      }
      setConnections(next);
    }
    if (results[3].status === "fulfilled") {
      const candidates = results[3].value.agreements ?? [];
      setCrmResyncCandidates(candidates);
      setCrmResyncNextCursor(results[3].value.nextCursor ?? null);
      const eligible = candidates.filter((candidate) => candidate.eligibleActions.includes(crmResyncAction));
      setCrmResyncAgreementId((current) => eligible.some((candidate) => candidate.id === current) ? current : eligible[0]?.id ?? 0);
    }
    if (results[4].status === "fulfilled") {
      const principals = results[4].value.principals ?? [];
      setAgentPrincipals(principals);
      setAgentGrantPrincipalId((current) => principals.some((principal) => principal.id === current && principal.status === "active")
        ? current
        : principals.find((principal) => principal.status === "active")?.id ?? "");
    }
    if (results[5].status === "fulfilled") setAgentGrants(results[5].value.grants ?? []);
    if (results[6].status === "fulfilled") {
      setAgentPlans(results[6].value.plans ?? []);
      setAgentPlanNextCursor(results[6].value.nextCursor ?? null);
    }
    setAgentGrantAgreementId((current) => agreements.some((agreement) => agreement.id === current)
      ? current
      : agreements[0]?.id ?? 0);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") setAdminError(failure.reason instanceof Error ? failure.reason.message : "Some setup information could not be loaded.");
    setAdminLoading(false);
  }

  async function createAgentPrincipal() {
    if (agentPrincipalName.trim().length < 2 || !agentPrincipalCommonName.trim()) {
      return notify("Add a service-principal name and its exact verified Cloudflare common name.");
    }
    setAgentAdminBusy(true);
    try {
      await requestJson("/api/admin/agent-principals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: agentPrincipalName.trim(),
          commonName: agentPrincipalCommonName.trim(),
        }),
      });
      setAgentPrincipalName("");
      setAgentPrincipalCommonName("");
      await loadAdmin();
      notify("Service principal registered without storing a bearer secret.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The service principal could not be registered.");
    } finally {
      setAgentAdminBusy(false);
    }
  }

  async function setAgentPrincipalStatus(principal: AgentPrincipal) {
    if (agentAdminReason.trim().length < 8) return notify("Add an audit reason of at least eight characters.");
    const status = principal.status === "active" ? "disabled" : "active";
    if (!window.confirm(`${status === "disabled" ? "Disable" : "Enable"} ${principal.name}? Active grants are re-evaluated on every request.`)) return;
    setAgentAdminBusy(true);
    try {
      await requestJson("/api/admin/agent-principals", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          principalId: principal.id,
          version: principal.version,
          status,
          reason: agentAdminReason.trim(),
        }),
      });
      await loadAdmin();
      notify(`Service principal ${status}.`);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The service principal could not be updated.");
    } finally {
      setAgentAdminBusy(false);
    }
  }

  async function createAgentGrant() {
    if (!agentGrantPrincipalId || !agentGrantAgreementId) return notify("Select an active principal and an agreement resource.");
    const actionIds = agentGrantAction === "agreement.read"
      ? ["agreement.read"]
      : ["agreement.read", agentGrantAction];
    setAgentAdminBusy(true);
    try {
      await requestJson("/api/admin/agent-grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          principalId: agentGrantPrincipalId,
          actionIds,
          resourceConstraints: { resources: [{ type: "agreement", ids: [String(agentGrantAgreementId)] }] },
          policyVersion: "v1",
          expiresAt: new Date(Date.now() + agentGrantDays * 24 * 60 * 60 * 1_000).toISOString(),
        }),
      });
      await loadAdmin();
      notify("Time-limited exact-resource agent grant created.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The agent grant could not be created.");
    } finally {
      setAgentAdminBusy(false);
    }
  }

  async function revokeAgentGrant(grant: AgentGrant) {
    if (agentAdminReason.trim().length < 8) return notify("Add an audit reason of at least eight characters.");
    if (!window.confirm("Revoke this exact grant now? The service principal will lose this authority on its next request.")) return;
    setAgentAdminBusy(true);
    try {
      await requestJson("/api/admin/agent-grants", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revoke", grantId: grant.id, version: grant.version, reason: agentAdminReason.trim() }),
      });
      await loadAdmin();
      notify("Agent grant revoked.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The agent grant could not be revoked.");
    } finally {
      setAgentAdminBusy(false);
    }
  }

  async function openAgentPlanReview(planId: string) {
    setAgentReviewBusy(true);
    try {
      const payload = await requestJson<{ plan: AgentPlanDetail }>(`/api/v1/plans/${encodeURIComponent(planId)}`);
      setAgentReviewPlan(payload.plan);
      setAgentReviewReason("");
      setAgentReviewConfirmed(false);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The exact agent plan could not be loaded.");
    } finally {
      setAgentReviewBusy(false);
    }
  }

  async function decideAgentPlan(decision: "approved" | "rejected") {
    if (!agentReviewPlan || agentReviewReason.trim().length < 8 || !agentReviewConfirmed) {
      return notify("Review the exact plan, add an eight-character reason, and confirm the decision.");
    }
    if (!agentReviewPlan.review.eligible) return notify("This plan is no longer eligible for a human decision.");
    setAgentReviewBusy(true);
    try {
      await requestJson(`/api/v1/plans/${encodeURIComponent(agentReviewPlan.id)}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedStatus: "pending_approval",
          planDigest: agentReviewPlan.planSha256,
          decision,
          reason: agentReviewReason.trim(),
          confirmed: true,
        }),
      });
      setAgentReviewPlan(null);
      setAgentReviewReason("");
      setAgentReviewConfirmed(false);
      await loadAdmin();
      notify(`Agent plan ${decision}.`);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The agent plan decision could not be recorded.");
    } finally {
      setAgentReviewBusy(false);
    }
  }

  async function loadMoreAgentPlans() {
    if (!agentPlanNextCursor || agentPlanPageBusy) return;
    setAgentPlanPageBusy(true);
    try {
      const payload = await requestJson<{ plans: AgentPlanSummary[]; nextCursor: string | null }>(
        `/api/admin/agent-plans?limit=25&cursor=${encodeURIComponent(agentPlanNextCursor)}`,
      );
      setAgentPlans((current) => {
        const byId = new Map(current.map((plan) => [plan.id, plan]));
        for (const plan of payload.plans ?? []) byId.set(plan.id, plan);
        return [...byId.values()];
      });
      setAgentPlanNextCursor(payload.nextCursor ?? null);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "More agent plans could not be loaded.");
    } finally {
      setAgentPlanPageBusy(false);
    }
  }

  async function inviteMember() {
    if (!inviteEmail.trim() || !inviteName.trim()) return notify("Add the member’s name and email.");
    try {
      await requestJson("/api/admin/memberships", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), displayName: inviteName.trim(), role: inviteRole }),
      });
      setInviteEmail("");
      setInviteName("");
      await loadAdmin();
      notify("Workspace access is ready for that verified email.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The member could not be added.");
    }
  }

  async function updateMember(member: WorkspaceMember, role: SessionData["role"], status = member.membershipStatus) {
    try {
      await requestJson("/api/admin/memberships", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: member.userId, role, status }),
      });
      await loadAdmin();
      notify("Member access updated.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "Member access could not be updated.");
    }
  }

  function openIdentityReplacement(member: WorkspaceMember) {
    setIdentityReplacementMember(member);
    setReplacementIdentitySubject("");
    setReplacementConfirmationEmail("");
  }

  async function replaceMemberIdentity() {
    if (!identityReplacementMember || !replacementIdentitySubject.trim()) {
      return notify("Enter the new verified SSO subject.");
    }
    try {
      await requestJson("/api/admin/memberships", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "replace_identity",
          userId: identityReplacementMember.userId,
          confirmationEmail: replacementConfirmationEmail.trim(),
          newIdentitySubject: replacementIdentitySubject.trim(),
        }),
      });
      setIdentityReplacementMember(null);
      setReplacementIdentitySubject("");
      setReplacementConfirmationEmail("");
      await loadAdmin();
      notify("SSO identity replaced. Review the audit event, then enable the member.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The SSO identity could not be replaced.");
    }
  }

  async function testIntegration(provider: string) {
    try {
      const payload = await requestJson<{ integration?: IntegrationStatus; message?: string }>("/api/admin/integrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      await loadAdmin();
      notify(payload.message ?? `${payload.integration?.label ?? provider} connection test passed.`);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The integration test failed.");
    }
  }

  async function resyncCrmAgreement() {
    const candidate = crmResyncCandidates.find((item) =>
      item.id === crmResyncAgreementId && item.eligibleActions.includes(crmResyncAction));
    if (!candidate) return notify(`Select an agreement eligible for a CRM ${crmResyncAction}.`);
    if (crmResyncReason.trim().length < 3) return notify("Add a short audit reason for the resync.");
    if (
      crmResyncAction === "legacy_cleanup_attestation"
      && (!crmLegacyCleanupConfirmed || crmLegacyCleanupConfirmation !== CRM_LEGACY_CLEANUP_CONFIRMATION)
    ) {
      return notify("Confirm the external legacy CRM cleanup and type the exact attestation sentence.");
    }
    if (
      crmResyncAction === "tombstone"
      && candidate.historicalCleanup
      && (!crmHistoricalCleanupConfirmed || crmHistoricalCleanupConfirmation !== CRM_HISTORICAL_CLEANUP_CONFIRMATION)
    ) {
      return notify("Confirm the historical-profile maintenance sequence and type the exact sentence.");
    }
    setCrmResyncBusy(true);
    try {
      const payload = await requestJson<{
        event?: { topic: string };
        crm: {
          provider?: string;
          mappingVersion?: string;
          attestedEvents?: number;
          hasMore?: boolean;
          deliveryQueued?: boolean;
          liveProfileReprojectionRequired?: boolean;
        };
      }>("/api/admin/integrations/resync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: crmResyncAction,
          agreementId: candidate.id,
          version: candidate.version,
          reason: crmResyncReason.trim(),
          ...(crmResyncAction === "legacy_cleanup_attestation" ? {
            legacyCleanupConfirmed: true,
            legacyCleanupConfirmation: crmLegacyCleanupConfirmation,
          } : {}),
          ...(crmResyncAction === "tombstone" && candidate.historicalCleanup ? {
            historicalCleanupConfirmed: true,
            historicalCleanupConfirmation: crmHistoricalCleanupConfirmation,
          } : {}),
        }),
      });
      await Promise.all([loadAdmin(), reloadAgreements()]);
      if (crmResyncAction === "legacy_cleanup_attestation") {
        setCrmLegacyCleanupConfirmed(false);
        setCrmLegacyCleanupConfirmation("");
        notify(`Recorded immutable cleanup evidence for ${payload.crm.attestedEvents ?? 0} legacy CRM event${payload.crm.attestedEvents === 1 ? "" : "s"}.${payload.crm.deliveryQueued ? " A fresh deletion tombstone was queued for the deleted agreement." : ""}${payload.crm.hasMore ? " Another bounded batch remains; review and attest again." : ""}`);
      } else {
        setCrmHistoricalCleanupConfirmed(false);
        setCrmHistoricalCleanupConfirmation("");
        notify(`${crmResyncAction === "tombstone" ? "CRM tombstone" : "Agreement projection"} queued for ${payload.crm.provider} mapping ${payload.crm.mappingVersion}.${payload.crm.liveProfileReprojectionRequired ? " After acceptance, restore and retest the intended live profile, then project this current record and reconcile provider state before resuming service." : ""}`);
      }
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The CRM resync could not be queued.");
    } finally {
      setCrmResyncBusy(false);
    }
  }

  function changeCrmResyncAction(action: CrmResyncAction) {
    setCrmResyncAction(action);
    setCrmLegacyCleanupConfirmed(false);
    setCrmLegacyCleanupConfirmation("");
    setCrmHistoricalCleanupConfirmed(false);
    setCrmHistoricalCleanupConfirmation("");
    const eligible = crmResyncCandidates.filter((candidate) => candidate.eligibleActions.includes(action));
    setCrmResyncAgreementId(eligible[0]?.id ?? 0);
  }

  async function loadMoreCrmResyncCandidates() {
    if (!crmResyncNextCursor || crmResyncPageBusy) return;
    setCrmResyncPageBusy(true);
    try {
      const payload = await requestJson<{ agreements: CrmResyncCandidate[]; nextCursor: string | null }>(
        `/api/admin/integrations/resync?cursor=${encodeURIComponent(crmResyncNextCursor)}`,
      );
      setCrmResyncCandidates((current) => {
        const byId = new Map(current.map((candidate) => [candidate.id, candidate]));
        for (const candidate of payload.agreements ?? []) byId.set(candidate.id, candidate);
        return [...byId.values()];
      });
      setCrmResyncNextCursor(payload.nextCursor ?? null);
      const firstEligible = (payload.agreements ?? []).find((candidate) => candidate.eligibleActions.includes(crmResyncAction));
      setCrmResyncAgreementId((current) => current || firstEligible?.id || 0);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "More CRM resync candidates could not be loaded.");
    } finally {
      setCrmResyncPageBusy(false);
    }
  }

  async function loadRetentionPolicy(agreementId: number) {
    try {
      const payload = await requestJson<{ policy: RetentionPolicy }>(`/api/admin/retention?agreementId=${agreementId}`);
      setRetentionPolicy(payload.policy);
    } catch {
      setRetentionPolicy(null);
    }
  }

  async function saveRetentionPolicy() {
    if (!retentionPolicy || retentionPolicy.id !== selected.id) return notify("Retention policy is still loading.");
    if (retentionReason.trim().length < 3) return notify("Add a reason for this records-policy change.");
    try {
      const payload = await requestJson<{ policy: RetentionPolicy; event: AuditEvent }>("/api/admin/retention", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetType: "agreement",
          targetId: selected.id,
          expectedVersion: retentionPolicy.version,
          legalHold: retentionPolicy.legalHold,
          retentionUntil: retentionPolicy.retentionUntil,
          reason: retentionReason.trim(),
          cascadeRetentionToDocuments: true,
        }),
      });
      setRetentionPolicy(payload.policy);
      applyEvent(payload.event);
      await reloadAgreements();
      notify("Retention and legal-hold policy saved with audit evidence.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "The records policy could not be saved.");
    }
  }

  async function downloadWorkspaceExport() {
    try {
      const response = await fetch("/api/admin/export");
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: { message?: string } | string };
        throw new Error(typeof payload.error === "string" ? payload.error : payload.error?.message ?? "Workspace export failed.");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `notice-${session?.workspace.slug ?? "workspace"}-export.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      notify("Signed workspace offboarding evidence downloaded.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "Workspace evidence could not be exported.");
    }
  }

  function openTemplate(template: string, side: AgreementSide) {
    if (!canCreateAgreement) return notify("Your workspace role does not allow agreement creation.");
    requestDraftDecision(() => {
      discardDocumentEdit();
      setWorkspaceTab("document");
      resetGenerator();
      setNewTemplate(template);
      setNewSide(side);
      setNewDepartment(side === "Sell-side" ? "Sales" : side === "Buy-side" ? "Procurement" : "Legal");
      setNewOpen(true);
      setNewStep(2);
    });
  }

  function openGovernedTemplate(template: PublishedTemplate) {
    if (!canCreateAgreement) return notify("Your workspace role does not allow agreement creation.");
    requestDraftDecision(() => {
      discardDocumentEdit();
      setWorkspaceTab("document");
      resetGenerator();
      setNewTemplate(template.agreementType);
      setNewSide(template.side);
      setNewGovernedTemplateVersionId(template.publishedVersion.id);
      const variables = template.publishedVersion.variableSchema.variables ?? {};
      setNewTemplateVariables(Object.fromEntries(Object.entries(variables).filter(([, definition]) => definition.source === "input").map(([name]) => [name, ""])));
      setNewDepartment(template.side === "Sell-side" ? "Sales" : template.side === "Buy-side" ? "Procurement" : "Legal");
      setNewOpen(true);
      setNewStep(2);
    });
  }

  function openNextAction(agreement: Agreement) {
    const action = agreement.nextAction.toLowerCase();
    const tab: WorkspaceTab = isActiveNegotiationQueueAction(agreement.nextAction) || action.includes("redline") || action.includes("flagged") || action.includes("counterparty return")
      ? "changes"
      : action.includes("approval") || action.includes("data") || action.includes("renewal") || action.includes("obligation")
        ? "details"
        : "document";
    openAgreement(agreement.id, tab);
  }

  function handleWorkspaceTabKey(event: ReactKeyboardEvent<HTMLButtonElement>, tab: WorkspaceTab) {
    const currentIndex = workspaceTabs.indexOf(tab);
    const nextIndex = event.key === "ArrowRight"
      ? (currentIndex + 1) % workspaceTabs.length
      : event.key === "ArrowLeft"
        ? (currentIndex - 1 + workspaceTabs.length) % workspaceTabs.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? workspaceTabs.length - 1
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextTab = workspaceTabs[nextIndex];
    openWorkspaceTab(nextTab);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']")[nextIndex]?.focus();
  }

  function runWorkspacePrimaryAction() {
    if (workspacePrimaryAction.kind === "obligations") return navigate("obligations");
    if (workspacePrimaryAction.kind === "signature_status") return navigate("signatures");
    if (workspacePrimaryAction.kind === "document_review") {
      return openWorkspaceTab(workspaceTab === "document" ? "details" : "document");
    }
    if (workspacePrimaryAction.kind === "signature") {
      if (!canUpdateAgreement) return notify("Your workspace role does not allow signature packet changes.");
      return openSigningRoom();
    }
    if (workspacePrimaryAction.kind === "counterparty_exchange" || workspacePrimaryAction.kind === "changes") return openWorkspaceTab("changes");
    if (workspacePrimaryAction.kind === "request_approval") {
      if (selectedIsSeedEvaluation) {
        notifyInfo("This evaluation contract is illustrative and is not persisted. Open the queue to explore its labeled sample approval workflow.");
        return navigate("approvals");
      }
      if (!canRequestApprovals) return navigate("approvals");
      void requestRequiredApprovals(selected).then(async (payload) => {
        await reloadAgreements();
        if (payload.createdRoles.length > 0) notify(`${payload.createdRoles.join(" and ")} approval work queued atomically.`);
        else {
          notify("Every required approval role is already routed.");
          navigate("approvals");
        }
      }).catch((error) => notifyError(error instanceof Error ? error.message : "Approval could not be requested."));
      return;
    }
    if (workspacePrimaryAction.kind === "review_approvals") return navigate("approvals");
    if (!canUpdateAgreement) return notify("Your workspace role does not allow stage changes.");
    if (selectedIsSeedEvaluation) return void advanceStage();
    if (selected.approvalStatus === "Approved" && canRequestApprovals) {
      void requestRequiredApprovals(selected).then(async (payload) => {
        await reloadAgreements();
        if (payload.agreement.approvalStatus !== "Approved") {
          notify(payload.createdRoles.length > 0
            ? `${payload.createdRoles.join(" and ")} approval work was re-routed before stage advancement.`
            : "Approval evidence needs reconciliation before stage advancement.");
          navigate("approvals");
          return;
        }
        await advanceStage(payload.agreement);
      }).catch((error) => notifyError(error instanceof Error ? error.message : "Approval evidence could not be reconciled."));
      return;
    }
    void advanceStage();
  }

  const workspacePrimaryLabel = workspacePrimaryAction.kind === "document_review" && workspaceTab === "document"
    ? "Continue to contract details"
    : workspacePrimaryAction.label;
  const canRunWorkspacePrimary = workspacePrimaryAction.available;

  const actionAgreements = agreements.filter((agreement) => agreement.stage !== "Active").slice(0, 5);
  const selectedApprovals = approvals.filter((approval) => approval.agreementId === selected.id);
  const approvalDecisionAgreement = approvalDecision
    ? agreements.find((agreement) => agreement.id === approvalDecision.approval.agreementId)
    : undefined;
  const approvalDecisionIsEvaluationSample = Boolean(
    approvalDecision
    && session?.mode === "evaluation"
    && seedApprovals.some((approval) => approval.id === approvalDecision.approval.id),
  );
  const approvalDecisionBasisComplete = Boolean(
    approvalDecision?.approval.basisHash
    && approvalDecision.approval.documentVersion
    && approvalDecision.approval.documentSha256,
  );
  const selectedObligations = obligations.filter((obligation) => obligation.agreementId === selected.id);
  const selectedEvents = events.filter((event) => event.agreementId === selected.id);
  const languageInsertionAgreement = agreements.find((agreement) => agreement.id === selectedId) ?? agreements[0];
  const pageLabel: Record<Exclude<View, "workspace">, string> = { today: "Today", portfolio: "Portfolio & work", agreements: "Contracts", intake: "Request intake", approvals: "Approvals", signatures: "Signatures", obligations: "Post-signature tasks", repository: "Repository", library: "Approved clauses", templates: "Templates", integrations: "Integrations", admin: "Enterprise setup" };

  return (
    <main className="clm-shell">
      <a className="skip-link" href="#workspace-content">Skip to workspace content</a>
      <aside ref={mobileNavigationRef} id="product-navigation" className={`clm-sidebar ${mobileNavOpen ? "open" : ""}`} role={compactNavigation ? "dialog" : undefined} aria-modal={compactNavigation && mobileNavOpen ? true : undefined} aria-label={compactNavigation ? "Product navigation" : undefined} aria-hidden={compactNavigation && !mobileNavOpen ? true : undefined} inert={compactNavigation && !mobileNavOpen}>
        <div className="brand-row">
          <button className="clm-brand" type="button" onClick={() => navigate("today")} aria-label="Notice home"><span className="clm-mark"><i /></span><b>NOTICE</b><em>CLM</em></button>
          <button ref={mobileCloseRef} className="mobile-close" type="button" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation">×</button>
        </div>
        <nav aria-label="Product navigation">
          <p>WORK</p>
          <NavButton active={view === "today"} glyph="✦" label="Today" count={String(actionAgreements.length)} onClick={() => navigate("today")} />
          <NavButton active={view === "portfolio"} glyph="◫" label="Portfolio & work" onClick={() => navigate("portfolio")} />
          <NavButton active={view === "agreements" || view === "workspace"} glyph="▤" label="Contracts" count={String(agreements.length)} onClick={() => navigate("agreements")} />
          <NavButton active={view === "intake"} glyph="↳" label="Request intake" onClick={() => navigate("intake")} />
          <NavButton active={view === "approvals"} glyph="✓" label="Approvals" count={String(pendingApprovals)} onClick={() => navigate("approvals")} />
          <NavButton active={view === "signatures"} glyph="✎" label="Signatures" count={String(agreements.filter((item) => item.stage === "Signature").length)} onClick={() => navigate("signatures")} />
          <NavButton active={view === "obligations"} glyph="◷" label="Post-signature tasks" count={String(activeObligations)} onClick={() => navigate("obligations")} />
          <p>BUILD</p>
          <NavButton active={view === "repository"} glyph="⌕" label="Repository" onClick={() => navigate("repository")} />
          <NavButton active={view === "templates"} glyph="▧" label="Templates" onClick={() => navigate("templates")} />
          <NavButton active={view === "library"} glyph="▦" label="Approved clauses" onClick={() => navigate("library")} />
          <NavButton active={view === "integrations"} glyph="⌁" label="Integrations" onClick={() => navigate("integrations")} />
          {canManageWorkspace && <NavButton active={view === "admin"} glyph="⚙" label="Setup & access" onClick={() => navigate("admin")} />}
          {canCreateAgreement && <button className="sidebar-create" type="button" onClick={openGenerator}><span>＋</span>Start from template <kbd>N</kbd></button>}
        </nav>
        <div className="side-foot"><span>{(session?.workspace.name ?? "Notice").split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase()}</span><div><b>{session?.workspace.name ?? "Secure workspace"}</b><small>{session?.mode === "evaluation" ? "Evaluation workspace" : "Production workspace"}</small></div>{canManageWorkspace && <button type="button" aria-label="Open workspace setup" onClick={() => navigate("admin")}>•••</button>}</div>
      </aside>

      {mobileNavOpen && <button className="nav-scrim" type="button" tabIndex={-1} aria-hidden="true" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}

      <section id="workspace-content" className="clm-main" aria-hidden={compactNavigation && mobileNavOpen ? true : undefined} inert={compactNavigation && mobileNavOpen}>
        <header className="clm-topbar">
          <button ref={mobileMenuRef} className="mobile-menu" type="button" data-modal-focus-fallback onClick={() => setMobileNavOpen(true)} aria-label="Open navigation" aria-controls="product-navigation" aria-expanded={mobileNavOpen}>☰</button>
          <div className="top-context"><span>{session?.workspace.name ?? "Notice"}</span><b>/</b><strong>{view === "workspace" ? selected.party : pageLabel[view as Exclude<View, "workspace">]}</strong></div>
          <label className="global-search"><span>⌕</span><input ref={searchRef} value={globalQuery} onChange={(event) => { setGlobalQuery(event.target.value); setCommandOpen(true); }} onFocus={() => setCommandOpen(true)} placeholder="Search everything or jump to…" aria-label="Global search" /><kbd>⌘ K</kbd></label>
          <button className="top-icon" type="button" data-modal-focus-fallback aria-label="Open command menu" onClick={() => setCommandOpen(true)}>＋</button>
          <div className="user-menu" ref={userMenuRef}>
            <button
              ref={userMenuButtonRef}
              className="top-avatar"
              type="button"
              aria-controls="account-menu"
              aria-expanded={userMenuOpen}
              aria-label={`Open account menu for ${session?.user.displayName ?? "signed-in user"}`}
              onClick={() => setUserMenuOpen((open) => !open)}
            >
              {(session?.user.displayName ?? "User").split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase()}
            </button>
            {userMenuOpen && (
              <div id="account-menu" className="user-menu-popover" role="region" aria-label="Account and workspace">
                <div className="user-menu-identity">
                  <b>{session?.user.displayName ?? "Signed-in user"}</b>
                  <small>{session?.user.email ?? "Identity unavailable"}</small>
                </div>
                <dl className="user-menu-context">
                  <div><dt>Role</dt><dd>{session?.role ?? "Unknown"}</dd></div>
                  <div><dt>Workspace</dt><dd>{session?.workspace.name ?? "Notice"}</dd></div>
                </dl>
                {canManageWorkspace && (
                  <button type="button" onClick={() => { setUserMenuOpen(false); navigate("admin"); }}>
                    <span>⚙</span><span><b>Setup &amp; access</b><small>Members, policy, integrations, and agents</small></span>
                  </button>
                )}
                {session?.mode === "production" ? (
                  <a href="/cdn-cgi/access/logout"><span>↗</span><span><b>Sign out of Notice</b><small>End the Cloudflare Access session</small></span></a>
                ) : (
                  <div className="user-menu-evaluation" role="status"><span>◇</span><span><b>Evaluation session</b><small>No production identity session to end</small></span></div>
                )}
              </div>
            )}
          </div>
        </header>

        {(loading || optionalLoading) && <div className="sync-line" role="status" aria-label={loading ? "Loading contracts" : "Loading workspace queues"}><i /></div>}
        {loadError && <div className="workspace-error" role="alert"><b>Workspace data could not be loaded.</b><span>{loadError}</span><button type="button" onClick={() => window.location.reload()}>Retry</button></div>}
        {optionalLoadErrors.length > 0 && <div className="workspace-warning" role="status"><b>Your contracts are available.</b><span>Some supporting data could not load: {optionalLoadErrors.join("; ")}.</span><button type="button" onClick={() => setOptionalReloadToken((value) => value + 1)}>Retry supporting data</button></div>}

        {view === "today" && (
          <div className="page-pad today-page">
            <section className="today-hero">
              <div><p className="overline"><span /> <time suppressHydrationWarning>{todayLabel}</time></p><h1>{actionAgreements.length === 0 ? "No contracts need a next move." : `${actionAgreements.length} contract${actionAgreements.length === 1 ? "" : "s"} need a next move.`}</h1><p>Revenue, spend, risk, and signature work from the current workspace record.</p></div>
              {(canImportAgreement || canCreateAgreement) && <div className="hero-actions">{canImportAgreement && <button type="button" className="primary-button" onClick={openImport}>↥ Upload a contract</button>}{canCreateAgreement && <button type="button" className={canImportAgreement ? "ghost-button" : "primary-button"} onClick={openGenerator}>＋ Start from template</button>}</div>}
            </section>

            {session?.mode === "production" && agreements.length === 0 && <section className="panel empty-state first-use-state"><span>◇</span><h3>Bring your first contract into Notice</h3><p>{canImportAgreement || canCreateAgreement ? "Upload existing paper or start from a clearly marked template. Human review and company-approved policy are still required before approval or signature." : "Your role has read-only access. Ask a workspace administrator to add a contract or grant the least-privilege role needed for intake."}</p><FirstUseChecklist />{(canImportAgreement || canCreateAgreement || canManageWorkspace) && <div className="empty-state-actions">{canImportAgreement && <button type="button" className="primary-button" onClick={openImport}>Upload a contract</button>}{canCreateAgreement && <button type="button" onClick={openGenerator}>Start from template</button>}{canManageWorkspace && <button type="button" onClick={() => navigate("admin")}>Review setup</button>}</div>}</section>}

            <section className="metric-grid" aria-label="Contract operations metrics">
              <MetricCard label="Contracts in motion" value={String(agreements.filter((item) => item.stage !== "Active").length)} note={agreementMetricScope} trend="Current" />
              <MetricCard label="Open approvals" value={String(pendingApprovals)} note="Awaiting a recorded decision" trend={pendingApprovals ? "Needs action" : "Clear"} />
              <MetricCard label="High-risk records" value={String(agreements.filter((item) => item.risk === "High").length)} note={agreementMetricScope} tone="risk" trend="Review" />
              <MetricCard label="Open obligations" value={String(activeObligations)} note="Owned post-signature work" tone="warn" trend={activeObligations ? "Track" : "Clear"} />
            </section>

            <section className="dashboard-grid">
              <article className="panel action-panel">
                <PanelHeading title="Move these forward" subtitle="The first five non-active contracts in the loaded workspace record." action="View all" onAction={() => navigate("agreements")} />
                <div className="action-list">
                  {actionAgreements.map((agreement, index) => (
                    <button type="button" key={agreement.id} onClick={() => openNextAction(agreement)}>
                      <span className={`action-rank r${index}`}>{index + 1}</span>
                      <span className={`party-logo ${agreement.side.toLowerCase().replace("-side", "")}`}>{agreement.initials}</span>
                      <span className="action-copy"><strong>{agreement.nextAction}</strong><small>{agreement.party} · {agreement.type}</small></span>
                      <span className={`lane-pill ${agreement.side.toLowerCase().replace("-side", "")}`}>{contractDirectionLabel(agreement.side)}</span>
                      <span className="due-text">{agreement.due}</span><span className="action-arrow">›</span>
                    </button>
                  ))}
                </div>
              </article>

              <article className="panel velocity-panel">
                <PanelHeading title="Agreement velocity" subtitle={workspaceAgreementEstatePartial ? "Loaded workspace records by stage; open the register to page through the remaining estate." : "Current loaded portfolio by stage."} />
                <div className="velocity-chart">
                  {stages.map((stage, index) => {
                    const count = stageCounts[index];
                    const height = count === 0 ? 0 : Math.max(18, Math.round((count / largestStageCount) * 100));
                    return <button key={stage} type="button" onClick={() => { setStageFilter(stage); navigate("agreements"); }}><i style={{ height: `${height}%` }} /><b>{count}</b><span>{stage}</span></button>;
                  })}
                </div>
                <div className="velocity-foot"><span><i className="good" /> {agreements.length} loaded records{workspaceAgreementEstatePartial ? ` · ${workspaceAgreementSavedLoadedCount} of ${workspaceAgreementTotalMatched} saved` : " in scope"}</span><span><i className="risk" /> {pendingApprovals} pending approvals</span></div>
              </article>
            </section>

            <section className="attention-grid">
              <article className="panel mini-queue"><PanelHeading title="Approvals" subtitle={`${pendingApprovals} waiting`} action="Open queue" onAction={() => navigate("approvals")} />{approvals.filter((item) => item.status === "Pending").slice(0, 3).map((approval) => <MiniQueueRow key={approval.id} avatar={approval.approver.split(" ").map((word) => word[0]).join("")} title={agreements.find((item) => item.id === approval.agreementId)?.party ?? "Agreement"} detail={`${approval.role} · ${approval.due}`} onOpen={() => openAgreement(approval.agreementId, "details")} />)}</article>
              <article className="panel mini-queue"><PanelHeading title="Signatures" subtitle="Packets in flight" action="Track all" onAction={() => navigate("signatures")} />{agreements.filter((item) => item.stage === "Signature").slice(0, 3).map((agreement) => <MiniQueueRow key={agreement.id} avatar={agreement.initials} title={agreement.party} detail={`${agreement.signatureStatus} · ${agreement.due}`} onOpen={() => openAgreement(agreement.id)} />)}</article>
              <article className="panel mini-queue"><PanelHeading title="Open obligations" subtitle="Current recorded commitments" action="Open queue" onAction={() => navigate("obligations")} />{obligations.filter((item) => item.status === "Open").slice(0, 3).map((obligation) => <MiniQueueRow key={obligation.id} avatar="◷" title={obligation.title} detail={`${agreements.find((item) => item.id === obligation.agreementId)?.party} · ${obligation.dueDate}`} onOpen={() => openAgreement(obligation.agreementId, "details")} />)}</article>
            </section>
          </div>
        )}

        {view === "portfolio" && <PortfolioWorkspace onOpenAgreement={(id) => openAgreement(id, "details", "portfolio")} />}

        {view === "intake" && session && <IntakeWorkspace session={session} onOpenAgreement={(id) => openAgreement(id, "details", "intake")} onAgreementCreated={async () => { await reloadAgreements(); }} />}

        {view === "repository" && <RepositoryIntelligenceWorkspace agreements={agreements} canReview={canManageDocuments} onOpenAgreement={(id) => openAgreement(id, "document", "repository")} />}

        {view === "agreements" && (
          <div className="page-pad agreements-page">
            <PageHeading eyebrow="CONTRACT WORKSPACE" title="Every contract, one living record." subtitle="Searchable, owned, and actionable from intake through post-signature work." actions={canImportAgreement || canCreateAgreement ? <>{canImportAgreement && <button type="button" className="primary-button" onClick={openImport}>↥ Upload a contract</button>}{canCreateAgreement && <button type="button" className="ghost-button" onClick={openGenerator}>＋ Start from template</button>}</> : undefined} />
            <section className="portfolio-strip"><div><span>Customer contracts</span><strong>{agreements.filter((item) => item.side === "Sell-side").length}</strong><small>{agreementMetricScope}</small></div><div><span>Supplier contracts</span><strong>{agreements.filter((item) => item.side === "Buy-side").length}</strong><small>{agreementMetricScope}</small></div><div><span>High-risk contracts</span><strong>{agreements.filter((item) => item.risk === "High").length}</strong><small>{agreementMetricScope}</small></div><div><span>Register query coverage</span><strong>{agreementSavedLoadedCount} / {agreementTotalMatched}</strong><small>Matching saved agreements loaded</small></div></section>
            <section className="panel agreements-card">
              {session && <AgreementSavedViewsBar currentUserId={session.user.id} isAdmin={session.role === "admin"} filters={{ side: sideFilter, stage: stageFilter, risk: riskFilter, query: agreementQuery, sort }} onApply={(saved) => {
                setSideFilter((["All", "Sell-side", "Buy-side", "Corporate"] as string[]).includes(saved.side) ? saved.side as typeof sideFilter : "All");
                setStageFilter((["All", ...stages] as string[]).includes(saved.stage) ? saved.stage as typeof stageFilter : "All");
                setRiskFilter((["All", "Unassessed", "High", "Medium", "Low"] as string[]).includes(saved.risk) ? saved.risk as typeof riskFilter : "All");
                setAgreementQuery(saved.query);
                setSort((["Updated", "Value", "Risk"] as string[]).includes(saved.sort) ? saved.sort as typeof sort : "Updated");
              }} />}
              <div className="list-toolbar">
                <label className="agreement-list-search">⌕ <input value={agreementQuery} onChange={(event) => setAgreementQuery(event.target.value)} placeholder="Search this register…" aria-label="Search agreement register" /></label>
                <div className="filter-group"><select value={sideFilter} onChange={(event) => setSideFilter(event.target.value as typeof sideFilter)} aria-label="Filter by contract direction"><option value="All">All contract directions</option><option value="Sell-side">Customer contracts</option><option value="Buy-side">Supplier contracts</option><option value="Corporate">Company contracts</option></select><select value={stageFilter} onChange={(event) => setStageFilter(event.target.value as typeof stageFilter)} aria-label="Filter by stage"><option>All</option>{stages.map((stage) => <option key={stage}>{stage}</option>)}</select><select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value as typeof riskFilter)} aria-label="Filter by risk"><option>All</option><option>Unassessed</option><option>High</option><option>Medium</option><option>Low</option></select></div>
                <div className="toolbar-meta"><span aria-live="polite">{!agreementRegisterCurrent ? "Searching the full register…" : agreementEstatePartial ? `${agreementSavedLoadedCount} of ${agreementTotalMatched} matching saved agreements loaded` : `${agreementTotalMatched} saved match${agreementTotalMatched === 1 ? "" : "es"}${registerEvaluationSampleCount > 0 ? ` + ${registerEvaluationSampleCount} browser sample${registerEvaluationSampleCount === 1 ? "" : "s"}` : ""}`}</span><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="Sort agreements"><option>Updated</option><option>Value</option><option>Risk</option></select><button type="button" onClick={() => { setSideFilter("All"); setStageFilter("All"); setRiskFilter("All"); setAgreementQuery(""); }}>Reset</button></div>
              </div>
              {selectedRows.length > 0 && <div className="bulk-bar"><strong>{selectedRows.length} selected</strong><span>Export the selected register rows without changing any contract.</span><button type="button" onClick={exportSelectedAgreements}>↓ Export CSV</button><button type="button" onClick={() => setSelectedRows([])}>Clear</button></div>}
              {agreementRegisterCurrent && <AgreementTable agreements={filtered} selectedRows={selectedRows} onSelect={(id) => setSelectedRows((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])} onSelectAll={() => setSelectedRows(selectedRows.length === filtered.length ? [] : filtered.map((item) => item.id))} onOpen={openAgreement} />}
              {(agreementRegisterCurrent && (agreementSavedLoadedCount > 0 || agreementTotalMatched > 0) || agreementPageError) && <div className="agreement-pagination" aria-busy={agreementPageBusy}>
                {agreementRegisterCurrent && <div><strong>{agreementEstatePartial ? `Loaded ${agreementSavedLoadedCount} of ${agreementTotalMatched} matching saved agreements` : `All ${agreementTotalMatched} matching saved agreements are loaded`}</strong><span>{agreementEstatePartial ? "Search and filters already cover the full saved register; load more to display the remaining matches." : registerEvaluationSampleCount > 0 ? `Results also include ${registerEvaluationSampleCount} labeled browser sample${registerEvaluationSampleCount === 1 ? "" : "s"}.` : "The server applied this search, filter, and sort to the full saved register."}</span></div>}
                {agreementPageError ? <div className="agreement-page-error" role="alert"><span>{agreementPageError}</span><button type="button" disabled={agreementPageBusy} onClick={() => void (agreementRegisterCurrent && agreementNextCursor ? loadMoreAgreements() : reloadAgreementRegister(agreementListControls))}>{agreementPageBusy ? "Retrying…" : "Retry"}</button></div> : agreementRegisterCurrent && agreementNextCursor && <button className="agreement-load-more" type="button" disabled={agreementPageBusy} onClick={() => void loadMoreAgreements()}>{agreementPageBusy ? "Loading more agreements…" : "Load more agreements"}</button>}
              </div>}
              {!agreementRegisterCurrent && !agreementPageError ? <div className="empty-state" role="status" aria-live="polite"><span>⌕</span><h3>Searching the full register…</h3><p>Notice is applying this search, filter, and sort across saved agreements.</p></div> : agreementRegisterCurrent && agreementTotalMatched === 0 && !workspaceAgreementEstatePartial && workspaceAgreementTotalMatched === 0 && agreementCurrentQueryKey === agreementListKey(defaultAgreementListControls) && session?.mode === "production" ? <div className="empty-state first-use-state"><span>◇</span><h3>No contracts have been added yet</h3><p>{canImportAgreement || canCreateAgreement ? "Upload security-scanned paper or start from a clearly marked template, then review it before approval." : "This workspace has no contract records yet. Ask an administrator, legal user, or requester to complete intake."}</p><FirstUseChecklist /><div className="empty-state-actions">{canImportAgreement && <button className="primary-button" type="button" onClick={openImport}>Upload a contract</button>}{canCreateAgreement && <button type="button" onClick={openGenerator}>Start from template</button>}{!canImportAgreement && !canCreateAgreement && canManageWorkspace && <button type="button" onClick={() => navigate("admin")}>Review workspace access</button>}</div></div> : agreementRegisterCurrent && filtered.length === 0 && <div className="empty-state"><span>⌕</span><h3>No contracts match these filters</h3><p>The full saved register was searched. Reset filters or try a different counterparty, owner, or term.</p><button type="button" onClick={() => { setSideFilter("All"); setStageFilter("All"); setRiskFilter("All"); setAgreementQuery(""); }}>Reset filters</button></div>}
            </section>
          </div>
        )}

        {view === "approvals" && (
          <div className="page-pad approvals-page">
            <PageHeading eyebrow="DECISIONS" title="Approval without the chase." subtitle="Recorded business context, risk, and decision history in one queue." actions={canSendNotifications ? <button className="ghost-button" type="button" onClick={() => void sendReminders("approvals")}>↗ Queue reminders</button> : undefined} />
            <div className="approval-summary"><article><span>Waiting</span><strong>{pendingApprovals}</strong><small>Pending decisions</small></article><article><span>Recorded decisions</span><strong>{approvals.filter((item) => item.status !== "Pending").length}</strong><small>In this workspace</small></article><article><span>Contracts blocked</span><strong>{agreements.filter((agreement) => new Set(["Required", "Pending", "Changes requested"]).has(agreement.approvalStatus)).length}</strong><small>{agreementMetricScope}</small></article></div>
            <section className="approval-list">
              {approvals.map((approval) => {
                const agreement = agreements.find((item) => item.id === approval.agreementId);
                if (!agreement) return null;
                return <article className={`approval-card ${approval.status.toLowerCase().replace(" ", "-")}`} key={approval.id}><div className="approval-person"><span>{approval.approver.split(" ").map((word) => word[0]).join("")}</span><div><small>{approval.role.toUpperCase()} APPROVAL</small><b>{approval.approver}</b><p>{approval.due}</p></div></div><button className="approval-contract card-open" type="button" onClick={() => openAgreement(agreement.id, "details")}><strong>{agreement.party}</strong><p>{agreement.type}</p><div><RiskBadge risk={agreement.risk} /><span>{contractDirectionLabel(agreement.side)}</span><span>{formatAgreementMoney(agreement)}</span></div><i aria-hidden="true">›</i></button><div className="approval-reason"><small>RECORDED REQUEST</small><p>{approval.role} review was routed to {approval.approver}. Open the contract for its recorded terms, risk, and audit history.</p></div><div className="approval-actions">{approval.status === "Pending" ? canDecideApproval(approval) ? <><button type="button" onClick={() => openApprovalDecision(approval, "Changes requested")}>Request changes</button><button type="button" className="approve" onClick={() => openApprovalDecision(approval, "Approved")}>✓ Review & approve</button></> : canClaimApproval(approval) ? <button type="button" className="approve" onClick={() => void claimApproval(approval)}>Claim review</button> : <span className="decision">Read-only</span> : <span className={`decision ${approval.status.toLowerCase().replace(" ", "-")}`}>{approval.status}</span>}</div></article>;
              })}
              {approvals.length === 0 && session?.mode === "production" && <div className="empty-state"><span>✓</span><h3>No approval requests are in this workspace</h3><p>Approvals appear after an authorized user routes an agreement for a recorded decision.</p></div>}
            </section>
          </div>
        )}

        {view === "signatures" && (
          <div className="page-pad signatures-page">
            <PageHeading eyebrow="EXECUTION" title="Every signature packet, accounted for." subtitle="See who has signed, who is next, and which completed artifacts still require authorized human review before activation." />
            <section className="signature-board">
              {agreements.filter((agreement) => agreement.stage === "Signature" || agreement.signatureStatus === "Completed").map((agreement) => {
                const packet = signaturePackets.find((candidate) => candidate.agreementId === agreement.id);
                const signerRows = packet?.signers ?? [];
                const isEvaluationSample = isEvaluationAgreement(agreement.id);
                const needsEvidenceReview = packet?.status === "completed_review_required";
                const packetLabel = packet
                  ? ` · Packet ${packet.status.replaceAll("_", " ")}`
                  : isEvaluationSample
                    ? " · Evaluation workflow sample"
                    : " · No packet created";
                const fallbackSignerLabel = packet
                  ? "Provider packet"
                  : isEvaluationSample
                    ? "Illustrative signature state"
                    : "Packet not created";
                const fallbackSignerDetail = packet?.status.replaceAll("_", " ")
                  ?? (isEvaluationSample
                    ? `${agreement.signatureStatus} sample · not provider evidence`
                    : "Prepare the immutable signing packet");
                const actionLabel = isEvaluationSample
                  ? "Open evaluation sample"
                  : needsEvidenceReview
                    ? canReviewCompletedSignature ? "Review signed evidence" : "View review status"
                  : agreement.signatureStatus === "Completed"
                    ? "View signed record"
                    : canUpdateAgreement
                      ? agreement.signatureStatus === "Sent" || agreement.signatureStatus === "Partially signed"
                        ? "View signature status"
                        : "Create signature packet"
                      : "View agreement";

                return <article className={`signature-card ${needsEvidenceReview ? "review-required" : ""}`} key={agreement.id}><div className="signature-card-top"><span className={`party-logo ${agreement.side.toLowerCase().replace("-side", "")}`}>{agreement.initials}</span><SignatureBadge status={agreement.signatureStatus} /></div><button className="card-open signature-card-open" type="button" onClick={() => openAgreement(agreement.id, agreement.signatureStatus === "Completed" || needsEvidenceReview ? "activity" : "document")}><span><strong>{agreement.party}</strong><small>{agreement.type}{packetLabel}</small></span><i aria-hidden="true">›</i></button><div className="signer-progress">{signerRows.length ? signerRows.map((signer, index) => { const completed = new Set(["completed", "signed"]).has((signer.status ?? "").toLowerCase()); return <div className={completed ? "signed" : "waiting"} key={`${packet?.id}:${signer.submitterId ?? signer.email ?? index}`}><i>{completed ? "✓" : index + 1}</i><span><b>{signer.name || signer.email || signer.role || `Signer ${index + 1}`}</b><small>{signer.role ? `${signer.role} · ` : ""}{signer.status ?? "Pending provider status"}</small></span></div>; }) : <div className={agreement.signatureStatus === "Completed" ? "signed" : "waiting"}><i>{agreement.signatureStatus === "Completed" ? "✓" : "1"}</i><span><b>{fallbackSignerLabel}</b><small>{fallbackSignerDetail}</small></span></div>}</div><footer><span>{packet ? `Document v${packet.documentVersion} · ${packet.documentSha256.slice(0, 12)}…` : isEvaluationSample ? "Illustrative workflow · no provider evidence" : `Last update ${agreement.updated}`}</span><button type="button" onClick={() => { if (needsEvidenceReview && packet && canReviewCompletedSignature) { openSignatureEvidenceReview(agreement, packet); return; } openAgreement(agreement.id, agreement.signatureStatus === "Completed" || needsEvidenceReview ? "activity" : "document"); if (!isEvaluationSample && !needsEvidenceReview && agreement.signatureStatus !== "Completed" && canUpdateAgreement) openSigningRoom(agreement); }}>{actionLabel} →</button></footer></article>;
              })}
              {agreements.filter((agreement) => agreement.stage === "Signature" || agreement.signatureStatus === "Completed").length === 0 && session?.mode === "production" && <div className="empty-state"><span>✎</span><h3>No signature packets yet</h3><p>Verified packets and completed signature evidence will appear here after an authorized user advances an approved agreement.</p></div>}
            </section>
          </div>
        )}

        {view === "obligations" && (
          <div className="page-pad obligations-page">
            <PageHeading eyebrow="POST-SIGNATURE" title="Make every promise operational." subtitle="Each row is a dated occurrence. Schedules govern future work; completion requires immutable human evidence." actions={canWriteObligations ? <button className="primary-button" type="button" onClick={openObligationCreator}>＋ Add obligation schedule</button> : undefined} />
            {session?.mode === "evaluation" && <div className="obligation-evaluation-note" role="status"><strong>Evaluation samples</strong><span>Rows labeled “browser sample” are illustrative and stay in this tab. They do not run reminders, materialize future occurrences, or create durable evidence.</span></div>}
            <section className="obligation-metrics" aria-label="Obligation occurrence and schedule metrics">
              <article><span>Open occurrences</span><strong>{activeObligations}</strong><small>Individual dated commitments</small></article>
              <article className={overdueObligations ? "risk" : ""}><span>Overdue</span><strong>{overdueObligations}</strong><small>Open dates before today</small></article>
              <article><span>Active schedules</span><strong>{activeObligationSchedules}</strong><small>Eligible to create future work</small></article>
              <article><span>Evidence retained</span><strong>{evidencedCompletions}</strong><small>Completed occurrences with proof</small></article>
            </section>
            <div className="obligation-filters" role="group" aria-label="Filter obligations">{(["Open", "Complete", "All"] as const).map((filter) => <button type="button" className={obligationFilter === filter ? "active" : ""} aria-pressed={obligationFilter === filter} onClick={() => setObligationFilter(filter)} key={filter}>{filter}</button>)}</div>
            <section className="panel obligation-list" aria-label="Obligation occurrence queue" tabIndex={0}>
              <div className="obligation-head"><span>Occurrence</span><span>Agreement</span><span>Owner</span><span>Schedule</span><span>Due</span><span>Action</span></div>
              {sortedObligations.filter((item) => obligationFilter === "All" || item.status === obligationFilter).map((obligation) => {
                const agreement = agreements.find((item) => item.id === obligation.agreementId);
                const schedule = obligation.scheduleId ? obligationScheduleById.get(obligation.scheduleId) : undefined;
                const evidence = obligationEvidenceByOccurrence.get(obligation.id);
                const assignedOwner = obligation.ownerUserId === session?.user.id;
                const canComplete = canWriteObligations || (canFulfillObligations && assignedOwner);
                const overdue = obligationIsOverdue(obligation);
                return <article className={`obligation-row ${overdue ? "overdue" : ""}`} key={obligation.id}>
                  <button className="card-open obligation-open" type="button" onClick={() => agreement && openAgreement(agreement.id, "details")} disabled={!agreement}>
                    <span><b>{obligation.title}</b><small>{obligation.source}</small><em>Occurrence #{obligation.occurrenceNumber ?? 1}{obligation.evaluationOnly ? " · browser sample" : ""}</em></span><i aria-hidden="true">›</i>
                  </button>
                  <button type="button" disabled={!agreement} onClick={() => agreement && openAgreement(agreement.id, "details")}>{agreement?.party ?? "Agreement unavailable"}</button>
                  <span className="person-cell"><i>{obligation.owner.split(" ").map((word) => word[0]).join("").slice(0, 2) || "?"}</i><span>{obligation.owner}<small>{schedule?.ownerUserId === null ? <b className="repair-badge">Owner repair needed</b> : assignedOwner ? "Assigned to you" : "Assigned owner"}</small></span></span>
                  <span className="obligation-schedule-cell"><b>{obligationRecurrenceLabel(schedule, obligation.cadence)}</b><small><span className={`schedule-status ${schedule?.status ?? "ended"}`}>{schedule?.status ?? "legacy"}</span>{obligation.timezone ?? schedule?.timezone ?? "Timezone not recorded"}</small>{canWriteObligations && schedule && <button type="button" onClick={() => openObligationScheduleManagement(schedule)}>Manage schedule</button>}</span>
                  <span className="obligation-due"><b>{obligationDateLabel(obligation.dueDate)}</b><small>{obligation.status === "Complete" ? `Completed${obligation.completedAt ? ` ${obligationDateLabel(obligation.completedAt)}` : ""}` : overdue ? "Overdue" : `Reminder leads: ${(obligation.reminderLeadDays ?? schedule?.reminderLeadDays ?? [0]).join(", ")}d`}</small></span>
                  <span className="obligation-actions">{obligation.status === "Open" ? canComplete ? <button className="complete-obligation" type="button" onClick={() => openObligationCompletion(obligation)}>{assignedOwner ? "Submit evidence" : "Override & complete"}</button> : <b>Open · owner action</b> : evidence ? <button className="evidence-button" type="button" onClick={() => setObligationEvidenceReview(evidence)}>View evidence</button> : <b className="complete-label">✓ Complete · evidence unavailable</b>}</span>
                </article>;
              })}
              {sortedObligations.filter((item) => obligationFilter === "All" || item.status === obligationFilter).length === 0 && <div className="empty-state"><span>◷</span><h3>{obligationFilter === "All" ? "No obligations have been recorded" : `No ${obligationFilter.toLowerCase()} occurrences`}</h3><p>{canWriteObligations ? "Review an executed agreement and create a schedule with an eligible owner, source, reminders, and first due date." : "An authorized member must create and manage post-signature work."}</p></div>}
            </section>
          </div>
        )}

        {view === "templates" && (
          <div className="page-pad templates-page">
            <PageHeading eyebrow="CONTRACT TEMPLATES" title="Start from governed paper or a clearly labeled starter." subtitle="Published templates pin an exact immutable version. Starter structures remain available and never imply company approval." actions={canCreateAgreement ? <button className="primary-button" type="button" onClick={openGenerator}>＋ Start from template</button> : undefined} />
            <div className="template-metrics"><span><b>{enterpriseChoicesLoading ? "—" : publishedTemplates.length}</b> Published governed templates</span><span><b>{templateDetails.length}</b> Starter structures</span><span><b>{clauses.length}</b> Available approved clauses</span></div>
            {enterpriseChoicesError && <div className="workspace-warning" role="alert"><b>Governed templates could not load.</b><span>{enterpriseChoicesError}</span><button type="button" onClick={() => void loadEnterpriseChoices()}>Retry</button></div>}
            {publishedTemplates.length > 0 && <><div className="enterprise-section-heading template-section-heading"><div><p>GOVERNED PAPER</p><h2>Published templates</h2><span>Each choice creates working paper from the exact published version and records its immutable digest.</span></div></div><section className="template-grid governed-template-grid">{publishedTemplates.map((template) => <article className="template-card governed" key={template.publishedVersion.id}><div className="template-preview"><span>NOTICE / GOVERNED V{template.publishedVersion.version}</span><h3>{template.name.toUpperCase()}</h3><i /><i /><i /><b>PUBLISHED</b></div><div className="template-copy"><div><span className={`lane-pill ${template.side.toLowerCase().replace("-side", "")}`}>{contractDirectionLabel(template.side)}</span><small>Exact published version</small></div><h2>{template.name}</h2><p>{template.description || template.agreementType}</p><code title={template.publishedVersion.contentSha256}>SHA-256 {template.publishedVersion.contentSha256.slice(0, 16)}…</code><footer><span>Working paper still requires human review</span>{canCreateAgreement && <button type="button" onClick={() => openGovernedTemplate(template)}>Use governed v{template.publishedVersion.version} →</button>}</footer></div></article>)}</section></>}
            <div className="enterprise-section-heading template-section-heading"><div><p>STARTER STRUCTURES</p><h2>Ungoverned starters</h2><span>Useful scaffolding only; no approved company language or policy is applied automatically.</span></div></div>
            <section className="template-grid">{templateDetails.map(([name, side, contents, team]) => <article className="template-card" key={name}><div className="template-preview"><span>NOTICE / {team.toUpperCase()}</span><h3>{name.toUpperCase()}</h3><i /><i /><i /><b>TEMPLATE</b></div><div className="template-copy"><div><span className={`lane-pill ${side.toLowerCase().replace("-side", "")}`}>{contractDirectionLabel(side as AgreementSide)}</span><small>Starter template</small></div><h2>{name}</h2><p>{contents} · Suggested owner: {team}</p><footer><span>Human review against company policy required</span>{canCreateAgreement && <button type="button" onClick={() => openTemplate(name, side as AgreementSide)}>Use template →</button>}</footer></div></article>)}</section>
          </div>
        )}

        {view === "library" && (
          <div className="page-pad library-page">
            <PageHeading eyebrow="APPROVED CLAUSES" title="Reuse approved language with confidence." subtitle="Company-approved clauses ready to add to a governed working draft." actions={canWriteLanguage ? <button className="primary-button" type="button" onClick={() => setClauseOpen(true)}>＋ New approved clause</button> : undefined} />
            <section className="library-layout"><aside className="library-filters" role="group" aria-labelledby="library-collections-label"><p id="library-collections-label">COLLECTIONS</p>{["All language", "Commercial", "Risk", "Data & security", "Termination", "Renewal", "Corporate"].map((item) => <button className={libraryCollection === item ? "active" : ""} type="button" key={item} aria-pressed={libraryCollection === item} onClick={() => setLibraryCollection(item)}>{item}<span>{item === "All language" ? clauses.length : clauses.filter((clause) => clause.category === item).length}</span></button>)}</aside><div className="library-content"><label className="library-search">⌕ <input value={clauseQuery} onChange={(event) => setClauseQuery(event.target.value)} placeholder="Search approved clauses…" aria-label="Search approved clauses" /></label><div className="clause-grid">{filteredClauses.map((clause) => <article className="clause-card" key={clause.id}><div className="clause-card-top"><span className={`profile ${clause.profile.toLowerCase()}`}>{clause.profile}</span><small>{clause.category}</small></div><h2>{clause.title}</h2><p className="clause-summary">{clause.summary}</p><blockquote>{clause.language}</blockquote><footer><span>Workspace-approved clause</span>{languageInsertionAgreement && canManageDocuments && <button type="button" onClick={() => insertClauseFromLibrary(clause.id)}>Add to {languageInsertionAgreement.party} draft →</button>}</footer></article>)}</div>{filteredClauses.length === 0 && <div className="empty-state"><h3>{clauses.length === 0 && session?.mode === "production" ? "No workspace language has been approved" : "No language blocks found"}</h3><p>{clauses.length === 0 && session?.mode === "production" ? canWriteLanguage ? "Add the company’s standard, fallback, and strict positions before teams generate production drafts." : "A legal user or administrator must add company-approved language before it can be inserted into drafts." : "Try a different clause name, category, or profile."}</p>{clauses.length === 0 && session?.mode === "production" && canWriteLanguage && <button type="button" onClick={() => setClauseOpen(true)}>Add the first approved clause</button>}</div>}</div></section>
          </div>
        )}

        {view === "integrations" && (
          <div className="page-pad integrations-page">
            <PageHeading eyebrow="CONNECTED AGREEMENTS" title="A secure handoff to the systems your business uses." subtitle="Notice sends canonical, signed, retry-safe events to separate mail and CRM gateways; customer credentials remain in deployment secrets." actions={canManageIntegrations ? <button className="ghost-button" type="button" onClick={() => navigate("admin")}>⚙ Configure & test</button> : undefined} />
            <div className="integration-summary"><article><span>{integrationStatusKnown ? integrations.filter((item) => item.configured).length : "—"}</span><div><b>Configured services</b><small>{canManageIntegrations ? integrationStatusKnown ? "Reported by the server" : "Loading server status" : "Administrator-only status"}</small></div></article><article><span>1</span><div><b>Canonical event contract</b><small>Agreements, approvals, signatures</small></div></article><article><span>✓</span><div><b>Durable delivery</b><small>Retry and dead-letter workflow included</small></div></article></div>
            <section className="integration-grid"><IntegrationCard name="Salesforce" monogram="SF" color="blue" connected={connections.Salesforce} statusKnown={integrationStatusKnown} canManage={canManageIntegrations} description="Included gateway adapter for Salesforce client-credentials authentication and external-ID upserts." objects={["Client credentials", "External-ID upsert", "Field mapping"]} onClick={() => setIntegrationPanel("Salesforce")} /><IntegrationCard name="HubSpot" monogram="HS" color="orange" connected={connections.HubSpot} statusKnown={integrationStatusKnown} canManage={canManageIntegrations} description="Included gateway adapter for HubSpot private-app access and stable external-ID upserts." objects={["Private-app token", "Batch upsert", "Field mapping"]} onClick={() => setIntegrationPanel("HubSpot")} /><IntegrationCard name="Custom CRM" monogram="{ }" color="dark" connected={connections["Custom CRM"]} statusKnown={integrationStatusKnown} canManage={canManageIntegrations} description="Included signed-webhook adapter for an approved custom CRM or integration endpoint." objects={["HTTPS webhook", "HMAC", "Idempotency key"]} onClick={() => setIntegrationPanel("Custom CRM")} /></section>
            <section className="panel sync-map"><PanelHeading title="Canonical CRM projection" subtitle="The included gateway validates Notice events, fences stale aggregate versions, and maps a bounded agreement projection to the selected adapter." /><div className="map-table" role="region" tabIndex={0} aria-label="Canonical CRM projection field map"><div className="map-head"><span>Notice field</span><span>Type</span><span>Source</span><span>Direction</span><span>Control</span></div>{[["event.id", "Identifier", "Server", "→", "Idempotency key"], ["event.workspaceId", "Identifier", "Server", "→", "Tenant mapping"], ["payload.crmAgreement", "Projection", "Authoritative state", "→", "Bounded fields"], ["projection.version", "Integer", "Agreement", "→", "Stale-write fence"], ["projection.externalKey", "Identifier", "Server", "→", "Stable provider key"], ["event.createdAt", "Timestamp", "Server", "→", "Server attributed"]].map((row) => <div className="map-row" key={row[0]}>{row.map((cell, index) => <span key={index}>{cell}</span>)}</div>)}</div></section>
          </div>
        )}

        {view === "admin" && canManageWorkspace && (
          <div className={`page-pad admin-page section-${enterpriseSetupSection}`}>
            <PageHeading eyebrow="ENTERPRISE SETUP" title="Govern the workspace without editing configuration files." subtitle="Company records, exact published paper, human approval policy, intake, and agent access stay structured and auditable." actions={<><button className="ghost-button" type="button" onClick={() => void downloadWorkspaceExport()}>↓ Export workspace evidence</button><button className="ghost-button" type="button" onClick={() => { void loadAdmin(); void loadEnterpriseChoices(); }}>↻ Refresh evidence</button></>} />
            {session && <EnterpriseSetupCenter section={enterpriseSetupSection} onSectionChange={changeEnterpriseSetupSection} userId={session.user.id} members={members} onConfigurationChanged={loadEnterpriseChoices} />}
            {adminLoading && <div className="sync-line" aria-label="Loading setup evidence"><i /></div>}
            {adminError && <div className="setup-warning" role="alert">{adminError}</div>}
            <section className="setup-summary">
              <article className={readiness?.code.ready ? "ready" : "blocked"}><span>{readiness?.code.ready ? "✓" : "!"}</span><div><b>Repository controls</b><small>{readiness?.code.ready ? "Implementation gates pass" : "Maintainer work remains"}</small></div></article>
              <article className={readiness?.customer.ready ? "ready" : "blocked"}><span>{readiness?.customer.ready ? "✓" : "!"}</span><div><b>Customer configuration</b><small>{readiness?.customer.ready ? "Deployment inputs pass" : "Deployment inputs remain"}</small></div></article>
              <article className={readiness?.readyForProduction ? "ready" : "blocked"}><span>{readiness?.readyForProduction ? "✓" : "×"}</span><div><b>Technical preflight</b><small>{readiness?.readyForProduction ? "Technical checks pass; business acceptance still required" : "Fail closed"}</small></div></article>
            </section>
            <div className="admin-grid">
              <section className="panel setup-card">
                <PanelHeading title="Readiness evidence" subtitle="These checks cannot be bypassed by the interface." />
                <div className="readiness-list" role="region" tabIndex={0} aria-label="Deployment readiness checks">{[...(readiness?.code.checks ?? []), ...(readiness?.customer.checks ?? [])].map((check) => <article key={check.id} className={check.status}><span>{check.status === "pass" || check.status === "not_required" ? "✓" : "!"}</span><div><b>{check.label}</b><p>{check.message}</p>{check.status === "fail" && check.remediation && <small>{check.remediation}</small>}</div></article>)}</div>
              </section>
              <aside className="panel setup-card">
                <PanelHeading title="Provider connections" subtitle="Tests use server-held secrets and never expose credentials." />
                <div className="provider-list">{integrations.length ? integrations.map((integration) => { const livePassed = integration.lastTest?.status === "passed"; const liveFailed = integration.lastTest?.status === "failed"; return <article key={integration.id}><span className={livePassed ? "configured" : "missing"}>{livePassed ? "Live verified" : liveFailed ? "Live test failed" : integration.configured ? "Live test required" : integration.testable ? "Ready to test" : "Not configured"}</span><div><b>{integration.label}</b><small>{integration.lastTest?.detail ?? integration.detail ?? "Configure this service in deployment secrets."}</small>{integration.selectedOcrProfile && <small className="provider-profile">Customer-hosted OCR via signed gateway · Model <code>{integration.selectedOcrProfile.modelId}</code> · Profile <code>{integration.selectedOcrProfile.profileId}</code></small>}</div><button type="button" disabled={!integration.testable} onClick={() => void testIntegration(integration.id)}>Test</button></article>; }) : <div className="quiet-empty">Provider status is unavailable until the integration status route is configured.</div>}</div>
                <p className="secret-note">Credentials belong in the deployment secret manager. Notice intentionally does not accept or store secrets in this screen.</p>
              </aside>
            </div>
            <section className="panel crm-resync-admin">
              <PanelHeading title="CRM resync & backfill" subtitle="Queue a tested-profile repair, or attest cleanup of legacy events whose original CRM destination cannot be proven." />
              <div className="crm-resync-form">
                <label><span>Operation</span><select value={crmResyncAction} onChange={(event) => changeCrmResyncAction(event.target.value as CrmResyncAction)} disabled={crmResyncBusy}><option value="projection">Project current record</option><option value="tombstone">Send cleanup tombstone</option><option value="legacy_cleanup_attestation">Attest legacy cleanup</option></select></label>
                <label><span>Agreement</span><select value={crmResyncAgreementId || ""} onChange={(event) => { setCrmResyncAgreementId(Number(event.target.value)); setCrmHistoricalCleanupConfirmed(false); setCrmHistoricalCleanupConfirmation(""); }} disabled={!crmResyncEligibleCandidates.length || crmResyncBusy}><option value="" disabled>{crmResyncEligibleCandidates.length ? "Select an eligible agreement" : "No eligible agreement on loaded pages"}</option>{crmResyncEligibleCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.deletedAt ? "Deleted · " : "Active · "}{candidate.party} · v{candidate.version} · {candidate.crm}</option>)}</select></label>
                <label><span>Audit reason</span><input value={crmResyncReason} maxLength={500} onChange={(event) => setCrmResyncReason(event.target.value)} disabled={crmResyncBusy} /></label>
                <button className="primary-button" type="button" disabled={crmResyncBusy || !crmResyncAgreementId || !crmResyncReady} onClick={() => void resyncCrmAgreement()}>{crmResyncBusy ? "Saving…" : crmResyncAction === "legacy_cleanup_attestation" ? "Record attestation" : crmResyncAction === "tombstone" ? "Queue tombstone" : "Queue projection"}</button>
                {crmResyncAction === "legacy_cleanup_attestation" && <div className="crm-legacy-confirmation">
                  <p>This action does not infer a destination, bind a delivery receipt, or contact a CRM. Reconcile or delete every legacy copy outside Notice before recording the evidence.</p>
                  <label className="crm-legacy-check"><input type="checkbox" checked={crmLegacyCleanupConfirmed} onChange={(event) => setCrmLegacyCleanupConfirmed(event.target.checked)} disabled={crmResyncBusy} /><span>I completed the external reconciliation or deletion.</span></label>
                  <label className="crm-legacy-phrase"><span>Type this exact sentence to confirm</span><code>{CRM_LEGACY_CLEANUP_CONFIRMATION}</code><input value={crmLegacyCleanupConfirmation} maxLength={CRM_LEGACY_CLEANUP_CONFIRMATION.length} onChange={(event) => setCrmLegacyCleanupConfirmation(event.target.value)} disabled={crmResyncBusy} aria-label="Legacy CRM cleanup confirmation" /></label>
                </div>}
                {historicalCleanupConfirmationRequired && <div className="crm-legacy-confirmation">
                  <p>This tombstone can affect the same provider object as the intended live mapping. Keep CRM mutations paused, verify the live profile first, and reproject it before resuming service.</p>
                  <label className="crm-legacy-check"><input type="checkbox" checked={crmHistoricalCleanupConfirmed} onChange={(event) => setCrmHistoricalCleanupConfirmed(event.target.checked)} disabled={crmResyncBusy} /><span>I completed the provider/gateway reconciliation and approved the maintenance sequence.</span></label>
                  <label className="crm-legacy-phrase"><span>Type this exact sentence to confirm</span><code>{CRM_HISTORICAL_CLEANUP_CONFIRMATION}</code><input value={crmHistoricalCleanupConfirmation} maxLength={CRM_HISTORICAL_CLEANUP_CONFIRMATION.length} onChange={(event) => setCrmHistoricalCleanupConfirmation(event.target.value)} disabled={crmResyncBusy} aria-label="Historical CRM cleanup confirmation" /></label>
                </div>}
              </div>
              {crmResyncNextCursor && <button className="crm-resync-more" type="button" disabled={crmResyncPageBusy} onClick={() => void loadMoreCrmResyncCandidates()}>{crmResyncPageBusy ? "Loading…" : "Load more agreements"}</button>}
              {crmResyncBlockedReasons.map((reason) => <p className="crm-resync-note" key={reason}>{reason}</p>)}
              <p className="crm-resync-note">Projection and tombstone repairs require the exact configured and successfully tested CRM profile. Pending and dead attempts remain cleanup-eligible because a lost response cannot prove the CRM write failed; only an accepted same-profile tombstone resolves them. Legacy cleanup attestation is offered only for pre-profile events with incomplete destination evidence and must reflect reconciliation performed outside Notice.</p>
            </section>
            <section className="panel agent-governance-admin" aria-busy={agentAdminBusy || agentReviewBusy}>
              <PanelHeading title="Agent governance" subtitle="Register signed workload identities, delegate exact time-limited resources, and review immutable action plans as a human administrator." />
              <div className="agent-governance-metrics">
                <span><b>{agentPrincipals.filter((principal) => principal.status === "active").length}</b> active principals</span>
                <span><b>{agentGrants.filter((grant) => grant.status === "active").length}</b> active grant records</span>
                <span><b>{agentPlans.filter((plan) => plan.status === "pending_approval").length}</b> awaiting review</span>
              </div>
              <div className="agent-governance-grid">
                <div className="agent-admin-column">
                  <div className="agent-admin-heading"><div><h3>Service principals</h3><p>Notice stores the verified Cloudflare common name, never a client secret.</p></div></div>
                  <div className="agent-principal-form">
                    <label><span>Display name</span><input value={agentPrincipalName} maxLength={120} onChange={(event) => setAgentPrincipalName(event.target.value)} placeholder="Contract review agent" /></label>
                    <label><span>Verified common name</span><input value={agentPrincipalCommonName} maxLength={512} onChange={(event) => setAgentPrincipalCommonName(event.target.value)} placeholder="service-token-client-id.access" /></label>
                    <button className="primary-button" type="button" disabled={agentAdminBusy || agentPrincipalName.trim().length < 2 || !agentPrincipalCommonName.trim()} onClick={() => void createAgentPrincipal()}>Register principal</button>
                  </div>
                  <div className="agent-admin-list">{agentPrincipals.map((principal) => <article key={principal.id}><div><b>{principal.name}</b><small>{principal.commonName}</small><code>{principal.id}</code></div><span className={`agent-status ${principal.status}`}>{principal.status}</span><button type="button" disabled={agentAdminBusy} onClick={() => void setAgentPrincipalStatus(principal)}>{principal.status === "active" ? "Disable" : "Enable"}</button></article>)}{agentPrincipals.length === 0 && <div className="quiet-empty">No signed service principal is registered.</div>}</div>
                </div>
                <div className="agent-admin-column">
                  <div className="agent-admin-heading"><div><h3>Exact-resource grants</h3><p>Every delegated agreement action is independently scoped, sponsored, revocable, and expiring.</p></div></div>
                  <div className="agent-grant-form">
                    <label><span>Principal</span><select value={agentGrantPrincipalId} onChange={(event) => setAgentGrantPrincipalId(event.target.value)}><option value="">Select an active principal</option>{agentPrincipals.filter((principal) => principal.status === "active").map((principal) => <option key={principal.id} value={principal.id}>{principal.name}</option>)}</select></label>
                    <label><span>Agreement resource</span><select value={agentGrantAgreementId || ""} onChange={(event) => setAgentGrantAgreementId(Number(event.target.value))}><option value="">Select an agreement</option>{agreements.map((agreement) => <option key={agreement.id} value={agreement.id}>{agreement.party} · {agreement.type}</option>)}</select></label>
                    <label><span>Delegated action</span><select value={agentGrantAction} onChange={(event) => setAgentGrantAction(event.target.value as AgentActionId)}>{agentDelegableAgreementActions.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}</select></label>
                    <label><span>Expires after</span><select value={agentGrantDays} onChange={(event) => setAgentGrantDays(Number(event.target.value))}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label>
                    <button className="primary-button" type="button" disabled={agentAdminBusy || !agentGrantPrincipalId || !agentGrantAgreementId} onClick={() => void createAgentGrant()}>Create grant</button>
                  </div>
                  <label className="agent-admin-reason"><span>Administrative audit reason</span><input value={agentAdminReason} maxLength={500} onChange={(event) => setAgentAdminReason(event.target.value)} /></label>
                  <div className="agent-admin-list grants">{agentGrants.map((grant) => { const principal = agentPrincipals.find((candidate) => candidate.id === grant.principalId); const resources = grant.resourceConstraints.resources.flatMap((resource) => resource.ids.map((id) => `${resource.type}:${id}`)); return <article key={grant.id}><div><b>{principal?.name ?? "Unknown principal"}</b><small>{grant.actionIds.join(" · ")}</small><code>{resources.join(", ")} · expires {grant.expiresAt.slice(0, 10)}</code></div><span className={`agent-status ${grant.status}`}>{grant.status}</span>{grant.status === "active" && <button type="button" disabled={agentAdminBusy} onClick={() => void revokeAgentGrant(grant)}>Revoke</button>}</article>; })}{agentGrants.length === 0 && <div className="quiet-empty">No agent grants have been issued.</div>}</div>
                </div>
              </div>
              <div className="agent-plan-inbox">
                <div className="agent-admin-heading"><div><h3>Human plan review inbox</h3><p>Open the persisted before-state, proposed diff, blockers, provenance, target version, basis, and SHA-256 digest before deciding.</p></div><button type="button" disabled={adminLoading || agentReviewBusy} onClick={() => void loadAdmin()}>Refresh</button></div>
                <div className="agent-plan-list">{agentPlans.map((plan) => { const principal = agentPrincipals.find((candidate) => candidate.id === plan.principalId); const agreement = plan.target.type === "agreement" ? agreements.find((candidate) => String(candidate.id) === plan.target.id) : null; return <article key={plan.id} className={`agent-plan-card ${plan.riskTier}`}><span className={`agent-status ${plan.status}`}>{plan.status.replaceAll("_", " ")}</span><div><b>{plan.actionId}</b><small>{principal?.name ?? plan.principalId} · {agreement ? `${agreement.party} · ${agreement.type}` : `${plan.target.type}:${plan.target.id}`}</small><code>{plan.planSha256}</code></div><span className="agent-plan-risk">{plan.riskTier} risk</span><button type="button" disabled={agentReviewBusy} onClick={() => void openAgentPlanReview(plan.id)}>Review exact plan</button></article>; })}{agentPlans.length === 0 && <div className="quiet-empty">No durable agent plans are recorded in this workspace.</div>}</div>
                {agentPlanNextCursor && <button className="agent-plan-more" type="button" disabled={agentPlanPageBusy} onClick={() => void loadMoreAgentPlans()}>{agentPlanPageBusy ? "Loading…" : "Load more plans"}</button>}
              </div>
            </section>
            <section className="panel member-admin">
              <PanelHeading title="Workspace access" subtitle="Add a verified email, select a least-privilege role, and let identity bind on first sign-in." />
              <div className="member-invite"><input value={inviteName} onChange={(event) => setInviteName(event.target.value)} placeholder="Full name" aria-label="Member name" /><input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="name@company.example" aria-label="Member email" /><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as SessionData["role"])} aria-label="Member role"><option value="requester">Requester</option><option value="approver">Approver</option><option value="legal">Legal</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select><button className="primary-button" type="button" onClick={() => void inviteMember()}>Add member</button></div>
              <div className="member-list">{members.map((member) => <article key={member.userId}><div><b>{member.displayName}</b><small>{member.email} · {member.identityProvider}</small></div><select value={member.role} onChange={(event) => void updateMember(member, event.target.value as SessionData["role"])} aria-label={`Role for ${member.displayName}`}><option value="requester">Requester</option><option value="approver">Approver</option><option value="legal">Legal</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select><button type="button" onClick={() => void updateMember(member, member.role, member.membershipStatus === "active" ? "disabled" : "active")}>{member.membershipStatus === "active" ? "Disable" : "Enable"}</button><button type="button" disabled={member.membershipStatus !== "disabled" || member.userId === session?.user.id} onClick={() => openIdentityReplacement(member)}>Replace SSO</button></article>)}</div>
            </section>
          </div>
        )}

        {view === "workspace" && (
          <div className="workspace-page">
            <header className="agreement-head"><button className="back-button" type="button" onClick={returnFromAgreement} aria-label={`Back to ${pageLabel[returnView]}`}>← <span>{pageLabel[returnView]}</span></button><span className={`party-logo large ${selected.side.toLowerCase().replace("-side", "")}`}>{selected.initials}</span><div className="agreement-title"><div><span className={`lane-pill ${selected.side.toLowerCase().replace("-side", "")}`}>{contractDirectionLabel(selected.side)}</span><span>{selected.type}</span><RiskBadge risk={selected.risk} /></div><h1>{selected.party}</h1><p>{formatAgreementMoney(selected)} · {selected.crm !== "None" ? selected.crmRecord ? `${selected.crm} · ${selected.crmRecord}` : `${selected.crm} sync via Notice external ID` : "CRM synchronization disabled"}</p><div className="agreement-governance-tags"><span>{selected.governedTemplateVersionId ? "Governed template pinned" : "Starter or imported paper"}</span><span>{selected.workflowDefinitionId ? "Governed workflow pinned" : "Starter approval policy"}</span></div></div><div className="agreement-actions">{canReadDocuments && <button type="button" disabled={editing || selectedDraft?.status !== "ready"} onClick={downloadDraft} title={editing ? "Save or discard edits before downloading" : "Download the exact saved plain-text working draft"}>↓ Download saved draft (.txt)</button>}{canRunWorkspacePrimary && <button className="send-sign" type="button" onClick={runWorkspacePrimaryAction}>{workspacePrimaryLabel} →</button>}</div></header>
            <div className="stage-rail" role="region" tabIndex={0} aria-label={`Contract lifecycle stages. Current stage: ${selected.stage}`}>{stages.map((stage, index) => { const currentIndex = stages.indexOf(selected.stage); return <div className={index < currentIndex ? "done" : index === currentIndex ? "current" : ""} key={stage} aria-current={index === currentIndex ? "step" : undefined}><span>{index < currentIndex ? "✓" : index + 1}</span><b>{stage}</b>{index < stages.length - 1 && <i />}</div>; })}</div>
            <div className="agreement-tabs" role="tablist" aria-label="Contract workspace">{workspaceTabs.map((tab) => <button id={`agreement-tab-${tab}`} role="tab" aria-selected={workspaceTab === tab} aria-controls={`agreement-panel-${tab}`} tabIndex={workspaceTab === tab ? 0 : -1} className={workspaceTab === tab ? "active" : ""} type="button" key={tab} onClick={() => openWorkspaceTab(tab)} onKeyDown={(event) => handleWorkspaceTabKey(event, tab)}>{workspaceTabLabels[tab]}{tab === "changes" && selectedIsSeedEvaluation && <span>{openChanges}</span>}{tab === "activity" && <span>{selectedEvents.length}</span>}</button>)}</div>

            {workspaceTab === "document" && (
              <div id="agreement-panel-document" className="agreement-workbench" role="tabpanel" aria-labelledby="agreement-tab-document" tabIndex={0}>
                <section className="document-zone">
                  <div className="document-toolbar"><div className="draft-version-label"><span className="live-dot" />{editing ? <><strong>{documentDirty ? "Unsaved working draft" : "Working draft open for editing"}</strong>{selectedDraft?.status === "ready" && <small>Based on saved v{selectedDraft.version}{selectedDraft.sha256 ? ` · SHA-256 ${selectedDraft.sha256}` : ""}</small>}</> : selectedDraft?.status === "ready" ? <><strong>Saved working draft v{selectedDraft.version}</strong>{selectedDraft.sha256 && <small>SHA-256 {selectedDraft.sha256}</small>}</> : selectedDraftPending ? <strong>Checking the latest saved working draft</strong> : selectedNeedsWorkingCopy ? <strong>{selectedHasImportedSource ? "Uploaded source retained · verified working text required" : "No saved working draft"}</strong> : <strong>Evaluation starter template</strong>}</div><div>{selectedIsSeedEvaluation && hasStructuredChanges && !editing && !selectedNeedsWorkingCopy && <button type="button" className={showRedlines ? "active" : ""} aria-pressed={showRedlines} onClick={() => setShowRedlines((value) => !value)}>⌁ {showRedlines ? "Sample changes visible" : "Show sample changes"}</button>}{editing && <button type="button" onClick={cancelDocumentEdit}>Cancel</button>}{canManageDocuments && !selectedDraftPending && selectedDraft?.status !== "error" && <button type="button" onClick={() => editing ? void saveDocumentVersion() : beginDocumentEdit()}>{editing ? "✓ Save version" : selectedNeedsWorkingCopy ? selectedHasImportedSource ? "＋ Create verified working draft" : "＋ Create starter working draft" : "✎ Edit working draft"}</button>}</div></div>
                  <article ref={editing ? undefined : contractRef} className={`contract-paper ${editing ? "editing" : ""}`}>
                    {editing ? <textarea className="document-text-editor" value={documentEditText} onChange={(event) => setDocumentEditText(event.target.value)} aria-label="Working draft content" /> : selectedDraftPending ? <div className="document-version-state"><h3>Loading the latest saved working draft…</h3><p>Notice is checking durable workspace storage before showing the contract text.</p></div> : selectedDraft?.status === "error" ? <div className="document-version-state error"><h3>The latest saved working draft could not be loaded</h3><p>{selectedDraft.message}</p><button type="button" onClick={() => setDocumentReloadToken((value) => value + 1)}>Retry loading</button></div> : selectedNeedsWorkingCopy ? <div className="document-version-state"><h3>No saved working text is available</h3><p>{selectedHasImportedSource ? "The original source remains protected and linked. Run the approved OCR or human-review process, then create and save verified working text; Notice will not substitute template language for the uploaded contract." : "This record has no saved working draft. Start from a clearly marked template or paste approved text, review it, and save the first durable version."}</p>{selectedHasImportedSource && <div className="source-document-actions">{selectedSourceDocuments.map((source) => <button type="button" key={source.id} onClick={() => void downloadSourceDocument(source)}>↓ {source.fileName}</button>)}</div>}</div> : selectedDraft?.status === "ready" ? <pre className="persisted-draft-text">{selectedDraft.content}</pre> : <>
                    <div className="paper-top"><span>NOTICE / AGREEMENTS</span><b>R{selected.version ?? 1}</b></div>
                    <h2>{selected.type.toUpperCase()}</h2>
                    <p className="paper-intro">This {selected.type} (the “Agreement”) is entered into as of <mark>{selected.effectiveDate || "Effective date to be confirmed"}</mark> by and between <strong>{session?.workspace.name ?? "Our organization"}</strong> (“{selected.side === "Sell-side" ? "Provider" : selected.side === "Buy-side" ? "Customer" : "Company"}”) and <strong>{selected.party}</strong> (“{selected.side === "Sell-side" ? "Customer" : selected.side === "Buy-side" ? "Provider" : "Counterparty"}”).</p>
                    <ContractSection number="1" title="Scope and services" editable={editing}>The parties will perform the obligations described in each mutually executed schedule or order form. Each order form will identify the scope, fees, service levels, and term.</ContractSection>
                    <ContractSection number="2" title="Fees and payment" editable={editing}>Customer will pay all undisputed amounts within {showRedlines && selectedChangeStatus[2] === "open" ? <><del>thirty (30)</del> <ins>sixty (60)</ins></> : selectedChangeStatus[2] === "accepted" ? <ins className="resolved">sixty (60)</ins> : <span>thirty (30)</span>} days after receipt of a valid invoice. The parties will work in good faith to resolve disputed amounts promptly.</ContractSection>
                    <ContractSection number="3" title="Confidentiality" editable={editing}>Each party will protect the other party’s Confidential Information using at least reasonable care and will use it solely to perform or receive services under this Agreement.</ContractSection>
                    <ContractSection number="4" title="Data protection" editable={editing}>Each party will comply with applicable privacy and security law. Provider will process Customer Data only to perform the services and in accordance with the Data Processing Addendum.</ContractSection>
                    <ContractSection number="5" title="Limitation of liability" editable={editing}>Except for excluded claims, each party’s aggregate liability will not exceed {showRedlines && selectedChangeStatus[1] === "open" ? <><del>the fees paid or payable in the twelve months preceding the claim</del><ins>two times the total fees paid or payable under this Agreement</ins></> : selectedChangeStatus[1] === "accepted" ? <ins className="resolved">two times the total fees paid or payable under this Agreement</ins> : <span>the fees paid or payable in the twelve months preceding the claim</span>}.</ContractSection>
                    <ContractSection number="6" title="Term and termination" editable={editing}>This Agreement continues for the Initial Term and renews for successive twelve-month terms unless either party provides written notice of non-renewal at least sixty days before the end of the then-current term.</ContractSection>
                    {insertedClauses.map((id, index) => { const clause = clauses.find((item) => item.id === id); return clause ? <ContractSection number={String(7 + index)} title={clause.title} editable={editing} key={id}>{clause.language}</ContractSection> : null; })}
                    <div className="signature-lines"><div><i /><b>{(session?.workspace.name ?? "OUR ORGANIZATION").toUpperCase()}</b><span>Name / Title / Date</span></div><div><i /><b>{selected.party.toUpperCase()}</b><span>Name / Title / Date</span></div></div>
                    <footer>{session?.workspace.name ?? "Notice workspace"} · {selected.type} · Confidential</footer>
                    </>}
                  </article>
                </section>
                <aside className="workbench-rail">
                  <section className="health-panel"><div className="rail-heading"><h3>Recorded controls</h3><span className={`health-score ${selected.risk.toLowerCase()}`}>{selected.risk} risk</span></div><dl><div><dt>Review evidence</dt><dd>{selectedIsSeedEvaluation ? `${openChanges} evaluation sample${openChanges === 1 ? "" : "s"}` : "See activity"}</dd></div><div><dt>Approval</dt><dd>{selected.approvalStatus}</dd></div><div><dt>Signature</dt><dd>{selected.signatureStatus}</dd></div></dl></section>
                  {selectedIsSeedEvaluation && showRedlines && openChanges > 0 && <section className="changes-panel"><div className="rail-heading"><h3>Evaluation sample changes</h3><span>{openChanges}</span></div>{selectedChangeStatus[1] === "open" && <ChangeCard party="Sample counterparty counsel" title="Liability cap" detail="12 months of fees → 2× total fees" playbook="Sample escalation" canResolve={canResolveChanges} onAccept={() => void resolveChange(1, "accepted")} onReject={() => void resolveChange(1, "rejected")} />}{selectedChangeStatus[2] === "open" && <ChangeCard party="Sample counterparty counsel" title="Payment terms" detail="Net 30 → Net 60" playbook="Sample fallback" canResolve={canResolveChanges} onAccept={() => void resolveChange(2, "accepted")} onReject={() => void resolveChange(2, "rejected")} />}</section>}
                  <section className="deal-data"><div className="rail-heading"><h3>Key data</h3><button type="button" onClick={() => openWorkspaceTab("details")}>View all</button></div><dl><div><dt>Contract direction</dt><dd>{contractDirectionLabel(selected.side)}</dd></div><div><dt>Value</dt><dd>{formatAgreementMoney(selected)}</dd></div><div><dt>Owner</dt><dd><i className="mini-avatar">{selected.owner.split(" ").map((word) => word[0]).join("")}</i>{selected.owner}</dd></div><div><dt>CRM</dt><dd className="crm-link">{selected.crm}</dd></div></dl></section>
                  <section className="tag-panel"><div className="rail-heading"><h3>Recorded tags</h3></div><div className="tag-cloud">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><p><b>✦</b> Recorded tags power search, reporting, and workflow routing.</p></section>
                  {selectedSourceDocuments.length > 0 && <section className="source-documents"><div className="rail-heading"><h3>Uploaded sources</h3><span>{selectedSourceDocuments.length}</span></div><div className="source-document-list">{selectedSourceDocuments.map((source) => <button type="button" key={source.id} onClick={() => void downloadSourceDocument(source)}><span><b>{source.fileName}</b><small>{source.scanStatus} · {(source.size / 1024).toFixed(1)} KiB · {source.sha256.slice(0, 12)}…</small></span><i>↓</i></button>)}</div></section>}
                  <section className="clause-insert"><div className="rail-heading"><h3>Approved language</h3><button type="button" onClick={() => navigate("library")}>Library ↗</button></div>{clauses.slice(0, 4).map((clause) => <button type="button" className="insert-row" key={clause.id} disabled={!canManageDocuments} onClick={() => insertClause(selected.id, clause.id)}><span><b>{clause.title}</b><small>{clause.profile} · {clause.category}</small></span><i>{insertedClauses.includes(clause.id) ? "✓" : canManageDocuments ? "+" : "—"}</i></button>)}</section>
                </aside>
              </div>
            )}

            {workspaceTab === "changes" && (selectedIsSeedEvaluation ? <div id="agreement-panel-changes" className="workspace-content changes-workspace" role="tabpanel" aria-labelledby="agreement-tab-changes" tabIndex={0}>
              <section className="panel change-summary">
                <PanelHeading title="Evaluation sample comparison" subtitle="Labeled sample variances for exploring the review interaction." />
                <div className="change-score"><div><strong>{openChanges}</strong><span>sample changes</span></div><div><strong>{selectedChangeStatus[1] === "open" ? 1 : 0}</strong><span>sample escalation</span></div><div><strong>{selectedEvents.length}</strong><span>evaluation events</span></div></div>
                {hasStructuredChanges ? <div className="change-list-full"><ChangeReviewRow title="Liability cap" standard="12 months of fees" proposed="2× total fees" status={selectedChangeStatus[1]} risk="High" onAccept={canResolveChanges ? () => resolveChange(1, "accepted") : undefined} onReject={canResolveChanges ? () => resolveChange(1, "rejected") : undefined} /><ChangeReviewRow title="Payment terms" standard="Net 30" proposed="Net 60" status={selectedChangeStatus[2]} risk="Medium" onAccept={canResolveChanges ? () => resolveChange(2, "accepted") : undefined} onReject={canResolveChanges ? () => resolveChange(2, "rejected") : undefined} /><ChangeReviewRow title="Confidentiality" standard="Mutual; 3 years" proposed="Accepted as drafted" status="accepted" risk="Low" /></div> : <div className="empty-state"><h3>No sample comparison is recorded</h3><p>Notice does not invent proposed terms or policy verdicts.</p></div>}
              </section>
              <aside className="panel playbook-panel"><h3>Evaluation sample policy</h3><p>Example positions demonstrate the interaction only; they are not workspace-approved policy.</p><dl><div><dt>Sample standard</dt><dd>12 months of fees</dd></div><div><dt>Sample fallback</dt><dd>1.5× annual fees</dd></div><div><dt>Sample escalation</dt><dd>Above 1.5× or uncapped</dd></div></dl><button type="button" onClick={() => navigate("library")}>Open sample language →</button></aside>
            </div> : sessionMode === "production" ? <ProductionNegotiationPanel
              key={selected.id}
              agreement={selected}
              canManage={canManageDocuments}
              documentDirty={documentDirty}
              savedDraft={selectedDraft}
              sourceDocuments={selectedSourceDocuments}
              onOpenDraft={() => openWorkspaceTab("document")}
              onDownloadSource={downloadSourceDocument}
              onOpenHistory={() => openWorkspaceTab("activity")}
              onDraftStateChange={setNegotiationDraftDirty}
              onReconcileAgreement={reconcileNegotiationMutation}
              notify={notify}
            /> : <div id="agreement-panel-changes" className="workspace-content" role="tabpanel" aria-labelledby="agreement-tab-changes" tabIndex={0}><section className="panel empty-state"><h3>No evaluation sample comparison is recorded</h3><p>This record has no synthetic comparison. Open its working draft and history for the available evidence.</p></section></div>)}

            {workspaceTab === "details" && <div id="agreement-panel-details" className="workspace-content details-workspace" role="tabpanel" aria-labelledby="agreement-tab-details" tabIndex={0}>
              <section className="panel details-panel">
                <PanelHeading title="Contract details" subtitle={canUpdateAgreement ? "Edit confirmed business data and exact enterprise references. Value is stored in minor units for the selected currency." : "Confirmed business data and exact enterprise references; your role has read-only access."} action={canUpdateAgreement ? "Save changes" : undefined} onAction={canUpdateAgreement ? () => void saveDetails() : undefined} />
                <div className="details-grid">
                  <DetailField label="Counterparty display name" value={detailsDraft.party} readOnly={!canUpdateAgreement} onChange={(value) => setDetailsDraft((current) => ({ ...current, party: value }))} />
                  <DetailSelect label="Structured counterparty" value={detailsDraft.primaryCounterpartyId ?? ""} readOnly={!canUpdateAgreement || enterpriseCounterparties.length === 0} options={[{ value: "", label: enterpriseCounterparties.length ? "No primary counterparty link" : detailsDraft.primaryCounterpartyId ? "Current structured counterparty (restricted)" : "No directory access" }, ...enterpriseCounterparties.filter((party) => party.status === "active").map((party) => ({ value: party.id, label: party.displayName }))]} onChange={(value) => { const party = enterpriseCounterparties.find((entry) => entry.id === value); setDetailsDraft((current) => ({ ...current, primaryCounterpartyId: value || null, ...(party ? { party: party.displayName } : {}) })); }} />
                  <DetailField label="Contract type" value={detailsDraft.type} readOnly={!canUpdateAgreement || Boolean(detailsDraft.governedTemplateVersionId)} onChange={(value) => setDetailsDraft((current) => ({ ...current, type: value }))} />
                  <DetailSelect label="Contract direction" value={detailsDraft.side} readOnly={!canUpdateAgreement || Boolean(detailsDraft.governedTemplateVersionId)} options={[{ value: "Sell-side", label: "Customer contract" }, { value: "Buy-side", label: "Supplier contract" }, { value: "Corporate", label: "Company contract" }]} onChange={(value) => setDetailsDraft((current) => ({ ...current, side: value as AgreementSide }))} />
                  <DetailSelect label="Governed template" value={detailsDraft.governedTemplateVersionId ?? ""} readOnly={!canUpdateAgreement} options={[{ value: "", label: "No governed template pin" }, ...(detailsDraft.governedTemplateVersionId && !publishedTemplates.some((template) => template.publishedVersion.id === detailsDraft.governedTemplateVersionId) ? [{ value: detailsDraft.governedTemplateVersionId, label: "Existing retired or restricted template pin" }] : []), ...publishedTemplates.filter((template) => template.side === detailsDraft.side && template.agreementType === detailsDraft.type).map((template) => ({ value: template.publishedVersion.id, label: `${template.name} · published v${template.publishedVersion.version}` }))]} onChange={(value) => setDetailsDraft((current) => ({ ...current, governedTemplateVersionId: value || null }))} />
                  <DetailSelect label="Approval workflow" value={detailsDraft.workflowDefinitionId ?? ""} readOnly={!canUpdateAgreement} options={[{ value: "", label: "Starter approval policy" }, ...(detailsDraft.workflowDefinitionId && !enterpriseWorkflows.some((workflow) => workflow.id === detailsDraft.workflowDefinitionId) ? [{ value: detailsDraft.workflowDefinitionId, label: "Existing retired or restricted workflow pin" }] : []), ...enterpriseWorkflows.filter((workflow) => workflow.status === "published").map((workflow) => ({ value: workflow.id, label: `${workflow.name} · v${workflow.version}` }))]} onChange={(value) => setDetailsDraft((current) => ({ ...current, workflowDefinitionId: value || null }))} />
                  <DetailSelect label="Our legal entity" value={detailsDraft.legalEntityId ?? ""} readOnly={!canUpdateAgreement || enterpriseLegalEntities.length === 0} options={[{ value: "", label: enterpriseLegalEntities.length ? "No structured entity link" : detailsDraft.legalEntityId ? "Current legal entity (restricted)" : "No entity directory access" }, ...enterpriseLegalEntities.filter((entity) => entity.status === "active").map((entity) => ({ value: entity.id, label: entity.displayName }))]} onChange={(value) => setDetailsDraft((current) => ({ ...current, legalEntityId: value || null }))} />
                  <DetailField label="Department" value={detailsDraft.department} readOnly={!canUpdateAgreement} onChange={(value) => setDetailsDraft((current) => ({ ...current, department: value }))} />
                  <label><span>Contract value</span><div className="money-input"><input className="currency-code" aria-label="Contract currency" pattern="[A-Za-z]{3}" maxLength={3} readOnly={!canUpdateAgreement} value={detailsDraft.currencyCode ?? "USD"} onChange={(event) => { const currencyCode = event.target.value.toUpperCase(); const amount = minorToAmount(detailsDraft.valueMinor, detailsDraft.currencyCode, detailsDraft.value); setDetailsDraft((current) => ({ ...current, currencyCode, valueMinor: amountToMinor(amount, currencyCode) ?? current.valueMinor })); }} /><input aria-label="Contract amount" inputMode="decimal" readOnly={!canUpdateAgreement} value={String(minorToAmount(detailsDraft.valueMinor, detailsDraft.currencyCode, detailsDraft.value))} onChange={(event) => { const valueMinor = amountToMinor(event.target.value, detailsDraft.currencyCode ?? "USD"); if (valueMinor === null) return; setDetailsDraft((current) => ({ ...current, valueMinor, value: Math.round(minorToAmount(valueMinor, current.currencyCode, current.value)) })); }} /></div></label>
                  <DetailSelect label="Owner" value={detailsDraft.ownerUserId ?? ""} readOnly={!canUpdateAgreement} options={[{ value: "", label: "Unassigned" }, ...(detailsDraft.ownerUserId && !members.some((member) => member.userId === detailsDraft.ownerUserId) && detailsDraft.ownerUserId !== session?.user.id ? [{ value: detailsDraft.ownerUserId, label: `${detailsDraft.owner} · current owner` }] : []), ...(session && !members.some((member) => member.userId === session.user.id) ? [{ value: session.user.id, label: `${session.user.displayName} · current user` }] : []), ...members.filter((member) => member.membershipStatus === "active").map((member) => ({ value: member.userId, label: `${member.displayName} · ${member.role}` }))]} onChange={(value) => { const member = members.find((entry) => entry.userId === value); setDetailsDraft((current) => ({ ...current, ownerUserId: value || null, owner: value ? member?.displayName ?? session?.user.displayName ?? current.owner : "Unassigned" })); }} />
                  <DetailField label="Effective date" type="date" value={dateInputValue(detailsDraft.effectiveDate)} readOnly={!canUpdateAgreement} onChange={(value) => setDetailsDraft((current) => ({ ...current, effectiveDate: value }))} />
                  <DetailField label="Expiration date" type="date" value={dateInputValue(detailsDraft.expirationDate)} readOnly={!canUpdateAgreement} onChange={(value) => setDetailsDraft((current) => ({ ...current, expirationDate: value }))} />
                  <DetailSelect label="CRM connection" value={detailsDraft.crm} readOnly={!canUpdateAgreement} options={[{ value: "None", label: "No CRM sync" }, { value: "Salesforce", label: "Salesforce", disabled: !connections.Salesforce }, { value: "HubSpot", label: "HubSpot", disabled: !connections.HubSpot }, { value: "Custom CRM", label: "Custom CRM", disabled: !connections["Custom CRM"] }]} onChange={(value) => setDetailsDraft((current) => ({ ...current, crm: value as Agreement["crm"] }))} />
                  <DetailField label="Existing CRM record reference (optional)" value={detailsDraft.crmRecord} readOnly={!canUpdateAgreement} onChange={(value) => setDetailsDraft((current) => ({ ...current, crmRecord: value }))} />
                </div>
                <div className="risk-assessment-editor">
                  <div className="risk-assessment-heading"><div><span>Risk assessment</span><strong>Current record: {selected.risk}</strong></div><RiskBadge risk={selected.risk} /></div>
                  <div className="risk-selector" role="group" aria-labelledby="risk-level-label"><span id="risk-level-label">Assessed level</span>{(["Low", "Medium", "High"] as const).map((risk) => <button className={riskAssessmentLevel === risk ? `active ${risk.toLowerCase()}` : ""} type="button" key={risk} aria-pressed={riskAssessmentLevel === risk} disabled={!canAssessRisk || riskAssessmentBusy || selected.stage === "Active"} onClick={() => setRiskAssessmentLevel(risk)}>{risk}</button>)}</div>
                  <div className={`risk-basis ${selectedWorkflowBasis?.riskAssessment ? "ready" : "blocked"}`}><span>{selectedWorkflowBasis?.riskAssessment ? "✓" : "!"}</span><div><b>{selectedIsSeedEvaluation ? "Labeled evaluation assessment" : selectedWorkflowBasis?.riskAssessment ? `Exact working paper v${selectedWorkflowBasis.riskAssessment.documentVersion}` : "Exact working-paper basis unavailable"}</b><code>{selectedIsSeedEvaluation ? "No production evidence is created" : selectedWorkflowBasis?.riskAssessment.documentSha256 ? `SHA-256 ${selectedWorkflowBasis.riskAssessment.documentSha256}` : "Reload the saved working paper before assessing risk"}</code></div></div>
                  <label className="approval-reason-field"><span>Assessment rationale *</span><textarea disabled={!canAssessRisk || riskAssessmentBusy || selected.stage === "Active"} maxLength={2000} rows={3} value={riskAssessmentRationale} onChange={(event) => setRiskAssessmentRationale(event.target.value)} placeholder="Describe the reviewed terms and why this level applies…" /></label>
                  <label className="approval-confirmation"><input type="checkbox" disabled={!canAssessRisk || riskAssessmentBusy || selected.stage === "Active" || (!selectedIsSeedEvaluation && !selectedWorkflowBasis?.riskAssessment)} checked={riskAssessmentConfirmed} onChange={(event) => setRiskAssessmentConfirmed(event.target.checked)} /><span>I confirm I reviewed the exact saved working paper identified above and am recording a human risk decision.</span></label>
                  {canAssessRisk ? <button className="risk-assessment-submit" type="button" disabled={riskAssessmentBusy || !riskAssessmentRationale.trim() || !riskAssessmentConfirmed || detailsDirty || selected.stage === "Active" || (!selectedIsSeedEvaluation && (!selectedWorkflowBasis?.riskAssessment || selectedWorkflowBasis.agreementVersion !== (selected.version ?? 1)))} onClick={() => void assessRisk()}>{riskAssessmentBusy ? "Recording assessment…" : "Record risk assessment"}</button> : <p className="permission-note">Your role can view the recorded risk but cannot assess it.</p>}
                </div>
              </section>
              <aside className="details-side"><section className="panel"><h3>Approvals</h3>{selectedApprovals.length ? selectedApprovals.map((approval) => <button className="detail-row" type="button" key={approval.id} onClick={() => navigate("approvals")}><span>{approval.role}<small>{approval.approver}</small></span><b className={approval.status.toLowerCase().replace(" ", "-")}>{approval.status}</b></button>) : <div className="quiet-empty">{selected.approvalStatus === "Required" ? "Approval is required but has not been requested." : "No approval requests are recorded."}</div>}</section><section className="panel"><h3>Obligations</h3>{selectedObligations.length ? selectedObligations.map((obligation) => <button className="detail-row obligation" type="button" key={obligation.id} onClick={() => { setObligationFilter("All"); navigate("obligations"); }}><span>{obligation.title}<small>{obligation.source}</small></span><b>{obligation.dueDate}</b></button>) : <div className="quiet-empty">No obligations are recorded; add them after human review of the executed agreement.</div>}</section>{canManageWorkspace && <section className="panel retention-editor"><h3>Retention & legal hold</h3>{retentionPolicy?.id === selected.id ? <><label><span>Retention through</span><input type="date" value={retentionPolicy.retentionUntil?.slice(0, 10) ?? ""} onChange={(event) => setRetentionPolicy((current) => current ? { ...current, retentionUntil: event.target.value ? `${event.target.value}T23:59:59.999Z` : null } : current)} /></label><label className="hold-toggle"><input type="checkbox" checked={retentionPolicy.legalHold} onChange={(event) => setRetentionPolicy((current) => current ? { ...current, legalHold: event.target.checked } : current)} /><span>Legal hold overrides deletion</span></label><label><span>Reason</span><input value={retentionReason} onChange={(event) => setRetentionReason(event.target.value)} /></label><button type="button" onClick={() => void saveRetentionPolicy()}>Save records policy</button></> : <button type="button" onClick={() => void loadRetentionPolicy(selected.id)}>Load records policy</button>}</section>}</aside>
              <AgreementRelationshipsPanel agreementId={selected.id} agreements={agreements} legalEntities={enterpriseLegalEntities} counterparties={enterpriseCounterparties} canEdit={canUpdateAgreement && !isEvaluationAgreement(selected.id)} evaluationSample={selectedIsSeedEvaluation} />
              <AgreementCustomFieldsPanel agreementId={selected.id} canManage={canManageWorkspace && !isEvaluationAgreement(selected.id)} />
            </div>}

            {workspaceTab === "activity" && <div id="agreement-panel-activity" className="workspace-content activity-workspace" role="tabpanel" aria-labelledby="agreement-tab-activity" tabIndex={0}><section className="panel activity-panel"><PanelHeading title="History & comments" subtitle="Hash-linked workflow, document, and decision history with server-attributed actors." />{canAppendAudit ? <div className="comment-box"><span className="top-avatar">{(session?.user.displayName ?? "User").split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase()}</span><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add attributable context…" rows={3} /><button type="button" disabled={!comment.trim()} onClick={() => void addComment()}>Post comment</button></div> : <div className="quiet-empty">Your role can review this evidence but cannot append audit comments.</div>}<div className="timeline">{selectedEvents.map((event) => <article key={event.id}><span className={`event-icon ${event.type.toLowerCase()}`}>{event.type === "Signature" ? "✎" : event.type === "Comment" ? "…" : event.type === "Redline" ? "⌁" : "✓"}</span><div><p><b>{event.actor}</b> · {event.type}</p><span>{event.detail}</span><small>{event.createdAt}</small></div></article>)}</div></section>{canReadAudit && <aside className="panel audit-export"><span>↧</span><h3>Export audit evidence</h3><p>Download the contract, approval history, version hashes, signature evidence, and verified audit head in one signed JSON envelope.</p><button type="button" onClick={() => void downloadAudit()}>Download evidence</button></aside>}</div>}
          </div>
        )}
      </section>

      {approvalDecision && <Modal titleId="approval-decision-title" onClose={closeApprovalDecision} wide>
        <div className="modal-head"><div><p>RECORDED APPROVAL DECISION</p><h2 id="approval-decision-title">Review before you {approvalDecision.status === "Approved" ? "approve" : "request changes"}</h2></div><button type="button" disabled={approvalDecisionBusy} onClick={closeApprovalDecision} aria-label="Close approval review">×</button></div>
        <div className="wizard-body approval-decision-review" aria-busy={approvalDecisionBusy}>
          <p className="approval-decision-intro">Your decision is attributable and cannot be treated as review of different paper. Confirm the exact basis below and record why you reached this decision.</p>
          <dl className="approval-basis-review">
            <div><dt>Agreement</dt><dd>{approvalDecisionAgreement ? <>{approvalDecisionAgreement.party}<small>{approvalDecisionAgreement.type}</small></> : "Agreement is no longer available"}</dd></div>
            <div><dt>Decision</dt><dd>{approvalDecision.status}<small>{approvalDecision.approval.role} approval</small></dd></div>
            <div><dt>Document version</dt><dd>{approvalDecision.approval.documentVersion ? `Working v${approvalDecision.approval.documentVersion}` : "Not recorded in this evaluation sample"}</dd></div>
            <div><dt>Document SHA-256</dt><dd><code>{approvalDecision.approval.documentSha256 ?? "No durable document hash is available for this evaluation sample"}</code></dd></div>
            <div><dt>Approval basis hash</dt><dd><code>{approvalDecision.approval.basisHash ?? "No durable basis hash is available for this evaluation sample"}</code></dd></div>
          </dl>
          {!approvalDecisionBasisComplete && <div className="approval-basis-warning" role={approvalDecisionIsEvaluationSample ? "note" : "alert"}><strong>{approvalDecisionIsEvaluationSample ? "Evaluation data only" : "Decision blocked"}</strong><p>{approvalDecisionIsEvaluationSample ? "This sample has no immutable approval basis. The decision stays local and cannot activate a production contract." : "This production approval is missing its exact request basis. Reload the queue; do not infer or substitute a document version."}</p></div>}
          <label className="approval-reason-field"><span>Decision reason *</span><textarea autoFocus disabled={approvalDecisionBusy} maxLength={2000} rows={4} value={approvalDecisionReason} onChange={(event) => setApprovalDecisionReason(event.target.value)} placeholder={approvalDecision.status === "Approved" ? "Explain why the exact terms and paper are acceptable…" : "Describe the changes required before this can be approved…"} /></label>
          <label className="approval-confirmation"><input type="checkbox" disabled={approvalDecisionBusy} checked={approvalDecisionConfirmed} onChange={(event) => setApprovalDecisionConfirmed(event.target.checked)} /><span>I confirm I reviewed the agreement and, when listed above, the exact immutable document version, SHA-256, and approval basis for this decision.</span></label>
        </div>
        <div className="wizard-actions"><button type="button" disabled={approvalDecisionBusy} onClick={closeApprovalDecision}>Cancel</button><button className={approvalDecision.status === "Approved" ? "primary-button" : "danger-button"} type="button" disabled={approvalDecisionBusy || !approvalDecisionReason.trim() || !approvalDecisionConfirmed || !approvalDecisionAgreement || (!approvalDecisionIsEvaluationSample && !approvalDecisionBasisComplete)} onClick={() => void decideApproval(approvalDecision.approval, approvalDecision.status, approvalDecisionReason, approvalDecisionConfirmed)}>{approvalDecisionBusy ? "Recording decision…" : approvalDecision.status === "Approved" ? "Confirm approval" : "Confirm change request"} {!approvalDecisionBusy && <span>→</span>}</button></div>
      </Modal>}

      {newOpen && canCreateAgreement && <Modal titleId="generate-title" onClose={closeGenerator} wide={newStep === 3}>
        <div className="modal-head"><div><p>START FROM TEMPLATE</p><h2 id="generate-title">{newStep === 1 ? "Choose governed or starter paper" : newStep === 2 ? "Confirm the contract details" : "Review before creating the working draft"}</h2></div><button type="button" disabled={newCreateBusy} onClick={closeGenerator} aria-label="Close">×</button></div>
        <div className="wizard-steps" aria-label="Template creation progress"><span className={newStep >= 1 ? "active" : ""} aria-current={newStep === 1 ? "step" : undefined}>1 <b>Direction</b></span><i aria-hidden="true" /><span className={newStep >= 2 ? "active" : ""} aria-current={newStep === 2 ? "step" : undefined}>2 <b>Data</b></span><i aria-hidden="true" /><span className={newStep >= 3 ? "active" : ""} aria-current={newStep === 3 ? "step" : undefined}>3 <b>Draft</b></span></div>
        {newStep === 1 && <div className="wizard-body"><p id="contract-direction-label" className="field-label">CONTRACT DIRECTION</p><div className="direction-grid" role="group" aria-labelledby="contract-direction-label">{(["Sell-side", "Buy-side", "Corporate"] as AgreementSide[]).map((side) => <button className={newSide === side ? "active" : ""} type="button" key={side} aria-pressed={newSide === side} onClick={() => { setNewSide(side); setNewTemplate(templatesBySide[side][0]); setNewGovernedTemplateVersionId(""); setNewTemplateVariables({}); setNewDepartment(side === "Sell-side" ? "Sales" : side === "Buy-side" ? "Procurement" : "Legal"); }}><span aria-hidden="true">{side === "Sell-side" ? "↗" : side === "Buy-side" ? "↙" : "◇"}</span><b>{contractDirectionLabel(side)}</b><small>{side === "Sell-side" ? "Customer and revenue contracts" : side === "Buy-side" ? "Supplier and procurement contracts" : "People, partnership, and company contracts"}</small></button>)}</div><p id="starter-template-label" className="field-label">CHOOSE EXACT PAPER</p><div className="template-list" role="group" aria-labelledby="starter-template-label">{publishedTemplates.filter((template) => template.side === newSide).map((template) => <button className={newGovernedTemplateVersionId === template.publishedVersion.id ? "active governed" : "governed"} type="button" key={template.publishedVersion.id} aria-pressed={newGovernedTemplateVersionId === template.publishedVersion.id} onClick={() => { setNewTemplate(template.agreementType); setNewGovernedTemplateVersionId(template.publishedVersion.id); const variables = template.publishedVersion.variableSchema.variables ?? {}; setNewTemplateVariables(Object.fromEntries(Object.entries(variables).filter(([, definition]) => definition.source === "input").map(([name]) => [name, ""]))); }}><span aria-hidden="true">◆</span><div><b>{template.name}</b><small>Governed · exact published v{template.publishedVersion.version}</small></div><i aria-hidden="true">{newGovernedTemplateVersionId === template.publishedVersion.id ? "✓" : ""}</i></button>)}{templatesBySide[newSide].map((template) => <button className={!newGovernedTemplateVersionId && newTemplate === template ? "active" : ""} type="button" key={`starter-${template}`} aria-pressed={!newGovernedTemplateVersionId && newTemplate === template} onClick={() => { setNewTemplate(template); setNewGovernedTemplateVersionId(""); setNewTemplateVariables({}); }}><span aria-hidden="true">▤</span><div><b>{template}</b><small>Starter structure · Human review required</small></div><i aria-hidden="true">{!newGovernedTemplateVersionId && newTemplate === template ? "✓" : ""}</i></button>)}</div>{enterpriseChoicesLoading && <p className="wizard-inline-state" role="status">Loading governed templates…</p>}{enterpriseChoicesError && <p className="wizard-inline-state error" role="alert">Governed templates are unavailable. Starter templates remain available.</p>}</div>}
        {newStep === 2 && <div className="wizard-body"><div className="crm-source"><span className={`crm-monogram ${newCrm === "Salesforce" ? "blue" : newCrm === "HubSpot" ? "orange" : "dark"}`}>{newCrm === "Salesforce" ? "SF" : newCrm === "HubSpot" ? "HS" : "{ }"}</span><div><p>CRM SYNC</p><b>{newCrm === "None" ? "Synchronization disabled" : `${newCrm} outbound sync`}</b></div><select value={newCrm} onChange={(event) => setNewCrm(event.target.value as Agreement["crm"])}><option value="None">No CRM sync</option><option disabled={!connections.HubSpot}>HubSpot</option><option disabled={!connections.Salesforce}>Salesforce</option><option disabled={!connections["Custom CRM"]}>Custom CRM</option></select></div><div className="form-grid">
          <label><span>Counterparty *</span><input data-initial-focus value={newParty} onChange={(event) => setNewParty(event.target.value)} /></label>
          <label><span>Structured counterparty</span><select value={newPrimaryCounterpartyId} onChange={(event) => { const id = event.target.value; const party = enterpriseCounterparties.find((entry) => entry.id === id); setNewPrimaryCounterpartyId(id); if (party) setNewParty(party.displayName); }}><option value="">Use display name only</option>{enterpriseCounterparties.filter((party) => party.status === "active").map((party) => <option value={party.id} key={party.id}>{party.displayName}</option>)}</select></label>
          <label><span>Contract value</span><div className="money-input"><input className="currency-code" aria-label="Currency code" pattern="[A-Za-z]{3}" maxLength={3} value={newCurrency} onChange={(event) => setNewCurrency(event.target.value.toUpperCase())} /><input aria-label="Contract amount" value={newValue} inputMode="decimal" onChange={(event) => setNewValue(event.target.value)} /></div></label>
          <label><span>Our legal entity</span><select value={newLegalEntityId} onChange={(event) => { const id = event.target.value; const entity = enterpriseLegalEntities.find((entry) => entry.id === id); setNewLegalEntityId(id); if (entity && !newCurrency) setNewCurrency(entity.defaultCurrencyCode); }}><option value="">{session?.workspace.name ?? "No structured entity"}</option>{enterpriseLegalEntities.filter((entity) => entity.status === "active").map((entity) => <option value={entity.id} key={entity.id}>{entity.displayName} · {entity.defaultCurrencyCode}</option>)}</select></label>
          <label><span>Department</span><select value={newDepartment} onChange={(event) => setNewDepartment(event.target.value)}><option>Sales</option><option>Procurement</option><option>Legal</option><option>People</option><option>IT</option><option>Finance</option></select></label>
          <label><span>Owner</span><select value={newOwnerUserId} onChange={(event) => { const userId = event.target.value; const member = members.find((entry) => entry.userId === userId); setNewOwnerUserId(userId); setNewOwner(member?.displayName ?? session?.user.displayName ?? "Current user"); }}><option value={session?.user.id ?? ""}>{session?.user.displayName ?? "Current user"} · current user</option>{members.filter((member) => member.membershipStatus === "active" && member.userId !== session?.user.id).map((member) => <option value={member.userId} key={member.userId}>{member.displayName} · {member.role}</option>)}</select></label>
          <label><span>Approval workflow</span><select value={newWorkflowDefinitionId} onChange={(event) => setNewWorkflowDefinitionId(event.target.value)}><option value="">Starter approval policy</option>{enterpriseWorkflows.filter((workflow) => workflow.status === "published").map((workflow) => <option value={workflow.id} key={workflow.id}>{workflow.name} · v{workflow.version}</option>)}</select></label>
          <label><span>Governing law</span><select value={newLaw} onChange={(event) => setNewLaw(event.target.value)}><option>New York</option><option>Delaware</option><option>California</option><option>England & Wales</option></select></label>
          {Object.keys(newTemplateVariables).map((name) => <label key={name}><span>{name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())} *</span><input value={newTemplateVariables[name]} onChange={(event) => setNewTemplateVariables((current) => ({ ...current, [name]: event.target.value }))} /></label>)}
        </div><div className={`generation-rules ${newGovernedTemplateVersionId ? "governed" : ""}`}><span>{newGovernedTemplateVersionId ? "◆" : "✦"}</span><div><b>{newGovernedTemplateVersionId ? "Exact governed template selected" : "Starter template only"}</b><p>{newGovernedTemplateVersionId ? "Notice will render the immutable published body with confirmed variables and record its version and digest. Human legal review is still required." : `${starterDraftSummary(newTemplate)}. No workspace-approved language or policy decision is applied automatically.`}</p></div><span className="rule-source">{newWorkflowDefinitionId ? "Published workflow pinned" : `${clauses.length} approved clauses available after generation`}</span></div></div>}
        {newStep === 3 && <div className="draft-ready"><div className="draft-summary"><span className="ready-check">✓</span><h3>{newTemplate}</h3><p>{newParty} · {amountToMinor(newValue, newCurrency) !== null ? formatAgreementMoney({ value: Math.round(Number(newValue || 0)), valueMinor: amountToMinor(newValue, newCurrency) ?? 0, currencyCode: newCurrency }) : "No contract value"}</p><div>{[contractDirectionLabel(newSide), newGovernedTemplateVersionId ? "Governed template" : "Starter template", "Human review required", newWorkflowDefinitionId ? "Governed workflow" : "Starter policy", newCrm].map((tag) => <span key={tag}>{tag}</span>)}</div><dl><div><dt>Approval route</dt><dd>{newWorkflowDefinitionId ? "Computed from the exact published workflow after creation" : newCurrency === "USD" && Number(newValue) > FINANCE_APPROVAL_THRESHOLD_USD ? "Starter policy · Legal + Finance threshold" : "Starter policy · Legal review"}</dd></div><div><dt>Risk status</dt><dd>Not assessed · confirm against the saved paper</dd></div><div><dt>Owner</dt><dd>{newOwner}</dd></div><div><dt>CRM delivery</dt><dd>{newCrm === "None" ? "Off" : "Server configuration detected"}</dd></div></dl></div><div className={`mini-paper ${newGovernedTemplateVersionId ? "governed" : ""}`}><span>{newGovernedTemplateVersionId ? "GOVERNED PUBLISHED VERSION / HUMAN REVIEW REQUIRED" : "STARTER TEMPLATE / HUMAN REVIEW REQUIRED"}</span><h4>{newTemplate.toUpperCase()}</h4><p>This paper uses confirmed party data for <strong>{session?.workspace.name ?? "Our organization"}</strong> and <mark>{newParty}</mark>.</p><b>{newGovernedTemplateVersionId ? "Exact version pin" : "Starter structure"}</b><p>{newGovernedTemplateVersionId ? `Published version ${publishedTemplates.find((template) => template.publishedVersion.id === newGovernedTemplateVersionId)?.publishedVersion.version ?? "selected"} will be rendered server-side and its digest recorded.` : `${starterDraftSummary(newTemplate)}.`}</p><b>Human review</b><p>{newGovernedTemplateVersionId ? "Published governance does not approve this contract; review the generated working paper before routing decisions." : "No approved clause is applied automatically. Insert and save approved clauses in the working draft."}</p></div></div>}
        <div className="wizard-actions" aria-busy={newCreateBusy}><button type="button" disabled={newCreateBusy || newCreationRecoveryLocked} onClick={() => newStep === 1 ? closeGenerator() : setNewStep((step) => step - 1)}>← {newStep === 1 ? "Cancel" : "Back"}</button><button type="button" disabled={newCreateBusy || (newStep === 2 && (!newParty.trim() || !/^[A-Z]{3}$/.test(newCurrency) || amountToMinor(newValue, newCurrency) === null || Object.values(newTemplateVariables).some((value) => !value.trim())))} onClick={() => newStep < 3 ? setNewStep((step) => step + 1) : void createAgreement()}>{newCreateBusy ? "Creating working draft…" : newStep < 3 ? "Continue" : newCreationRecoveryLocked ? "Retry exact intake" : "Open working draft"} {!newCreateBusy && <span>→</span>}</button></div>
      </Modal>}

      {obligationOpen && canWriteObligations && <Modal titleId="obligation-title" onClose={closeObligationCreator} wide>
        <div className="modal-head"><div><p>NEW OBLIGATION SCHEDULE</p><h2 id="obligation-title">Turn an executed promise into owned work</h2></div><button type="button" disabled={obligationCreateBusy} onClick={closeObligationCreator} aria-label="Close obligation schedule creator">×</button></div>
        <div className="wizard-body obligation-creator" aria-busy={obligationCreateBusy}>
          {obligationCreationRecoveryLocked && <div className="obligation-recovery" role="status"><div><strong>Protected retry ready</strong><p>The exact request body and UUID idempotency key are locked after an ambiguous attempt. Retry it unchanged to recover the original result without creating a duplicate.</p></div><button type="button" disabled={obligationCreateBusy} onClick={() => clearObligationCreationRecovery()}>Discard protected retry</button></div>}
          {session?.mode === "evaluation" && <div className="obligation-evaluation-note"><strong>Browser-only evaluation</strong><span>Schedules for labeled sample agreements stay in this tab and never run jobs or write evidence. API-backed agreements still use the governed server workflow.</span></div>}
          <div className="form-grid obligation-form-grid">
            <label><span>Executed agreement *</span><select autoFocus disabled={obligationCreateBusy || obligationCreationRecoveryLocked} value={obligationAgreementId || ""} onChange={(event) => setObligationAgreementId(Number(event.target.value))}><option value="">Select an active agreement</option>{agreements.filter((agreement) => agreement.stage === "Active" || agreement.signatureStatus === "Completed").map((agreement) => <option key={agreement.id} value={agreement.id}>{agreement.party} · {agreement.type}{isEvaluationAgreement(agreement.id) ? " · browser sample" : ""}</option>)}</select></label>
            <label><span>Eligible owner *</span><select disabled={obligationCreateBusy || obligationCreationRecoveryLocked || eligibleObligationOwners.length === 0} value={obligationOwnerUserId} onChange={(event) => setObligationOwnerUserId(event.target.value)}><option value="">Select an active owner</option>{eligibleObligationOwners.map((owner) => <option key={owner.userId} value={owner.userId}>{owner.displayName} · {owner.role}</option>)}</select></label>
            <label><span>First due date *</span><input disabled={obligationCreateBusy || obligationCreationRecoveryLocked} type="date" min={obligationRecurrence === "once" ? undefined : obligationCalendarDateInTimeZone(obligationTimeZone)} value={obligationDue} onChange={(event) => setObligationDue(event.target.value)} /></label>
            <label><span>Recurrence *</span><select disabled={obligationCreateBusy || obligationCreationRecoveryLocked} value={obligationRecurrence} onChange={(event) => { const recurrence = event.target.value as ObligationRecurrenceChoice; setObligationRecurrence(recurrence); if (recurrence === "once") setObligationEndDate(""); }}><option value="once">Once</option><option value="week">Weekly</option><option value="month">Monthly</option><option value="quarter">Quarterly</option><option value="year">Annual</option></select></label>
            <label><span>Calendar timezone *</span><select disabled={obligationCreateBusy || obligationCreationRecoveryLocked} value={obligationTimeZone} onChange={(event) => setObligationTimeZone(event.target.value)}>{obligationTimeZoneOptions.map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}</select></label>
            {obligationRecurrence !== "once" && <label><span>Inclusive end date (optional)</span><input disabled={obligationCreateBusy || obligationCreationRecoveryLocked} type="date" min={obligationDue || obligationCalendarDateInTimeZone(obligationTimeZone)} value={obligationEndDate} onChange={(event) => setObligationEndDate(event.target.value)} /></label>}
          </div>
          <label className="obligation-title-field"><span>Obligation *</span><input disabled={obligationCreateBusy || obligationCreationRecoveryLocked} value={obligationTitle} maxLength={500} onChange={(event) => setObligationTitle(event.target.value)} placeholder="e.g. Send renewal notice" /></label>
          <label className="obligation-title-field"><span>Contract source *</span><input disabled={obligationCreateBusy || obligationCreationRecoveryLocked} value={obligationSource} maxLength={500} onChange={(event) => setObligationSource(event.target.value)} placeholder="e.g. § 8.2 Renewal notice" /></label>
          <fieldset className="reminder-leads" disabled={obligationCreateBusy || obligationCreationRecoveryLocked}><legend>Reminder lead times *</legend>{[30, 14, 7, 1, 0].map((days) => <label key={days}><input type="checkbox" checked={obligationReminderLeadDays.includes(days)} onChange={(event) => setObligationReminderLeadDays((current) => event.target.checked ? [...current, days] : current.filter((value) => value !== days))} /><span>{days === 0 ? "On due date" : `${days} day${days === 1 ? "" : "s"} before`}</span></label>)}</fieldset>
          <div className="generation-rules"><span>⌁</span><div><b>Anchored calendar schedule</b><p>Monthly, quarterly, and annual dates stay anchored in {obligationTimeZone}. Pausing or ending stops future occurrence creation; it never closes existing work.</p></div><span className="rule-source">{obligationRecurrence === "once" ? "One occurrence" : `${obligationRecurrenceLabel({ recurrenceUnit: obligationRecurrenceRule(obligationRecurrence).unit, recurrenceInterval: obligationRecurrenceRule(obligationRecurrence).interval })} schedule`}</span></div>
          <label className="approval-confirmation"><input type="checkbox" disabled={obligationCreateBusy || obligationCreationRecoveryLocked} checked={obligationCreateConfirmed} onChange={(event) => setObligationCreateConfirmed(event.target.checked)} /><span>I reviewed the executed source, first due date, recurrence, timezone, reminders, and eligible owner. Create this exact human-authored schedule and occurrence.</span></label>
        </div>
        <div className="wizard-actions"><button type="button" disabled={obligationCreateBusy} onClick={closeObligationCreator}>Cancel</button><button type="button" disabled={obligationCreateBusy || !obligationAgreementId || !obligationTitle.trim() || !obligationSource.trim() || !obligationDue || !obligationOwnerUserId || obligationReminderLeadDays.length === 0 || !obligationCreateConfirmed} onClick={() => void addObligation()}>{obligationCreateBusy ? "Creating exact schedule…" : obligationCreationRecoveryLocked ? "Retry exact schedule" : "Create schedule & occurrence"} {!obligationCreateBusy && <span>→</span>}</button></div>
      </Modal>}

      {obligationCompletion && <Modal titleId="obligation-completion-title" onClose={closeObligationCompletion}>
        <div className="modal-head"><div><p>FULFILLMENT EVIDENCE</p><h2 id="obligation-completion-title">Review before completing {obligationCompletion.title}</h2></div><button type="button" disabled={obligationCompletionBusy} onClick={closeObligationCompletion} aria-label="Close obligation evidence review">×</button></div>
        <div className="wizard-body" aria-busy={obligationCompletionBusy}>
          <p>Completion is an attributable human assertion. Record the ticket, confirmation, delivered artifact, or measurable outcome that proves this exact obligation was fulfilled.</p>
          <dl className="agent-plan-basis"><div><dt>Agreement</dt><dd>{agreements.find((agreement) => agreement.id === obligationCompletion.agreementId)?.party ?? obligationCompletion.agreementId}</dd></div><div><dt>Occurrence</dt><dd>#{obligationCompletion.occurrenceNumber ?? 1} · {obligationRecurrenceLabel(obligationCompletion.scheduleId ? obligationScheduleById.get(obligationCompletion.scheduleId) : null, obligationCompletion.cadence)}</dd></div><div><dt>Assigned owner</dt><dd>{obligationCompletion.owner}</dd></div><div><dt>Due date</dt><dd>{obligationDateLabel(obligationCompletion.dueDate)}</dd></div><div><dt>Source</dt><dd>{obligationCompletion.source}</dd></div><div><dt>Evidence effect</dt><dd>{obligationCompletion.evaluationOnly ? "Browser sample only" : "Immutable evidence record + audit event"}</dd></div></dl>
          <label className="approval-reason-field"><span>Completion evidence *</span><textarea autoFocus disabled={obligationCompletionBusy} maxLength={2000} rows={5} value={obligationCompletionEvidence} onChange={(event) => setObligationCompletionEvidence(event.target.value)} placeholder="Ticket, delivery confirmation, evidence location, and outcome…" /></label>
          {obligationCompletion.ownerUserId !== session?.user.id && <div className="approval-basis-warning" role="alert"><strong>Legal/Admin override</strong><p>You are not the assigned owner. Explain why you are completing this obligation on their behalf; the reason is recorded in the audit trail.</p><label className="approval-reason-field"><span>Override reason *</span><textarea disabled={obligationCompletionBusy} maxLength={2000} rows={3} value={obligationOverrideReason} onChange={(event) => setObligationOverrideReason(event.target.value)} /></label></div>}
          <label className="approval-confirmation"><input type="checkbox" disabled={obligationCompletionBusy} checked={obligationCompletionConfirmed} onChange={(event) => setObligationCompletionConfirmed(event.target.checked)} /><span>I reviewed this exact dated occurrence and confirm the evidence proves it was fulfilled. This completion cannot be reopened or edited.</span></label>
        </div>
        <div className="wizard-actions"><button type="button" disabled={obligationCompletionBusy} onClick={closeObligationCompletion}>Cancel</button><button className="primary-button" type="button" disabled={obligationCompletionBusy || !obligationCompletionEvidence.trim() || !obligationCompletionConfirmed || (obligationCompletion.ownerUserId !== session?.user.id && obligationOverrideReason.trim().length < 8)} onClick={() => void completeObligation()}>{obligationCompletionBusy ? "Recording evidence…" : "Mark complete with evidence"} {!obligationCompletionBusy && <span>→</span>}</button></div>
      </Modal>}

      {obligationScheduleManagement && <Modal titleId="obligation-schedule-management-title" onClose={closeObligationScheduleManagement} wide>
        <div className="modal-head"><div><p>SCHEDULE CONTROL</p><h2 id="obligation-schedule-management-title">Manage {obligationScheduleManagement.title}</h2></div><button type="button" disabled={obligationScheduleBusy} onClick={closeObligationScheduleManagement} aria-label="Close obligation schedule management">×</button></div>
        <div className="wizard-body obligation-schedule-management" aria-busy={obligationScheduleBusy}>
          <dl className="agent-plan-basis"><div><dt>Agreement</dt><dd>{agreements.find((agreement) => agreement.id === obligationScheduleManagement.agreementId)?.party ?? obligationScheduleManagement.agreementId}</dd></div><div><dt>Schedule</dt><dd>{obligationRecurrenceLabel(obligationScheduleManagement)} · {obligationScheduleManagement.status}</dd></div><div><dt>Current owner</dt><dd>{obligationScheduleManagement.owner}{obligationScheduleManagement.ownerUserId === null && <small className="repair-badge">Migrated owner needs repair</small>}</dd></div><div><dt>Calendar</dt><dd>{obligationScheduleManagement.timezone}<small>{obligationScheduleManagement.anchorDate}{obligationScheduleManagement.endDate ? ` through ${obligationScheduleManagement.endDate}` : " · no end date"}</small></dd></div></dl>
          <div className="schedule-action-picker" role="group" aria-label="Schedule change">{(["reassign", ...(obligationScheduleManagement.status === "active" ? ["pause", "end"] : obligationScheduleManagement.status === "paused" ? ["resume", "end"] : [])] as Array<"reassign" | "pause" | "resume" | "end">).map((action) => <button type="button" disabled={obligationScheduleBusy} className={obligationScheduleAction === action ? "active" : ""} aria-pressed={obligationScheduleAction === action} key={action} onClick={() => { setObligationScheduleAction(action); setObligationScheduleConfirmed(false); }}>{action === "reassign" ? "Reassign owner" : action === "pause" ? "Pause future work" : action === "resume" ? "Resume future work" : "End irreversibly"}</button>)}</div>
          {obligationScheduleAction === "reassign" ? <label className="schedule-owner-field"><span>New eligible owner *</span><select disabled={obligationScheduleBusy} value={obligationScheduleOwnerUserId} onChange={(event) => setObligationScheduleOwnerUserId(event.target.value)}><option value="">Select an active owner</option>{eligibleObligationOwners.map((owner) => <option disabled={owner.userId === obligationScheduleManagement.ownerUserId} key={owner.userId} value={owner.userId}>{owner.displayName} · {owner.role}</option>)}</select></label> : <div className={`schedule-effect ${obligationScheduleAction === "end" ? "danger" : ""}`}><strong>{obligationScheduleAction === "pause" ? "Pause future materialization" : obligationScheduleAction === "resume" ? "Resume anchored materialization" : "End this schedule forever"}</strong><p>Existing open occurrences are unaffected and remain due in the queue. {obligationScheduleAction === "end" ? "Ending clears the future cursor and cannot be reversed." : obligationScheduleAction === "pause" ? "No future occurrence is created until an authorized member resumes it." : "Future dates continue from the immutable anchor without drift."}</p>{obligationScheduleAction === "resume" && !managedScheduleOwnerEligible && <small role="alert">This owner is no longer eligible. Reassign the schedule before resuming future occurrences.</small>}</div>}
          {obligationScheduleAction === "reassign" && <div className="schedule-effect"><strong>Ownership change</strong><p>The new owner replaces schedule ownership and every currently open occurrence. Completed evidence remains attributed to its original submitter.</p></div>}
          <label className="approval-reason-field"><span>Schedule-change reason *</span><textarea autoFocus disabled={obligationScheduleBusy} maxLength={2000} rows={4} value={obligationScheduleReason} onChange={(event) => setObligationScheduleReason(event.target.value)} placeholder="Explain the operational reason for this exact change…" /></label>
          <label className="approval-confirmation"><input type="checkbox" disabled={obligationScheduleBusy} checked={obligationScheduleConfirmed} onChange={(event) => setObligationScheduleConfirmed(event.target.checked)} /><span>I reviewed the schedule version, owner, recurrence cursor effect, and existing-occurrence behavior. Apply this exact human-authorized change.</span></label>
        </div>
        <div className="wizard-actions"><button type="button" disabled={obligationScheduleBusy} onClick={closeObligationScheduleManagement}>Cancel</button><button className={obligationScheduleAction === "end" ? "danger-button" : "primary-button"} type="button" disabled={obligationScheduleBusy || obligationScheduleReason.trim().length < 8 || !obligationScheduleConfirmed || (obligationScheduleAction === "reassign" && (!obligationScheduleOwnerUserId || obligationScheduleOwnerUserId === obligationScheduleManagement.ownerUserId)) || (obligationScheduleAction === "resume" && !managedScheduleOwnerEligible)} onClick={() => void manageObligationSchedule()}>{obligationScheduleBusy ? "Applying exact change…" : obligationScheduleAction === "reassign" ? "Reassign schedule" : obligationScheduleAction === "pause" ? "Pause future work" : obligationScheduleAction === "resume" ? "Resume future work" : "End schedule forever"} {!obligationScheduleBusy && <span>→</span>}</button></div>
      </Modal>}

      {obligationEvidenceReview && <Modal titleId="obligation-evidence-title" onClose={() => setObligationEvidenceReview(null)}>
        <div className="modal-head"><div><p>IMMUTABLE FULFILLMENT EVIDENCE</p><h2 id="obligation-evidence-title">Recorded completion evidence</h2></div><button type="button" onClick={() => setObligationEvidenceReview(null)} aria-label="Close recorded obligation evidence">×</button></div>
        <div className="wizard-body obligation-evidence-review">
          {obligationEvidenceReview.evaluationOnly && <div className="obligation-evaluation-note"><strong>Browser sample only</strong><span>This illustrative evidence is not durable and has no cryptographic digest or audit-chain entry.</span></div>}
          <dl className="agent-plan-basis"><div><dt>Agreement</dt><dd>{agreements.find((agreement) => agreement.id === obligationEvidenceReview.agreementId)?.party ?? obligationEvidenceReview.agreementId}</dd></div><div><dt>Occurrence</dt><dd>{obligations.find((obligation) => obligation.id === obligationEvidenceReview.obligationId)?.title ?? obligationEvidenceReview.obligationId}</dd></div><div><dt>Recorded</dt><dd>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(obligationEvidenceReview.createdAt))}</dd></div><div><dt>Provenance</dt><dd>{obligationEvidenceReview.provenance === "legacy_v16" ? "Legacy v16 backfill" : obligationEvidenceReview.provenance === "evaluation" ? "Evaluation browser sample" : "Native governed completion"}</dd></div></dl>
          <section className="evidence-text"><h3>Evidence assertion</h3><p>{obligationEvidenceReview.evidenceText}</p></section>
          <dl className="evidence-metadata"><div><dt>SHA-256</dt><dd><code>{obligationEvidenceReview.evidenceSha256 ?? "Not available for this legacy or evaluation record"}</code></dd></div><div><dt>Submitted by</dt><dd>{eligibleObligationOwners.find((owner) => owner.userId === obligationEvidenceReview.submittedByUserId)?.displayName ?? obligationEvidenceReview.submittedByUserId ?? "Legacy attribution unavailable"}</dd></div>{obligationEvidenceReview.overrideReason && <div><dt>Override reason</dt><dd>{obligationEvidenceReview.overrideReason}</dd></div>}</dl>
        </div>
        <div className="wizard-actions"><span /><button type="button" onClick={() => setObligationEvidenceReview(null)}>Close evidence</button></div>
      </Modal>}

      {importOpen && canImportAgreement && <ImportDialog mode={session?.mode ?? "production"} step={importStep} name={importName} analysis={importAnalysis} error={importError} busy={importUploadBusy || importCreateBusy} recoveryLocked={importCreationRecoveryLocked} onClose={closeImport} onDiscard={discardImportedIntake} onFile={handleFile} onDrop={handleDrop} onStartSample={() => void startImport()} onBack={() => { setImportError(""); setImportStep("drop"); }} onConfirm={addImportedAgreement} onAnalysisChange={updateImportAnalysis} />}

      {signatureReview && signatureReviewPacket && signatureReviewAgreement && <Modal titleId="signature-review-title" onClose={closeSignatureEvidenceReview} wide>
        <div className="modal-head"><div><p>HUMAN SIGNED-EVIDENCE REVIEW</p><h2 id="signature-review-title">Review the final signed artifact before activation</h2></div><button type="button" disabled={signatureReviewBusy} onClick={closeSignatureEvidenceReview} aria-label="Close signed evidence review">×</button></div>
        <div className="wizard-body signature-evidence-review" aria-busy={signatureReviewBusy}>
          <p className="signature-review-intro"><strong>{signatureReviewAgreement.party}</strong> remains in Signature. Provider completion, scanning, and matching identifiers are evidence inputs—not authorization to activate the agreement.</p>
          <dl className="approval-basis-review signature-basis-review">
            <div><dt>Approved working paper</dt><dd>Version {signatureReviewPacket.documentVersion}<small><code>{signatureReviewPacket.documentSha256}</code></small></dd></div>
            <div><dt>Approval basis</dt><dd><code>{signatureReviewPacket.basisHash ?? "Missing basis hash"}</code></dd></div>
            <div><dt>Final signed artifact</dt><dd>{signatureReviewPacket.evidenceDocumentId ?? "Missing artifact identifier"}<small><code>{signatureReviewPacket.finalArtifactSha256 ?? "Missing artifact SHA-256"}</code></small></dd></div>
          </dl>
          {!signatureReviewBasisComplete && <div className="approval-basis-warning" role="alert"><strong>Activation blocked</strong><p>The packet does not include every exact-basis and final-artifact field. Refresh the provider record; do not confirm or work around this gate.</p></div>}
          <button className="signed-artifact-download" type="button" disabled={signatureReviewBusy || !signatureReviewPacket.evidenceDocumentId} onClick={() => void downloadSignatureEvidence(signatureReviewPacket, signatureReviewAgreement)}>↓ Download exact final signed artifact</button>
          <label className="approval-reason-field"><span>Review reason *</span><textarea autoFocus disabled={signatureReviewBusy} maxLength={2000} rows={4} value={signatureReviewReason} onChange={(event) => setSignatureReviewReason(event.target.value)} placeholder="Describe the artifact, signer, and approved-basis checks you completed…" /></label>
          <label className="approval-confirmation"><input type="checkbox" disabled={signatureReviewBusy || !signatureReviewBasisComplete} checked={signatureReviewConfirmed} onChange={(event) => setSignatureReviewConfirmed(event.target.checked)} /><span>{FINAL_SIGNATURE_REVIEW_CONFIRMATION}</span></label>
        </div>
        <div className="wizard-actions"><button type="button" disabled={signatureReviewBusy} onClick={closeSignatureEvidenceReview}>Cancel</button><button type="button" disabled={signatureReviewBusy || !signatureReviewBasisComplete || !signatureReviewReason.trim() || !signatureReviewConfirmed} onClick={() => void reviewCompletedSignatureEvidence()}>{signatureReviewBusy ? "Recording review…" : "Confirm review and activate"} {!signatureReviewBusy && <span>→</span>}</button></div>
      </Modal>}

      {signOpen && canUpdateAgreement && <Modal titleId="signature-title" onClose={() => setSignOpen(false)} extraWide>
        <div className="modal-head signature-head"><div><p>VERIFIED SIGNATURE</p><h2 id="signature-title">Sign {selected.party} · {selected.type}</h2></div><div className="docuseal-credit"><span>DS</span><div><small>PROVIDER</small><b>DocuSeal</b></div></div><button type="button" onClick={() => setSignOpen(false)} aria-label="Close">×</button></div>
        <div className="signature-flow"><span className="done">✓ <b>{session?.workspace.name ?? "Our organization"}</b><small>{session?.user.email ?? "Verified identity"}</small></span><i>→</i><span>2 <b>{selected.party}</b><small>{selectedSignatureInFlight ? signatureStatusLabel(selected.signatureStatus) : `${signatureParties.length} signer${signatureParties.length === 1 ? "" : "s"} to confirm`}</small></span><i>→</i><span className={selectedSignatureNeedsHumanReview ? "review" : ""}>3 <b>Evidence review</b><small>Human confirmation required before activation</small></span></div>
        {!evaluationSigningReady && selectedSignatureInFlight && <div className={`signature-setup ${selectedSignatureNeedsHumanReview ? "review-required" : ""}`}><div><b>{selectedSignatureNeedsHumanReview ? "Signed evidence requires human review" : selectedSignatureNeedsRecovery ? "Provider packet needs recovery" : selectedSignaturePacket?.status === "archived" ? "Provider packet is archived" : "Provider packet already sent"}</b><p>{selectedSignatureNeedsHumanReview ? "The provider completion and final artifact were retained, but Notice did not activate this agreement. An authorized Legal or Admin member must download and review the final signed artifact against the exact approved basis, then record an attributable confirmation." : selectedSignatureNeedsRecovery ? "Notice retained a unique recovery key after provider creation did not finish mapping into the agreement. Reconcile the same packet; do not create another submission. After one hour, a workspace administrator can verify that no provider submission exists and release the retained packet." : selectedSignaturePacket?.status === "archived" ? "The archived DocuSeal submission remains reserved because it can be restored by the provider. Refresh it, or have a workspace administrator explicitly supersede the provider-confirmed archive before creating a replacement." : "Notice will not create a duplicate packet or retain a replayable signing link. Signers use DocuSeal’s delivery flow; refresh provider state here after activity or if a webhook needs reconciliation."}</p>{selectedSignatureNeedsHumanReview && selectedSignaturePacket && canReviewCompletedSignature && <button className="primary-button" type="button" onClick={() => openSignatureEvidenceReview(selected, selectedSignaturePacket)}>Review signed evidence</button>}{selectedSignatureNeedsHumanReview && !canReviewCompletedSignature && <span className="permission-note">Your role can view this status, but cannot activate signed evidence.</span>}{selectedSignatureCanRefresh && <button className="primary-button" type="button" onClick={() => void reconcileSignaturePacket()}>{selectedSignatureNeedsRecovery ? "Reconcile provider packet" : "Refresh provider state"}</button>}{canManageWorkspace && selectedSignatureCanBeAbandoned && <button type="button" onClick={() => void abandonUnmappedSignaturePacket()}>Verify absence and release packet</button>}{canManageWorkspace && selectedSignatureCanBeSuperseded && <button type="button" onClick={() => void supersedeArchivedSignaturePacket()}>Supersede archived packet</button>}</div></div>}
        {!evaluationSigningReady && !selectedSignatureInFlight && <div className="signature-setup">
          {signatureParties.map((party, index) => <div key={party.role || index}><label><span>Signer role</span><input value={party.role} readOnly={signatureProviderRoles.length > 0} onChange={(event) => setSignatureParties((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, role: event.target.value } : item))} placeholder="Counterparty" /></label><label><span>Signer name</span><input value={party.name} onChange={(event) => setSignatureParties((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} placeholder="Alex Morgan" /></label><label><span>Signer email</span><input type="email" value={party.email} onChange={(event) => setSignatureParties((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, email: event.target.value } : item))} placeholder="signer@counterparty.example" /></label>{signatureProviderRoles.length === 0 && signatureParties.length > 1 && <button type="button" onClick={() => setSignatureParties((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove signer</button>}</div>)}
          {signatureProviderRoles.length === 0 && signatureParties.length < 10 && <button type="button" onClick={() => setSignatureParties((current) => [...current, { role: "Additional signer", name: "", email: "" }])}>＋ Add signer</button>}
          <button className="primary-button" type="button" onClick={() => void startSignaturePacket()}>Create secure packet</button>
        </div>}
        {evaluationSigningReady && session?.mode === "evaluation" && <div className="signature-setup"><div><b>Local signature simulation</b><p>No signer details leave this device. Confirming below updates only the synthetic evaluation record and cannot create production evidence.</p><button className="primary-button" type="button" onClick={completeSignature}>Confirm simulated signature</button></div></div>}
        <div className="signature-note"><span>◆</span><p>{session?.mode === "evaluation" ? "Evaluation signing is a local simulation. It does not contact DocuSeal, create production evidence, or activate a contract." : "A verified provider completion only stages scanned signed evidence. Activation requires a separate attributable human review of the exact artifact and approved basis."}</p></div>
      </Modal>}

      {clauseOpen && canWriteLanguage && <Modal titleId="clause-title" onClose={() => setClauseOpen(false)}><div className="modal-head"><div><p>LANGUAGE BUILDER</p><h2 id="clause-title">Create an approved block</h2></div><button type="button" onClick={() => setClauseOpen(false)} aria-label="Close">×</button></div><div className="clause-builder"><label><span>Block name</span><input value={clauseTitle} onChange={(event) => setClauseTitle(event.target.value)} /></label><div className="profile-choice" role="group" aria-labelledby="negotiation-profile-label"><p id="negotiation-profile-label">NEGOTIATION PROFILE</p>{(["Standard", "Fallback", "Strict"] as const).map((profile) => <button type="button" className={clauseProfile === profile ? `active ${profile.toLowerCase()}` : ""} key={profile} aria-pressed={clauseProfile === profile} onClick={() => setClauseProfile(profile)}><i aria-hidden="true" />{profile}<small>{profile === "Standard" ? "Default paper" : profile === "Fallback" ? "Acceptable compromise" : "Required position"}</small></button>)}</div><label><span>Approved language</span><textarea value={clauseText} onChange={(event) => setClauseText(event.target.value)} rows={7} /></label><div className="token-row"><p>PLACEHOLDER TEXT · INSERTED LITERALLY</p>{["{{counterparty}}", "{{effective_date}}", "{{fees}}", "{{notice_period}}"].map((token) => <button type="button" key={token} onClick={() => setClauseText((value) => `${value} ${token}`)}>{token}</button>)}</div><div className="builder-rule"><span>⌁</span><div><b>Starter condition</b><p>Sell-side agreement · Contract value below $500k · United States</p></div><span>Replace with company policy</span></div></div><div className="wizard-actions"><button type="button" onClick={() => setClauseOpen(false)}>Cancel</button><button type="button" onClick={addClause}>Save approved block <span>→</span></button></div></Modal>}

      {integrationPanel && <Modal titleId="integration-title" onClose={() => setIntegrationPanel(null)}><div className="modal-head"><div><p>CRM DELIVERY</p><h2 id="integration-title">{integrationPanel}</h2></div><button type="button" onClick={() => setIntegrationPanel(null)} aria-label="Close">×</button></div><div className="connection-detail"><div className="connection-status"><span className={`crm-monogram ${integrationPanel === "Salesforce" ? "blue" : integrationPanel === "HubSpot" ? "orange" : "dark"}`}>{integrationPanel === "Salesforce" ? "SF" : integrationPanel === "HubSpot" ? "HS" : "{ }"}</span><div><b>{integrationStatusKnown ? connections[integrationPanel] ? "Included adapter configured" : "Included adapter available" : "Configuration status is administrator-only"}</b><p>{integrationStatusKnown ? connections[integrationPanel] ? "Run the authenticated no-side-effect test and retain the gateway receipt before production use." : "Select this provider in deployment configuration, create its approved fields and credential, deploy the included CRM gateway, then run the live test." : "Ask a workspace administrator to review the server-held CRM gateway status."}</p></div><i className={integrationStatusKnown && connections[integrationPanel] ? "on" : ""} /></div><div className="event-list"><p>CRM MUTATION EVENTS</p>{["agreement.created", "agreement.updated", "agreement.stage_changed", "signature.completed", "agreement.deleted"].map((event) => <label key={event}><span>{event}</span><small>Validated and normalized by the included CRM gateway</small></label>)}</div>{canManageIntegrations ? <button className="test-connection" type="button" disabled={!integrations.find((integration) => integration.id === "crm")?.testable} onClick={() => void testIntegration("crm")}>⌁ Run no-side-effect test</button> : <p className="secret-note">Provider credentials and customer-approved field mappings stay in deployment secrets, never in the browser.</p>}</div><div className="wizard-actions"><button type="button" onClick={() => setIntegrationPanel(null)}>Close</button>{canManageWorkspace && <button type="button" onClick={() => { setIntegrationPanel(null); navigate("admin"); }}>Open deployment setup <span>→</span></button>}</div></Modal>}

      {agentReviewPlan && canManageWorkspace && <Modal titleId="agent-plan-review-title" onClose={() => { if (!agentReviewBusy) setAgentReviewPlan(null); }} extraWide>
        <div className="modal-head"><div><p>HUMAN AGENT-PLAN REVIEW</p><h2 id="agent-plan-review-title">Review {agentReviewPlan.actionId} against the exact persisted target</h2></div><button type="button" disabled={agentReviewBusy} onClick={() => setAgentReviewPlan(null)} aria-label="Close agent plan review">×</button></div>
        <div className="wizard-body agent-plan-review" aria-busy={agentReviewBusy}>
          <p className="agent-plan-review-intro">This decision does not execute the action or grant new authority. It binds your attributable decision to this exact plan digest; execution must still re-prove the creating principal, grant, sponsor, target, version, basis, and expiry.</p>
          <dl className="agent-plan-basis">
            <div><dt>Action and target</dt><dd>{agentReviewPlan.actionId}<small>{agentReviewPlan.target.type}:{agentReviewPlan.target.id} · expected v{agentReviewPlan.expectedVersion ?? "not required"}</small></dd></div>
            <div><dt>Durable / effective status</dt><dd>{agentReviewPlan.durableStatus.replaceAll("_", " ")}<small>{agentReviewPlan.review.effectiveStatus.replaceAll("_", " ")} · evaluated {agentReviewPlan.review.evaluatedAt}</small></dd></div>
            <div><dt>Plan SHA-256</dt><dd><code>{agentReviewPlan.planSha256}</code></dd></div>
            <div><dt>Paper basis</dt><dd><code>{agentReviewPlan.basisHash ?? "No paper basis required"}</code>{agentReviewPlan.workingDocument && <small>Working v{agentReviewPlan.workingDocument.version} · {agentReviewPlan.workingDocument.sha256}</small>}</dd></div>
            <div><dt>Grant / policy</dt><dd><code>{agentReviewPlan.grantId}</code><small>{agentReviewPlan.policyVersion} · expires {agentReviewPlan.expiresAt}</small></dd></div>
            <div><dt>Risk tier</dt><dd>{agentReviewPlan.riskTier}</dd></div>
          </dl>
          {!agentReviewPlan.review.eligible && <div className="approval-basis-warning" role="alert"><strong>Decision blocked</strong><p>The plan is stale, expired, blocked, already decided, or no longer backed by exact current authority.</p>{agentReviewPlan.review.blockers.map((blocker) => <small key={`${blocker.code}:${blocker.message}`}><code>{blocker.code}</code> {blocker.message}</small>)}</div>}
          <AgentPlanEffectSummary plan={agentReviewPlan} />
          <div className="agent-plan-material">
            <section><h3>Before state</h3><pre tabIndex={0} aria-label="Exact plan before state">{JSON.stringify(agentReviewPlan.before, null, 2)}</pre></section>
            <section><h3>Proposed diff</h3><pre tabIndex={0} aria-label="Exact proposed plan diff">{JSON.stringify(agentReviewPlan.proposedDiff, null, 2)}</pre></section>
            <section><h3>Canonical input</h3><pre tabIndex={0} aria-label="Canonical plan input">{JSON.stringify(agentReviewPlan.input, null, 2)}</pre></section>
            <section><h3>Provenance</h3><pre tabIndex={0} aria-label="Agent plan provenance">{JSON.stringify(agentReviewPlan.provenance, null, 2)}</pre></section>
          </div>
          {agentReviewPlan.blockers.length > 0 && <div className="agent-plan-persisted-blockers"><h3>Proposal-time blockers</h3><pre tabIndex={0} aria-label="Proposal-time blockers">{JSON.stringify(agentReviewPlan.blockers, null, 2)}</pre></div>}
          <label className="approval-reason-field"><span>Decision reason *</span><textarea autoFocus disabled={agentReviewBusy || !agentReviewPlan.review.eligible} maxLength={4000} rows={4} value={agentReviewReason} onChange={(event) => setAgentReviewReason(event.target.value)} placeholder="Explain your review of the exact before-state, diff, authority, and target basis…" /></label>
          <label className="approval-confirmation"><input type="checkbox" disabled={agentReviewBusy || !agentReviewPlan.review.eligible} checked={agentReviewConfirmed} onChange={(event) => setAgentReviewConfirmed(event.target.checked)} /><span>I reviewed the complete persisted plan material and confirm this decision applies only to the displayed SHA-256 digest, target version, paper basis, grant, and expiry.</span></label>
        </div>
        <div className="wizard-actions"><button type="button" disabled={agentReviewBusy} onClick={() => setAgentReviewPlan(null)}>Cancel</button><button className="danger-button" type="button" disabled={agentReviewBusy || !agentReviewPlan.review.eligible || agentReviewReason.trim().length < 8 || !agentReviewConfirmed} onClick={() => void decideAgentPlan("rejected")}>Reject plan</button><button className="primary-button" type="button" disabled={agentReviewBusy || !agentReviewPlan.review.eligible || agentReviewReason.trim().length < 8 || !agentReviewConfirmed} onClick={() => void decideAgentPlan("approved")}>{agentReviewBusy ? "Recording decision…" : "Approve exact plan"} {!agentReviewBusy && <span>→</span>}</button></div>
      </Modal>}

      {identityReplacementMember && canManageWorkspace && <Modal titleId="identity-replacement-title" onClose={() => setIdentityReplacementMember(null)}><div className="modal-head"><div><p>REVIEWED ACCOUNT RECOVERY</p><h2 id="identity-replacement-title">Replace {identityReplacementMember.displayName}&apos;s SSO identity</h2></div><button type="button" onClick={() => setIdentityReplacementMember(null)} aria-label="Close">×</button></div><div className="wizard-body"><p>This disabled member stays disabled after replacement. Verify the new immutable subject in the identity provider, confirm the member&apos;s email below, submit, review the audit event, and only then enable access.</p><div className="form-grid"><label><span>Confirmation email</span><input type="email" autoFocus value={replacementConfirmationEmail} onChange={(event) => setReplacementConfirmationEmail(event.target.value)} placeholder={identityReplacementMember.email} /></label><label><span>New verified SSO subject</span><input value={replacementIdentitySubject} onChange={(event) => setReplacementIdentitySubject(event.target.value)} placeholder="Immutable IdP subject" /></label></div></div><div className="wizard-actions"><button type="button" onClick={() => setIdentityReplacementMember(null)}>Cancel</button><button type="button" disabled={replacementConfirmationEmail.trim().toLowerCase() !== identityReplacementMember.email || !replacementIdentitySubject.trim()} onClick={() => void replaceMemberIdentity()}>Replace identity <span>→</span></button></div></Modal>}

      {draftDecisionOpen && <Modal titleId="draft-decision-title" onClose={stayWithDraft}><div className="modal-head"><div><p>UNSAVED WORKING DRAFT</p><h2 id="draft-decision-title">Save your changes before leaving?</h2></div><button type="button" onClick={stayWithDraft} aria-label="Stay with working draft">×</button></div><div className="wizard-body draft-decision-copy"><p>Your edits to <strong>{selected.party}</strong> exist only in this browser tab. Save a new immutable version before moving to another contract or page.</p><p>Downloading is available only for the exact saved working draft.</p></div><div className="wizard-actions draft-decision-actions"><button type="button" disabled={draftDecisionBusy} onClick={stayWithDraft}>Stay</button><button className="danger-button" type="button" disabled={draftDecisionBusy} onClick={discardDraftAndContinue}>Discard changes</button><button type="button" disabled={draftDecisionBusy} onClick={() => void saveDraftAndContinue()}>{draftDecisionBusy ? "Saving…" : "Save version and continue"} <span>→</span></button></div></Modal>}

      {negotiationDecisionOpen && <Modal titleId="negotiation-decision-title" onClose={stayWithNegotiationDraft}><div className="modal-head"><div><p>UNSUBMITTED REVIEW WORK</p><h2 id="negotiation-decision-title">Keep reviewing before you leave?</h2></div><button type="button" onClick={stayWithNegotiationDraft} aria-label="Stay with review work">×</button></div><div className="wizard-body draft-decision-copy"><p>Your reviewed text or decision notes for <strong>{selected.party}</strong> exist only in this browser tab. They are not saved evidence until you complete the corresponding review action.</p><p>Switching between returned submissions keeps a separate in-memory draft for each submission. Leaving this review workspace discards all of those unsubmitted drafts.</p></div><div className="wizard-actions draft-decision-actions"><button type="button" onClick={stayWithNegotiationDraft}>Stay with review</button><button className="danger-button" type="button" onClick={discardNegotiationDraftAndContinue}>Discard review drafts and continue</button></div></Modal>}

      {commandOpen && <Modal titleId="command-title" onClose={() => setCommandOpen(false)} command><div className="command-head"><label>⌕ <input autoFocus value={globalQuery} onChange={(event) => { setGlobalQuery(event.target.value); setCommandOpen(true); }} placeholder="Search or jump to…" aria-label="Command search" /></label><kbd>ESC</kbd></div><div className="command-results"><p id="command-title">QUICK ACTIONS</p>{canCreateAgreement && <button type="button" onClick={() => { setCommandOpen(false); openGenerator(); }}><span>＋</span><b>Start from template</b><kbd>N</kbd></button>}{canImportAgreement && <button type="button" onClick={() => { setCommandOpen(false); openImport(); }}><span>↥</span><b>Upload a contract</b></button>}<button type="button" onClick={() => { setCommandOpen(false); navigate("approvals"); }}><span>✓</span><b>Open approval queue</b></button><p>CONTRACTS</p>{globalResults.map((agreement) => <button type="button" key={agreement.id} onClick={() => { setCommandOpen(false); setGlobalQuery(""); openAgreement(agreement.id); }}><span className={`party-logo ${agreement.side.toLowerCase().replace("-side", "")}`}>{agreement.initials}</span><b>{agreement.party}<small>{agreement.type} · {agreement.stage}</small></b><i>›</i></button>)}{globalResults.length === 0 && <div className="command-empty"><b>No contract found</b><span>{agreements.length === 0 && session?.mode === "production" ? "No contracts have been added to this production workspace yet." : "Try a counterparty, owner, stage, or contract type."}</span></div>}</div></Modal>}

      {toast && <div className={`clm-toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"} aria-live={toast.tone === "error" ? "assertive" : "polite"}><span>{toast.tone === "success" ? "✓" : toast.tone === "error" ? "!" : "i"}</span>{toast.message}</div>}
    </main>
  );
}

function NavButton({ active, glyph, label, count, onClick }: { active: boolean; glyph: string; label: string; count?: string; onClick: () => void }) {
  return <button className={`clm-nav ${active ? "active" : ""}`} type="button" aria-current={active ? "page" : undefined} onClick={onClick}><span>{glyph}</span><b>{label}</b>{count && <i>{count}</i>}</button>;
}

function PageHeading({ eyebrow, title, subtitle, actions }: { eyebrow: string; title: string; subtitle: string; actions?: ReactNode }) {
  return <section className="page-heading"><div><p className="overline"><span /> {eyebrow}</p><h1>{title}</h1><p>{subtitle}</p></div>{actions && <div className="hero-actions">{actions}</div>}</section>;
}

function PanelHeading({ title, subtitle, action, onAction }: { title: string; subtitle: string; action?: string; onAction?: () => void }) {
  return <div className="panel-heading"><div><h2>{title}</h2><p>{subtitle}</p></div>{action && <button type="button" onClick={onAction}>{action} →</button>}</div>;
}

function FirstUseChecklist() {
  return <ol className="first-use-checklist"><li><b>1</b><span>Upload a contract or start from a template.</span></li><li><b>2</b><span>Confirm the working draft and contract details.</span></li><li><b>3</b><span>Share for counterparty review and record the returned file when negotiation is needed.</span></li><li><b>4</b><span>Request approval on the exact saved version.</span></li><li><b>5</b><span>Send the approved version for signature and track follow-up work.</span></li></ol>;
}

function AgentPlanEffectSummary({ plan }: { plan: AgentPlanDetail }) {
  if (plan.actionId !== "approval.request") return null;
  const effectCandidate = plan.proposedDiff.effect;
  const policyCandidate = plan.proposedDiff.policy;
  if (!effectCandidate || typeof effectCandidate !== "object" || Array.isArray(effectCandidate)) return null;
  const effect = effectCandidate as Record<string, unknown>;
  const policy = policyCandidate && typeof policyCandidate === "object" && !Array.isArray(policyCandidate)
    ? policyCandidate as Record<string, unknown>
    : {};
  const createdRoles = Array.isArray(effect.createdRoles)
    ? effect.createdRoles.filter((role): role is string => typeof role === "string")
    : [];
  const supersededIds = Array.isArray(effect.supersededApprovalIds)
    ? effect.supersededApprovalIds.filter((id): id is string => typeof id === "string")
    : [];
  const requiredRoles = Array.isArray(policy.requiredRoles)
    ? policy.requiredRoles.filter((role): role is string => typeof role === "string")
    : [];
  return <section className="agent-effect-summary" aria-labelledby="agent-effect-summary-title">
    <div><p>SERVER-COMPILED EFFECT</p><h3 id="agent-effect-summary-title">Ensure the policy-required approval lanes</h3></div>
    <p>The service principal did not choose an approver or author these effects. Notice derived them from the exact current agreement, working paper, risk decision, and approval policy.</p>
    <dl>
      <div><dt>Required lanes</dt><dd>{requiredRoles.join(" + ") || "None resolved"}</dd></div>
      <div><dt>Will create</dt><dd>{createdRoles.join(" + ") || "No lanes"}</dd></div>
      <div><dt>Will supersede</dt><dd>{supersededIds.length ? `${supersededIds.length} stale lane${supersededIds.length === 1 ? "" : "s"}` : "No lanes"}</dd></div>
      <div><dt>Result</dt><dd>{String(effect.approvalStatus ?? "Unresolved")}<small>Agreement v{String(effect.agreementVersion ?? "?")} · {String(effect.nextAction ?? "No next action")}</small></dd></div>
    </dl>
  </section>;
}

function negotiationRoundLabel(status: NegotiationRoundStatus) {
  return status === "prepared" ? "Prepared to share"
    : status === "outbound" ? "Awaiting a return"
      : status === "returned" ? "Return received"
        : status === "review" ? "Human review"
          : status === "resolved" ? "Promoted to working draft"
            : "Closed";
}

function negotiationSubmissionGuidance(status: NegotiationSubmissionStatus) {
  if (status === "ready") return "The saved attachment is clean and eligible for human review. This is not a legal, policy, or no-change verdict.";
  if (status === "sender_review") return "The file is clean, but the sender address or email authentication did not exactly match the prepared counterparty. Verify identity before marking it ready.";
  if (status === "quarantined") return "The file is isolated because scanning did not establish a trusted clean result. Do not download or promote it. Mark ready only after an approved rescan is recorded as clean.";
  if (status === "rejected") return "Document validation or security scanning rejected this attachment. Keep it out of the working draft and request a safe replacement.";
  if (status === "late") return "This clean file was recorded as authenticated staff evidence after the round stopped accepting returns. It cannot be promoted from this round; inactive email aliases and expired portals do not accept a late return.";
  if (status === "no_attachment") return "A response was recorded without an attachment. No counterparty revision is available to review or promote.";
  if (status === "promoted") return "This returned file was already promoted into an immutable working version. Review the recorded version and audit history.";
  return "Review this recorded submission and its audit history before taking any action.";
}

function negotiationSourceLabel(source: NegotiationSubmission["source"]) {
  return source === "email" ? "Authenticated email gateway" : source === "portal" ? "Scoped counterparty portal" : "Authenticated staff upload";
}

function preferredNegotiationSubmission(state: NegotiationState): NegotiationSubmission | null {
  const activeSubmissions = state.activeRound
    ? state.submissions.filter((submission) => submission.roundId === state.activeRound?.id)
    : [];
  const priority: NegotiationSubmissionStatus[] = [
    "ready",
    "sender_review",
    "quarantined",
    "rejected",
    "no_attachment",
    "promoted",
    "late",
  ];
  const selectFrom = (submissions: NegotiationSubmission[]) => {
    for (const status of priority) {
      const match = submissions.find((submission) => submission.status === status);
      if (match) return match;
    }
    return submissions.find((submission) => submission.documentId) ?? submissions[0] ?? null;
  };
  return selectFrom(activeSubmissions) ?? selectFrom(state.submissions);
}

function negotiationDeliveryPresentation(round: NegotiationRound): { label: string; detail: string } {
  const recordedAt = round.sentAt ? formatNegotiationTime(round.sentAt) : null;
  if (round.deliveryState === "queued") {
    return {
      label: "Email queued",
      detail: `${recordedAt ? `Queued at ${recordedAt}. ` : ""}The gateway has not accepted it yet.`,
    };
  }
  if (round.deliveryState === "processing") {
    return {
      label: "Gateway processing",
      detail: `${recordedAt ? `Queued at ${recordedAt}. ` : ""}Final delivery acceptance is still pending.`,
    };
  }
  if (round.deliveryState === "accepted") {
    return {
      label: "Gateway accepted",
      detail: `${recordedAt ? `Queued at ${recordedAt}. ` : ""}This does not prove counterparty receipt.`,
    };
  }
  if (round.deliveryState === "dead") {
    return {
      label: "Gateway did not accept",
      detail: `${recordedAt ? `Queued at ${recordedAt}. ` : ""}The terminal event must not be resent.`,
    };
  }
  if (round.deliveryState === "manual_recorded") {
    return {
      label: "Manual delivery attested",
      detail: `${recordedAt ? `Recorded at ${recordedAt}. ` : ""}This is staff evidence, not recipient confirmation.`,
    };
  }
  return { label: "Not queued", detail: "Prepared only; no delivery is recorded." };
}

function ProductionNegotiationPanel({
  agreement,
  canManage,
  documentDirty,
  savedDraft,
  sourceDocuments,
  onOpenDraft,
  onDownloadSource,
  onOpenHistory,
  onReconcileAgreement,
  onDraftStateChange,
  notify,
}: {
  agreement: Agreement;
  canManage: boolean;
  documentDirty: boolean;
  savedDraft: DraftLoadState | undefined;
  sourceDocuments: SourceDocumentSummary[];
  onOpenDraft: () => void;
  onDownloadSource: (source: SourceDocumentSummary) => void | Promise<void>;
  onOpenHistory: () => void;
  onReconcileAgreement: (agreement?: Agreement | null) => Promise<void>;
  onDraftStateChange: (dirty: boolean) => void;
  notify: (message: string, tone?: ToastTone) => void;
}) {
  const endpoint = `/api/agreements/${agreement.id}/negotiation`;
  const defaultPromotionLabel = `Counterparty revision — ${agreement.party}`;
  const defaultSendSubject = `Contract review requested: ${agreement.type}`;
  const portalOnlySendMessage = `Please use the secure link in this message to download the ${agreement.type} review copy and upload one reviewed file. Notice reply capture is not configured for this round; return the file through the secure link.`;
  const replyEnabledSendMessage = `Please use the secure link in this message to download the ${agreement.type} review copy and upload one reviewed file. You may instead reply to the Notice reply address in this message with one reviewed file.`;
  const [state, setState] = useState<NegotiationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const [issuedPortal, setIssuedPortal] = useState<IssuedPortalLink | null>(null);
  const [counterpartyName, setCounterpartyName] = useState(agreement.party);
  const [counterpartyEmail, setCounterpartyEmail] = useState("");
  const [sendSubject, setSendSubject] = useState(defaultSendSubject);
  const [sendMessage, setSendMessage] = useState(portalOnlySendMessage);
  const [manualReference, setManualReference] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadSenderName, setUploadSenderName] = useState("");
  const [uploadSenderEmail, setUploadSenderEmail] = useState("");
  const [uploadMessageId, setUploadMessageId] = useState("");
  const [uploadReviewedText, setUploadReviewedText] = useState("");
  const [selectedSubmissionId, setSelectedSubmissionId] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [reviewedText, setReviewedText] = useState("");
  const [reviewedContentType, setReviewedContentType] = useState<"text/plain" | "text/markdown">("text/plain");
  const [promotionLabel, setPromotionLabel] = useState(defaultPromotionLabel);
  const [promotionNote, setPromotionNote] = useState("");
  const [savedReviewTextBySubmission, setSavedReviewTextBySubmission] = useState<Record<string, string>>({});
  const [cachedReviewDraftDirty, setCachedReviewDraftDirty] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const humanReviewRef = useRef<HTMLElement>(null);
  const reviewDraftCacheRef = useRef<Record<string, {
    decisionNote: string;
    reviewedText: string;
    reviewedContentType: "text/plain" | "text/markdown";
    promotionLabel: string;
    promotionNote: string;
  }>>({});

  const activeRound = state?.activeRound ?? null;
  const configuredDefaultSendMessage = activeRound?.emailAddress ? replyEnabledSendMessage : portalOnlySendMessage;
  const deliveryPresentation = activeRound ? negotiationDeliveryPresentation(activeRound) : null;
  const activeRoundHasReturnEvidence = Boolean(activeRound && state?.submissions.some((submission) => (
    submission.roundId === activeRound.id
    && ["ready", "sender_review", "quarantined", "rejected", "no_attachment"].includes(submission.status)
  )));
  const selectedSubmission = state?.submissions.find((submission) => submission.id === selectedSubmissionId) ?? null;
  const selectedSubmissionLabel = selectedSubmission?.document?.fileName
    ?? (selectedSubmission?.documentId ? `submission ${selectedSubmission.id}` : "message with no attachment");
  const activeSubmission = selectedSubmission?.roundId === activeRound?.id ? selectedSubmission : null;
  const managerBusy = Boolean(busyAction) || refreshRequired;
  const cleanSourceBasis = savedDraft?.status === "none"
    ? sourceDocuments.find((source) => source.scanStatus === "clean") ?? null
    : null;
  const workingDraftBasisReady = savedDraft?.status === "ready" && Boolean(savedDraft.sha256);
  const prepareEligible = !documentDirty && (workingDraftBasisReady || Boolean(cleanSourceBasis));
  const activeRoundIsLatest = Boolean(activeRound && state?.latestRound?.id === activeRound.id);
  const deliveryFinalizationPending = activeRound?.deliveryState === "queued" || activeRound?.deliveryState === "processing";
  const selectedDocumentScanStatus = activeSubmission?.document?.scanStatus ?? null;
  const canRescan = Boolean(canManage && activeSubmission?.status === "quarantined" && activeSubmission.documentId && selectedDocumentScanStatus === "quarantined");
  const canMarkReady = Boolean(canManage && activeSubmission && activeRoundIsLatest && selectedDocumentScanStatus === "clean" && (activeSubmission.status === "sender_review" || activeSubmission.status === "quarantined"));
  const canReject = Boolean(canManage && activeSubmission && activeSubmission.status !== "promoted" && activeSubmission.status !== "rejected");
  const canPromote = Boolean(canManage && activeSubmission?.status === "ready" && activeRoundIsLatest && !deliveryFinalizationPending);
  const selectedSubmissionReadable = Boolean(selectedSubmission?.documentId && selectedSubmission.documentSha256 && !["quarantined", "rejected", "no_attachment"].includes(selectedSubmission.status));
  const currentStep = activeRound
    ? activeRound.status === "prepared" ? 0 : activeRound.status === "outbound" ? 1 : 2
    : state?.latestRound?.status === "resolved" ? 3 : 0;
  const comparison = useMemo<{ result: TextDiffResult | null; error: string }>(() => {
    if (savedDraft?.status !== "ready" || !reviewedText.trim()) return { result: null, error: "" };
    try {
      return { result: compareTextLines(savedDraft.content, reviewedText), error: "" };
    } catch (error) {
      return { result: null, error: error instanceof Error ? error.message : "The line comparison could not be created." };
    }
  }, [reviewedText, savedDraft]);
  const changedComparisonLines = comparison.result?.lines.filter((line) => line.kind !== "unchanged") ?? [];

  function reviewDraftHasChanges(submissionId: string, draft: {
    decisionNote: string;
    reviewedText: string;
    reviewedContentType: "text/plain" | "text/markdown";
    promotionLabel: string;
    promotionNote: string;
  }) {
    return Boolean(
      draft.decisionNote.trim()
      || draft.promotionNote.trim()
      || draft.reviewedText !== (savedReviewTextBySubmission[submissionId] ?? "")
      || draft.reviewedContentType !== "text/plain"
      || draft.promotionLabel !== defaultPromotionLabel
    );
  }

  const currentReviewDraft = {
    decisionNote,
    reviewedText,
    reviewedContentType,
    promotionLabel,
    promotionNote,
  };
  const hasUnsavedReviewWork = Boolean(
    (selectedSubmissionId && reviewDraftHasChanges(selectedSubmissionId, currentReviewDraft))
    || cachedReviewDraftDirty
    || (!activeRound && (counterpartyEmail.trim() || counterpartyName !== agreement.party))
    || (activeRound?.status === "prepared" && (sendSubject !== defaultSendSubject || sendMessage !== configuredDefaultSendMessage || manualReference.trim()))
    || (activeRound && (closeNote.trim() || uploadFile || uploadSenderName.trim() || uploadSenderEmail.trim() || uploadMessageId.trim() || uploadReviewedText.trim()))
  );

  useEffect(() => {
    if (!selectedSubmissionId) return;
    reviewDraftCacheRef.current[selectedSubmissionId] = {
      decisionNote,
      reviewedText,
      reviewedContentType,
      promotionLabel,
      promotionNote,
    };
  }, [decisionNote, promotionLabel, promotionNote, reviewedContentType, reviewedText, selectedSubmissionId]);

  useEffect(() => {
    onDraftStateChange(hasUnsavedReviewWork);
  }, [hasUnsavedReviewWork, onDraftStateChange]);

  useEffect(() => {
    if (!hasUnsavedReviewWork) return;
    const preventUnsubmittedReviewLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnsubmittedReviewLoss);
    return () => window.removeEventListener("beforeunload", preventUnsubmittedReviewLoss);
  }, [hasUnsavedReviewWork]);

  useEffect(() => () => onDraftStateChange(false), [onDraftStateChange]);

  function announce(text: string, tone: "success" | "error" | "info") {
    setActionMessage({ text, tone });
    notify(text, tone);
  }

  function cacheCurrentReviewDraft() {
    if (!selectedSubmissionId) return;
    reviewDraftCacheRef.current[selectedSubmissionId] = {
      decisionNote,
      reviewedText,
      reviewedContentType,
      promotionLabel,
      promotionNote,
    };
  }

  function refreshCachedReviewDraftDirty(nextSelectedSubmissionId: string) {
    setCachedReviewDraftDirty(Object.entries(reviewDraftCacheRef.current).some(([submissionId, draft]) => (
      submissionId !== nextSelectedSubmissionId && reviewDraftHasChanges(submissionId, draft)
    )));
  }

  function selectSubmission(submission: NegotiationSubmission, focusReview = false) {
    cacheCurrentReviewDraft();
    refreshCachedReviewDraftDirty(submission.id);
    const cached = reviewDraftCacheRef.current[submission.id];
    setSelectedSubmissionId(submission.id);
    setDecisionNote(cached?.decisionNote ?? "");
    setPromotionNote(cached?.promotionNote ?? "");
    setPromotionLabel(cached?.promotionLabel ?? defaultPromotionLabel);
    setReviewedContentType(cached?.reviewedContentType ?? "text/plain");
    setReviewedText(cached?.reviewedText ?? savedReviewTextBySubmission[submission.id] ?? "");
    if (focusReview) window.requestAnimationFrame(() => humanReviewRef.current?.focus());
  }

  async function refreshNegotiationState(showLoading = false): Promise<NegotiationState> {
    if (showLoading) setLoading(true);
    try {
      const next = await requestNegotiation<NegotiationState>(endpoint);
      setState(next);
      const nextDefaultSendMessage = next.activeRound?.emailAddress ? replyEnabledSendMessage : portalOnlySendMessage;
      setSendMessage((current) => (
        current === portalOnlySendMessage || current === replyEnabledSendMessage
          ? nextDefaultSendMessage
          : current
      ));
      setLoadError("");
      setRefreshRequired(false);
      const retained = next.submissions.find((submission) => submission.id === selectedSubmissionId);
      const activeHasSubmissions = Boolean(next.activeRound && next.submissions.some((submission) => submission.roundId === next.activeRound?.id));
      const retainedIsRelevant = Boolean(retained && (!activeHasSubmissions || retained.roundId === next.activeRound?.id));
      if (!retainedIsRelevant) {
        const preferred = preferredNegotiationSubmission(next);
        if (preferred) selectSubmission(preferred);
        else {
          setSelectedSubmissionId("");
          refreshCachedReviewDraftDirty("");
        }
      }
      return next;
    } catch (error) {
      const message = humanNegotiationError(error);
      setLoadError(message);
      setRefreshRequired(true);
      throw error;
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    void requestNegotiation<NegotiationState>(endpoint).then((next) => {
      if (!alive) return;
      setState(next);
      const nextDefaultSendMessage = next.activeRound?.emailAddress ? replyEnabledSendMessage : portalOnlySendMessage;
      setSendMessage(nextDefaultSendMessage);
      const preferred = preferredNegotiationSubmission(next);
      if (preferred) {
        const cached = reviewDraftCacheRef.current[preferred.id];
        setSelectedSubmissionId(preferred.id);
        setDecisionNote(cached?.decisionNote ?? "");
        setPromotionNote(cached?.promotionNote ?? "");
        setPromotionLabel(cached?.promotionLabel ?? defaultPromotionLabel);
        setReviewedContentType(cached?.reviewedContentType ?? "text/plain");
        setReviewedText(cached?.reviewedText ?? "");
      }
    }).catch((error) => {
      if (alive) setLoadError(humanNegotiationError(error));
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [defaultPromotionLabel, endpoint, portalOnlySendMessage, replyEnabledSendMessage]);

  async function performMutation<T extends object>(
    key: string,
    operation: () => Promise<T>,
    successMessage: string,
  ): Promise<T | null> {
    setBusyAction(key);
    setActionMessage(null);
    try {
      const result = await operation();
      try {
        const returnedAgreement = "agreement" in result && result.agreement && typeof result.agreement === "object"
          ? result.agreement as Agreement
          : null;
        await onReconcileAgreement(returnedAgreement);
        await refreshNegotiationState();
        announce(successMessage, "success");
      } catch {
        const message = "The action was accepted, but the latest contract state could not be refreshed. Reload before taking another action.";
        setRefreshRequired(true);
        announce(message, "info");
      }
      return result;
    } catch (error) {
      const stateChangingSecurityVerdict = error instanceof NegotiationRequestError
        && error.status === 422
        && error.code === "malware_detected";
      let stateRecovered = false;
      if (error instanceof NegotiationRequestError && (error.status === 409 || error.status === 410 || stateChangingSecurityVerdict)) {
        const agreementRecovered = await onReconcileAgreement(null).then(() => true).catch(() => false);
        const negotiationRecovered = await refreshNegotiationState().then(() => true).catch(() => false);
        stateRecovered = agreementRecovered && negotiationRecovered;
        if (!stateRecovered) setRefreshRequired(true);
      }
      const message = stateRecovered && error instanceof NegotiationRequestError && error.status === 409
        ? `This contract changed or the action is no longer eligible. Notice refreshed the current record; review it before trying again. ${error.message}${error.requestId ? ` Support reference: ${error.requestId}.` : ""}`
        : humanNegotiationError(error);
      announce(message, "error");
      return null;
    } finally {
      setBusyAction("");
    }
  }

  async function prepareRound() {
    if (!prepareEligible) {
      const message = documentDirty
        ? "Save or discard the current editor changes before preparing a review round."
        : "Load an exact saved working draft or link an eligible clean source document before preparing a review round.";
      announce(message, "error");
      return;
    }
    if (!counterpartyName.trim() || !counterpartyEmail.trim() || !state) {
      announce("Add the counterparty name and email address before preparing the round.", "error");
      return;
    }
    const envelope = await performMutation("prepare", async () => {
      const payload = await requestNegotiation<{ result: { agreement: Agreement; round: NegotiationRound; portalUrl: string | null; portalTokenIssued: boolean } }>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "prepare",
          expectedAgreementVersion: state.agreementVersion,
          counterpartyEmail: counterpartyEmail.trim(),
          counterpartyName: counterpartyName.trim(),
        }),
      });
      return payload.result;
    }, workingDraftBasisReady ? "Review round prepared from the exact saved working draft." : "Review round prepared from the exact clean uploaded source.");
    setIssuedPortal(envelope?.portalUrl ? { url: envelope.portalUrl, expiresAt: envelope.round.portalExpiresAt, source: "prepare" } : null);
  }

  async function sendRound() {
    if (!state || !activeRound?.counterpartyEmail) return;
    if (!sendSubject.trim() || !sendMessage.trim()) {
      announce("Add an email subject and message before queueing delivery.", "error");
      return;
    }
    const envelope = await performMutation("send", async () => {
      const payload = await requestNegotiation<{ result: { agreement: Agreement; roundId: string; status: "outbound"; queued: true; portalExpiresAt: string; portalUrl: string } }>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "send",
          roundId: activeRound.id,
          expectedAgreementVersion: state.agreementVersion,
          recipientEmail: activeRound.counterpartyEmail,
          subject: sendSubject.trim(),
          message: sendMessage.trim(),
        }),
      });
      return payload.result;
    }, "Delivery was queued through the configured gateway. Queued does not mean delivered.");
    if (envelope?.portalUrl) setIssuedPortal({ url: envelope.portalUrl, expiresAt: envelope.portalExpiresAt, source: "send" });
  }

  async function attestManualSend() {
    if (!state || !activeRound?.counterpartyEmail || !manualReference.trim()) {
      announce("Record the external delivery reference before saving the manual-delivery attestation.", "error");
      return;
    }
    const result = await performMutation("manual-send", async () => {
      const payload = await requestNegotiation<{ result: { agreement: Agreement; roundId: string; status: "outbound"; deliveryMethod: "manual" } }>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "attest_manual_send",
          roundId: activeRound.id,
          expectedAgreementVersion: state.agreementVersion,
          recipientEmail: activeRound.counterpartyEmail,
          providerMessageId: manualReference.trim(),
        }),
      });
      return payload.result;
    }, "Manual delivery was recorded as staff attestation, not provider verification.");
    if (result) setManualReference("");
  }

  async function rotatePortal() {
    if (!activeRound) return;
    if (!window.confirm("Revoke the current portal URL now and issue a replacement? Anyone using the earlier URL will immediately lose access.")) return;
    const result = await performMutation("rotate", async () => {
      const payload = await requestNegotiation<{ result: { portalUrl: string; expiresAt: string } }>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rotate_portal", roundId: activeRound.id }),
      });
      return payload.result;
    }, "The prior portal URL was revoked and a replacement was issued.");
    if (result?.portalUrl) setIssuedPortal({ url: result.portalUrl, expiresAt: result.expiresAt, source: "rotate" });
  }

  async function copyIssuedPortal() {
    if (!issuedPortal) return;
    try {
      await navigator.clipboard.writeText(issuedPortal.url);
      announce("Portal URL copied. Treat it as a temporary bearer credential and share it only with the prepared counterparty.", "success");
    } catch {
      announce("The browser could not copy the portal URL. Select the visible URL and copy it manually before leaving this page.", "error");
    }
  }

  async function downloadNegotiationDocument(metadata: NegotiationDocumentSummary | null | undefined, fallbackId: string | null, expectedSha256: string | null, label: string) {
    const documentId = metadata?.id ?? fallbackId;
    if (!documentId || !expectedSha256) return;
    setBusyAction(`download:${documentId}`);
    try {
      const response = await fetch(`/api/documents/${documentId}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string }; requestId?: string };
        throw new NegotiationRequestError(payload.error?.message ?? `${label} could not be downloaded.`, response.status, payload.error?.code ?? "download_failed", payload.requestId ?? response.headers.get("x-request-id"));
      }
      const responseSha256 = response.headers.get("x-document-sha256");
      if (responseSha256 !== expectedSha256 || (metadata?.sha256 && metadata.sha256 !== expectedSha256)) {
        throw new Error(`${label} did not match its recorded full SHA-256. Nothing was downloaded.`);
      }
      const fileName = metadata?.fileName ?? fileNameFromDisposition(response.headers.get("content-disposition"));
      if (!fileName) throw new Error(`${label} did not include an authenticated filename. Nothing was downloaded.`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      announce(`${fileName} downloaded after its full SHA-256 matched the authenticated record.`, "success");
    } catch (error) {
      announce(humanNegotiationError(error), "error");
    } finally {
      setBusyAction("");
    }
  }

  async function uploadReturnedFile() {
    if (!activeRound || !uploadFile) {
      announce("Choose exactly one returned file before uploading.", "error");
      return;
    }
    const form = new FormData();
    form.append("action", "upload");
    form.append("roundId", activeRound.id);
    form.append("file", uploadFile);
    if (uploadSenderName.trim()) form.append("senderName", uploadSenderName.trim());
    if (uploadSenderEmail.trim()) form.append("senderEmail", uploadSenderEmail.trim());
    if (uploadMessageId.trim()) form.append("providerMessageId", uploadMessageId.trim());
    if (uploadReviewedText.trim()) form.append("reviewedText", uploadReviewedText);
    const result = await performMutation("upload", async () => requestNegotiation<{ replay: boolean; submissions: NegotiationSubmission[]; roundId: string; roundStatus?: NegotiationRoundStatus }>(endpoint, { method: "POST", body: form }), "One returned file was stored with immutable provenance for human review.");
    const submission = result?.submissions[0];
    if (submission) {
      if (uploadReviewedText.trim()) {
        setSavedReviewTextBySubmission((current) => ({ ...current, [submission.id]: uploadReviewedText }));
        reviewDraftCacheRef.current[submission.id] = {
          decisionNote: "",
          reviewedText: uploadReviewedText,
          reviewedContentType: "text/plain",
          promotionLabel: defaultPromotionLabel,
          promotionNote: "",
        };
      }
      selectSubmission(submission);
      setUploadFile(null);
      setUploadSenderName("");
      setUploadSenderEmail("");
      setUploadReviewedText("");
      setUploadMessageId("");
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  }

  async function loadSavedReviewText() {
    if (!selectedSubmission?.reviewTextAvailable) return;
    setBusyAction("review-text");
    try {
      const response = await fetch(`${endpoint}?view=review-text&submissionId=${encodeURIComponent(selectedSubmission.id)}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string }; requestId?: string };
        throw new NegotiationRequestError(payload.error?.message ?? "Saved reviewed text could not be loaded.", response.status, payload.error?.code ?? "review_text_failed", payload.requestId ?? response.headers.get("x-request-id"));
      }
      const sha256 = response.headers.get("x-document-sha256");
      if (!selectedSubmission.reviewTextSha256 || sha256 !== selectedSubmission.reviewTextSha256) throw new Error("The saved reviewed text did not match its recorded full SHA-256.");
      const text = await response.text();
      setSavedReviewTextBySubmission((current) => ({ ...current, [selectedSubmission.id]: text }));
      reviewDraftCacheRef.current[selectedSubmission.id] = {
        decisionNote,
        reviewedText: text,
        reviewedContentType,
        promotionLabel,
        promotionNote,
      };
      setReviewedText(text);
      announce("The exact saved staff-reviewed text was loaded for comparison. Reconfirm it before promotion.", "success");
    } catch (error) {
      announce(humanNegotiationError(error), "error");
    } finally {
      setBusyAction("");
    }
  }

  async function decideSubmission(action: "mark_ready" | "reject_submission") {
    if (!selectedSubmission || !decisionNote.trim()) {
      announce(action === "mark_ready" ? "Record how the sender identity or clean rescan was verified." : "Record why this submission is being rejected.", "error");
      return;
    }
    const result = await performMutation(action, async () => {
      const payload = await requestNegotiation<{ result: { submissionId: string; status: "ready" | "rejected" } }>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, submissionId: selectedSubmission.id, note: decisionNote.trim() }),
      });
      return payload.result;
    }, action === "mark_ready" ? "Submission marked ready after recorded staff verification; human contract review is still required." : "Submission rejected with an attributable note.");
    if (result) {
      setDecisionNote("");
      const cached = reviewDraftCacheRef.current[selectedSubmission.id];
      if (cached) reviewDraftCacheRef.current[selectedSubmission.id] = { ...cached, decisionNote: "" };
    }
  }

  async function rescanSubmission() {
    if (!selectedSubmission?.documentId || selectedSubmission.status !== "quarantined") return;
    await performMutation("rescan", async () => requestNegotiation<{ document: { id: string; scanStatus: "clean" } }>("/api/documents/import", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentId: selectedSubmission.documentId }),
    }), "The scanner recorded a clean result. Add a verification note, then mark the submission ready before contract review.");
  }

  async function promoteSubmission() {
    if (!state || !activeRound || !selectedSubmission || !reviewedText.trim() || !promotionLabel.trim() || !promotionNote.trim()) {
      announce("Add the reviewed text, version label, and human-review note before promotion.", "error");
      return;
    }
    const result = await performMutation("promote", async () => {
      const payload = await requestNegotiation<{ result: { agreement: Agreement; roundId: string; submissionId: string; documentVersion: DocumentVersionSummary & { id: string; size: number; contentType: string } } }>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "promote_submission",
          roundId: activeRound.id,
          submissionId: selectedSubmission.id,
          expectedAgreementVersion: state.agreementVersion,
          reviewedText,
          contentType: reviewedContentType,
          label: promotionLabel.trim(),
          note: promotionNote.trim(),
        }),
      });
      return payload.result;
    }, "The reviewed text became a new immutable working version. Prior approvals and signature readiness were invalidated.");
    if (result) {
      setSavedReviewTextBySubmission((current) => ({ ...current, [selectedSubmission.id]: reviewedText }));
      reviewDraftCacheRef.current[selectedSubmission.id] = {
        decisionNote: "",
        reviewedText,
        reviewedContentType: "text/plain",
        promotionLabel: defaultPromotionLabel,
        promotionNote: "",
      };
      setDecisionNote("");
      setReviewedContentType("text/plain");
      setPromotionLabel(defaultPromotionLabel);
      setPromotionNote("");
      setIssuedPortal(null);
    }
  }

  async function closeRound() {
    if (!state || !activeRound || !closeNote.trim()) {
      announce("Explain why this active review round is being closed.", "error");
      return;
    }
    const result = await performMutation("close", async () => {
      const payload = await requestNegotiation<{ result: { agreement: Agreement; roundId: string; status: "closed" } }>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "close", roundId: activeRound.id, expectedAgreementVersion: state.agreementVersion, note: closeNote.trim() }),
      });
      return payload.result;
    }, "The active review round was closed and its portal credential was revoked.");
    if (result) {
      setCloseNote("");
      setIssuedPortal(null);
    }
  }

  const outboundDocument = activeRound?.outboundDocument ?? null;
  const uploadIsDocx = uploadFile?.name.toLowerCase().endsWith(".docx") === true;

  return <div id="agreement-panel-changes" className="workspace-content production-negotiation" role="tabpanel" aria-labelledby="agreement-tab-changes" tabIndex={0} aria-busy={loading || managerBusy}>
    <section className="panel negotiation-overview">
      <PanelHeading title="Review & redlines" subtitle="Exchange immutable files, record human review, and promote only reviewed text. Notice never makes a legal or policy decision." />
      <ol className="negotiation-stepper" aria-label="Counterparty review workflow">
        {["Prepare & share", "Await return", "Review & promote"].map((label, index) => <li className={index < currentStep ? "complete" : index === currentStep ? "current" : ""} aria-current={index === currentStep ? "step" : undefined} key={label}><span>{index < currentStep ? "✓" : index + 1}</span><b>{label}</b></li>)}
      </ol>
      <div className="negotiation-safety-note"><strong>Human review required</strong><span>Files, send records, and line comparisons are evidence and workflow aids. They do not establish legal acceptability, policy compliance, or that tracked changes were fully reviewed.</span></div>
    </section>

    <div className={`negotiation-live-status ${actionMessage?.tone ?? ""}`}>{actionMessage?.text ?? (loading ? "Loading the authenticated review exchange…" : "Review exchange ready.")}</div>
    {loading && !state && <section className="panel negotiation-loading"><i /><h3>Loading the authenticated review exchange…</h3><p>Notice is loading only this contract’s saved rounds and returned files.</p></section>}
    {loadError && <section className="panel negotiation-load-error" role="alert"><h3>Review exchange unavailable</h3><p>{loadError}</p><button type="button" disabled={loading} onClick={() => void refreshNegotiationState(true).catch(() => undefined)}>Retry</button></section>}
    {refreshRequired && !loadError && <section className="panel negotiation-load-error" role="alert"><h3>Refresh required before another action</h3><p>The last action was accepted, but this screen could not confirm the latest contract state. Mutating controls are locked until the authenticated state reloads.</p><button type="button" disabled={loading} onClick={() => void refreshNegotiationState(true).catch(() => undefined)}>{loading ? "Refreshing…" : "Refresh latest state"}</button></section>}

    {state && <div className="negotiation-layout">
      <div className="negotiation-main">
        {!activeRound && <section className="panel negotiation-card prepare-round-card">
          <div className="negotiation-card-head"><div><p>{state.latestRound?.status === "resolved" ? "NEW ROUND" : "STEP 1"}</p><h2>{state.latestRound?.status === "resolved" ? "Start another counterparty review" : "Prepare the exact current paper"}</h2></div>{state.latestRound && <span>Last round: {negotiationRoundLabel(state.latestRound.status)}</span>}</div>
          <p>Notice pins an immutable copy of the latest saved working draft, or the eligible clean uploaded source when no working draft exists. It never sends unsaved editor text.</p>
          <div className={`negotiation-basis ${prepareEligible ? "ready" : "blocked"}`}><span>{prepareEligible ? "✓" : "!"}</span><div><b>{workingDraftBasisReady ? `Saved working draft v${savedDraft?.status === "ready" ? savedDraft.version : "—"}` : cleanSourceBasis ? `Clean uploaded source: ${cleanSourceBasis.fileName}` : "Exact saved paper required"}</b><code>{workingDraftBasisReady && savedDraft?.status === "ready" ? `SHA-256 ${savedDraft.sha256}` : cleanSourceBasis ? `SHA-256 ${cleanSourceBasis.sha256}` : documentDirty ? "Unsaved editor changes must be saved or discarded" : savedDraft?.status === "loading" || !savedDraft ? "Checking the latest saved paper" : savedDraft?.status === "error" ? "Reload the working draft before preparing" : "Link a clean source or save a verified working draft"}</code></div>{cleanSourceBasis ? <button type="button" onClick={() => void onDownloadSource(cleanSourceBasis)}>Download exact source</button> : <button type="button" onClick={onOpenDraft}>Open working draft</button>}</div>
          {canManage ? <div className="negotiation-form two-column"><label><span>Counterparty name</span><input value={counterpartyName} maxLength={200} onChange={(event) => setCounterpartyName(event.target.value)} /></label><label><span>Counterparty email</span><input type="email" value={counterpartyEmail} maxLength={320} onChange={(event) => setCounterpartyEmail(event.target.value)} placeholder="reviewer@counterparty.example" /></label><button className="primary-button" type="button" disabled={!prepareEligible || managerBusy || !counterpartyName.trim() || !counterpartyEmail.trim()} onClick={() => void prepareRound()}>{busyAction === "prepare" ? "Preparing…" : "Prepare review round"}</button></div> : <p className="permission-note">You can review saved exchange evidence. Only a member with document-management permission can prepare, send, decide, upload, promote, rotate, or close a round.</p>}
        </section>}

        {activeRound && <section className="panel negotiation-card active-round-card">
          <div className="negotiation-card-head"><div><p>ROUND {activeRound.roundNumber}</p><h2>{negotiationRoundLabel(activeRound.status)}</h2></div><span className={`negotiation-status ${activeRound.status}`}>{activeRound.status}</span></div>
          <dl className="negotiation-round-facts"><div><dt>Prepared for</dt><dd>{activeRound.counterpartyName || agreement.party}<small>{activeRound.counterpartyEmail || "No address recorded"}</small></dd></div><div><dt>Baseline</dt><dd>{activeRound.baseDocumentVersion ? `Working draft v${activeRound.baseDocumentVersion}` : "Clean source document"}<code>SHA-256 {activeRound.baseSha256}</code></dd></div><div><dt>Delivery state</dt><dd>{deliveryPresentation?.label ?? "Not queued"}<small>{deliveryPresentation?.detail ?? "Prepared only; no delivery is recorded."}</small></dd></div></dl>
          {activeRound.deliveryState === "dead" && <div className="negotiation-delivery-warning" role="alert"><strong>The configured gateway did not accept this delivery</strong><p>{activeRoundHasReturnEvidence ? "A return or response is already recorded for this round. Follow its current review or remediation task below; do not resend the terminal delivery event." : "Do not resend this delivery event: its plaintext portal URL was scrubbed when delivery became terminal. The round token is not single-use, but rotating it cannot replay this event or reset the round budget. Close the round, confirm the counterparty details, and prepare a fresh round with a new temporary URL."}</p></div>}
          {(activeRound.deliveryState === "queued" || activeRound.deliveryState === "processing") && <div className="negotiation-delivery-pending"><strong>Delivery is not final</strong><p>Wait for the gateway to accept or reject this queued request before rotating the portal URL, closing the round, or assuming the counterparty can respond.</p></div>}
          <div className="negotiation-document-row"><div><span>OUTBOUND FILE</span><strong>{outboundDocument?.fileName ?? "Exact filename pending authenticated metadata"}</strong><code>SHA-256 {outboundDocument?.sha256 ?? activeRound.outboundSha256}</code>{outboundDocument && <small>{outboundDocument.contentType} · {(outboundDocument.size / 1024).toFixed(1)} KiB</small>}</div><button type="button" disabled={managerBusy} onClick={() => void downloadNegotiationDocument(outboundDocument, activeRound.outboundDocumentId, activeRound.outboundSha256, "Outbound review file")}>{busyAction === `download:${activeRound.outboundDocumentId}` ? "Downloading…" : "Download exact outbound file"}</button></div>
          {activeRound.emailAddress && <div className="negotiation-alias"><span>Active reply address</span><code>{activeRound.emailAddress}</code><small>This address is shown only because the authenticated API returned it for the active round.</small></div>}

          {issuedPortal && <div className="issued-portal" role="region" aria-labelledby="issued-portal-title"><div><strong id="issued-portal-title">Temporary portal URL (shown once)</strong><span>{issuedPortal.source === "send" ? "This newly issued URL replaces any portal copy shown before send." : issuedPortal.source === "rotate" ? "The earlier URL was revoked immediately." : "Copy it now if you will deliver it manually."}</span></div><input value={issuedPortal.url} readOnly aria-label="Newly issued temporary portal URL" /><p>Usable until {formatNegotiationTime(issuedPortal.expiresAt)}, or until staff rotate the link, close the round, or promote a return. An upload does not consume it. This is a bearer credential. {issuedPortal.source === "send" ? "Notice temporarily retains its plaintext in the protected delivery event, then scrubs it after gateway acceptance or terminal failure." : "Notice does not retain or redisplay its plaintext after this page state is lost."}</p><div><button type="button" onClick={() => void copyIssuedPortal()}>Copy temporary URL</button><button type="button" onClick={() => setIssuedPortal(null)}>I saved it — hide URL</button></div></div>}

          {canManage && activeRound.status === "prepared" && <div className="share-round-grid">
            <section>
              <h3>Send through configured gateway</h3>
              <label><span>Recipient (locked when prepared)</span><input value={activeRound.counterpartyEmail ?? ""} readOnly /></label>
              <label><span>Email subject</span><input value={sendSubject} maxLength={300} onChange={(event) => setSendSubject(event.target.value)} /></label>
              <label><span>Email message</span><textarea value={sendMessage} maxLength={4000} rows={5} onChange={(event) => setSendMessage(event.target.value)} /></label>
              <div className="negotiation-message-preview" aria-label="Outbound gateway message preview">
                <span>OUTBOUND PREVIEW</span>
                <dl><div><dt>To</dt><dd>{activeRound.counterpartyEmail}</dd></div><div><dt>Reply handling</dt><dd>{activeRound.emailAddress ? `Authenticated Notice reply address: ${activeRound.emailAddress}` : "Notice reply capture is off — return through the secure portal"}</dd></div><div><dt>Included securely</dt><dd>Scoped portal URL and authenticated review-copy metadata; no attachment bytes</dd></div></dl>
                <strong>{sendSubject.trim() || "Add a subject"}</strong>
                <p>{sendMessage.trim() || "Add a message"}</p>
                <small>The gateway receives the temporary portal URL as a separate signed field and must render it as the secure download/upload link. Notice does not claim the file is attached.</small>
              </div>
              <button className="primary-button" type="button" disabled={managerBusy || !state.deliveryConfigured || !state.negotiationMailAccepted || !state.portalEnabled || !activeRound.counterpartyEmail || !sendSubject.trim() || !sendMessage.trim()} onClick={() => void sendRound()}>{busyAction === "send" ? "Queueing…" : "Queue gateway delivery"}</button>
              {(!state.deliveryConfigured || !state.portalEnabled) && <p className="form-guidance">Gateway delivery requires the attested outbound delivery gateway and scoped portal. Use manual attestation only after delivering the exact outbound file outside Notice.</p>}
              {state.deliveryConfigured && state.portalEnabled && !state.negotiationMailAccepted && <p className="form-guidance">Automated counterparty delivery remains locked until the separate negotiation-mail acceptance proves the exact secure-link rendering, recipient handling, and optional reply behavior. Use the reviewed manual-delivery path until then.</p>}
              {state.deliveryConfigured && state.negotiationMailAccepted && state.portalEnabled && !state.inboundEmailConfigured && <p className="form-guidance">Inbound email capture is off. This message carries the secure portal link without a Notice reply alias; ask the counterparty to return its file through the portal.</p>}
            </section>
            <section><h3>Record manual delivery</h3><p>This records your attestation and external reference. It does not verify that a provider delivered or the counterparty received the file.</p><label><span>Recipient (locked when prepared)</span><input value={activeRound.counterpartyEmail ?? ""} readOnly /></label><label><span>External message or delivery reference</span><input value={manualReference} maxLength={500} onChange={(event) => setManualReference(event.target.value)} placeholder="Provider message ID or reviewed ticket reference" /></label><button type="button" disabled={managerBusy || !activeRound.counterpartyEmail || !manualReference.trim()} onClick={() => void attestManualSend()}>{busyAction === "manual-send" ? "Recording…" : "Record manual-delivery attestation"}</button></section>
          </div>}

          {canManage && state.portalEnabled && activeRound.deliveryState !== "dead" && <div className="rotate-portal"><div><strong>Revoke and replace the portal URL</strong><p>Rotation immediately invalidates the old URL. Wait if gateway delivery is still queued; never assume the earlier email can be resent with a redacted link.</p></div><button type="button" disabled={managerBusy || deliveryFinalizationPending} onClick={() => void rotatePortal()}>{busyAction === "rotate" ? "Rotating…" : deliveryFinalizationPending ? "Waiting for gateway" : "Rotate temporary URL"}</button></div>}
        </section>}

        {activeRound && canManage && <section className="panel negotiation-card manual-return-card">
          <div className="negotiation-card-head"><div><p>MANUAL FALLBACK</p><h2>Upload one returned file</h2></div></div>
          <p>Use this only for a file received outside the configured portal or reply channel. Notice binds the upload to round {activeRound.roundNumber}, scans it, stores its exact bytes, and creates one submission for this one attachment.</p>
          <div className="negotiation-form two-column"><label className="file-field"><span>Returned file</span><input ref={uploadInputRef} type="file" accept=".pdf,.docx,.rtf,.txt,.md" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} /></label><label><span>Sender email (optional)</span><input type="email" value={uploadSenderEmail} onChange={(event) => setUploadSenderEmail(event.target.value)} /></label><label><span>Sender name (optional)</span><input value={uploadSenderName} maxLength={200} onChange={(event) => setUploadSenderName(event.target.value)} /></label><label><span>External message reference (optional)</span><input value={uploadMessageId} maxLength={500} onChange={(event) => setUploadMessageId(event.target.value)} /></label><label className="full-width"><span>Personally reviewed plain text for this attachment (optional)</span><textarea value={uploadReviewedText} maxLength={2000000} rows={8} onChange={(event) => setUploadReviewedText(event.target.value)} placeholder="Paste only text you reviewed against this exact returned attachment." /></label></div>
          {uploadIsDocx && <div className="word-review-warning"><strong>Microsoft Word review required</strong><p>Notice stores and scans the DOCX, but does not parse or prove tracked changes, comments, formatting, fields, headers, footers, or hidden content. Open the exact downloaded DOCX in Word and review those features yourself. Paste reviewed plain text only if you personally reconciled it to this one attachment.</p></div>}
          <button className="primary-button" type="button" disabled={managerBusy || !uploadFile} onClick={() => void uploadReturnedFile()}>{busyAction === "upload" ? "Uploading and scanning…" : "Upload one returned file"}</button>
        </section>}

        <section className="panel negotiation-card submission-list-card">
          <div className="negotiation-card-head"><div><p>RETURN HISTORY</p><h2>Every recorded submission</h2></div><span>{state.submissions.length}</span></div>
          {state.submissions.length === 0 ? <div className="negotiation-empty"><h3>No return has been recorded</h3><p>Await the prepared reply or portal route. Notice does not infer that silence means acceptance.</p></div> : <div className="negotiation-submissions">{state.submissions.map((submission) => {
            const submissionDocument = submission.document ?? null;
            const readable = Boolean(submission.documentId && submission.documentSha256 && !["quarantined", "rejected", "no_attachment"].includes(submission.status));
            const submissionLabel = submissionDocument?.fileName ?? (submission.documentId ? `submission ${submission.id}` : "message with no attachment");
            const selectedRecord = selectedSubmissionId === submission.id;
            return <article className={`${selectedRecord ? "selected" : ""} status-${submission.status}`} aria-current={selectedRecord ? "true" : undefined} key={submission.id}><header><div><span>{negotiationSourceLabel(submission.source)}</span><h3>{submissionDocument?.fileName ?? (submission.documentId ? "Exact filename pending authenticated metadata" : "No attachment")}</h3></div><b>{submission.status.replace("_", " ")}</b></header><dl><div><dt>Received</dt><dd>{formatNegotiationTime(submission.createdAt)}</dd></div><div><dt>Sender</dt><dd>{submission.senderName || "Not supplied"}<small>{submission.senderEmail || "No sender email"}</small></dd></div><div><dt>Full file SHA-256</dt><dd><code>{submissionDocument?.sha256 ?? submission.documentSha256 ?? "No attachment hash"}</code></dd></div><div><dt>Round</dt><dd>{state.rounds.find((round) => round.id === submission.roundId)?.roundNumber ?? "Unknown"}</dd></div></dl><p>{negotiationSubmissionGuidance(submission.status)}</p>{submission.decisionNote && <blockquote>{submission.decisionNote}</blockquote>}<footer><button type="button" className={selectedRecord ? "active" : ""} aria-pressed={selectedRecord} aria-controls="negotiation-human-review" aria-label={`Review ${submissionLabel}`} onClick={() => selectSubmission(submission, true)}>Review record</button>{readable && <button type="button" disabled={managerBusy} aria-label={`Download exact returned file ${submissionLabel}`} onClick={() => void downloadNegotiationDocument(submissionDocument, submission.documentId, submission.documentSha256, "Returned review file")}>{busyAction === `download:${submission.documentId}` ? "Downloading…" : "Download exact returned file"}</button>}</footer></article>;
          })}</div>}
        </section>

        {selectedSubmission && <section ref={humanReviewRef} id="negotiation-human-review" className="panel negotiation-card human-review-card" aria-labelledby="negotiation-human-review-title" tabIndex={-1}>
          <div className="negotiation-card-head"><div><p>HUMAN REVIEW</p><h2 id="negotiation-human-review-title">Review {selectedSubmissionLabel} · round {state.rounds.find((round) => round.id === selectedSubmission.roundId)?.roundNumber ?? "unknown"}</h2></div><span>{selectedSubmission.status.replace("_", " ")}</span></div>
          <p>{negotiationSubmissionGuidance(selectedSubmission.status)}</p>
          {selectedSubmission.document?.fileName?.toLowerCase().endsWith(".docx") && <div className="word-review-warning"><strong>Review tracked changes in Microsoft Word</strong><p>The returned DOCX may contain tracked changes, comments, formatting, fields, headers, footers, or hidden content that Notice does not parse. Review the exact downloaded file in Word before entering reviewed text or making a decision.</p></div>}
          {selectedSubmissionReadable && <button type="button" disabled={managerBusy} onClick={() => void downloadNegotiationDocument(selectedSubmission.document, selectedSubmission.documentId, selectedSubmission.documentSha256, "Returned review file")}>{busyAction === `download:${selectedSubmission.documentId}` ? "Downloading…" : "Download exact returned file for review"}</button>}
          {canRescan && <div className="submission-rescan"><div><strong>Security scan did not finish cleanly</strong><p>Run the configured scanner again. The file stays isolated until a clean result is recorded; after that, add a verification note and mark it ready.</p></div><button type="button" disabled={managerBusy} onClick={() => void rescanSubmission()}>{busyAction === "rescan" ? "Rescanning…" : "Rescan quarantined file"}</button></div>}
          {canManage && (canMarkReady || canReject) && <div className="submission-decision"><label><span>Required decision or verification note</span><textarea value={decisionNote} maxLength={2000} rows={4} onChange={(event) => setDecisionNote(event.target.value)} /></label><div>{canReject && <button className="danger-button" type="button" disabled={managerBusy || !decisionNote.trim()} onClick={() => void decideSubmission("reject_submission")}>{busyAction === "reject_submission" ? "Rejecting…" : "Reject submission"}</button>}{canMarkReady && <button type="button" disabled={managerBusy || !decisionNote.trim()} onClick={() => void decideSubmission("mark_ready")}>{busyAction === "mark_ready" ? "Saving…" : "Mark ready after verification"}</button>}</div></div>}
          {selectedSubmission.reviewTextAvailable && <div className="saved-review-text"><div><strong>Saved staff-reviewed text is available</strong><code>SHA-256 {selectedSubmission.reviewTextSha256}</code><small>{selectedSubmission.reviewTextProvenance || "Authenticated reviewed-text provenance recorded."}</small></div><button type="button" disabled={managerBusy} onClick={() => void loadSavedReviewText()}>{busyAction === "review-text" ? "Loading…" : "Load exact saved reviewed text"}</button></div>}

          {canManage && activeSubmission?.status === "ready" && deliveryFinalizationPending && <div className="negotiation-delivery-pending"><strong>Promotion waits for gateway finalization</strong><p>The return is ready for human review, but the original delivery request is still queued or processing. Finish review now, then promote only after the gateway records an accepted or failed terminal state.</p></div>}

          {canPromote && <div className="promotion-editor">
            <div className="promotion-warning"><strong>Promotion changes the governed contract record</strong><p>Promotion creates a new immutable working version from the reviewed plain text or Markdown below. It invalidates prior approvals and signature readiness. It does not convert the returned binary, parse Word tracked changes, or approve any term.</p></div>
            <div className="negotiation-form two-column"><label><span>Saved version label</span><input value={promotionLabel} maxLength={120} onChange={(event) => setPromotionLabel(event.target.value)} /></label><label><span>Reviewed text format</span><select value={reviewedContentType} onChange={(event) => setReviewedContentType(event.target.value as "text/plain" | "text/markdown")}><option value="text/plain">Plain text</option><option value="text/markdown">Markdown</option></select></label><label className="full-width"><span>Your reviewed working text</span><textarea value={reviewedText} maxLength={2000000} rows={16} aria-describedby="reviewed-text-help" onChange={(event) => setReviewedText(event.target.value)} /><small id="reviewed-text-help" className="field-help">Enter only text that a human reviewed against this exact returned file. Notice does not extract or verify Word tracked changes.</small></label><label className="full-width"><span>Required human-review note</span><textarea value={promotionNote} maxLength={2000} rows={4} aria-describedby="promotion-note-help" onChange={(event) => setPromotionNote(event.target.value)} /><small id="promotion-note-help" className="field-help">Record who reviewed the returned file, how Word or PDF features were checked, and why this text is the intended working version.</small></label></div>

            <section className="line-comparison" aria-label="Coarse line comparison for human review"><header><div><span>COARSE LINE COMPARISON</span><h3>Current saved draft ↔ your reviewed text</h3></div>{comparison.result && <b>{comparison.result.mode === "coarse" ? "Coarse alignment" : "Exact line alignment"}</b>}</header><p>This deterministic browser comparison uses only saved working draft v{savedDraft?.status === "ready" ? savedDraft.version : "—"} and the text you entered. It does not inspect the returned binary or make a legal, policy, risk, or no-change verdict.</p>{savedDraft?.status === "ready" && <code>Current saved SHA-256 {savedDraft.sha256 ?? "unavailable"}</code>}{comparison.error && <div className="comparison-error" role="alert">{comparison.error}</div>}{comparison.result && <><div className="comparison-counts"><span><b>{comparison.result.removed}</b> removed lines</span><span><b>{comparison.result.added}</b> added lines</span><span><b>{comparison.result.unchanged}</b> aligned unchanged lines</span></div>{changedComparisonLines.length ? <div className="line-diff-list" role="region" aria-label={`Changed lines: ${changedComparisonLines.length} total, showing up to 240`} tabIndex={0}>{changedComparisonLines.slice(0, 240).map((line, index) => <div className={line.kind} key={`${line.kind}:${line.baseLine}:${line.proposedLine}:${index}`}><span>{line.kind === "removed" ? `− ${line.baseLine ?? ""}` : `+ ${line.proposedLine ?? ""}`}</span><code>{line.text || " "}</code></div>)}</div> : <div className="comparison-identical"><strong>No line differences are displayed</strong><p>This says only that the two text inputs align line-for-line. It does not prove the returned file is unchanged or acceptable.</p></div>}{changedComparisonLines.length > 240 && <p className="comparison-truncated">Showing the first 240 changed lines of {changedComparisonLines.length}. Review the complete saved draft and reviewed text before promotion.</p>}</>}</section>
            <button className="primary-button promote-button" type="button" disabled={managerBusy || !reviewedText.trim() || !promotionLabel.trim() || !promotionNote.trim()} onClick={() => void promoteSubmission()}>{busyAction === "promote" ? "Creating immutable version…" : "Promote reviewed text to new version"}</button>
          </div>}
        </section>}
      </div>

      <aside className="negotiation-side">
        <section className="panel negotiation-card round-history-card"><h2>Round history</h2>{state.rounds.length ? <ol>{state.rounds.map((round) => <li key={round.id}><span>{round.roundNumber}</span><div><b>{negotiationRoundLabel(round.status)}</b><small>{formatNegotiationTime(round.createdAt)}</small><code>Outbound SHA-256 {round.outboundDocument?.sha256 ?? round.outboundSha256}</code>{round.resolvedDocumentVersion && <em>Promoted as v{round.resolvedDocumentVersion}</em>}</div></li>)}</ol> : <p>No review rounds have been prepared.</p>}</section>
        <section className="panel negotiation-card provenance-card"><h2>What Notice records</h2><ul><li>Exact outbound and returned file hashes</li><li>Authenticated source and recorded time</li><li>Sender-review, quarantine, rejection, late, and no-attachment states</li><li>Human notes and immutable promoted versions</li></ul><p>Notice does not parse tracked changes, decide legal meaning, or infer counterparty acceptance.</p><button type="button" onClick={onOpenHistory}>Open history & comments</button></section>
        {canManage && activeRound && <section className="panel negotiation-card close-round-card"><h2>Close active round</h2><p>{deliveryFinalizationPending ? "Gateway delivery is still queued or processing. Wait for a terminal result before closing so Notice cannot revoke a link while it may still be sent." : "Closing stops this round from receiving a promotable return and revokes its portal credential. It does not delete its evidence."}</p><label><span>Required closure note</span><textarea value={closeNote} maxLength={2000} rows={5} onChange={(event) => setCloseNote(event.target.value)} /></label><button className="danger-button" type="button" disabled={managerBusy || deliveryFinalizationPending || !closeNote.trim()} onClick={() => void closeRound()}>{busyAction === "close" ? "Closing…" : deliveryFinalizationPending ? "Waiting for gateway" : "Close round"}</button></section>}
      </aside>
    </div>}
  </div>;
}

function MetricCard({ label, value, note, trend, tone = "good" }: { label: string; value: string; note: string; trend: string; tone?: "good" | "warn" | "risk" }) {
  return <article className={`metric-card ${tone}`}><div><span>{label}</span><b className={tone}>{trend}</b></div><strong>{value}</strong><p>{note}</p></article>;
}

function MiniQueueRow({ avatar, title, detail, onOpen }: { avatar: string; title: string; detail: string; onOpen: () => void }) {
  return <button className="mini-queue-row" type="button" onClick={onOpen}><span>{avatar}</span><div><b>{title}</b><small>{detail}</small></div><i aria-hidden="true">›</i></button>;
}

function AgreementTable({ agreements, selectedRows, onSelect, onSelectAll, onOpen }: { agreements: Agreement[]; selectedRows: number[]; onSelect: (id: number) => void; onSelectAll: () => void; onOpen: (id: number) => void }) {
  return <div className="agreement-table" role="table" aria-label="Contracts"><div className="agreement-row table-head" role="row"><span role="columnheader"><input type="checkbox" checked={agreements.length > 0 && selectedRows.length === agreements.length} onChange={onSelectAll} aria-label="Select all contracts" /></span><span role="columnheader">Contract</span><span role="columnheader">Direction</span><span role="columnheader">Stage</span><span role="columnheader">Value</span><span role="columnheader">Risk</span><span role="columnheader">Next action</span><span role="columnheader">Owner</span><span role="columnheader" /></div>{agreements.map((agreement) => <div className="agreement-row" role="row" key={agreement.id}><span className="agreement-select-cell" role="cell"><button type="button" className="agreement-row-open" onClick={() => onOpen(agreement.id)} aria-label={`Open ${agreement.party}`} /><input type="checkbox" checked={selectedRows.includes(agreement.id)} onChange={() => onSelect(agreement.id)} aria-label={`Select ${agreement.party}`} /></span><div className="party-cell" role="cell"><i className={`party-logo ${agreement.side.toLowerCase().replace("-side", "")}`}>{agreement.initials}</i><span><b>{agreement.party}</b><small>{agreement.type} · {agreement.updated}</small></span></div><span role="cell"><i className={`lane-pill ${agreement.side.toLowerCase().replace("-side", "")}`}>{contractDirectionLabel(agreement.side)}</i></span><span className="stage-cell" role="cell"><i className={`stage-dot ${agreement.stage.toLowerCase()}`} />{agreement.stage}</span><span className="value-cell" role="cell">{agreement.valueMinor !== undefined || agreement.value !== undefined ? formatAgreementMoney(agreement) : "—"}</span><span role="cell"><RiskBadge risk={agreement.risk} /></span><span className="next-cell" role="cell"><b>{agreement.nextAction}</b><small>{agreement.due}</small></span><span className="owner-cell" role="cell"><i>{agreement.owner.split(" ").map((word) => word[0]).join("")}</i>{agreement.owner}</span><span className="row-arrow" role="cell" aria-hidden="true">›</span></div>)}</div>;
}

function RiskBadge({ risk }: { risk: Risk }) {
  return <span className={`risk-badge ${risk.toLowerCase()}`}><i />{risk}</span>;
}

function signatureStatusLabel(status: Agreement["signatureStatus"]) {
  return status === "completed_review_required" ? "Evidence review required" : status;
}

function SignatureBadge({ status }: { status: Agreement["signatureStatus"] }) {
  return <span className={`signature-badge ${status.toLowerCase().replaceAll(" ", "-").replaceAll("_", "-")}`}>{signatureStatusLabel(status)}</span>;
}

function ContractSection({ number, title, children, editable }: { number: string; title: string; children: ReactNode; editable: boolean }) {
  return <section className="contract-section"><h3>{number}. {title}</h3><p contentEditable={editable} suppressContentEditableWarning>{children}</p></section>;
}

function ChangeCard({ party, title, detail, playbook, canResolve, onAccept, onReject }: { party: string; title: string; detail: string; playbook: string; canResolve: boolean; onAccept: () => void; onReject: () => void }) {
  return <article className="change-card"><div><span>CC</span><p><b>{party}</b><small>proposed a change</small></p></div><h4>{title}</h4><p>{detail}</p><em>{playbook}</em>{canResolve ? <footer><button type="button" onClick={onReject}>× Reject</button><button type="button" onClick={onAccept}>✓ Accept</button></footer> : <footer><span>Read-only</span></footer>}</article>;
}

function ChangeReviewRow({ title, standard, proposed, status, risk, onAccept, onReject }: { title: string; standard: string; proposed: string; status: ChangeStatus; risk: Risk; onAccept?: () => void; onReject?: () => void }) {
  return <article><div><RiskBadge risk={risk} /><h3>{title}</h3></div><dl><div><dt>Standard</dt><dd>{standard}</dd></div><div><dt>Proposed</dt><dd>{proposed}</dd></div></dl><footer>{status === "open" ? onAccept && onReject ? <><button type="button" onClick={onReject}>Reject</button><button type="button" onClick={onAccept}>Accept change</button></> : <span>Read-only</span> : <span className={status}>✓ {status}</span>}</footer></article>;
}

function DetailField({ label, value, onChange, inputMode, type = "text", readOnly = false }: { label: string; value: string; onChange: (value: string) => void; inputMode?: "numeric"; type?: "text" | "date"; readOnly?: boolean }) {
  return <label><span>{label}</span><input type={type} value={type === "date" ? dateInputValue(value) : value} inputMode={inputMode} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} /></label>;
}

function DetailSelect({ label, value, onChange, options, readOnly = false }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string; disabled?: boolean }>; readOnly?: boolean }) {
  return <label><span>{label}</span><select value={value} disabled={readOnly} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}{option.disabled && option.value !== value ? " — not configured" : ""}</option>)}</select></label>;
}

function IntegrationCard({ name, monogram, color, connected, statusKnown, fixedStatus, canManage, description, objects, onClick }: { name: string; monogram: string; color: string; connected: boolean; statusKnown: boolean; fixedStatus?: string; canManage: boolean; description: string; objects: string[]; onClick: () => void }) {
  return <article className="integration-card"><div className="integration-top"><span className={`crm-monogram ${color}`}>{monogram}</span><i className={!fixedStatus && statusKnown && connected ? "connected" : ""}>{fixedStatus ?? (statusKnown ? connected ? "Configured" : "Not configured" : "Status restricted")}</i></div><h2>{name}</h2><p>{description}</p><div className="object-tags">{objects.map((object) => <span key={object}>{object}</span>)}</div><button type="button" onClick={onClick}>{fixedStatus ? "View gateway requirement" : statusKnown && connected ? canManage ? "Review configuration" : "View status" : canManage ? "Review setup" : "View requirements"} <span>→</span></button></article>;
}

function ImportDialog({ mode, step, name, analysis, error, busy, recoveryLocked, onClose, onDiscard, onFile, onDrop, onStartSample, onBack, onConfirm, onAnalysisChange }: {
  mode: SessionData["mode"];
  step: "drop" | "scan" | "review";
  name: string;
  analysis: ImportAnalysis;
  error: string;
  busy: boolean;
  recoveryLocked: boolean;
  onClose: () => void;
  onDiscard: () => void;
  onFile: (event: ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onStartSample: () => void;
  onBack: () => void;
  onConfirm: () => void;
  onAnalysisChange: (analysis: ImportAnalysis) => void;
}) {
  const fields: Array<[keyof ImportAnalysis["extracted"], string]> = [
    ["side", "Contract direction"],
    ["type", "Contract type"],
    ["counterparty", "Counterparty"],
    ["agreementValue", "Contract value (USD default; confirm in details)"],
    ["paymentTerms", "Payment terms"],
    ["renewalNotice", "Renewal notice"],
    ["governingLaw", "Governing law"],
    ["effectiveDate", "Effective date"],
    ["expirationDate", "Expiration date"],
    ["liabilityCap", "Liability cap"],
  ];
  function updateField(field: keyof ImportAnalysis["extracted"], value: string) {
    onAnalysisChange({ ...analysis, extracted: { ...analysis.extracted, [field]: value } });
  }
  const documentUsable = analysis.scanStatus === "clean" || (mode === "evaluation" && analysis.scanStatus === "evaluation-bypassed");
  const directionConfirmed = (["Sell-side", "Buy-side", "Corporate"] as string[]).includes(analysis.extracted.side);
  const typeConfirmed = Boolean(analysis.extracted.type.trim() && analysis.extracted.type !== "Not detected");
  const title = step === "drop" ? "Upload an existing contract" : step === "scan" ? "Reading the contract" : "Confirm the contract details";

  return <Modal titleId="import-title" onClose={onClose} wide={step === "review"}>
    <div className="modal-head"><div><p>{mode === "evaluation" ? "EVALUATION CONTRACT UPLOAD" : "UPLOAD CONTRACT"}</p><h2 id="import-title">{title}</h2></div><button type="button" disabled={busy} onClick={onClose} aria-label="Close">×</button></div>
    {step === "drop" && <div className="import-drop" onDrop={onDrop} onDragOver={(event) => event.preventDefault()}><span>↥</span><h3>Drop PDF, DOCX, RTF, or text here</h3><p>Notice stores the security-scanned source and proposes fields, tags, and review flags. Confirm every suggestion against the source and approved company policy.</p>{error && <p className="import-error" role="alert">{error}</p>}<input id="import-document-file" className="visually-hidden-file" type="file" accept=".pdf,.docx,.txt,.rtf" aria-describedby="import-upload-help" onChange={onFile} /><label htmlFor="import-document-file">Choose document</label>{mode === "evaluation" && <button type="button" onClick={onStartSample}>Use labeled evaluation sample MSA →</button>}<small id="import-upload-help">Maximum file size 20 MB · Scanned PDFs route to OCR or manual review</small></div>}
    {step === "scan" && <div className="scan-state" role="status" aria-live="polite" aria-busy="true"><div className="scan-doc" aria-hidden="true"><i /></div><h3>Extracting suggestions for review</h3><p>{name}</p><div aria-hidden="true"><span /></div><small>Parties · type · value · dates · renewal · governing law · review terms</small></div>}
    {step === "review" && <div className="import-review" aria-busy={busy}>
      <div className="import-file"><span>{name.toLowerCase().endsWith(".pdf") ? "PDF" : name.toLowerCase().endsWith(".docx") ? "DOCX" : "TEXT"}</span><div><b>{name}</b><small>{analysis.extractionMode} · {analysis.extracted.type}</small></div><i>{mode === "evaluation" ? "Evaluation sample · confirm every field" : "Human confirmation required"}</i></div>
      <div className="detected-tags"><p>SUGGESTED TAGS</p>{analysis.tags.map((tag) => <span className={tag.includes("Liability") ? "risk" : ""} key={tag}>{tag}</span>)}</div>
      <div className="extracted-fields">{fields.map(([field, label]) => {
        const confirmed = field === "side" ? directionConfirmed : Boolean(analysis.extracted[field] && analysis.extracted[field] !== "Not detected");
        const dateField = field === "effectiveDate" || field === "expirationDate";
        return <label key={field}><span>{label} <i>{confirmed ? "Suggested" : "Review"}</i></span>{field === "side" ? <select value={directionConfirmed ? analysis.extracted.side : ""} disabled={busy || recoveryLocked} onChange={(event) => updateField(field, event.target.value)}><option value="" disabled>Choose contract direction</option><option value="Sell-side">Customer contract</option><option value="Buy-side">Supplier contract</option><option value="Corporate">Company contract</option></select> : <input type={dateField ? "date" : "text"} value={dateField ? dateInputValue(analysis.extracted[field]) : analysis.extracted[field]} disabled={busy || recoveryLocked} onChange={(event) => updateField(field, event.target.value)} />}</label>;
      })}</div>
      {analysis.riskFlags.length > 0 ? <div className="risk-find"><span>!</span><div><b>{analysis.riskFlags.length} automated review flag{analysis.riskFlags.length === 1 ? "" : "s"}</b><p>{analysis.riskFlags[0]}</p></div></div> : <div className="risk-find clear"><span>✓</span><div><b>No automated review flags listed</b><p>This is not a policy approval. Confirm the source text against customer-approved positions.</p></div></div>}
      <div className="import-actions"><button type="button" disabled={busy || (!analysis.documentId && recoveryLocked)} onClick={analysis.documentId && !recoveryLocked ? onDiscard : analysis.documentId ? onClose : onBack}>{analysis.documentId && !recoveryLocked ? "Discard staged upload" : analysis.documentId ? "Pause and finish later" : "Back"}</button><button type="button" disabled={busy || !documentUsable || !directionConfirmed || !typeConfirmed} onClick={onConfirm}>{busy ? "Adding contract…" : recoveryLocked ? "Retry exact intake" : !documentUsable ? "Quarantined pending scan" : !directionConfirmed ? "Choose contract direction" : !typeConfirmed ? "Confirm contract type" : "Add contract to workspace"} {!busy && <span>→</span>}</button></div>
    </div>}
  </Modal>;
}

function Modal({ children, onClose, titleId, wide = false, extraWide = false, command = false }: { children: ReactNode; onClose: () => void; titleId: string; wide?: boolean; extraWide?: boolean; command?: boolean }) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = dialog?.querySelector<HTMLElement>("[data-initial-focus], input[autofocus], textarea[autofocus], select[autofocus], input:not([type='hidden']):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex='-1'])");
    focusable?.focus();
    function keydown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onCloseRef.current();
      if (event.key === "Tab" && dialog) {
        const items = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.body.classList.add("modal-open");
    window.addEventListener("keydown", keydown);
    return () => {
      document.body.classList.remove("modal-open");
      window.removeEventListener("keydown", keydown);
      window.requestAnimationFrame(() => {
        // A nested dialog owns focus when it has replaced this one. Otherwise
        // restore the exact opener when it still exists, or a stable visible
        // header trigger when the opener belonged to an unmounted dialog.
        if (document.querySelector("[role='dialog'][aria-modal='true']")) return;
        const available = (element: HTMLElement | null): element is HTMLElement => Boolean(
          element?.isConnected
          && element !== document.body
          && element !== document.documentElement
          && !element.closest("[inert]")
          && !element.matches(":disabled")
          && element.matches("button, input, select, textarea, a[href], [contenteditable='true'], [tabindex]:not([tabindex='-1'])")
          && element.getClientRects().length > 0,
        );
        const fallback = Array.from(document.querySelectorAll<HTMLElement>("[data-modal-focus-fallback]"))
          .find((element) => available(element)) ?? null;
        const target = available(previous) ? previous : fallback;
        target?.focus();
      });
    };
  }, []);
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section ref={dialogRef} className={`clm-modal ${wide ? "wide" : ""} ${extraWide ? "extra-wide" : ""} ${command ? "command" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>{children}</section></div>;
}
