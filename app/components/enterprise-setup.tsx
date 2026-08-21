"use client";

import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

export type EnterpriseSetupSection =
  | "readiness"
  | "entities"
  | "counterparties"
  | "groups"
  | "custom-fields"
  | "templates"
  | "workflows"
  | "authorities"
  | "intake-forms"
  | "playbooks"
  | "agents";

export type EnterpriseLegalEntity = { id: string; version: number; legalName: string; displayName: string; entityType: string; jurisdiction: string; defaultCurrencyCode: string; status: string };
export type EnterpriseCounterparty = { id: string; version: number; legalName: string; displayName: string; domain: string; jurisdiction: string; status: string };
export type EnterpriseGroup = { id: string; version: number; name: string; description: string; status: string; externalProvider?: string | null };
export type EnterpriseGroupMember = { groupId: string; userId: string; source: string; displayName?: string; email?: string };
export type EnterpriseCustomField = { id: string; version: number; resourceType: string; key: string; label: string; description: string; dataType: string; options: string[]; required: boolean; status: string };
export type EnterpriseTemplate = { id: string; version: number; name: string; description: string; agreementType: string; side: "Sell-side" | "Buy-side" | "Corporate"; status: string; currentPublishedVersion: number | null; createdByUserId: string };
export type EnterpriseTemplateVersion = { id: string; templateId: string; version: number; status: string; body: string; variableSchema: { version?: number; variables?: Record<string, { type: string; source: string; required: boolean; maxLength: number }> }; contentSha256: string; changeSummary: string; createdByUserId: string };
export type EnterpriseWorkflow = { id: string; version: number; name: string; description: string; status: string; definition: { schemaVersion?: string; approvalLanes?: Array<{ lane: string; when?: Record<string, unknown> }> }; definitionSha256: string; createdByUserId: string };
export type EnterpriseAuthority = { id: string; version: number; lane: string; subjectType: "user" | "group"; subjectId: string; currencyCode: string; amountLimitMinor: number | null; status: string; reason: string };
export type EnterpriseIntakeForm = { id: string; version: number; name: string; description: string; status: string; formSchema: { fields?: Array<{ key: string; label: string; type: string; required: boolean; options: string[] }>; submitLabel?: string }; templateId: string | null; templateVersionId: string | null; workflowDefinitionId: string | null; createdByUserId: string };
export type EnterprisePlaybook = { id: string; version: number; name: string; description: string; status: string; currentPublishedVersion: number | null; scope: { agreementTypes?: string[]; sides?: string[]; jurisdictions?: string[] }; createdByUserId: string };
export type EnterprisePlaybookVersion = { id: string; playbookId: string; version: number; status: string; rules: { clauses?: Array<{ key: string; title: string; category: string; position: string; preferredText: string; alternatives: string[]; reviewGuidance: string; risk: string }> }; contentSha256: string; changeSummary: string; createdByUserId: string };
export type EnterpriseMember = { userId: string; displayName: string; email?: string; role: string; membershipStatus?: string };

type ConfigState = {
  legalEntities: EnterpriseLegalEntity[];
  counterparties: EnterpriseCounterparty[];
  groups: EnterpriseGroup[];
  groupMembers: EnterpriseGroupMember[];
  customFields: EnterpriseCustomField[];
  templates: EnterpriseTemplate[];
  templateVersions: EnterpriseTemplateVersion[];
  workflows: EnterpriseWorkflow[];
  authorities: EnterpriseAuthority[];
  intakeForms: EnterpriseIntakeForm[];
  playbooks: EnterprisePlaybook[];
  playbookVersions: EnterprisePlaybookVersion[];
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

const sections: Array<{ id: EnterpriseSetupSection; label: string; short: string }> = [
  { id: "readiness", label: "Readiness", short: "Deployment & providers" },
  { id: "entities", label: "Entities", short: "Our legal parties" },
  { id: "counterparties", label: "Counterparties", short: "External parties" },
  { id: "groups", label: "Groups", short: "People & teams" },
  { id: "custom-fields", label: "Custom fields", short: "Structured metadata" },
  { id: "templates", label: "Templates", short: "Governed paper" },
  { id: "workflows", label: "Workflows", short: "Approval policy" },
  { id: "authorities", label: "Authorities", short: "Who may decide" },
  { id: "intake-forms", label: "Intake forms", short: "Published requests" },
  { id: "playbooks", label: "Playbooks", short: "Clause positions" },
  { id: "agents", label: "Agent governance", short: "Identity & grants" },
];

const blank: ConfigState = {
  legalEntities: [], counterparties: [], groups: [], groupMembers: [], customFields: [], templates: [], templateVersions: [], workflows: [], authorities: [], intakeForms: [], playbooks: [], playbookVersions: [],
};

function statusLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function SetupState({ busy, error, onRetry }: { busy: boolean; error: string; onRetry: () => void }) {
  if (busy) return <div className="setup-state loading" role="status"><span>◌</span><div><b>Loading this setup section</b><p>Notice is reading the current governed records.</p></div></div>;
  if (error) return <div className="setup-state error" role="alert"><span>!</span><div><b>This setup section could not load</b><p>{error}</p></div><button type="button" onClick={onRetry}>Retry</button></div>;
  return null;
}

function EmptyConfig({ children }: { children: string }) {
  return <div className="setup-empty"><span>◇</span><p>{children}</p></div>;
}

function LifecycleButtons({
  status,
  busy,
  canPublish = true,
  onPublish,
  onRetire,
  onAddVersion,
}: {
  status: string;
  busy: boolean;
  canPublish?: boolean;
  onPublish?: () => void;
  onRetire?: () => void;
  onAddVersion?: () => void;
}) {
  return <div className="lifecycle-buttons">{onAddVersion && <button type="button" disabled={busy} onClick={onAddVersion}>Draft next version</button>}{status === "draft" && onPublish && <button type="button" disabled={busy || !canPublish} title={!canPublish ? "A different administrator must publish this draft." : undefined} onClick={onPublish}>{canPublish ? "Publish" : "Second admin required"}</button>}{status === "published" && onRetire && <button className="danger-link" type="button" disabled={busy} onClick={onRetire}>Retire</button>}</div>;
}

function extractTemplateVariables(body: string, customInputs: string[]) {
  const system = new Set(["organization"]);
  const agreement = new Set(["party", "side", "type", "effectiveDate", "expirationDate", "governingLaw", "due", "department", "currencyCode"]);
  const placeholders = [...new Set([...body.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g)].map((match) => match[1]))];
  const inputNames = new Set(customInputs.map((entry) => entry.trim()).filter(Boolean));
  return {
    version: 1,
    variables: Object.fromEntries(placeholders.map((name) => [name, {
      type: "string",
      source: system.has(name) ? "system" : agreement.has(name) ? "agreement" : "input",
      required: true,
      maxLength: name === "party" || inputNames.has(name) ? 500 : 200,
    }])),
  };
}

function currencyDigits(code: string) {
  if (new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]).has(code)) return 0;
  if (new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]).has(code)) return 3;
  return 2;
}

