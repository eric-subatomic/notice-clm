"use client";

import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

type AgreementLink = {
  id: number;
  party: string;
  type: string;
  stage?: string;
  side?: string;
  department?: string;
  ownerUserId?: string | null;
  primaryCounterpartyId?: string | null;
  legalEntityId?: string | null;
};

type SessionSummary = {
  user: { id: string; displayName: string };
  role: string;
  permissions: string[];
};

type ApiFailure = { error?: string | { message?: string } };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as T & ApiFailure;
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw new Error(message ?? `Request failed with HTTP ${response.status}`);
  }
  return payload;
}

function prettyStatus(value: unknown): string {
  return String(value ?? "unknown").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function compactValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not supplied";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(compactValue).join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${prettyStatus(key)}: ${compactValue(item)}`)
      .join(" · ");
  }
  return "Recorded value";
}

function SurfaceState({
  title,
  detail,
  tone = "empty",
  onRetry,
}: {
  title: string;
  detail: string;
  tone?: "loading" | "error" | "empty";
  onRetry?: () => void;
}) {
  return <div className={`enterprise-state ${tone}`} role={tone === "error" ? "alert" : "status"} aria-live="polite">
    <span aria-hidden="true">{tone === "loading" ? "◌" : tone === "error" ? "!" : "◇"}</span>
    <div><strong>{title}</strong><p>{detail}</p></div>
    {onRetry && <button type="button" onClick={onRetry}>Retry</button>}
  </div>;
}

type PortfolioReport = {
  generatedAt: string;
  asOfDate: string;
  portfolio: {
    agreements: number;
    stages: Array<{ key: string; count: number }>;
    risks: Array<{ key: string; count: number }>;
    currencies: Array<{ currencyCode: string; agreements: number; valueMinor: string }>;
    renewals: { through: string; count: number };
  };
  work: {
    approvals: { pending: number; overdue: number; changesRequested: number };
    signatures: Array<{ key: string; count: number }>;
    obligations: { open: number; overdue: number; complete: number };
    obligationSchedules: Array<{ key: string; count: number }>;
  };
};

type WorkResource = "approvals" | "signatures" | "obligations" | "obligation_schedules" | "events";
type WorkItem = Record<string, unknown> & { id: string; agreement?: AgreementLink };
type WorkPayload = {
  items: WorkItem[];
  page: { hasMore: boolean; nextCursor: string | null; snapshotAt: string };
  summary: { totalMatched: number; totalMatchedCapped: boolean; statusCounts: Array<{ status: string; count: number; capped: boolean }> };
};

const workResources: Array<{ id: WorkResource; label: string; description: string }> = [
  { id: "approvals", label: "Approvals", description: "Human decisions awaiting action" },
  { id: "signatures", label: "Signatures", description: "Packets and completed-evidence review" },
  { id: "obligations", label: "Obligations", description: "Dated post-signature commitments" },
  { id: "obligation_schedules", label: "Schedules", description: "Recurring commitment controls" },
  { id: "events", label: "History", description: "Attributable contract activity" },
];

const workSort: Record<WorkResource, string> = {
  approvals: "due_asc",
  signatures: "updated_desc",
  obligations: "due_asc",
  obligation_schedules: "next_due_asc",
  events: "newest",
};

function formatMinor(valueMinor: string, currencyCode: string): string {
  const zero = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
  const three = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);
  const digits = zero.has(currencyCode) ? 0 : three.has(currencyCode) ? 3 : 2;
  try {
    const minor = BigInt(valueMinor);
    const negative = minor < BigInt(0);
    const absolute = negative ? -minor : minor;
    const scale = BigInt(10) ** BigInt(digits);
    const whole = (absolute / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const fraction = digits ? `.${(absolute % scale).toString().padStart(digits, "0")}` : "";
    return `${currencyCode} ${negative ? "-" : ""}${whole}${fraction}`;
  } catch {
    return `${currencyCode} ${valueMinor}`;
  }
}

function WorkItemCard({ item, resource, onOpenAgreement }: { item: WorkItem; resource: WorkResource; onOpenAgreement: (id: number) => void }) {
  const agreement = item.agreement;
  const title = resource === "approvals"
    ? `${String(item.role ?? "Approval")} decision`
    : resource === "signatures"
      ? "Signature packet"
      : resource === "obligations" || resource === "obligation_schedules"
        ? String(item.title ?? "Post-signature commitment")
        : String(item.type ?? "Contract activity");
  const status = item.status ?? (resource === "events" ? item.type : "Open");
  const owner = item.approver ?? item.owner ?? item.actor ?? agreement?.party ?? "Unassigned";
  const date = item.due ?? item.dueDate ?? item.nextOccurrenceDate ?? item.updatedAt ?? item.createdAt;
  return <article className="work-item-card">
    <div><span className={`enterprise-status ${String(status).toLowerCase().replaceAll(" ", "-").replaceAll("_", "-")}`}>{prettyStatus(status)}</span><small>{prettyStatus(resource)}</small></div>
    <h3>{title}</h3>
    <p>{agreement ? `${agreement.party} · ${agreement.type}` : String(item.detail ?? "Workspace evidence")}</p>
    <dl><div><dt>Owner</dt><dd>{String(owner)}</dd></div><div><dt>Timing</dt><dd>{date ? String(date) : "No date recorded"}</dd></div></dl>
    {agreement && <button type="button" onClick={() => onOpenAgreement(agreement.id)}>Open contract →</button>}
  </article>;
}

