export type StarterDraftInput = Readonly<{
  organization: string;
  party: string;
  side: "Sell-side" | "Buy-side" | "Corporate";
  type: string;
  effectiveDate?: string;
  governingLaw?: string;
}>;

type StarterSection = Readonly<{
  title: string;
  body: string;
}>;

function serviceSections(governingLaw: string): StarterSection[] {
  return [
    { title: "Scope and services", body: "The parties will describe the services, deliverables, acceptance criteria, dependencies, and service levels in a mutually executed schedule or order form." },
    { title: "Fees and payment", body: "Customer will pay undisputed amounts within thirty (30) days after receipt of a valid invoice. The parties will document pricing, taxes, expenses, and any disputed-payment process in the applicable schedule." },
    { title: "Confidentiality", body: "Each party will protect the other party's Confidential Information using at least reasonable care and will use it solely to perform or receive services under this Agreement." },
    { title: "Data protection", body: "The parties will identify whether personal or regulated data is processed and attach customer-approved privacy and security terms when required." },
    { title: "Limitation of liability", body: "The parties must confirm the applicable liability cap, exclusions, and carve-outs against approved company policy before release." },
    { title: "Term and termination", body: "The parties must confirm the initial term, renewal mechanics, termination rights, and transition obligations before release." },
    { title: "Governing law", body: `This Agreement is governed by the laws of ${governingLaw}, without regard to conflict-of-laws rules.` },
  ];
}

function starterSections(type: string, governingLaw: string): StarterSection[] {
  const normalized = type.trim().toLowerCase();

  if (normalized.includes("non-disclosure") || normalized.includes("nda")) {
    return [
      { title: "Purpose", body: "The parties may disclose information solely to evaluate or perform the business purpose that they confirm before release." },
      { title: "Confidential information", body: "Confidential Information includes non-public information disclosed in any form that is marked confidential or reasonably should be understood to be confidential." },
      { title: "Use and protection", body: "Each party will use Confidential Information only for the agreed purpose, protect it using at least reasonable care, and disclose it only to representatives with a need to know and equivalent duties." },
      { title: "Exclusions and required disclosure", body: "The parties must confirm customary exclusions and the process for disclosure required by law." },
      { title: "Term and return", body: "The parties must confirm the disclosure period, survival period, and return-or-destruction obligations before release." },
      { title: "Governing law", body: `This Agreement is governed by the laws of ${governingLaw}, without regard to conflict-of-laws rules.` },
    ];
  }

  if (normalized.includes("data processing")) {
    return [
      { title: "Scope and roles", body: "The parties must identify the covered services, data categories, processing purposes, data subjects, and controller/processor roles before release." },
      { title: "Documented instructions", body: "Processor will process Personal Data only on documented instructions and notify Controller if an instruction appears to violate applicable law." },
      { title: "Security and incidents", body: "Processor will maintain customer-approved safeguards and follow the approved security-incident notification process." },
      { title: "Subprocessors and transfers", body: "The parties must confirm subprocessor authorization, objection rights, transfer safeguards, and data-location requirements." },
      { title: "Assistance and deletion", body: "The parties must confirm assistance, audit, return, deletion, and retention obligations before release." },
      { title: "Governing law", body: `This Addendum is governed by the laws of ${governingLaw}, subject to mandatory data-protection law.` },
    ];
  }

  if (normalized.includes("order form")) {
    return [
      { title: "Order and incorporated agreement", body: "The parties must identify the governing master agreement and any order-of-precedence rules before release." },
      { title: "Products and services", body: "The parties must describe quantities, scope, deliverables, service levels, and dependencies in this Order Form." },
      { title: "Fees and invoicing", body: "The parties must confirm pricing, billing milestones, taxes, expenses, and payment terms before release." },
      { title: "Order term", body: "The parties must confirm the start date, subscription or service term, renewal mechanics, and termination effect." },
      { title: "Additional terms", body: "Security, privacy, support, and other schedules apply only when identified and approved by the parties." },
      { title: "Governing law", body: `The governing agreement's law is expected to be ${governingLaw}; confirm consistency before release.` },
    ];
  }

  if (normalized.includes("software subscription")) {
    return [
      { title: "Subscription rights", body: "Provider grants Customer the subscription access described in each executed order, subject to confirmed users, usage limits, documentation, and restrictions." },
      { title: "Fees and payment", body: "The parties must confirm subscription fees, invoicing, taxes, renewal pricing, and disputed-payment treatment before release." },
      { title: "Service, support, and security", body: "The parties must attach approved availability, support, security, continuity, and incident-response requirements when applicable." },
      { title: "Customer data", body: "The parties must confirm data ownership, permitted processing, portability, deletion, and any required Data Processing Addendum." },
      { title: "Warranties and liability", body: "The parties must confirm warranties, remedies, indemnities, liability limits, exclusions, and carve-outs against approved policy." },
      { title: "Term and exit", body: "The parties must confirm the initial term, renewal, suspension, termination, transition, and data-return obligations." },
      { title: "Governing law", body: `This Agreement is governed by the laws of ${governingLaw}, without regard to conflict-of-laws rules.` },
    ];
  }

  if (normalized.includes("employment")) {
    return [
      { title: "Role and start date", body: "The Company and Employee must confirm the role, reporting line, work location, start date, and applicable employment classification." },
      { title: "Compensation and benefits", body: "The parties must attach the customer-approved compensation, incentive, benefits, expense, and payroll terms." },
      { title: "Duties and policies", body: "Employee will perform the confirmed duties and comply with lawful Company policies supplied separately." },
      { title: "Confidentiality and work product", body: "The parties must insert jurisdiction-appropriate, company-approved confidentiality and intellectual-property terms before release." },
      { title: "Termination", body: "The parties must confirm notice, statutory rights, post-termination obligations, and return of Company property under applicable law." },
      { title: "Governing law", body: `This Agreement is governed by the laws of ${governingLaw}, subject to mandatory employment law.` },
    ];
  }

  if (normalized.includes("partnership")) {
    return [
      { title: "Purpose and scope", body: "The parties must confirm the partnership purpose, permitted activities, territory, exclusivity, and measurable responsibilities." },
      { title: "Contributions and economics", body: "The parties must document contributions, costs, revenue allocation, invoicing, taxes, and financial reporting before release." },
      { title: "Governance", body: "The parties must confirm decision rights, representatives, escalation, records, and conflicts processes." },
      { title: "Brand, data, and intellectual property", body: "The parties must identify ownership, licenses, publicity rights, confidentiality, and data responsibilities." },
      { title: "Term and separation", body: "The parties must confirm the term, exit rights, transition duties, accrued obligations, and continuing restrictions." },
      { title: "Governing law", body: `This Agreement is governed by the laws of ${governingLaw}, without regard to conflict-of-laws rules.` },
    ];
  }

  if (normalized.includes("lease amendment")) {
    return [
      { title: "Existing lease", body: "The parties must identify the existing lease, premises, original date, prior amendments, and their respective lease roles." },
      { title: "Amended terms", body: "The parties must set out each confirmed amendment, including any rent, term, premises, maintenance, access, or notice change." },
      { title: "Effective date", body: "The amendments take effect on the date confirmed by the parties." },
      { title: "Continuing effect", body: "Except as expressly amended, the existing lease remains in effect; the parties must resolve any conflict or precedence language before release." },
      { title: "Governing law", body: `This Amendment is governed by the laws of ${governingLaw}, subject to mandatory property law.` },
    ];
  }

  if (normalized.includes("board consent")) {
    return [
      { title: "Background", body: "The directors must confirm the entity, meeting or written-consent authority, relevant background, and action under consideration." },
      { title: "Resolutions", body: "The approved resolutions, limits, conditions, and any conflicts disclosures must be inserted before circulation." },
      { title: "Authorized actions", body: "The directors must identify each authorized officer and the documents or actions that officer may complete." },
      { title: "Effect and records", body: "The consent takes effect when validly approved and must be retained with the Company's corporate records." },
    ];
  }

  return serviceSections(governingLaw);
}