export function EnterpriseSetupCenter({
  section,
  onSectionChange,
  userId,
  members,
  onConfigurationChanged,
}: {
  section: EnterpriseSetupSection;
  onSectionChange: (section: EnterpriseSetupSection) => void;
  userId: string;
  members: EnterpriseMember[];
  onConfigurationChanged?: () => Promise<void> | void;
}) {
  const [config, setConfig] = useState<ConfigState>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [docuseal, setDocuseal] = useState<{ configured: boolean; detail?: string; lastTest?: { status: string; testedAt: string; detail: string } | null } | null>(null);
  const [entityDraft, setEntityDraft] = useState({ legalName: "", displayName: "", jurisdiction: "", currency: "USD" });
  const [counterpartyDraft, setCounterpartyDraft] = useState({ legalName: "", displayName: "", domain: "", jurisdiction: "" });
  const [groupDraft, setGroupDraft] = useState({ name: "", description: "" });
  const [groupMemberDraft, setGroupMemberDraft] = useState<Record<string, string>>({});
  const [fieldDraft, setFieldDraft] = useState({ resourceType: "agreement", key: "", label: "", dataType: "text", required: false, options: "" });
  const [templateDraft, setTemplateDraft] = useState({ name: "", description: "", agreementType: "Master Services Agreement", side: "Sell-side" as EnterpriseTemplate["side"], body: "{{type}}\n\nThis agreement is between {{organization}} and {{party}}.\n\nEffective date: {{effectiveDate}}\nGoverning law: {{governingLaw}}", customInputs: "", changeSummary: "Initial governed template version" });
  const [templateRevisionId, setTemplateRevisionId] = useState("");
  const templateCreationAttempt = useRef<{ requestJson: string; idempotencyKey: string } | null>(null);
  const [workflowDraft, setWorkflowDraft] = useState({ name: "", description: "", unconditionalLane: "Legal", conditionalLane: "Finance", currencyCode: "USD", minimumAmount: "100000" });
  const [authorityDraft, setAuthorityDraft] = useState({ lane: "Legal", subjectType: "user" as "user" | "group", subjectId: "", currencyCode: "USD", amountLimit: "", reason: "Approved authority assignment for this lane" });
  const [formDraft, setFormDraft] = useState({ name: "", description: "", templateId: "", workflowId: "", submitLabel: "Submit for legal review", fields: [{ key: "counterparty", label: "Counterparty", type: "text", required: true, options: "" }] });
  const [playbookDraft, setPlaybookDraft] = useState({ name: "", description: "", agreementType: "Master Services Agreement", side: "Sell-side", jurisdiction: "New York", ruleKey: "limitation_of_liability", ruleTitle: "Limitation of liability", category: "Risk", position: "preferred", preferredText: "Liability is capped at fees paid in the preceding twelve months.", alternatives: "", guidance: "Compare exclusions and the cap basis against the approved position.", risk: "high", changeSummary: "Initial governed clause position" });
  const [playbookRevisionId, setPlaybookRevisionId] = useState("");
  const playbookCreationAttempt = useRef<{ requestJson: string; idempotencyKey: string } | null>(null);
  const [pendingLifecycle, setPendingLifecycle] = useState<{
    title: string;
    detail: string;
    url: string;
    body: Record<string, unknown>;
    success: string;
    destructive: boolean;
  } | null>(null);
  const [lifecycleReason, setLifecycleReason] = useState("");
  const [lifecycleConfirmed, setLifecycleConfirmed] = useState(false);

  const activeSubjectOptions = authorityDraft.subjectType === "user"
    ? members.filter((member) => member.membershipStatus !== "disabled").map((member) => ({ id: member.userId, label: `${member.displayName} · ${member.role}` }))
    : config.groups.filter((group) => group.status === "active").map((group) => ({ id: group.id, label: group.name }));

  const loadSection = useCallback(async (target: EnterpriseSetupSection = section) => {
    setBusy(true); setError(""); setActionError(""); setNotice("");
    try {
      if (target === "readiness") {
        const payload = await api<{ integrations: Array<{ id: string; configured: boolean; detail?: string; lastTest?: { status: string; testedAt: string; detail: string } | null }> }>("/api/admin/integrations");
        setDocuseal(payload.integrations.find((entry) => entry.id === "docuseal") ?? null);
      } else if (target === "entities") {
        const payload = await api<{ legalEntities: EnterpriseLegalEntity[] }>("/api/admin/configuration/legal-entities?limit=200");
        setConfig((current) => ({ ...current, legalEntities: payload.legalEntities ?? [] }));
      } else if (target === "counterparties") {
        const payload = await api<{ counterparties: EnterpriseCounterparty[] }>("/api/admin/configuration/counterparties?limit=200");
        setConfig((current) => ({ ...current, counterparties: payload.counterparties ?? [] }));
      } else if (target === "groups") {
        const payload = await api<{ groups: EnterpriseGroup[]; members: EnterpriseGroupMember[] }>("/api/admin/configuration/groups?limit=200");
        setConfig((current) => ({ ...current, groups: payload.groups ?? [], groupMembers: payload.members ?? [] }));
      } else if (target === "custom-fields") {
        const payload = await api<{ customFields: EnterpriseCustomField[] }>("/api/admin/configuration/custom-fields?limit=200");
        setConfig((current) => ({ ...current, customFields: payload.customFields ?? [] }));
      } else if (target === "templates") {
        const payload = await api<{ templates: EnterpriseTemplate[]; versions: EnterpriseTemplateVersion[] }>("/api/admin/configuration/templates?limit=200");
        setConfig((current) => ({ ...current, templates: payload.templates ?? [], templateVersions: payload.versions ?? [] }));
      } else if (target === "workflows") {
        const payload = await api<{ workflows: EnterpriseWorkflow[] }>("/api/admin/configuration/workflows?limit=200");
        setConfig((current) => ({ ...current, workflows: payload.workflows ?? [] }));
      } else if (target === "authorities") {
        const [authorityPayload, groupPayload] = await Promise.all([
          api<{ approvalAuthorities: EnterpriseAuthority[] }>("/api/admin/configuration/approval-authorities?limit=200"),
          api<{ groups: EnterpriseGroup[]; members: EnterpriseGroupMember[] }>("/api/admin/configuration/groups?limit=200"),
        ]);
        setConfig((current) => ({ ...current, authorities: authorityPayload.approvalAuthorities ?? [], groups: groupPayload.groups ?? [], groupMembers: groupPayload.members ?? [] }));
      } else if (target === "intake-forms") {
        const [forms, templates, workflows] = await Promise.all([
          api<{ intakeForms: EnterpriseIntakeForm[] }>("/api/admin/configuration/intake-forms?limit=200"),
          api<{ templates: EnterpriseTemplate[]; versions: EnterpriseTemplateVersion[] }>("/api/admin/configuration/templates?limit=200"),
          api<{ workflows: EnterpriseWorkflow[] }>("/api/admin/configuration/workflows?limit=200"),
        ]);
        setConfig((current) => ({ ...current, intakeForms: forms.intakeForms ?? [], templates: templates.templates ?? [], templateVersions: templates.versions ?? [], workflows: workflows.workflows ?? [] }));
      } else if (target === "playbooks") {
        const payload = await api<{ playbooks: EnterprisePlaybook[] }>("/api/admin/configuration/playbooks?limit=100");
        const detailPayloads = await Promise.all((payload.playbooks ?? []).map((playbook) => api<{ versions: EnterprisePlaybookVersion[] }>(`/api/admin/configuration/playbooks?id=${encodeURIComponent(playbook.id)}&limit=100`)));
        setConfig((current) => ({ ...current, playbooks: payload.playbooks ?? [], playbookVersions: detailPayloads.flatMap((detail) => detail.versions ?? []) }));
      }
      return true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Setup data could not be loaded."); return false; }
    finally { setBusy(false); }
  }, [section]);

  useEffect(() => {
    if (section === "agents") return;
    const timer = window.setTimeout(() => void loadSection(section), 0);
    return () => window.clearTimeout(timer);
  }, [loadSection, section]);

  async function performMutation(url: string, method: "POST" | "PATCH", body: unknown, success: string) {
    setBusy(true); setActionError(""); setNotice("");
    try {
      await api(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const reloaded = await loadSection();
      if (reloaded) setNotice(success);
      await onConfigurationChanged?.();
    } catch (caught) { setActionError(caught instanceof Error ? caught.message : "The setup change could not be saved."); setBusy(false); }
  }

  async function mutate(url: string, method: "POST" | "PATCH", body: unknown, success: string) {
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const action = typeof record.action === "string" ? record.action : "change";
    if (method === "PATCH" && new Set(["publish", "publish_version", "retire", "retire_template", "retire_playbook", "revoke"]).has(action)) {
      const destructive = action === "retire" || action === "retire_template" || action === "retire_playbook" || action === "revoke";
      const noun = url.includes("templates") ? "governed template" : url.includes("workflows") ? "approval workflow" : url.includes("intake-forms") ? "intake form" : url.includes("playbooks") ? "clause playbook" : "approval authority";
      requestLifecycle({
        title: `${destructive ? action === "revoke" ? "Revoke" : "Retire" : "Publish"} this ${noun}?`,
        detail: destructive
          ? `This lifecycle change prevents future use of the selected ${noun}. Existing records and audit evidence remain durable.`
          : `Publication makes this exact ${noun} version available for future governed selection. It does not approve any contract or request.`,
        url,
        body: Object.fromEntries(Object.entries(record).filter(([key]) => key !== "confirmed" && key !== "reason")),
        success,
        destructive,
      });
      return;
    }
    await performMutation(url, method, body, success);
  }

  function requestLifecycle(input: NonNullable<typeof pendingLifecycle>) {
    setPendingLifecycle(input);
    setLifecycleReason("");
    setLifecycleConfirmed(false);
    setActionError("");
  }

  async function confirmLifecycle() {
    if (!pendingLifecycle || lifecycleReason.trim().length < 8 || !lifecycleConfirmed) return;
    const action = pendingLifecycle;
    setPendingLifecycle(null);
    await performMutation(action.url, "PATCH", { ...action.body, ...(action.url.includes("/playbooks") || action.url.includes("/groups") ? {} : { confirmed: true }), reason: lifecycleReason.trim() }, action.success);
    setLifecycleReason("");
    setLifecycleConfirmed(false);
  }

  async function addGroupMember(group: EnterpriseGroup) {
    const userId = groupMemberDraft[group.id];
    if (!userId) return;
    await mutate("/api/admin/configuration/groups", "POST", { action: "add_member", groupId: group.id, groupVersion: group.version, userId }, "Group member added with a version-checked update.");
    setGroupMemberDraft((current) => ({ ...current, [group.id]: "" }));
  }

  function requestGroupMemberRemoval(group: EnterpriseGroup, member: EnterpriseGroupMember) {
    requestLifecycle({
      title: `Remove ${member.displayName ?? "this person"} from ${group.name}?`,
      detail: "This changes approval-group membership for future eligibility. It does not erase prior decisions or audit evidence. SCIM-managed membership must be changed in the identity provider.",
      url: "/api/admin/configuration/groups",
      body: { action: "remove_member", groupId: group.id, groupVersion: group.version, userId: member.userId },
      success: "Group member removed with an attributable reason.",
      destructive: true,
    });
  }

  async function createTemplate(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setActionError(""); setNotice("");
    try {
      const revisionTarget = config.templates.find((template) => template.id === templateRevisionId);
      const customInputs = templateDraft.customInputs.split(",").map((entry) => entry.trim()).filter(Boolean);
      const versionMaterial = { body: templateDraft.body, variableSchema: extractTemplateVariables(templateDraft.body, customInputs), languageBlockIds: [], changeSummary: templateDraft.changeSummary };
      if (revisionTarget) {
        await api("/api/admin/configuration/templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create_version", templateId: revisionTarget.id, templateVersion: revisionTarget.version, ...versionMaterial }) });
      } else {
        const initialRequest = { action: "create_with_version", name: templateDraft.name, description: templateDraft.description, agreementType: templateDraft.agreementType, side: templateDraft.side, ...versionMaterial };
        const requestJson = JSON.stringify(initialRequest);
        if (templateCreationAttempt.current?.requestJson !== requestJson) {
          templateCreationAttempt.current = { requestJson, idempotencyKey: crypto.randomUUID() };
        }
        await api("/api/admin/configuration/templates", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": templateCreationAttempt.current.idempotencyKey },
          body: requestJson,
        });
        templateCreationAttempt.current = null;
      }
      setTemplateRevisionId("");
      setTemplateDraft((current) => ({ ...current, name: "", description: "", changeSummary: "Initial governed template version" }));
      const reloaded = await loadSection("templates");
      if (reloaded) setNotice(revisionTarget ? "New immutable draft version created. A different administrator must review and publish it." : "Draft template and immutable version created. A different administrator must review and publish it.");
      await onConfigurationChanged?.();
    } catch (caught) { setActionError(caught instanceof Error ? caught.message : "The governed template could not be created."); setBusy(false); }
  }

  function beginTemplateRevision(template: EnterpriseTemplate, versions: EnterpriseTemplateVersion[]) {
    const source = versions.find((version) => version.status === "published" && version.version === template.currentPublishedVersion) ?? versions[0];
    if (!source) { setActionError("Create the first template version before drafting a revision."); return; }
    const customInputs = Object.entries(source.variableSchema.variables ?? {}).filter(([, definition]) => definition.source === "input").map(([name]) => name).join(", ");
    setTemplateRevisionId(template.id);
    setTemplateDraft({ name: template.name, description: template.description, agreementType: template.agreementType, side: template.side, body: source.body, customInputs, changeSummary: `Revision after published v${template.currentPublishedVersion ?? source.version}` });
    setNotice(""); setActionError("");
  }

  async function createWorkflow(event: FormEvent) {
    event.preventDefault();
    const minimum = Number(workflowDraft.minimumAmount || 0);
    const definition = { schemaVersion: "1.0", approvalLanes: [
      { lane: workflowDraft.unconditionalLane },
      ...(workflowDraft.conditionalLane.trim() ? [{ lane: workflowDraft.conditionalLane.trim(), when: { currencyCodes: [workflowDraft.currencyCode], minimumValueMinor: Math.round(minimum * (10 ** currencyDigits(workflowDraft.currencyCode))) } }] : []),
    ] };
    await mutate("/api/admin/configuration/workflows", "POST", { name: workflowDraft.name, description: workflowDraft.description, definition }, "Draft workflow created. A different administrator must review and publish it.");
    setWorkflowDraft((current) => ({ ...current, name: "", description: "" }));
  }

  async function createIntakeForm(event: FormEvent) {
    event.preventDefault();
    const fields = formDraft.fields.map((field) => ({ key: field.key, label: field.label, type: field.type, required: field.required, options: field.type === "single_select" || field.type === "multi_select" ? field.options.split(",").map((entry) => entry.trim()).filter(Boolean) : [] }));
    await mutate("/api/admin/configuration/intake-forms", "POST", { name: formDraft.name, description: formDraft.description, formSchema: { fields, submitLabel: formDraft.submitLabel }, templateId: formDraft.templateId || null, workflowDefinitionId: formDraft.workflowId || null }, "Draft intake form created. A different administrator must review and publish it.");
    setFormDraft((current) => ({ ...current, name: "", description: "" }));
  }

  async function createPlaybook(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setActionError(""); setNotice("");
    try {
      const revisionTarget = config.playbooks.find((playbook) => playbook.id === playbookRevisionId);
      const versionMaterial = { rules: { clauses: [{ key: playbookDraft.ruleKey, title: playbookDraft.ruleTitle, category: playbookDraft.category, position: playbookDraft.position, preferredText: playbookDraft.preferredText, alternatives: playbookDraft.alternatives.split("\n").map((entry) => entry.trim()).filter(Boolean), reviewGuidance: playbookDraft.guidance, risk: playbookDraft.risk }] }, changeSummary: playbookDraft.changeSummary };
      if (revisionTarget) {
        await api("/api/admin/configuration/playbooks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create_version", playbookId: revisionTarget.id, playbookVersion: revisionTarget.version, ...versionMaterial }) });
      } else {
        const initialRequest = { action: "create_with_version", name: playbookDraft.name, description: playbookDraft.description, scope: { agreementTypes: playbookDraft.agreementType ? [playbookDraft.agreementType] : [], sides: playbookDraft.side ? [playbookDraft.side] : [], jurisdictions: playbookDraft.jurisdiction ? [playbookDraft.jurisdiction] : [] }, ...versionMaterial };
        const requestJson = JSON.stringify(initialRequest);
        if (playbookCreationAttempt.current?.requestJson !== requestJson) {
          playbookCreationAttempt.current = { requestJson, idempotencyKey: crypto.randomUUID() };
        }
        await api("/api/admin/configuration/playbooks", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": playbookCreationAttempt.current.idempotencyKey },
          body: requestJson,
        });
        playbookCreationAttempt.current = null;
      }
      setPlaybookRevisionId("");
      setPlaybookDraft((current) => ({ ...current, name: "", description: "", changeSummary: "Initial governed clause position" }));
      const reloaded = await loadSection("playbooks");
      if (reloaded) setNotice(revisionTarget ? "New immutable playbook version created. A different administrator must review and publish it." : "Draft playbook and immutable clause position created. A different administrator must review and publish it.");
      await onConfigurationChanged?.();
    } catch (caught) { setActionError(caught instanceof Error ? caught.message : "The governed playbook could not be created."); setBusy(false); }
  }

  function beginPlaybookRevision(playbook: EnterprisePlaybook, versions: EnterprisePlaybookVersion[]) {
    const source = versions.find((version) => version.status === "published" && version.version === playbook.currentPublishedVersion) ?? versions[0];
    const clause = source?.rules.clauses?.[0];
    if (!source || !clause) { setActionError("Create the first clause position before drafting a playbook revision."); return; }
    setPlaybookRevisionId(playbook.id);
    setPlaybookDraft({
      name: playbook.name,
      description: playbook.description,
      agreementType: playbook.scope.agreementTypes?.[0] ?? "",
      side: playbook.scope.sides?.[0] ?? "",
      jurisdiction: playbook.scope.jurisdictions?.[0] ?? "",
      ruleKey: clause.key,
      ruleTitle: clause.title,
      category: clause.category,
      position: clause.position,
      preferredText: clause.preferredText,
      alternatives: clause.alternatives.join("\n"),
      guidance: clause.reviewGuidance,
      risk: clause.risk,
      changeSummary: `Revision after published v${playbook.currentPublishedVersion ?? source.version}`,
    });
    setNotice(""); setActionError("");
  }

  function handleSectionTabKey(event: ReactKeyboardEvent<HTMLButtonElement>, currentSection: EnterpriseSetupSection) {
    const currentIndex = sections.findIndex((entry) => entry.id === currentSection);
    const nextIndex = event.key === "ArrowRight"
      ? (currentIndex + 1) % sections.length
      : event.key === "ArrowLeft"
        ? (currentIndex - 1 + sections.length) % sections.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? sections.length - 1
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextSection = sections[nextIndex];
    onSectionChange(nextSection.id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']")[nextIndex]?.focus();
  }

  const current = sections.find((entry) => entry.id === section)!;
  return <section className="enterprise-setup-center" aria-labelledby="enterprise-setup-title">
    <div className="setup-center-intro"><div><p>ENTERPRISE SETUP CENTER</p><h2 id="enterprise-setup-title">{current.label}</h2><span>{current.short}. Every change is workspace-scoped and audited by the server.</span></div></div>
    <div className="setup-tabs" role="tablist" aria-label="Enterprise setup sections" aria-orientation="horizontal">{sections.map((entry) => <button id={`enterprise-setup-tab-${entry.id}`} key={entry.id} role="tab" aria-selected={section === entry.id} aria-controls={`enterprise-setup-panel-${entry.id}`} tabIndex={section === entry.id ? 0 : -1} className={section === entry.id ? "active" : ""} type="button" onClick={() => onSectionChange(entry.id)} onKeyDown={(event) => handleSectionTabKey(event, entry.id)}><b>{entry.label}</b><small>{entry.short}</small></button>)}</div>
    {sections.filter((entry) => entry.id !== section).map((entry) => <div id={`enterprise-setup-panel-${entry.id}`} key={entry.id} role="tabpanel" aria-labelledby={`enterprise-setup-tab-${entry.id}`} hidden />)}
    <div id={`enterprise-setup-panel-${section}`} className="setup-tab-panel" role="tabpanel" aria-labelledby={`enterprise-setup-tab-${section}`} tabIndex={0} aria-busy={busy}>
    <SetupState busy={busy} error={error} onRetry={() => void loadSection()} />
    {actionError && <div className="setup-state error" role="alert"><span>!</span><div><b>This change was not saved</b><p>{actionError}</p></div><button type="button" onClick={() => setActionError("")}>Dismiss</button></div>}
    {notice && <div className="setup-notice" role="status"><span>✓</span>{notice}</div>}
    {section === "templates" && !busy && !error && config.templates.length > 0 && <div className="setup-version-picker"><label><span>Template task</span><select value={templateRevisionId} onChange={(event) => { const template = config.templates.find((item) => item.id === event.target.value); if (template) beginTemplateRevision(template, config.templateVersions.filter((version) => version.templateId === template.id)); else { setTemplateRevisionId(""); setTemplateDraft((current) => ({ ...current, name: "", description: "", changeSummary: "Initial governed template version" })); } }}><option value="">Create a new governed template</option>{config.templates.filter((template) => template.status !== "retired").map((template) => <option key={template.id} value={template.id}>Draft next version of {template.name}</option>)}</select></label><p>{templateRevisionId ? "The published body and variable inputs are copied into the editor. Only a new immutable body/variable version and change summary are created; template identity and scope stay unchanged." : "Create a new governed template identity and its first immutable draft version."}</p></div>}
    {section === "playbooks" && !busy && !error && config.playbooks.length > 0 && <div className="setup-version-picker"><label><span>Playbook task</span><select value={playbookRevisionId} onChange={(event) => { const playbook = config.playbooks.find((item) => item.id === event.target.value); if (playbook) beginPlaybookRevision(playbook, config.playbookVersions.filter((version) => version.playbookId === playbook.id)); else { setPlaybookRevisionId(""); setPlaybookDraft((current) => ({ ...current, name: "", description: "", changeSummary: "Initial governed clause position" })); } }}><option value="">Create a new clause playbook</option>{config.playbooks.filter((playbook) => playbook.status !== "retired").map((playbook) => <option key={playbook.id} value={playbook.id}>Draft next version of {playbook.name}</option>)}</select></label><p>{playbookRevisionId ? "The latest governed position is copied into the human-readable editor. Scope and playbook identity stay unchanged while a new immutable clause version is drafted." : "Create a new scoped playbook and its first immutable clause-position version."}</p></div>}

    {section === "readiness" && !busy && !error && <div className="docuseal-health-card"><div className="docuseal-health-mark">DS</div><div><p>LATEST DOCUSEAL COMPATIBILITY</p><h3>DocuSeal 3.2.1</h3><span>Governed REST contract 1.0.24 · the optional MCP live test invokes only read-only <code>load_template</code>; mutation tools stay blocked.</span></div><div className={`docuseal-health-status ${docuseal?.lastTest?.status === "passed" ? "ready" : "blocked"}`}><b>{docuseal?.lastTest?.status === "passed" ? "Live verified" : docuseal?.lastTest?.status === "failed" ? "Live test failed" : docuseal?.configured ? "Live test required" : "Configuration required"}</b><small>{docuseal?.lastTest ? `${statusLabel(docuseal.lastTest.status)} · ${docuseal.lastTest.testedAt.slice(0, 10)}` : docuseal?.detail ?? "Review provider readiness below."}</small></div></div>}

    {section === "entities" && !busy && !error && <div className="setup-split"><form className="setup-builder" onSubmit={(event) => { event.preventDefault(); void mutate("/api/admin/configuration/legal-entities", "POST", { legalName: entityDraft.legalName, displayName: entityDraft.displayName, entityType: "company", jurisdiction: entityDraft.jurisdiction, registrationNumber: "", defaultCurrencyCode: entityDraft.currency }, "Legal entity created."); setEntityDraft({ legalName: "", displayName: "", jurisdiction: "", currency: "USD" }); }}><h3>Add our legal entity</h3><label><span>Legal name *</span><input required value={entityDraft.legalName} onChange={(event) => setEntityDraft((current) => ({ ...current, legalName: event.target.value }))} /></label><label><span>Display name *</span><input required value={entityDraft.displayName} onChange={(event) => setEntityDraft((current) => ({ ...current, displayName: event.target.value }))} /></label><div className="setup-form-row"><label><span>Jurisdiction</span><input value={entityDraft.jurisdiction} onChange={(event) => setEntityDraft((current) => ({ ...current, jurisdiction: event.target.value }))} /></label><label><span>Default currency</span><input pattern="[A-Za-z]{3}" maxLength={3} value={entityDraft.currency} onChange={(event) => setEntityDraft((current) => ({ ...current, currency: event.target.value.toUpperCase() }))} /></label></div><button className="primary-button" type="submit" disabled={!entityDraft.legalName.trim() || !entityDraft.displayName.trim()}>Create entity</button></form><div className="setup-records"><h3>Entity readiness</h3>{config.legalEntities.length ? config.legalEntities.map((entity) => <article key={entity.id}><div><b>{entity.displayName}</b><small>{entity.legalName} · {entity.jurisdiction || "Jurisdiction not recorded"}</small></div><span className={`enterprise-status ${entity.status}`}>{statusLabel(entity.status)}</span><code>{entity.defaultCurrencyCode}</code></article>) : <EmptyConfig>Define at least one active company entity before using structured party links.</EmptyConfig>}</div></div>}

    {section === "counterparties" && !busy && !error && <div className="setup-split"><form className="setup-builder" onSubmit={(event) => { event.preventDefault(); void mutate("/api/admin/configuration/counterparties", "POST", { legalName: counterpartyDraft.legalName, displayName: counterpartyDraft.displayName, domain: counterpartyDraft.domain, jurisdiction: counterpartyDraft.jurisdiction, registrationNumber: "", externalId: "" }, "Counterparty created with duplicate protection."); setCounterpartyDraft({ legalName: "", displayName: "", domain: "", jurisdiction: "" }); }}><h3>Add a counterparty</h3><label><span>Legal name *</span><input required value={counterpartyDraft.legalName} onChange={(event) => setCounterpartyDraft((current) => ({ ...current, legalName: event.target.value }))} /></label><label><span>Display name *</span><input required value={counterpartyDraft.displayName} onChange={(event) => setCounterpartyDraft((current) => ({ ...current, displayName: event.target.value }))} /></label><label><span>Company domain</span><input value={counterpartyDraft.domain} onChange={(event) => setCounterpartyDraft((current) => ({ ...current, domain: event.target.value }))} placeholder="example.com" /></label><label><span>Jurisdiction</span><input value={counterpartyDraft.jurisdiction} onChange={(event) => setCounterpartyDraft((current) => ({ ...current, jurisdiction: event.target.value }))} /></label><button className="primary-button" type="submit" disabled={!counterpartyDraft.legalName.trim() || !counterpartyDraft.displayName.trim()}>Create counterparty</button></form><div className="setup-records"><h3>Counterparty directory</h3>{config.counterparties.length ? config.counterparties.map((party) => <article key={party.id}><div><b>{party.displayName}</b><small>{party.legalName} · {party.domain || "No domain"}</small></div><span className={`enterprise-status ${party.status}`}>{statusLabel(party.status)}</span></article>) : <EmptyConfig>No structured counterparties have been added.</EmptyConfig>}</div></div>}

    {section === "groups" && !busy && !error && <div className="setup-split"><form className="setup-builder" onSubmit={(event) => { event.preventDefault(); void mutate("/api/admin/configuration/groups", "POST", { action: "create_group", name: groupDraft.name, description: groupDraft.description }, "Workspace group created."); setGroupDraft({ name: "", description: "" }); }}><h3>Create an approval group</h3><label><span>Group name *</span><input value={groupDraft.name} onChange={(event) => setGroupDraft((current) => ({ ...current, name: event.target.value }))} /></label><label><span>Description</span><textarea rows={3} value={groupDraft.description} onChange={(event) => setGroupDraft((current) => ({ ...current, description: event.target.value }))} /></label><button className="primary-button" type="submit" disabled={!groupDraft.name.trim()}>Create group</button></form><div className="setup-records group-records"><h3>Groups &amp; membership</h3>{config.groups.length ? config.groups.map((group) => { const groupMembers = config.groupMembers.filter((member) => member.groupId === group.id); const availableMembers = members.filter((member) => member.membershipStatus !== "disabled" && !groupMembers.some((groupMember) => groupMember.userId === member.userId)); return <article key={group.id}><div className="group-record-copy"><div><b>{group.name}</b><small>{group.description || "No description"} · version {group.version}</small></div><ul>{groupMembers.length ? groupMembers.map((member) => <li key={member.userId}><span><b>{member.displayName ?? members.find((candidate) => candidate.userId === member.userId)?.displayName ?? "Unavailable member"}</b><small>{member.email ?? member.source}{member.source === "scim" ? " · managed by identity provider" : " · manual"}</small></span><button type="button" disabled={busy || member.source === "scim"} title={member.source === "scim" ? "Change this membership in the identity provider." : undefined} onClick={() => requestGroupMemberRemoval(group, member)}>Remove</button></li>) : <li className="group-empty-member">No members yet.</li>}</ul>{group.status === "active" && <div className="group-member-add"><select aria-label={`Add member to ${group.name}`} value={groupMemberDraft[group.id] ?? ""} onChange={(event) => setGroupMemberDraft((current) => ({ ...current, [group.id]: event.target.value }))}><option value="">Select an active workspace member</option>{availableMembers.map((member) => <option key={member.userId} value={member.userId}>{member.displayName} · {member.role}</option>)}</select><button type="button" disabled={busy || !groupMemberDraft[group.id]} onClick={() => void addGroupMember(group)}>Add member</button></div>}</div><span className={`enterprise-status ${group.status}`}>{statusLabel(group.status)}</span></article>; }) : <EmptyConfig>No approval or ownership groups are configured.</EmptyConfig>}</div></div>}

    {section === "custom-fields" && !busy && !error && <div className="setup-split"><form className="setup-builder" onSubmit={(event) => { event.preventDefault(); void mutate("/api/admin/configuration/custom-fields", "POST", { resourceType: fieldDraft.resourceType, key: fieldDraft.key, label: fieldDraft.label, description: "", dataType: fieldDraft.dataType, options: ["single_select", "multi_select"].includes(fieldDraft.dataType) ? fieldDraft.options.split(",").map((entry) => entry.trim()).filter(Boolean) : [], required: fieldDraft.required }, "Custom field definition created."); setFieldDraft((current) => ({ ...current, key: "", label: "" })); }}><h3>Define structured metadata</h3><div className="setup-form-row"><label><span>Resource</span><select value={fieldDraft.resourceType} onChange={(event) => setFieldDraft((current) => ({ ...current, resourceType: event.target.value }))}><option value="agreement">Agreement</option><option value="counterparty">Counterparty</option><option value="legal_entity">Legal entity</option></select></label><label><span>Data type</span><select value={fieldDraft.dataType} onChange={(event) => setFieldDraft((current) => ({ ...current, dataType: event.target.value }))}><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Yes / no</option><option value="single_select">Single select</option><option value="multi_select">Multi select</option></select></label></div><label><span>Key *</span><input pattern="[a-z][a-z0-9_]*" value={fieldDraft.key} onChange={(event) => setFieldDraft((current) => ({ ...current, key: event.target.value.toLowerCase().replaceAll(" ", "_") }))} placeholder="business_unit" /></label><label><span>Label *</span><input value={fieldDraft.label} onChange={(event) => setFieldDraft((current) => ({ ...current, label: event.target.value }))} /></label>{["single_select", "multi_select"].includes(fieldDraft.dataType) && <label><span>Options, comma separated *</span><input value={fieldDraft.options} onChange={(event) => setFieldDraft((current) => ({ ...current, options: event.target.value }))} /></label>}<label className="setup-check"><input type="checkbox" checked={fieldDraft.required} onChange={(event) => setFieldDraft((current) => ({ ...current, required: event.target.checked }))} /><span>Required where this definition is used</span></label><button className="primary-button" type="submit" disabled={!fieldDraft.key || !fieldDraft.label}>Create definition</button></form><div className="setup-records"><h3>Field definitions</h3>{config.customFields.length ? config.customFields.map((field) => <article key={field.id}><div><b>{field.label}</b><small>{field.resourceType} · {field.dataType} · {field.key}</small></div><span className={`enterprise-status ${field.status}`}>{statusLabel(field.status)}</span></article>) : <EmptyConfig>No custom field definitions are configured.</EmptyConfig>}</div></div>}

    {section === "templates" && !busy && !error && <div className="setup-split wide"><form className="setup-builder template-builder" onSubmit={(event) => void createTemplate(event)}><h3>{templateRevisionId ? "Draft the next governed version" : "Create governed paper"}</h3><div className="setup-form-row"><label><span>Template name *</span><input required disabled={Boolean(templateRevisionId)} value={templateDraft.name} onChange={(event) => setTemplateDraft((current) => ({ ...current, name: event.target.value }))} /></label><label><span>Direction</span><select disabled={Boolean(templateRevisionId)} value={templateDraft.side} onChange={(event) => setTemplateDraft((current) => ({ ...current, side: event.target.value as EnterpriseTemplate["side"] }))}><option value="Sell-side">Customer contract</option><option value="Buy-side">Supplier contract</option><option value="Corporate">Company contract</option></select></label></div><label><span>Agreement type *</span><input disabled={Boolean(templateRevisionId)} value={templateDraft.agreementType} onChange={(event) => setTemplateDraft((current) => ({ ...current, agreementType: event.target.value }))} /></label><label><span>Description</span><input disabled={Boolean(templateRevisionId)} value={templateDraft.description} onChange={(event) => setTemplateDraft((current) => ({ ...current, description: event.target.value }))} /></label><label><span>Template body *</span><textarea rows={10} value={templateDraft.body} onChange={(event) => setTemplateDraft((current) => ({ ...current, body: event.target.value }))} /></label><div className="builder-help"><b>Available governed variables</b><p><code>{"{{organization}}"}</code>, <code>{"{{party}}"}</code>, <code>{"{{type}}"}</code>, <code>{"{{effectiveDate}}"}</code>, <code>{"{{governingLaw}}"}</code>, <code>{"{{department}}"}</code>, and <code>{"{{currencyCode}}"}</code>. Other placeholders become human-supplied inputs.</p></div><label><span>Custom input names, comma separated</span><input value={templateDraft.customInputs} onChange={(event) => setTemplateDraft((current) => ({ ...current, customInputs: event.target.value }))} placeholder="serviceDescription, noticeAddress" /></label><label><span>Change summary *</span><input required minLength={3} value={templateDraft.changeSummary} onChange={(event) => setTemplateDraft((current) => ({ ...current, changeSummary: event.target.value }))} /></label><button className="primary-button" type="submit" disabled={!templateDraft.name.trim() || !templateDraft.body.trim() || templateDraft.changeSummary.trim().length < 3}>{templateRevisionId ? "Create next immutable version" : "Create draft & version"}</button></form><div className="setup-records lifecycle-records"><h3>Governed templates</h3>{config.templates.length ? config.templates.map((template) => { const versions = config.templateVersions.filter((version) => version.templateId === template.id); const publishable = versions.find((version) => version.status === "draft" && version.version > (template.currentPublishedVersion ?? 0)); return <article key={template.id}><div><b>{template.name}</b><small>{template.agreementType} · {template.side} · {versions.length} version(s)</small>{publishable && <code>Draft v{publishable.version} · {publishable.contentSha256.slice(0, 12)}…</code>}</div><span className={`enterprise-status ${template.status}`}>{statusLabel(template.status)}</span><LifecycleButtons status={publishable ? "draft" : template.status} busy={busy} canPublish={publishable?.createdByUserId !== userId} onPublish={publishable ? () => void mutate("/api/admin/configuration/templates", "PATCH", { action: "publish_version", templateId: template.id, templateVersion: template.version, versionId: publishable.id, confirmed: true, reason: "Independent administrator reviewed the exact template body and digest" }, "Governed template version published.") : undefined} onRetire={() => void mutate("/api/admin/configuration/templates", "PATCH", { action: "retire_template", templateId: template.id, templateVersion: template.version, confirmed: true, reason: "Template retired after governed lifecycle review" }, "Governed template retired.")} /></article>; }) : <EmptyConfig>No governed templates exist. Starter templates remain available but carry no company approval.</EmptyConfig>}</div></div>}

    {section === "workflows" && !busy && !error && <div className="setup-split"><form className="setup-builder workflow-builder" onSubmit={(event) => void createWorkflow(event)}><h3>Build an approval workflow</h3><label><span>Workflow name *</span><input value={workflowDraft.name} onChange={(event) => setWorkflowDraft((current) => ({ ...current, name: event.target.value }))} /></label><label><span>Description</span><input value={workflowDraft.description} onChange={(event) => setWorkflowDraft((current) => ({ ...current, description: event.target.value }))} /></label><div className="workflow-lane-builder"><span>1</span><div><label><span>Always-required lane *</span><input value={workflowDraft.unconditionalLane} onChange={(event) => setWorkflowDraft((current) => ({ ...current, unconditionalLane: event.target.value }))} /></label><small>This unconditional lane keeps every contract on a human review path.</small></div></div><div className="workflow-lane-builder conditional"><span>2</span><div><label><span>Conditional lane</span><input value={workflowDraft.conditionalLane} onChange={(event) => setWorkflowDraft((current) => ({ ...current, conditionalLane: event.target.value }))} /></label><div className="setup-form-row"><label><span>Currency</span><input maxLength={3} value={workflowDraft.currencyCode} onChange={(event) => setWorkflowDraft((current) => ({ ...current, currencyCode: event.target.value.toUpperCase() }))} /></label><label><span>Minimum amount</span><input inputMode="decimal" value={workflowDraft.minimumAmount} onChange={(event) => setWorkflowDraft((current) => ({ ...current, minimumAmount: event.target.value }))} /></label></div><small>Both conditions must match before this lane is added.</small></div></div><button className="primary-button" type="submit" disabled={!workflowDraft.name.trim() || !workflowDraft.unconditionalLane.trim()}>Create draft workflow</button></form><div className="setup-records lifecycle-records"><h3>Workflow definitions</h3>{config.workflows.length ? config.workflows.map((workflow) => <article key={workflow.id}><div><b>{workflow.name}</b><small>{(workflow.definition.approvalLanes ?? []).map((lane) => lane.when ? `${lane.lane} when matched` : `${lane.lane} always`).join(" · ")}</small><code>{workflow.definitionSha256.slice(0, 16)}…</code></div><span className={`enterprise-status ${workflow.status}`}>{statusLabel(workflow.status)}</span><LifecycleButtons status={workflow.status} busy={busy} canPublish={workflow.createdByUserId !== userId} onPublish={() => void mutate("/api/admin/configuration/workflows", "PATCH", { action: "publish", id: workflow.id, version: workflow.version, confirmed: true, reason: "Independent administrator reviewed every lane and condition" }, "Workflow published.")} onRetire={() => void mutate("/api/admin/configuration/workflows", "PATCH", { action: "retire", id: workflow.id, version: workflow.version, confirmed: true, reason: "Workflow retired after governed lifecycle review" }, "Workflow retired.")} /></article>) : <EmptyConfig>No governed workflows exist. Agreements use the starter approval policy until one is published and selected.</EmptyConfig>}</div></div>}

    {section === "authorities" && !busy && !error && <div className="setup-split"><form className="setup-builder" onSubmit={(event) => { event.preventDefault(); const amount = authorityDraft.amountLimit.trim() ? Math.round(Number(authorityDraft.amountLimit) * (10 ** currencyDigits(authorityDraft.currencyCode))) : null; void mutate("/api/admin/configuration/approval-authorities", "POST", { lane: authorityDraft.lane, subjectType: authorityDraft.subjectType, subjectId: authorityDraft.subjectId, currencyCode: authorityDraft.currencyCode, amountLimitMinor: amount, confirmed: true, reason: authorityDraft.reason }, "Approval authority granted."); }}><h3>Grant lane authority</h3><div className="setup-form-row"><label><span>Approval lane *</span><input value={authorityDraft.lane} onChange={(event) => setAuthorityDraft((current) => ({ ...current, lane: event.target.value }))} /></label><label><span>Subject type</span><select value={authorityDraft.subjectType} onChange={(event) => setAuthorityDraft((current) => ({ ...current, subjectType: event.target.value as "user" | "group", subjectId: "" }))}><option value="user">Person</option><option value="group">Group</option></select></label></div><label><span>Authorized subject *</span><select value={authorityDraft.subjectId} onChange={(event) => setAuthorityDraft((current) => ({ ...current, subjectId: event.target.value }))}><option value="">Select an active {authorityDraft.subjectType}</option>{activeSubjectOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label><div className="setup-form-row"><label><span>Currency</span><input maxLength={3} value={authorityDraft.currencyCode} onChange={(event) => setAuthorityDraft((current) => ({ ...current, currencyCode: event.target.value.toUpperCase() }))} /></label><label><span>Amount limit (blank = unlimited)</span><input inputMode="decimal" value={authorityDraft.amountLimit} onChange={(event) => setAuthorityDraft((current) => ({ ...current, amountLimit: event.target.value }))} /></label></div><label><span>Audit reason *</span><input value={authorityDraft.reason} onChange={(event) => setAuthorityDraft((current) => ({ ...current, reason: event.target.value }))} /></label><button className="primary-button" type="submit" disabled={!authorityDraft.lane.trim() || !authorityDraft.subjectId || authorityDraft.reason.trim().length < 8}>Grant authority</button></form><div className="setup-records lifecycle-records"><h3>Lane authority</h3>{config.authorities.length ? config.authorities.map((authority) => { const subject = authority.subjectType === "user" ? members.find((member) => member.userId === authority.subjectId)?.displayName : config.groups.find((group) => group.id === authority.subjectId)?.name; return <article key={authority.id}><div><b>{authority.lane} · {subject ?? "Unavailable subject"}</b><small>{authority.currencyCode} · {authority.amountLimitMinor === null ? "Unlimited" : `${(authority.amountLimitMinor / (10 ** currencyDigits(authority.currencyCode))).toLocaleString()} limit`}</small></div><span className={`enterprise-status ${authority.status}`}>{statusLabel(authority.status)}</span>{authority.status === "active" && <button className="danger-link" type="button" onClick={() => void mutate("/api/admin/configuration/approval-authorities", "PATCH", { action: "revoke", id: authority.id, version: authority.version, confirmed: true, reason: "Authority revoked after administrator review" }, "Approval authority revoked.")}>Revoke</button>}</article>; }) : <EmptyConfig>No explicit approval authority exists. Approval commits fail closed when lane authority is configured but no eligible subject matches.</EmptyConfig>}</div></div>}

    {section === "intake-forms" && !busy && !error && <div className="setup-split wide"><form className="setup-builder intake-form-builder" onSubmit={(event) => void createIntakeForm(event)}><h3>Build a request form</h3><label><span>Form name *</span><input value={formDraft.name} onChange={(event) => setFormDraft((current) => ({ ...current, name: event.target.value }))} /></label><label><span>Description</span><input value={formDraft.description} onChange={(event) => setFormDraft((current) => ({ ...current, description: event.target.value }))} /></label><div className="setup-form-row"><label><span>Published template (optional)</span><select value={formDraft.templateId} onChange={(event) => setFormDraft((current) => ({ ...current, templateId: event.target.value }))}><option value="">Starter paper only</option>{config.templates.filter((template) => template.status === "published").map((template) => <option key={template.id} value={template.id}>{template.name} · v{template.currentPublishedVersion}</option>)}</select></label><label><span>Published workflow (optional)</span><select value={formDraft.workflowId} onChange={(event) => setFormDraft((current) => ({ ...current, workflowId: event.target.value }))}><option value="">Starter approval policy</option>{config.workflows.filter((workflow) => workflow.status === "published").map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name} · v{workflow.version}</option>)}</select></label></div><div className="form-field-builder"><header><b>Request fields</b><button type="button" onClick={() => setFormDraft((current) => ({ ...current, fields: [...current.fields, { key: "", label: "", type: "text", required: false, options: "" }] }))}>＋ Add field</button></header>{formDraft.fields.map((field, index) => <div key={index}><input aria-label={`Field ${index + 1} key`} placeholder="field_key" value={field.key} onChange={(event) => setFormDraft((current) => ({ ...current, fields: current.fields.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value.toLowerCase().replaceAll(" ", "_") } : item) }))} /><input aria-label={`Field ${index + 1} label`} placeholder="Question label" value={field.label} onChange={(event) => setFormDraft((current) => ({ ...current, fields: current.fields.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) }))} /><select aria-label={`Field ${index + 1} type`} value={field.type} onChange={(event) => setFormDraft((current) => ({ ...current, fields: current.fields.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value } : item) }))}><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Yes / no</option><option value="single_select">Single select</option><option value="multi_select">Multi select</option></select><label><input type="checkbox" checked={field.required} onChange={(event) => setFormDraft((current) => ({ ...current, fields: current.fields.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item) }))} /><span>Required</span></label>{formDraft.fields.length > 1 && <button type="button" aria-label={`Remove field ${index + 1}`} onClick={() => setFormDraft((current) => ({ ...current, fields: current.fields.filter((_, itemIndex) => itemIndex !== index) }))}>×</button>}{["single_select", "multi_select"].includes(field.type) && <input className="field-options" aria-label={`Field ${index + 1} options`} placeholder="Options, comma separated" value={field.options} onChange={(event) => setFormDraft((current) => ({ ...current, fields: current.fields.map((item, itemIndex) => itemIndex === index ? { ...item, options: event.target.value } : item) }))} />}</div>)}</div><label><span>Submit button label</span><input value={formDraft.submitLabel} onChange={(event) => setFormDraft((current) => ({ ...current, submitLabel: event.target.value }))} /></label><button className="primary-button" type="submit" disabled={!formDraft.name.trim() || formDraft.fields.some((field) => !field.key || !field.label)}>Create draft form</button></form><div className="setup-records lifecycle-records"><h3>Intake forms</h3>{config.intakeForms.length ? config.intakeForms.map((form) => <article key={form.id}><div><b>{form.name}</b><small>{form.formSchema.fields?.length ?? 0} fields · {form.templateId ? `template pin ${form.templateVersionId ? "ready" : "on publish"}` : "starter paper"} · {form.workflowDefinitionId ? "governed workflow" : "starter policy"}</small></div><span className={`enterprise-status ${form.status}`}>{statusLabel(form.status)}</span><LifecycleButtons status={form.status} busy={busy} canPublish={form.createdByUserId !== userId} onPublish={() => void mutate("/api/admin/configuration/intake-forms", "PATCH", { action: "publish", id: form.id, version: form.version, confirmed: true, reason: "Independent administrator reviewed fields and exact configuration pins" }, "Intake form published with exact template-version pin.")} onRetire={() => void mutate("/api/admin/configuration/intake-forms", "PATCH", { action: "retire", id: form.id, version: form.version, confirmed: true, reason: "Intake form retired after administrator review" }, "Intake form retired.")} /></article>) : <EmptyConfig>No intake forms exist. Requesters cannot start governed structured intake yet.</EmptyConfig>}</div></div>}

    {section === "playbooks" && !busy && !error && <div className="setup-split wide"><form className="setup-builder" onSubmit={(event) => void createPlaybook(event)}><h3>Create a governed clause position</h3><label><span>Playbook name *</span><input value={playbookDraft.name} onChange={(event) => setPlaybookDraft((current) => ({ ...current, name: event.target.value }))} /></label><label><span>Description</span><input value={playbookDraft.description} onChange={(event) => setPlaybookDraft((current) => ({ ...current, description: event.target.value }))} /></label><label><span>Agreement type</span><input value={playbookDraft.agreementType} onChange={(event) => setPlaybookDraft((current) => ({ ...current, agreementType: event.target.value }))} /></label><div className="setup-form-row"><label><span>Direction</span><select value={playbookDraft.side} onChange={(event) => setPlaybookDraft((current) => ({ ...current, side: event.target.value }))}><option value="Sell-side">Customer contract</option><option value="Buy-side">Supplier contract</option><option value="Corporate">Company contract</option></select></label><label><span>Jurisdiction</span><input value={playbookDraft.jurisdiction} onChange={(event) => setPlaybookDraft((current) => ({ ...current, jurisdiction: event.target.value }))} /></label></div><div className="setup-form-row"><label><span>Clause key *</span><input pattern="[a-z0-9]+([._-][a-z0-9]+)*" value={playbookDraft.ruleKey} onChange={(event) => setPlaybookDraft((current) => ({ ...current, ruleKey: event.target.value.toLowerCase().replaceAll(" ", "_") }))} /></label><label><span>Clause title *</span><input value={playbookDraft.ruleTitle} onChange={(event) => setPlaybookDraft((current) => ({ ...current, ruleTitle: event.target.value }))} /></label></div><div className="setup-form-row"><label><span>Position</span><select value={playbookDraft.position} onChange={(event) => setPlaybookDraft((current) => ({ ...current, position: event.target.value }))}><option value="required">Required</option><option value="preferred">Preferred</option><option value="acceptable">Acceptable</option><option value="prohibited">Prohibited</option></select></label><label><span>Risk if changed</span><select value={playbookDraft.risk} onChange={(event) => setPlaybookDraft((current) => ({ ...current, risk: event.target.value }))}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label></div><label><span>Preferred clause text *</span><textarea rows={5} value={playbookDraft.preferredText} onChange={(event) => setPlaybookDraft((current) => ({ ...current, preferredText: event.target.value }))} /></label><label><span>Acceptable alternatives, one per line</span><textarea rows={3} value={playbookDraft.alternatives} onChange={(event) => setPlaybookDraft((current) => ({ ...current, alternatives: event.target.value }))} /></label><label><span>Review guidance *</span><textarea rows={3} value={playbookDraft.guidance} onChange={(event) => setPlaybookDraft((current) => ({ ...current, guidance: event.target.value }))} /></label><label><span>Version summary *</span><input value={playbookDraft.changeSummary} onChange={(event) => setPlaybookDraft((current) => ({ ...current, changeSummary: event.target.value }))} /></label><button className="primary-button" type="submit" disabled={!playbookDraft.name.trim() || !playbookDraft.ruleKey.trim() || !playbookDraft.ruleTitle.trim() || !playbookDraft.preferredText.trim() || playbookDraft.guidance.trim().length < 3 || playbookDraft.changeSummary.trim().length < 3}>Create draft &amp; immutable version</button><div className="builder-help"><b>Independent publication</b><p>The scoped position and exact clause text are digested into an immutable version. A different administrator must review and publish it.</p></div></form><div className="setup-records lifecycle-records"><h3>Clause playbooks</h3>{config.playbooks.length ? config.playbooks.map((playbook) => { const versions = config.playbookVersions.filter((version) => version.playbookId === playbook.id); const draft = versions.find((version) => version.status === "draft"); return <article key={playbook.id}><div><b>{playbook.name}</b><small>{playbook.scope.agreementTypes?.join(", ") || "All types"} · {playbook.scope.sides?.join(", ") || "All directions"} · {versions.length} version(s)</small>{draft && <code>Draft v{draft.version} · {draft.contentSha256.slice(0, 12)}… · {draft.rules.clauses?.[0]?.title}</code>}</div><span className={`enterprise-status ${playbook.status}`}>{statusLabel(playbook.status)}</span><LifecycleButtons status={draft ? "draft" : playbook.status} busy={busy} canPublish={draft?.createdByUserId !== userId} onPublish={draft ? () => void mutate("/api/admin/configuration/playbooks", "PATCH", { action: "publish_version", playbookId: playbook.id, playbookVersion: playbook.version, versionId: draft.id }, "Clause playbook version published.") : undefined} onRetire={() => void mutate("/api/admin/configuration/playbooks", "PATCH", { action: "retire_playbook", playbookId: playbook.id, playbookVersion: playbook.version }, "Clause playbook retired.")} /></article>; }) : <EmptyConfig>No clause playbooks exist. Repository extraction remains citable but carries no approved position.</EmptyConfig>}</div></div>}

    {section === "agents" && <div className="setup-section-pointer"><span>↧</span><div><b>Agent governance is shown below</b><p>Only <code>agreement.read</code> and <code>approval.request</code> are delegable. Every grant is exact-resource, sponsored, expiring, and revocable; every action plan still requires its governed human review.</p></div></div>}

    {pendingLifecycle && <div className={`setup-confirmation${pendingLifecycle.destructive ? " destructive" : ""}`} role="dialog" aria-modal="false" aria-labelledby="setup-confirmation-title">
      <div className="setup-confirmation-copy">
        <p>{pendingLifecycle.destructive ? "CONTROLLED LIFECYCLE CHANGE" : "GOVERNED PUBLICATION"}</p>
        <h3 id="setup-confirmation-title">{pendingLifecycle.title}</h3>
        <span>{pendingLifecycle.detail}</span>
      </div>
      <label><span>Audit reason *</span><textarea data-initial-focus rows={3} value={lifecycleReason} onChange={(event) => setLifecycleReason(event.target.value)} placeholder="Describe why this change is appropriate (at least 8 characters)." /></label>
      <label className="setup-check"><input type="checkbox" checked={lifecycleConfirmed} onChange={(event) => setLifecycleConfirmed(event.target.checked)} /><span>I reviewed the selected record and understand the effect on future use.</span></label>
      <div className="setup-confirmation-actions">
        <button type="button" disabled={busy} onClick={() => { setPendingLifecycle(null); setLifecycleReason(""); setLifecycleConfirmed(false); }}>Cancel</button>
        <button className={pendingLifecycle.destructive ? "danger-button" : "primary-button"} type="button" disabled={busy || lifecycleReason.trim().length < 8 || !lifecycleConfirmed} onClick={() => void confirmLifecycle()}>{busy ? "Saving…" : pendingLifecycle.destructive ? "Confirm lifecycle change" : "Confirm publication"}</button>
      </div>
    </div>}
    </div>
  </section>;
}