export function PortfolioWorkspace({ onOpenAgreement }: { onOpenAgreement: (id: number) => void }) {
  const [report, setReport] = useState<PortfolioReport | null>(null);
  const [reportBusy, setReportBusy] = useState(true);
  const [reportError, setReportError] = useState("");
  const [resource, setResource] = useState<WorkResource>("approvals");
  const [work, setWork] = useState<WorkPayload | null>(null);
  const [workBusy, setWorkBusy] = useState(true);
  const [workError, setWorkError] = useState("");
  const [workQuery, setWorkQuery] = useState("");
  const workRequestRef = useRef(0);

  async function loadReport() {
    setReportBusy(true);
    setReportError("");
    try { setReport(await api<PortfolioReport>("/api/reports/portfolio?renewalWindowDays=90")); }
    catch (error) { setReportError(error instanceof Error ? error.message : "Portfolio insights could not be loaded."); }
    finally { setReportBusy(false); }
  }

  const loadWork = useCallback(async ({
    reset,
    selectedResource,
    query,
    cursor,
  }: {
    reset: boolean;
    selectedResource: WorkResource;
    query: string;
    cursor?: string | null;
  }) => {
    const requestId = ++workRequestRef.current;
    setWorkBusy(true);
    setWorkError("");
    try {
      const params = new URLSearchParams({ resource: selectedResource, limit: "12", sort: workSort[selectedResource] });
      if (query.trim()) params.set("q", query.trim());
      if (!reset && cursor) params.set("cursor", cursor);
      const payload = await api<WorkPayload>(`/api/work-items?${params}`);
      if (requestId !== workRequestRef.current) return;
      setWork((current) => reset || !current ? payload : { ...payload, items: [...current.items, ...payload.items] });
    } catch (error) { if (requestId === workRequestRef.current) setWorkError(error instanceof Error ? error.message : "The work queue could not be loaded."); }
    finally { if (requestId === workRequestRef.current) setWorkBusy(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadReport(), 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { setWork(null); void loadWork({ reset: true, selectedResource: resource, query: "" }); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadWork, resource]);

  function selectWorkResource(nextResource: WorkResource) {
    if (resource === nextResource) {
      void loadWork({ reset: true, selectedResource: resource, query: workQuery });
      return;
    }
    workRequestRef.current += 1;
    setWork(null);
    setWorkQuery("");
    setResource(nextResource);
  }

  function handleWorkTabKey(event: ReactKeyboardEvent<HTMLButtonElement>, currentResource: WorkResource) {
    const currentIndex = workResources.findIndex((entry) => entry.id === currentResource);
    const nextIndex = event.key === "ArrowRight"
      ? (currentIndex + 1) % workResources.length
      : event.key === "ArrowLeft"
        ? (currentIndex - 1 + workResources.length) % workResources.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? workResources.length - 1
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    selectWorkResource(workResources[nextIndex].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']")[nextIndex]?.focus();
  }

  return <div className="page-pad enterprise-page portfolio-insights-page">
    <header className="enterprise-page-heading"><div><p>PORTFOLIO &amp; WORK</p><h1>Decisions first. Portfolio context right behind them.</h1><span>Live, workspace-scoped reporting and cursor-paged action queues. Counts stay blank until the server answers.</span></div><button type="button" onClick={() => { void loadReport(); void loadWork({ reset: true, selectedResource: resource, query: workQuery }); }}>↻ Refresh</button></header>

    <section className="enterprise-work-priority" aria-labelledby="work-queue-heading">
      <div className="enterprise-section-heading"><div><p>ACT NOW</p><h2 id="work-queue-heading">Workspace work queue</h2><span>Pages use insertion-fenced ordering in a live queue. Refresh after acting to see new or changed work.</span></div></div>
      <div className="enterprise-tabs" role="tablist" aria-label="Work queue type" aria-orientation="horizontal">{workResources.map((entry) => <button id={`work-queue-tab-${entry.id}`} key={entry.id} type="button" role="tab" aria-selected={resource === entry.id} aria-controls={`work-queue-panel-${entry.id}`} tabIndex={resource === entry.id ? 0 : -1} className={resource === entry.id ? "active" : ""} onClick={() => selectWorkResource(entry.id)} onKeyDown={(event) => handleWorkTabKey(event, entry.id)}><b>{entry.label}</b><small>{entry.description}</small></button>)}</div>
      {workResources.filter((entry) => entry.id !== resource).map((entry) => <div id={`work-queue-panel-${entry.id}`} key={entry.id} role="tabpanel" aria-labelledby={`work-queue-tab-${entry.id}`} hidden />)}
      <div id={`work-queue-panel-${resource}`} className="work-queue-panel" role="tabpanel" aria-labelledby={`work-queue-tab-${resource}`} tabIndex={0} aria-busy={workBusy}>
      <form className="enterprise-search-row" onSubmit={(event) => { event.preventDefault(); void loadWork({ reset: true, selectedResource: resource, query: workQuery }); }}><label><span>Search this queue</span><input value={workQuery} onChange={(event) => setWorkQuery(event.target.value)} placeholder="Contract, owner, role, or source…" /></label><button type="submit" disabled={workBusy}>Search</button></form>
      {workBusy && !work && <SurfaceState tone="loading" title="Loading actionable work" detail="The current workspace queue is being read with an insertion fence." />}
      {workError && <SurfaceState tone="error" title="Work queue unavailable" detail={workError} onRetry={() => void loadWork({ reset: true, selectedResource: resource, query: workQuery })} />}
      {work && !workError && <>
        <div className="queue-summary" aria-live="polite"><strong>{work.summary.totalMatched}{work.summary.totalMatchedCapped ? "+" : ""} matching item{work.summary.totalMatched === 1 ? "" : "s"}</strong><span>{work.summary.statusCounts.map((entry) => `${prettyStatus(entry.status)} ${entry.count}${entry.capped ? "+" : ""}`).join(" · ") || "Newest attributable activity"}</span></div>
        {work.items.length ? <div className="work-item-grid">{work.items.map((item) => <WorkItemCard key={item.id} item={item} resource={resource} onOpenAgreement={onOpenAgreement} />)}</div> : <SurfaceState title="This queue is clear" detail={workQuery.trim() ? "No work matches this search. Clear it or try a broader term." : "No matching work is recorded in the live workspace queue. Refresh after mutations."} />}
        {work.page.hasMore && <button className="enterprise-load-more" type="button" disabled={workBusy} onClick={() => void loadWork({ reset: false, selectedResource: resource, query: workQuery, cursor: work.page.nextCursor })}>{workBusy ? "Loading the next page…" : "Load more work"}</button>}
      </>}
      </div>
    </section>

    <section className="portfolio-report" aria-labelledby="portfolio-heading">
      <div className="enterprise-section-heading"><div><p>CONTEXT</p><h2 id="portfolio-heading">Portfolio insights</h2><span>Contract value is grouped by currency; Notice never combines currencies into a misleading total.</span></div>{report && <small>As of {report.asOfDate}</small>}</div>
      {reportBusy && !report && <SurfaceState tone="loading" title="Building portfolio insights" detail="Agreement and work totals are being calculated from durable records." />}
      {reportError && <SurfaceState tone="error" title="Portfolio report unavailable" detail={reportError} onRetry={() => void loadReport()} />}
      {report && !reportError && <>
        <div className="portfolio-kpis"><article><span>Contracts</span><strong>{report.portfolio.agreements}</strong><small>Live records in scope</small></article><article><span>Renewals</span><strong>{report.portfolio.renewals.count}</strong><small>Through {report.portfolio.renewals.through}</small></article><article className={report.work.approvals.overdue ? "risk" : ""}><span>Overdue approvals</span><strong>{report.work.approvals.overdue}</strong><small>{report.work.approvals.pending} pending total</small></article><article className={report.work.obligations.overdue ? "risk" : ""}><span>Overdue obligations</span><strong>{report.work.obligations.overdue}</strong><small>{report.work.obligations.open} open total</small></article></div>
        <div className="portfolio-breakdowns">
          <article><h3>Value by currency</h3>{report.portfolio.currencies.length ? <ul>{report.portfolio.currencies.map((entry) => <li key={entry.currencyCode}><span>{entry.currencyCode}<small>{entry.agreements} contract{entry.agreements === 1 ? "" : "s"}</small></span><b>{formatMinor(entry.valueMinor, entry.currencyCode)}</b></li>)}</ul> : <p>No contract values are recorded.</p>}</article>
          <article><h3>Lifecycle</h3>{report.portfolio.stages.length ? <ul>{report.portfolio.stages.map((entry) => <li key={entry.key}><span>{entry.key}</span><b>{entry.count}</b></li>)}</ul> : <p>No lifecycle records are in scope.</p>}</article>
          <article><h3>Risk record</h3>{report.portfolio.risks.length ? <ul>{report.portfolio.risks.map((entry) => <li key={entry.key}><span>{entry.key}</span><b>{entry.count}</b></li>)}</ul> : <p>No risk decisions are in scope.</p>}</article>
        </div>
      </>}
    </section>
  </div>;
}

type SearchResult = {
  agreement: { id: number; party: string };
  citation: { fragmentId: string; documentVersion: number; documentSha256: string; sourceTextSha256?: string; startOffset: number; endOffset: number; quote: string; quoteSha256: string };
};
type Proposal = {
  id: string;
  agreementId: number;
  targetType: string;
  targetField: string;
  proposedValue: unknown;
  confidencePpm: number;
  status: string;
  applicationStatus: string;
  blockerMessage: string | null;
  documentVersion: number;
  documentSha256: string;
  updatedAt: string;
};
type ProposalCitation = { id: string; proposalId: string; quote: string; documentVersion: number; documentSha256: string; sourceTextSha256: string; startOffset: number; endOffset: number; quoteSha256: string };
type IngestionBatch = { id: string; status: string; itemCount: number; acceptedCount: number; rejectedCount: number; blockerMessage: string | null; updatedAt: string };
type IngestionItem = { id: string; batchId: string; fileName: string; status: string; blockerMessage: string | null; size: number; updatedAt: string };

export function RepositoryIntelligenceWorkspace({ agreements, canReview, onOpenAgreement }: { agreements: AgreementLink[]; canReview: boolean; onOpenAgreement: (id: number) => void }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ results: SearchResult[]; page: { hasMore: boolean; nextCursor: string | null } } | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [citations, setCitations] = useState<ProposalCitation[]>([]);
  const [proposalBusy, setProposalBusy] = useState(true);
  const [proposalError, setProposalError] = useState("");
  const [reviewReason, setReviewReason] = useState<Record<string, string>>({});
  const [ingestion, setIngestion] = useState<{ batches: IngestionBatch[]; items: IngestionItem[] } | null>(null);
  const [ingestionBusy, setIngestionBusy] = useState(true);
  const [ingestionError, setIngestionError] = useState("");

  async function runSearch(cursor?: string | null) {
    if (query.trim().length < 2) { setSearchError("Enter at least two characters to search registered extractor fragments."); return; }
    setSearchBusy(true); setSearchError("");
    try {
      const params = new URLSearchParams({ q: query.trim(), limit: "20" });
      if (cursor) params.set("cursor", cursor);
      const payload = await api<{ results: SearchResult[]; page: { hasMore: boolean; nextCursor: string | null } }>(`/api/intelligence/search?${params}`);
      setSearch((current) => cursor && current ? { ...payload, results: [...current.results, ...payload.results] } : payload);
    } catch (error) { setSearchError(error instanceof Error ? error.message : "Repository search could not be completed."); }
    finally { setSearchBusy(false); }
  }

  async function loadProposals() {
    setProposalBusy(true); setProposalError("");
    try {
      const payload = await api<{ proposals: Proposal[]; citations: ProposalCitation[] }>("/api/intelligence/proposals?limit=50");
      setProposals(payload.proposals ?? []); setCitations(payload.citations ?? []);
    } catch (error) { setProposalError(error instanceof Error ? error.message : "Extraction proposals could not be loaded."); }
    finally { setProposalBusy(false); }
  }

  async function loadIngestion() {
    setIngestionBusy(true); setIngestionError("");
    try { setIngestion(await api<{ batches: IngestionBatch[]; items: IngestionItem[] }>("/api/intelligence/ingestion?limit=50")); }
    catch (error) { setIngestionError(error instanceof Error ? error.message : "Ingestion status could not be loaded."); }
    finally { setIngestionBusy(false); }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadProposals(); void loadIngestion(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function reviewProposal(proposal: Proposal, decision: "accept" | "reject") {
    const reason = reviewReason[proposal.id]?.trim() ?? "";
    if (reason.length < 3) { setProposalError("Add a short human review reason before recording a decision."); return; }
    setProposalBusy(true); setProposalError("");
    try {
      await api("/api/intelligence/proposals", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: proposal.id, decision, reason }) });
      await loadProposals();
    } catch (error) { setProposalError(error instanceof Error ? error.message : "The proposal decision could not be recorded."); setProposalBusy(false); }
  }

  return <div className="page-pad enterprise-page repository-page">
    <header className="enterprise-page-heading"><div><p>REPOSITORY INTELLIGENCE</p><h1>Find registered clause evidence. Verify every extracted fact.</h1><span>Extractor citations are pinned to a document version and hash with a caller-asserted source-text digest. Verify each quote against the protected working paper; no result applies itself.</span></div></header>
    <section className="repository-search-panel panel" aria-labelledby="repository-search-title">
      <div className="enterprise-section-heading"><div><p>REGISTERED CITATIONS</p><h2 id="repository-search-title">Search registered fragments</h2><span>Results carry claimed offsets and digests pinned to a document version/hash. Registration is evidence, not server verification of the source text.</span></div></div>
      <form className="repository-search-form" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}><label><span>Search contract language</span><input data-initial-focus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. limitation of liability" /></label><button className="primary-button" type="submit" disabled={searchBusy || query.trim().length < 2}>{searchBusy ? "Searching…" : "Search repository"}</button></form>
      {searchError && <SurfaceState tone="error" title="Search unavailable" detail={searchError} onRetry={query.trim().length >= 2 ? () => void runSearch() : undefined} />}
      {search && !searchError && (search.results.length ? <div className="citation-results">{search.results.map((result) => <article key={result.citation.fragmentId}><header><button type="button" onClick={() => onOpenAgreement(result.agreement.id)}>{result.agreement.party} →</button><span>Document v{result.citation.documentVersion}</span></header><blockquote>{result.citation.quote}</blockquote><p className="citation-verification">Verify this registered quote against the protected working paper before relying on it.</p><footer><span>Claimed offsets {result.citation.startOffset}–{result.citation.endOffset}</span><code title={result.citation.documentSha256}>Document {result.citation.documentSha256.slice(0, 12)}…</code>{result.citation.sourceTextSha256 && <code title={result.citation.sourceTextSha256}>Asserted source {result.citation.sourceTextSha256.slice(0, 12)}…</code>}<code title={result.citation.quoteSha256}>Quote {result.citation.quoteSha256.slice(0, 12)}…</code></footer></article>)}</div> : <SurfaceState title="No registered fragment matched" detail="Try a broader term. Only registered extractor fragments are searched; verify any result against its protected working paper." />)}
      {search?.page.hasMore && <button className="enterprise-load-more" type="button" disabled={searchBusy} onClick={() => void runSearch(search.page.nextCursor)}>{searchBusy ? "Loading…" : "Load more citations"}</button>}
    </section>

    <div className="repository-columns">
      <section className="panel proposal-review-panel" aria-labelledby="proposal-heading"><div className="enterprise-section-heading"><div><p>HUMAN REVIEW</p><h2 id="proposal-heading">Extraction proposals</h2><span>Review registered citations against the protected working paper. Acceptance records judgment but does not mutate the agreement.</span></div><button type="button" onClick={() => void loadProposals()}>↻</button></div>
        {proposalBusy && proposals.length === 0 && <SurfaceState tone="loading" title="Loading extraction proposals" detail="No zero count is shown until the review inbox responds." />}
        {proposalError && <SurfaceState tone="error" title="Proposal inbox unavailable" detail={proposalError} onRetry={() => void loadProposals()} />}
        {!proposalBusy && !proposalError && proposals.length === 0 && <SurfaceState title="No extraction proposals" detail="Proposals appear after an approved extractor registers citations against an immutable working-paper version." />}
        <div className="proposal-list">{proposals.map((proposal) => { const agreement = agreements.find((item) => item.id === proposal.agreementId); const proposalCitations = citations.filter((citation) => citation.proposalId === proposal.id); return <article key={proposal.id} className={`proposal-card ${proposal.status}`}><header><span className={`enterprise-status ${proposal.status}`}>{prettyStatus(proposal.status)}</span><b>{Math.round(proposal.confidencePpm / 10_000)}% confidence</b></header><h3>{prettyStatus(proposal.targetField)}</h3><p className="proposed-value">{compactValue(proposal.proposedValue)}</p><button className="proposal-agreement" type="button" onClick={() => onOpenAgreement(proposal.agreementId)}>{agreement?.party ?? `Contract ${proposal.agreementId}`} · working v{proposal.documentVersion} →</button>{proposalCitations.map((citation) => <div className="proposal-citation" key={citation.id}><blockquote>{citation.quote}</blockquote><span>Claimed offsets {citation.startOffset}–{citation.endOffset} · document v{citation.documentVersion}</span><div><code title={citation.documentSha256}>Document {citation.documentSha256.slice(0, 12)}…</code><code title={citation.sourceTextSha256}>Asserted source {citation.sourceTextSha256.slice(0, 12)}…</code><code title={citation.quoteSha256}>Quote {citation.quoteSha256.slice(0, 12)}…</code></div></div>)}{proposal.blockerMessage && <small>{proposal.blockerMessage}</small>}{proposal.status === "pending_review" && canReview && <div className="proposal-actions"><label><span>Review reason</span><input value={reviewReason[proposal.id] ?? ""} onChange={(event) => setReviewReason((current) => ({ ...current, [proposal.id]: event.target.value }))} placeholder="What did you verify?" /></label><button type="button" disabled={proposalBusy} onClick={() => void reviewProposal(proposal, "reject")}>Reject</button><button className="primary-button" type="button" disabled={proposalBusy} onClick={() => void reviewProposal(proposal, "accept")}>Accept as reviewed</button></div>}</article>; })}</div>
      </section>
      <aside className="panel ingestion-status-panel" aria-labelledby="ingestion-heading"><div className="enterprise-section-heading"><div><p>BOOKKEEPING</p><h2 id="ingestion-heading">Ingestion status</h2><span>Batches remain blocked until sources are uploaded, scanned, linked, extracted, and reviewed.</span></div><button type="button" onClick={() => void loadIngestion()}>↻</button></div>
        {ingestionBusy && !ingestion && <SurfaceState tone="loading" title="Loading ingestion status" detail="Batch receipts and blockers are being checked." />}
        {ingestionError && <SurfaceState tone="error" title="Ingestion status unavailable" detail={ingestionError} onRetry={() => void loadIngestion()} />}
        {ingestion && !ingestionError && ingestion.batches.length === 0 && <SurfaceState title="No ingestion batches" detail="Use governed document upload before registering bounded bulk-ingestion bookkeeping." />}
        <div className="ingestion-list">{ingestion?.batches.map((batch) => <article key={batch.id}><header><span className={`enterprise-status ${batch.status}`}>{prettyStatus(batch.status)}</span><small>{batch.itemCount} item{batch.itemCount === 1 ? "" : "s"}</small></header><p>{batch.blockerMessage ?? "Ready for the next governed step."}</p><div>{ingestion.items.filter((item) => item.batchId === batch.id).map((item) => <span key={item.id}><b>{item.fileName}</b><small>{prettyStatus(item.status)} · {Math.max(1, Math.round(item.size / 1024))} KB</small></span>)}</div></article>)}</div>
      </aside>
    </div>
    <section className="panel repository-playbook-note" aria-labelledby="repository-playbooks-heading"><div><p>GOVERNED POSITIONS</p><h2 id="repository-playbooks-heading">Clause playbooks</h2></div><p>Published positions are stored as immutable, independently reviewed versions in Enterprise setup. Repository review shows proposed facts with registered citations, asserted provenance, and a required working-paper verification step—never an automated legal decision.</p></section>
  </div>;
}

type IntakeField = { key: string; label: string; type: "text" | "number" | "date" | "boolean" | "single_select" | "multi_select"; required: boolean; options: string[] };
type IntakeForm = { id: string; version: number; name: string; description: string; formSchema: { fields: IntakeField[]; submitLabel?: string }; templateId: string | null; templateVersionId: string | null; workflowDefinitionId: string | null };
type IntakeSubmission = { id: string; formId: string; formVersion: number; templateVersionId: string | null; version: number; status: "draft" | "submitted" | "converted" | "rejected"; answers: Record<string, unknown>; agreementId: number | null; updatedAt: string };

function initialAnswers(form: IntakeForm): Record<string, unknown> {
  return Object.fromEntries(form.formSchema.fields.map((field) => [field.key, field.type === "boolean" ? false : field.type === "multi_select" ? [] : ""]));
}

function IntakeAnswerField({ field, value, disabled, onChange }: { field: IntakeField; value: unknown; disabled: boolean; onChange: (value: unknown) => void }) {
  if (field.type === "boolean") return <label className="intake-checkbox"><input type="checkbox" disabled={disabled} checked={value === true} onChange={(event) => onChange(event.target.checked)} /><span>{field.label}{field.required ? " *" : ""}</span></label>;
  if (field.type === "single_select") return <label><span>{field.label}{field.required ? " *" : ""}</span><select disabled={disabled} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}><option value="">Choose an option</option>{field.options.map((option) => <option key={option}>{option}</option>)}</select></label>;
  if (field.type === "multi_select") return <fieldset className="intake-multi" disabled={disabled}><legend>{field.label}{field.required ? " *" : ""}</legend>{field.options.map((option) => <label key={option}><input type="checkbox" checked={Array.isArray(value) && value.includes(option)} onChange={(event) => { const current = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []; onChange(event.target.checked ? [...current, option] : current.filter((entry) => entry !== option)); }} /><span>{option}</span></label>)}</fieldset>;
  return <label><span>{field.label}{field.required ? " *" : ""}</span><input disabled={disabled} type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"} value={String(value ?? "")} onChange={(event) => onChange(field.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)} /></label>;
}