export function starterDraftSummary(type: string): string {
  const normalized = type.trim().toLowerCase();
  if (normalized.includes("non-disclosure") || normalized.includes("nda")) return "Purpose, confidentiality, permitted use, exclusions, term, and governing law example sections";
  if (normalized.includes("data processing")) return "Processing roles, instructions, security, subprocessors, data rights, and governing law example sections";
  if (normalized.includes("order form")) return "Order scope, products or services, pricing, term, incorporated agreement, and governing law example sections";
  if (normalized.includes("software subscription")) return "Subscription, fees, service and security, customer data, risk, term, and governing law example sections";
  if (normalized.includes("employment")) return "Role, compensation, policies, confidentiality, termination, and governing law example sections";
  if (normalized.includes("partnership")) return "Purpose, economics, governance, intellectual property, separation, and governing law example sections";
  if (normalized.includes("lease amendment")) return "Existing lease, amended terms, effective date, continuing effect, and governing law example sections";
  if (normalized.includes("board consent")) return "Background, resolutions, authorized actions, and corporate-record example sections";
  return "Scope, fees, confidentiality, data, liability, term, and governing law example sections";
}

/**
 * Assemble a clearly marked repository example as plain text so the server can
 * persist the exact first working version and the browser can render the same
 * content. Workspace-approved language is inserted and saved separately.
 */
export function assembleStarterDraft(input: StarterDraftInput): string {
  const organization = input.organization.trim() || "Our organization";
  const party = input.party.trim();
  const type = input.type.trim();
  const effectiveDate = input.effectiveDate?.trim() || "[Effective date to be confirmed]";
  const governingLaw = input.governingLaw?.trim() || "[Governing law to be confirmed]";
  const [organizationRole, partyRole] = input.side === "Sell-side"
    ? ["Provider", "Customer"]
    : input.side === "Buy-side"
      ? ["Customer", "Provider"]
      : type.toLowerCase().includes("employment")
        ? ["Company", "Employee"]
        : ["Company", "Counterparty"];
  const isBoardConsent = type.toLowerCase().includes("board consent");
  const introduction = isBoardConsent
    ? `The undersigned directors of ${organization} adopt this written consent as of ${effectiveDate} concerning ${party}.`
    : `This ${type} (the "Agreement") is entered into as of ${effectiveDate} by and between ${organization} ("${organizationRole}") and ${party} ("${partyRole}").`;
  const sections = starterSections(type, governingLaw)
    .map((section, index) => `${index + 1}. ${section.title}\n${section.body}`)
    .join("\n\n");
  const signatures = isBoardConsent
    ? `${organization.toUpperCase()}\nDirector name / Signature / Date`
    : `${organization.toUpperCase()}\nName / Title / Date\n\n${party.toUpperCase()}\nName / Title / Date`;

  return `${type.toUpperCase()}

REPOSITORY STARTER — HUMAN REVIEW REQUIRED
This example has not applied workspace-approved language or company policy. Confirm every term and insert approved language before release.

${introduction}

${sections}

SIGNATURES

${signatures}
`;
}