export function IntakeWorkspace({ session, onOpenAgreement, onAgreementCreated }: { session: SessionSummary; onOpenAgreement: (id: number) => void; onAgreementCreated: () => Promise<void> | void }) {
  const canCreate = session.permissions.includes("agreement:create");
  const canReviewIntake = canCreate && (session.role === "legal" || session.role === "admin");
  const [forms, setForms] = useState<IntakeForm[]>([]);
  const [submissions, setSubmissions] = useState<IntakeSubmission[]>([]);
  const [reviewSubmissionIds, setReviewSubmissionIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activeFormId, setActiveFormId] = useState("");
  const [activeSubmissionId, setActiveSubmissionId] = useState("");
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [convert, setConvert] = useState({ party: "", side: "Sell-side", type: "Master Services Agreement", amount: "", currencyCode: "USD", department: "Legal", reason: "Reviewed submitted intake and configuration pins" });
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectConfirmed, setRejectConfirmed] = useState(false);
  const intakeRequestRef = useRef(0);

  const activeForm = forms.find((form) => form.id === activeFormId) ?? null;
  const activeSubmission = submissions.find((submission) => submission.id === activeSubmissionId) ?? null;
  const canConvert = canReviewIntake && reviewSubmissionIds.has(activeSubmissionId);

  const load = useCallback(async (preferredSubmissionId = "") => {
    const requestId = ++intakeRequestRef.current;
    setBusy(true); setError("");
    try {
      const [formPayload, submissionPayload, reviewPayload] = await Promise.all([
        api<{ intakeForms: IntakeForm[] }>("/api/intake/forms?limit=100"),
        api<{ intakeSubmissions: IntakeSubmission[] }>("/api/intake/submissions?limit=100"),
        canReviewIntake
          ? api<{ intakeSubmissions: IntakeSubmission[] }>("/api/intake/submissions?scope=review&status=submitted&limit=100")
          : Promise.resolve({ intakeSubmissions: [] }),
      ]);
      if (requestId !== intakeRequestRef.current) return;
      const reviewRows = reviewPayload.intakeSubmissions ?? [];
      const combined = [...new Map([...(submissionPayload.intakeSubmissions ?? []), ...reviewRows].map((item) => [item.id, item])).values()];
      setReviewSubmissionIds(new Set(reviewRows.map((item) => item.id)));
      setForms(formPayload.intakeForms ?? []); setSubmissions(combined);
      const current = combined.find((item) => item.id === preferredSubmissionId) ?? reviewRows[0] ?? combined.find((item) => item.status === "draft") ?? null;
      if (current) { setActiveSubmissionId(current.id); setActiveFormId(current.formId); setAnswers(current.answers ?? {}); }
      else if (formPayload.intakeForms?.[0]) { setActiveFormId(formPayload.intakeForms[0].id); setAnswers(initialAnswers(formPayload.intakeForms[0])); }
    } catch (caught) { if (requestId === intakeRequestRef.current) setError(caught instanceof Error ? caught.message : "Intake could not be loaded."); }
    finally { if (requestId === intakeRequestRef.current) { setBusy(false); setLoaded(true); } }
  }, [canReviewIntake]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function chooseForm(form: IntakeForm) {
    setActiveFormId(form.id); setActiveSubmissionId(""); setAnswers(initialAnswers(form)); setError("");
  }

  async function createDraft() {
    if (!activeForm) return;
    setBusy(true); setError("");
    try {
      const payload = await api<{ intakeSubmission: IntakeSubmission }>("/api/intake/submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ formId: activeForm.id, answers }) });
      setSubmissions((current) => [payload.intakeSubmission, ...current]); setActiveSubmissionId(payload.intakeSubmission.id); setAnswers(payload.intakeSubmission.answers);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The intake draft could not be created."); }
    finally { setBusy(false); }
  }

  async function saveSubmission(action: "update_draft" | "submit") {
    if (!activeSubmission) return;
    setBusy(true); setError("");
    try {
      const payload = await api<{ intakeSubmission: IntakeSubmission }>("/api/intake/submissions", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, id: activeSubmission.id, version: activeSubmission.version, answers, ...(action === "submit" ? { confirmed: true } : {}) }) });
      setSubmissions((current) => current.map((item) => item.id === payload.intakeSubmission.id ? payload.intakeSubmission : item));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The intake request could not be saved."); }
    finally { setBusy(false); }
  }

  async function convertSubmission() {
    if (!activeSubmission || activeSubmission.status !== "submitted" || !activeForm) return;
    if (!convert.party.trim()) { setError("Confirm a counterparty before converting the submitted request."); return; }
    setBusy(true); setError("");
    try {
      const amount = Number(convert.amount || 0);
      if (!Number.isFinite(amount) || amount < 0) throw new Error("Contract value must be zero or a positive number.");
      const valueMinor = Math.round(amount * (new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]).has(convert.currencyCode) ? 1 : new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]).has(convert.currencyCode) ? 1000 : 100));
      const payload = await api<{ conversion: { agreementId: number } }>(`/api/intake/submissions/${activeSubmission.id}/convert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        version: activeSubmission.version,
        formVersion: activeSubmission.formVersion,
        templateVersionId: activeSubmission.templateVersionId,
        workflowDefinitionId: activeForm.workflowDefinitionId,
        confirmed: true,
        reason: convert.reason,
        agreement: { party: convert.party.trim(), side: convert.side, type: convert.type.trim(), value: Math.round(amount), valueMinor, currencyCode: convert.currencyCode, ownerUserId: session.user.id, primaryCounterpartyId: null, legalEntityId: null, due: "Unscheduled", crm: "None", crmRecord: "", tags: ["Intake request"], department: convert.department, effectiveDate: "", expirationDate: "" },
      }) });
      await onAgreementCreated(); await load(); onOpenAgreement(payload.conversion.agreementId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The submitted intake could not be converted."); setBusy(false); }
  }

  async function rejectSubmission() {
    if (!activeSubmission || activeSubmission.status !== "submitted" || !canConvert) return;
    if (rejectReason.trim().length < 8 || !rejectConfirmed) {
      setError("Add an audit reason and confirm the rejection before continuing.");
      return;
    }
    setBusy(true); setError("");
    try {
      await api("/api/intake/submissions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reject", id: activeSubmission.id, version: activeSubmission.version, reason: rejectReason.trim(), confirmed: true }),
      });
      setRejectOpen(false); setRejectReason(""); setRejectConfirmed(false);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The submitted request could not be rejected.");
      setBusy(false);
    }
  }

  return <div className="page-pad enterprise-page intake-page">
    <header className="enterprise-page-heading"><div><p>REQUEST INTAKE</p><h1>Ask once. Keep the request, configuration, and contract linked.</h1><span>Published forms create owner-controlled drafts. Submission freezes the answers; conversion requires an explicit human confirmation of the exact form, template, and workflow pins.</span></div><button type="button" onClick={() => void load(activeSubmissionId)}>↻ Refresh</button></header>
    {!loaded && <SurfaceState tone="loading" title="Loading published intake" detail="Forms and your existing submissions are being read together." />}
    {error && <SurfaceState tone="error" title="Intake needs attention" detail={error} onRetry={() => void load(activeSubmissionId)} />}
    {loaded && !error && forms.length === 0 && <SurfaceState title="No published intake form" detail="An administrator must publish a structured form before requesters can start governed intake." />}
    {canReviewIntake && loaded && !error && <div className="intake-review-summary" role="status"><span>LEGAL REVIEW QUEUE</span><strong>{reviewSubmissionIds.size} submitted request{reviewSubmissionIds.size === 1 ? "" : "s"}</strong><p>Only requests returned by the workspace review scope expose conversion controls.</p></div>}
    {forms.length > 0 && <div className="intake-layout">
      <aside className="panel intake-form-list"><h2>Published forms</h2>{forms.map((form) => <button key={form.id} type="button" className={activeFormId === form.id ? "active" : ""} onClick={() => chooseForm(form)}><b>{form.name}</b><small>{form.description || `${form.formSchema.fields.length} structured fields`}</small><span>v{form.version}</span></button>)}</aside>
      <section className="panel intake-editor" aria-busy={busy}>{activeForm && <><header><div><span>{activeSubmission ? prettyStatus(activeSubmission.status) : "New request"}</span><h2>{activeForm.name}</h2><p>{activeForm.description || "Complete the published request fields."}</p></div>{activeSubmission && <small>Request v{activeSubmission.version} · form v{activeSubmission.formVersion}</small>}</header>
        {activeSubmission?.status === "converted" ? <SurfaceState title="Converted to a contract" detail="This submitted request is linked to its durable contract record." /> : activeSubmission?.status === "rejected" ? <SurfaceState title="Request rejected" detail="This immutable request remains in your history with its submitted answers and configuration pins." /> : <>
          <div className="intake-fields">{activeForm.formSchema.fields.map((field) => <IntakeAnswerField key={field.key} field={field} value={answers[field.key]} disabled={busy || activeSubmission?.status === "submitted"} onChange={(value) => setAnswers((current) => ({ ...current, [field.key]: value }))} />)}</div>
          {!activeSubmission && canCreate && <button className="primary-button intake-primary" type="button" disabled={busy} onClick={() => void createDraft()}>Save request draft</button>}
          {activeSubmission?.status === "draft" && <div className="intake-actions"><button type="button" disabled={busy} onClick={() => void saveSubmission("update_draft")}>Save draft</button><button className="primary-button" type="button" disabled={busy} onClick={() => void saveSubmission("submit")}>{activeForm.formSchema.submitLabel ?? "Submit for review"}</button></div>}
          {activeSubmission?.status === "submitted" && (canConvert ? <div className="intake-conversion"><div className="intake-pin-note"><span>✓</span><div><b>Submitted answers are immutable</b><p>The conversion below confirms form v{activeSubmission.formVersion}, {activeSubmission.templateVersionId ? "an exact governed template version" : "no governed template"}, and {activeForm.workflowDefinitionId ? "an exact workflow" : "the starter workflow"}.</p></div></div><h3>Create the reviewed contract record</h3><p className="intake-conversion-truth">The new contract starts in Intake. A template pin records governance but does not create working paper; add a source or create the working paper next.</p><div className="intake-convert-grid"><label><span>Counterparty *</span><input value={convert.party} onChange={(event) => setConvert((current) => ({ ...current, party: event.target.value }))} /></label><label><span>Direction</span><select value={convert.side} onChange={(event) => setConvert((current) => ({ ...current, side: event.target.value }))}><option value="Sell-side">Customer contract</option><option value="Buy-side">Supplier contract</option><option value="Corporate">Company contract</option></select></label><label><span>Contract type</span><input value={convert.type} onChange={(event) => setConvert((current) => ({ ...current, type: event.target.value }))} /></label><label><span>Value</span><div className="money-input"><select aria-label="Currency" value={convert.currencyCode} onChange={(event) => setConvert((current) => ({ ...current, currencyCode: event.target.value.toUpperCase() }))}>{["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF", "CNY", "INR", "BRL"].map((code) => <option key={code}>{code}</option>)}</select><input aria-label="Contract amount" inputMode="decimal" value={convert.amount} onChange={(event) => setConvert((current) => ({ ...current, amount: event.target.value }))} /></div></label><label><span>Department</span><input value={convert.department} onChange={(event) => setConvert((current) => ({ ...current, department: event.target.value }))} /></label><label className="full"><span>Conversion reason *</span><input value={convert.reason} onChange={(event) => setConvert((current) => ({ ...current, reason: event.target.value }))} /></label></div><button className="primary-button" type="button" disabled={busy || convert.party.trim().length === 0 || convert.reason.trim().length < 8} onClick={() => void convertSubmission()}>{busy ? "Creating contract…" : "Confirm pins & create contract"}</button></div> : <SurfaceState title="Submitted for legal review" detail="Your answers and exact configuration pins are frozen. A Legal or Admin member can confirm the submitted request and create its Intake-stage contract record." />)}
          {activeSubmission?.status === "submitted" && canConvert && <div className="intake-rejection">
            {!rejectOpen ? <button className="danger-link" type="button" disabled={busy} onClick={() => { setRejectOpen(true); setRejectReason(""); setRejectConfirmed(false); }}>Reject request…</button> : <div className="intake-rejection-review" role="group" aria-labelledby="intake-rejection-title">
              <div><b id="intake-rejection-title">Reject this submitted request</b><p>Rejection is immutable and removes the request from the legal review queue. The requester keeps the rejected record in their history.</p></div>
              <label><span>Rejection reason *</span><textarea rows={3} disabled={busy} value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} /></label>
              <label className="setup-check"><input type="checkbox" disabled={busy} checked={rejectConfirmed} onChange={(event) => setRejectConfirmed(event.target.checked)} /><span>I reviewed this exact request and confirm it should be rejected.</span></label>
              <div><button type="button" disabled={busy} onClick={() => { setRejectOpen(false); setRejectReason(""); setRejectConfirmed(false); }}>Cancel</button><button className="danger-button" type="button" disabled={busy || rejectReason.trim().length < 8 || !rejectConfirmed} onClick={() => void rejectSubmission()}>{busy ? "Rejecting…" : "Confirm rejection"}</button></div>
            </div>}
          </div>}
        </>}</>}</section>
      <aside className="panel intake-history"><h2>{canReviewIntake ? "Your requests & legal review" : "Your requests"}</h2>{submissions.length ? submissions.map((submission) => <article key={submission.id} className={activeSubmissionId === submission.id ? "active" : ""}><button type="button" className="intake-history-select" onClick={() => { setActiveSubmissionId(submission.id); setActiveFormId(submission.formId); setAnswers(submission.answers); setRejectOpen(false); }}><span className={`enterprise-status ${submission.status}`}>{reviewSubmissionIds.has(submission.id) ? "Legal review" : prettyStatus(submission.status)}</span><b>{forms.find((form) => form.id === submission.formId)?.name ?? "Published form"}</b><small>Updated {submission.updatedAt.slice(0, 10)}</small></button>{submission.agreementId && <button className="intake-history-contract" type="button" onClick={() => onOpenAgreement(submission.agreementId!)}>Open contract →</button>}</article>) : <p>{canReviewIntake ? "No owned drafts or submitted review work." : "No request drafts yet."}</p>}</aside>
    </div>}
  </div>;
}

type AgreementSavedView = {
  id: string;
  version: number;
  ownerUserId: string;
  name: string;
  filter: Record<string, unknown>;
  sort: Record<string, unknown>;
  shared: boolean;
};

export function AgreementSavedViewsBar({
  currentUserId,
  isAdmin,
  filters,
  onApply,
}: {
  currentUserId: string;
  isAdmin: boolean;
  filters: { side: string; stage: string; risk: string; query: string; sort: string };
  onApply: (filters: { side: string; stage: string; risk: string; query: string; sort: string }) => void;
}) {
  const [views, setViews] = useState<AgreementSavedView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AgreementSavedView | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);

  async function load() {
    setBusy(true); setError("");
    try {
      const payload = await api<{ savedViews: AgreementSavedView[] }>("/api/saved-views?resourceType=agreements&limit=100");
      setViews(payload.savedViews ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Saved views could not be loaded.");
    } finally {
      setBusy(false); setLoaded(true);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  function apply(view: AgreementSavedView) {
    const filter = view.filter ?? {};
    const savedSort = view.sort ?? {};
    onApply({
      side: typeof filter.side === "string" ? filter.side : "All",
      stage: typeof filter.stage === "string" ? filter.stage : "All",
      risk: typeof filter.risk === "string" ? filter.risk : "All",
      query: typeof filter.query === "string" ? filter.query : "",
      sort: typeof savedSort.field === "string" ? savedSort.field : "Updated",
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError("");
    try {
      await api("/api/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceType: "agreements",
          name: name.trim(),
          filter: { side: filters.side, stage: filters.stage, risk: filters.risk, query: filters.query },
          sort: { field: filters.sort },
          shared,
        }),
      });
      setName(""); setShared(false); setSaveOpen(false);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The current register view could not be saved.");
      setBusy(false);
    }
  }

  async function remove() {
    if (!pendingDelete || deleteReason.trim().length < 8 || !deleteConfirmed) return;
    setBusy(true); setError("");
    try {
      await api("/api/saved-views", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: pendingDelete.id, version: pendingDelete.version, reason: deleteReason.trim() }),
      });
      setPendingDelete(null); setDeleteReason(""); setDeleteConfirmed(false);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The saved view could not be removed.");
      setBusy(false);
    }
  }

  return <section className="saved-views-bar" aria-labelledby="saved-views-title" aria-busy={busy}>
    <div className="saved-views-heading"><div><b id="saved-views-title">Saved views</b><span>Reapply a named filter and sort without changing any contract.</span></div><button type="button" disabled={busy} onClick={() => setSaveOpen((current) => !current)}>{saveOpen ? "Cancel" : "Save current view"}</button></div>
    {!loaded && <span className="saved-view-state" role="status">Loading saved views…</span>}
    {error && <span className="saved-view-state error" role="alert">{error} <button type="button" onClick={() => void load()}>Retry</button></span>}
    {loaded && !error && <div className="saved-view-chips">{views.map((view) => <div key={view.id}><button type="button" disabled={busy} onClick={() => apply(view)}><b>{view.name}</b><small>{view.shared ? "Shared" : "Private"}</small></button>{(view.ownerUserId === currentUserId || isAdmin) && <button type="button" aria-label={`Remove saved view ${view.name}`} disabled={busy} onClick={() => { setPendingDelete(view); setDeleteReason(""); setDeleteConfirmed(false); }}>×</button>}</div>)}{views.length === 0 && <span>No saved register views yet.</span>}</div>}
    {saveOpen && <form className="saved-view-create" onSubmit={(event) => void save(event)}><label><span>View name *</span><input autoFocus value={name} maxLength={160} onChange={(event) => setName(event.target.value)} /></label><label><input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} /><span>Share with this workspace</span></label><button className="primary-button" type="submit" disabled={busy || !name.trim()}>Save filters &amp; sort</button></form>}
    {pendingDelete && <div className="saved-view-delete" role="group" aria-labelledby="saved-view-delete-title"><div><b id="saved-view-delete-title">Remove “{pendingDelete.name}”?</b><span>This deletes only the saved filter—not any contract.</span></div><label><span>Reason *</span><input value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} /></label><label><input type="checkbox" checked={deleteConfirmed} onChange={(event) => setDeleteConfirmed(event.target.checked)} /><span>I confirm this saved view should be removed.</span></label><div><button type="button" disabled={busy} onClick={() => setPendingDelete(null)}>Cancel</button><button className="danger-button" type="button" disabled={busy || deleteReason.trim().length < 8 || !deleteConfirmed} onClick={() => void remove()}>{busy ? "Removing…" : "Remove saved view"}</button></div></div>}
  </section>;
}

type AgreementCustomFieldDefinition = {
  id: string;
  version: number;
  key: string;
  label: string;
  description: string;
  dataType: "text" | "number" | "date" | "boolean" | "single_select" | "multi_select";
  options: string[];
  required: boolean;
  status: string;
};
type AgreementCustomFieldValue = { id: string; definitionId: string; valueJson: unknown; updatedAt: string };

function customFieldInitial(definition: AgreementCustomFieldDefinition, value: AgreementCustomFieldValue | undefined): unknown {
  if (value) return definition.dataType === "number" ? String(value.valueJson ?? "") : value.valueJson;
  if (definition.dataType === "boolean") return false;
  if (definition.dataType === "multi_select") return [];
  return "";
}

function CustomFieldControl({ definition, value, disabled, onChange }: { definition: AgreementCustomFieldDefinition; value: unknown; disabled: boolean; onChange: (value: unknown) => void }) {
  if (definition.dataType === "boolean") return <label className="custom-field-check"><input type="checkbox" disabled={disabled} checked={value === true} onChange={(event) => onChange(event.target.checked)} /><span>{definition.label}{definition.required ? " *" : ""}</span></label>;
  if (definition.dataType === "single_select") return <label><span>{definition.label}{definition.required ? " *" : ""}</span><select disabled={disabled} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}><option value="">Choose an option</option>{definition.options.map((option) => <option key={option}>{option}</option>)}</select></label>;
  if (definition.dataType === "multi_select") return <fieldset className="custom-field-options" disabled={disabled}><legend>{definition.label}{definition.required ? " *" : ""}</legend>{definition.options.map((option) => <label key={option}><input type="checkbox" checked={Array.isArray(value) && value.includes(option)} onChange={(event) => { const current = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; onChange(event.target.checked ? [...current, option] : current.filter((item) => item !== option)); }} /><span>{option}</span></label>)}</fieldset>;
  return <label><span>{definition.label}{definition.required ? " *" : ""}</span><input disabled={disabled} type={definition.dataType === "date" ? "date" : definition.dataType === "number" ? "number" : "text"} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />{definition.description && <small>{definition.description}</small>}</label>;
}

export function AgreementCustomFieldsPanel({ agreementId, canManage }: { agreementId: number; canManage: boolean }) {
  const [definitions, setDefinitions] = useState<AgreementCustomFieldDefinition[]>([]);
  const [values, setValues] = useState<AgreementCustomFieldValue[]>([]);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<AgreementCustomFieldDefinition | null>(null);
  const [removalReason, setRemovalReason] = useState("");
  const [removalConfirmed, setRemovalConfirmed] = useState(false);
  const customFieldRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++customFieldRequestRef.current;
    if (!canManage) { setLoaded(true); return; }
    setError("");
    try {
      const [definitionPayload, valuePayload] = await Promise.all([
        api<{ customFields: AgreementCustomFieldDefinition[] }>("/api/admin/configuration/custom-fields?resourceType=agreement&status=active&limit=200"),
        api<{ customFieldValues: AgreementCustomFieldValue[] }>(`/api/admin/configuration/custom-field-values?resourceType=agreement&resourceId=${agreementId}&limit=200`),
      ]);
      if (requestId !== customFieldRequestRef.current) return;
      const nextDefinitions = definitionPayload.customFields ?? [];
      const nextValues = valuePayload.customFieldValues ?? [];
      setDefinitions(nextDefinitions); setValues(nextValues);
      setDraft(Object.fromEntries(nextDefinitions.map((definition) => [definition.id, customFieldInitial(definition, nextValues.find((value) => value.definitionId === definition.id))])));
    } catch (caught) {
      if (requestId === customFieldRequestRef.current) setError(caught instanceof Error ? caught.message : "Custom contract fields could not be loaded.");
    } finally {
      if (requestId === customFieldRequestRef.current) { setLoaded(true); setBusyId(""); }
    }
  }, [agreementId, canManage]);

  useEffect(() => {
    const timer = window.setTimeout(() => { setLoaded(false); void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function save(definition: AgreementCustomFieldDefinition) {
    const current = values.find((value) => value.definitionId === definition.id);
    const entered = draft[definition.id];
    const value = definition.dataType === "number"
      ? String(entered ?? "").trim() === "" ? null : Number(entered)
      : ["date", "single_select"].includes(definition.dataType) && String(entered ?? "") === "" ? null : entered;
    setBusyId(definition.id); setError("");
    try {
      await api("/api/admin/configuration/custom-field-values", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definitionId: definition.id, definitionVersion: definition.version, resourceType: "agreement", resourceId: String(agreementId), value, expectedUpdatedAt: current?.updatedAt ?? null }),
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `“${definition.label}” could not be saved.`);
      setBusyId("");
    }
  }

  async function remove() {
    if (!pendingRemoval || removalReason.trim().length < 8 || !removalConfirmed) return;
    const current = values.find((value) => value.definitionId === pendingRemoval.id);
    if (!current) return;
    setBusyId(pendingRemoval.id); setError("");
    try {
      await api("/api/admin/configuration/custom-field-values", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definitionId: pendingRemoval.id, definitionVersion: pendingRemoval.version, resourceType: "agreement", resourceId: String(agreementId), expectedUpdatedAt: current.updatedAt, reason: removalReason.trim() }),
      });
      setPendingRemoval(null); setRemovalReason(""); setRemovalConfirmed(false);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `“${pendingRemoval.label}” could not be removed.`);
      setBusyId("");
    }
  }

  if (!canManage) return null;
  return <section className="panel agreement-custom-fields" aria-labelledby="agreement-custom-fields-title" aria-busy={Boolean(busyId)}>
    <div className="enterprise-section-heading"><div><p>STRUCTURED METADATA</p><h2 id="agreement-custom-fields-title">Custom contract fields</h2><span>Workspace-defined values are typed and version-checked; they do not rewrite working paper.</span></div><button type="button" disabled={Boolean(busyId)} onClick={() => void load()}>↻</button></div>
    {!loaded && <SurfaceState tone="loading" title="Loading custom fields" detail="Active definitions and this contract’s saved values are being read together." />}
    {error && <SurfaceState tone="error" title="Custom fields need attention" detail={error} onRetry={() => void load()} />}
    {loaded && !error && definitions.length === 0 && <SurfaceState title="No custom contract fields" detail="Create an agreement field definition in Enterprise setup to capture structured metadata here." />}
    {loaded && definitions.length > 0 && <div className="custom-field-grid">{definitions.map((definition) => { const current = values.find((value) => value.definitionId === definition.id); return <article key={definition.id}><CustomFieldControl definition={definition} value={draft[definition.id]} disabled={busyId === definition.id} onChange={(value) => setDraft((existing) => ({ ...existing, [definition.id]: value }))} /><div><small>{current ? `Saved ${current.updatedAt.slice(0, 10)} · definition v${definition.version}` : `Not set · definition v${definition.version}`}</small>{current && !definition.required && <button className="danger-link" type="button" disabled={Boolean(busyId)} onClick={() => { setPendingRemoval(definition); setRemovalReason(""); setRemovalConfirmed(false); }}>Remove…</button>}<button type="button" disabled={Boolean(busyId)} onClick={() => void save(definition)}>{busyId === definition.id ? "Saving…" : current ? "Update value" : "Set value"}</button></div></article>; })}</div>}
    {pendingRemoval && <div className="custom-field-removal" role="group" aria-labelledby="custom-field-removal-title"><div><b id="custom-field-removal-title">Remove “{pendingRemoval.label}”?</b><span>The field definition remains available; only this contract’s value is removed.</span></div><label><span>Reason *</span><input value={removalReason} onChange={(event) => setRemovalReason(event.target.value)} /></label><label><input type="checkbox" checked={removalConfirmed} onChange={(event) => setRemovalConfirmed(event.target.checked)} /><span>I confirm this contract value should be removed.</span></label><div><button type="button" disabled={Boolean(busyId)} onClick={() => setPendingRemoval(null)}>Cancel</button><button className="danger-button" type="button" disabled={Boolean(busyId) || removalReason.trim().length < 8 || !removalConfirmed} onClick={() => void remove()}>{busyId ? "Removing…" : "Remove value"}</button></div></div>}
  </section>;
}

type PartyOption = { id: string; displayName: string; legalName?: string; status?: string };
type AgreementParty = { id: string; role: string; targetType: "legal_entity" | "counterparty"; primary: boolean; target: PartyOption | null };
type AgreementRelationship = { id: string; relationshipType: string; direction: "inbound" | "outbound"; sourceAgreement: AgreementLink | null; targetAgreement: AgreementLink | null };

export function AgreementRelationshipsPanel({
  agreementId,
  agreements,
  legalEntities,
  counterparties,
  canEdit,
  evaluationSample = false,
}: {
  agreementId: number;
  agreements: AgreementLink[];
  legalEntities: PartyOption[];
  counterparties: PartyOption[];
  canEdit: boolean;
  evaluationSample?: boolean;
}) {
  const [payload, setPayload] = useState<{ parties: AgreementParty[]; relationships: AgreementRelationship[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [partyDraft, setPartyDraft] = useState({ role: "counterparty", targetType: "counterparty", targetId: "", primary: false });
  const [relationshipDraft, setRelationshipDraft] = useState({ targetAgreementId: 0, relationshipType: "related" });
  const [pendingRemoval, setPendingRemoval] = useState<{ kind: "party" | "relationship"; id: string; label: string } | null>(null);
  const [removalReason, setRemovalReason] = useState("");
  const [removalConfirmed, setRemovalConfirmed] = useState(false);
  const relationshipRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++relationshipRequestRef.current;
    setError("");
    if (evaluationSample) {
      setPayload(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const next = await api<{ parties: AgreementParty[]; relationships: AgreementRelationship[] }>(`/api/agreements/${agreementId}/relationships`);
      if (requestId === relationshipRequestRef.current) setPayload(next);
    }
    catch (caught) { if (requestId === relationshipRequestRef.current) setError(caught instanceof Error ? caught.message : "Parties and relationships could not be loaded."); }
    finally { if (requestId === relationshipRequestRef.current) setBusy(false); }
  }, [agreementId, evaluationSample]);
  useEffect(() => {
    const timer = window.setTimeout(() => { setPayload(null); void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const options = partyDraft.targetType === "legal_entity" ? legalEntities : counterparties;

  async function addParty(event: FormEvent) {
    event.preventDefault(); if (!partyDraft.targetId) return;
    setBusy(true); setError("");
    try { await api(`/api/agreements/${agreementId}/relationships`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "add_party", ...partyDraft }) }); setPartyDraft((current) => ({ ...current, targetId: "", primary: false })); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The party could not be linked."); setBusy(false); }
  }
  async function addRelationship(event: FormEvent) {
    event.preventDefault(); if (!relationshipDraft.targetAgreementId) return;
    setBusy(true); setError("");
    try { await api(`/api/agreements/${agreementId}/relationships`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "add_relationship", ...relationshipDraft }) }); setRelationshipDraft((current) => ({ ...current, targetAgreementId: 0 })); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The contract relationship could not be added."); setBusy(false); }
  }
  function requestRemoval(kind: "party" | "relationship", id: string, label: string) {
    setPendingRemoval({ kind, id, label });
    setRemovalReason("");
    setRemovalConfirmed(false);
  }
  async function remove() {
    if (!pendingRemoval || removalReason.trim().length < 8 || !removalConfirmed) return;
    setBusy(true); setError("");
    try { await api(`/api/agreements/${agreementId}/relationships`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: pendingRemoval.kind, id: pendingRemoval.id, reason: removalReason.trim() }) }); setPendingRemoval(null); setRemovalReason(""); setRemovalConfirmed(false); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The relationship could not be removed."); setBusy(false); }
  }

  return <section className="panel relationship-panel" aria-labelledby="relationship-panel-title" aria-busy={busy}><div className="enterprise-section-heading"><div><p>CONTRACT NETWORK</p><h2 id="relationship-panel-title">Parties &amp; related contracts</h2><span>Structured links supplement the primary counterparty and entity fields; they never rewrite working paper.</span></div>{!evaluationSample && <button type="button" onClick={() => void load()}>↻</button>}</div>
    {evaluationSample && <SurfaceState title="Evaluation relationship sample" detail="This browser-only contract has no durable party or related-contract records. Open or create a saved contract to review persisted relationship evidence." />}
    {busy && !payload && <SurfaceState tone="loading" title="Loading contract relationships" detail="Structured party and agreement links are being read." />}
    {error && <SurfaceState tone="error" title="Relationships need attention" detail={error} onRetry={() => void load()} />}
    {payload && <div className="relationship-columns"><div><h3>Parties</h3>{payload.parties.length ? <ul>{payload.parties.map((party) => <li key={party.id}><span><b>{party.target?.displayName ?? "Unavailable party"}</b><small>{prettyStatus(party.role)}{party.primary ? " · Primary" : ""}</small></span>{canEdit && <button type="button" disabled={busy || pendingRemoval !== null} onClick={() => requestRemoval("party", party.id, party.target?.displayName ?? "this party")}>Remove</button>}</li>)}</ul> : <p>No structured parties are linked.</p>}{canEdit && options.length > 0 && <form onSubmit={addParty}><label><span>Party kind</span><select value={partyDraft.targetType} onChange={(event) => { const targetType = event.target.value as "legal_entity" | "counterparty"; setPartyDraft({ role: targetType === "legal_entity" ? "our_entity" : "counterparty", targetType, targetId: "", primary: false }); }}><option value="counterparty">Counterparty</option><option value="legal_entity">Our entity</option></select></label><label><span>Role</span><select value={partyDraft.role} onChange={(event) => setPartyDraft((current) => ({ ...current, role: event.target.value }))}>{partyDraft.targetType === "legal_entity" ? <><option value="our_entity">Our entity</option><option value="affiliate">Affiliate</option><option value="guarantor">Guarantor</option><option value="other">Other</option></> : <><option value="counterparty">Counterparty</option><option value="affiliate">Affiliate</option><option value="guarantor">Guarantor</option><option value="other">Other</option></>}</select></label><label><span>Record</span><select value={partyDraft.targetId} onChange={(event) => setPartyDraft((current) => ({ ...current, targetId: event.target.value }))}><option value="">Select an active record</option>{options.filter((option) => option.status !== "inactive" && option.status !== "blocked").map((option) => <option key={option.id} value={option.id}>{option.displayName}</option>)}</select></label><label className="relationship-primary"><input type="checkbox" checked={partyDraft.primary} onChange={(event) => setPartyDraft((current) => ({ ...current, primary: event.target.checked }))} /><span>Primary for this role</span></label><button type="submit" disabled={busy || !partyDraft.targetId}>Add party</button></form>}</div>
      <div><h3>Related contracts</h3>{payload.relationships.length ? <ul>{payload.relationships.map((relationship) => { const related = relationship.direction === "outbound" ? relationship.targetAgreement : relationship.sourceAgreement; return <li key={relationship.id}><span><b>{related?.party ?? "Unavailable contract"}</b><small>{prettyStatus(relationship.relationshipType)} · {relationship.direction}</small></span>{canEdit && <button type="button" disabled={busy || pendingRemoval !== null} onClick={() => requestRemoval("relationship", relationship.id, related?.party ?? "this contract relationship")}>Remove</button>}</li>; })}</ul> : <p>No contract relationships are linked.</p>}{canEdit && <form onSubmit={addRelationship}><label><span>Related contract</span><select value={relationshipDraft.targetAgreementId || ""} onChange={(event) => setRelationshipDraft((current) => ({ ...current, targetAgreementId: Number(event.target.value) }))}><option value="">Select a contract</option>{agreements.filter((agreement) => agreement.id !== agreementId).map((agreement) => <option key={agreement.id} value={agreement.id}>{agreement.party} · {agreement.type}</option>)}</select></label><label><span>Relationship</span><select value={relationshipDraft.relationshipType} onChange={(event) => setRelationshipDraft((current) => ({ ...current, relationshipType: event.target.value }))}><option value="related">Related</option><option value="master">Master agreement</option><option value="order_under">Order under</option><option value="amends">Amends</option><option value="dpa_for">DPA for</option><option value="renews">Renews</option><option value="supersedes">Supersedes</option></select></label><button type="submit" disabled={busy || !relationshipDraft.targetAgreementId}>Add relationship</button></form>}</div></div>}
    {pendingRemoval && <div className="relationship-confirm" role="dialog" aria-modal="false" aria-labelledby="relationship-remove-title"><div><b id="relationship-remove-title">Remove {pendingRemoval.label}?</b><p>This removes the structured link, not the underlying party, contract, working paper, or audit evidence.</p></div><label><span>Reason *</span><input data-initial-focus value={removalReason} onChange={(event) => setRemovalReason(event.target.value)} placeholder="Why is this link no longer correct?" /></label><label className="relationship-confirm-check"><input type="checkbox" checked={removalConfirmed} onChange={(event) => setRemovalConfirmed(event.target.checked)} /><span>I reviewed the exact link and intend to remove it.</span></label><div><button type="button" disabled={busy} onClick={() => setPendingRemoval(null)}>Cancel</button><button className="danger-button" type="button" disabled={busy || removalReason.trim().length < 8 || !removalConfirmed} onClick={() => void remove()}>{busy ? "Removing…" : "Confirm removal"}</button></div></div>}
  </section>;
}
