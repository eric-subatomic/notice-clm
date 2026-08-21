import { z } from "zod";
import {
  GOVERNED_TEMPLATE_VARIABLE_MAX_COUNT,
  GOVERNED_TEMPLATE_VARIABLE_VALUE_MAX_LENGTH,
  GOVERNED_TEMPLATE_VARIABLES_MAX_BYTES,
} from "./governed-template-runtime";
import { normalizeIsoDate } from "./iso-date";
import { canonicalCurrencyCode, MAX_MONEY_MINOR } from "./money";
import { isValidObligationTimeZone } from "./obligation-recurrence";

const shortText = (label: string, max = 200) =>
  z.string({ error: `${label} must be text` }).trim().min(1, `${label} is required`).max(max, `${label} is too long`);

const optionalInputText = (max = 500) => z.string().trim().max(max);
const optionalText = (max = 500) => optionalInputText(max).default("");
const agreementId = z.coerce.number().int().positive();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "Must be a lowercase SHA-256 digest");
const optionalIsoDate = (label: string) => z.string().trim().max(10).refine(
  (value) => value === "" || normalizeIsoDate(value) !== null,
  `${label} must be a valid date in YYYY-MM-DD format`,
);
const requiredIsoDate = (label: string) => z.string().trim().length(10).refine(
  (value) => normalizeIsoDate(value) !== null,
  `${label} must be a valid date in YYYY-MM-DD format`,
);
const currencyCode = z.string().trim().transform((value) => value.toUpperCase()).refine(
  (value) => canonicalCurrencyCode(value) !== null,
  "Currency must be a three-letter ISO-4217 code",
);
const templateVariableName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "Template variable names are invalid");
const templateVariablesSchema = z.record(
  templateVariableName,
  z.string().max(GOVERNED_TEMPLATE_VARIABLE_VALUE_MAX_LENGTH, "Template variable value is too long"),
).superRefine((variables, context) => {
  if (Object.keys(variables).length > GOVERNED_TEMPLATE_VARIABLE_MAX_COUNT) {
    context.addIssue({
      code: "custom",
      message: `At most ${GOVERNED_TEMPLATE_VARIABLE_MAX_COUNT} template variables may be supplied`,
    });
  }
  if (new TextEncoder().encode(JSON.stringify(variables)).byteLength > GOVERNED_TEMPLATE_VARIABLES_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `Template variables may use at most ${GOVERNED_TEMPLATE_VARIABLES_MAX_BYTES} encoded bytes`,
    });
  }
}).transform((variables) => Object.fromEntries(
  Object.entries(variables).sort(([left], [right]) => left.localeCompare(right)),
));

function validateDateRange(
  value: { effectiveDate?: string; expirationDate?: string },
  context: z.RefinementCtx,
) {
  if (value.effectiveDate && value.expirationDate && value.expirationDate < value.effectiveDate) {
    context.addIssue({
      code: "custom",
      path: ["expirationDate"],
      message: "Expiration date must be on or after the effective date",
    });
  }
}

const agreementMutationFields = z.object({
  creationMode: z.enum(["generated", "imported", "manual"]).default("manual"),
  party: shortText("Counterparty"),
  side: z.enum(["Sell-side", "Buy-side", "Corporate"]),
  type: shortText("Agreement type"),
  value: z.coerce.number().int().nonnegative().max(9_000_000_000_000).default(0),
  valueMinor: z.coerce.number().int().nonnegative().max(MAX_MONEY_MINOR).optional(),
  currencyCode: currencyCode.default("USD"),
  owner: shortText("Owner"),
  ownerUserId: z.string().trim().min(1).max(200).optional(),
  primaryCounterpartyId: z.string().uuid().optional(),
  legalEntityId: z.string().uuid().optional(),
  governedTemplateVersionId: z.string().uuid().optional(),
  templateVariables: templateVariablesSchema.optional(),
  workflowDefinitionId: z.string().uuid().optional(),
  // Queue state is derived by the server from document and lifecycle state.
  // Explicitly reject it on creation instead of silently stripping an
  // attempted caller-owned queue value.
  nextAction: z.never().optional(),
  due: shortText("Due", 100),
  crm: z.enum(["Salesforce", "HubSpot", "Custom CRM", "None"]),
  crmRecord: optionalText(500),
  tags: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
  department: shortText("Department", 100),
  // Older clients may still send an intake guess. It is deliberately
  // normalized to Unassessed; only the evidence-bound risk operation can set
  // a governed risk level.
  risk: z.enum(["Unassessed", "Low", "Medium", "High"]).transform(() => "Unassessed" as const).default("Unassessed"),
  effectiveDate: optionalIsoDate("Effective date").default(""),
  expirationDate: optionalIsoDate("Expiration date").default(""),
  governingLaw: optionalText(100),
});

export const agreementMutationSchema = agreementMutationFields.superRefine((value, context) => {
  validateDateRange(value, context);
  if (value.governedTemplateVersionId && value.creationMode !== "generated") {
    context.addIssue({
      code: "custom",
      path: ["governedTemplateVersionId"],
      message: "A governed template version can be used only for generated agreements",
    });
  }
  if (value.templateVariables && !value.governedTemplateVersionId) {
    context.addIssue({
      code: "custom",
      path: ["templateVariables"],
      message: "Template variables require a governed template version",
    });
  }
});

export const agreementPatchSchema = agreementMutationFields.omit({ nextAction: true, templateVariables: true }).partial().extend({
  id: agreementId,
  version: z.number().int().nonnegative(),
  nextAction: z.never().optional(),
}).refine((value) => Object.keys(value).some((key) => !["id", "version"].includes(key)), {
  message: "At least one agreement field must be changed",
});

export const agreementDetailsPatchSchema = z.object({
  id: agreementId,
  version: z.number().int().positive(),
  party: shortText("Counterparty").optional(),
  type: shortText("Agreement type").optional(),
  side: z.enum(["Sell-side", "Buy-side", "Corporate"]).optional(),
  value: z.coerce.number().int().nonnegative().max(9_000_000_000_000).optional(),
  valueMinor: z.coerce.number().int().nonnegative().max(MAX_MONEY_MINOR).optional(),
  currencyCode: currencyCode.optional(),
  owner: shortText("Owner").optional(),
  ownerUserId: z.string().trim().min(1).max(200).nullable().optional(),
  primaryCounterpartyId: z.string().uuid().nullable().optional(),
  legalEntityId: z.string().uuid().nullable().optional(),
  governedTemplateVersionId: z.string().uuid().nullable().optional(),
  workflowDefinitionId: z.string().uuid().nullable().optional(),
  // Queue state is derived by server-side lifecycle transitions. Keeping this
  // as an explicit never-field rejects mixed payloads instead of silently
  // stripping a caller's attempted queue overwrite.
  nextAction: z.never().optional(),
  due: shortText("Due", 100).optional(),
  crm: z.enum(["Salesforce", "HubSpot", "Custom CRM", "None"]).optional(),
  crmRecord: optionalInputText(500).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(40).optional(),
  department: shortText("Department", 100).optional(),
  // Risk changes require the dedicated evidence-bound risk operation.
  risk: z.never().optional(),
  effectiveDate: optionalIsoDate("Effective date").optional(),
  expirationDate: optionalIsoDate("Expiration date").optional(),
}).refine((value) => Object.keys(value).some((key) => !["id", "version"].includes(key)), {
  message: "At least one agreement field must be changed",
});

export const agreementTransitionSchema = z.object({
  id: agreementId,
  version: z.number().int().positive(),
  toStage: z.enum(["Intake", "Draft", "Review", "Negotiation", "Signature", "Active"]),
});

export const languageBlockMutationSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  version: z.number().int().nonnegative().optional(),
  title: shortText("Block name"),
  category: shortText("Category", 100),
  profile: z.enum(["Standard", "Fallback", "Strict"]),
  summary: shortText("Summary", 500),
  language: shortText("Approved language", 30_000),
  uses: z.coerce.number().int().nonnegative().default(0),
});

const createApproval = z.object({
  entity: z.literal("approval"),
  action: z.literal("create"),
  record: z.object({
    agreementId,
    role: shortText("Approval role", 100),
    approverUserId: z.string().trim().min(1).max(200).optional(),
    // Accepted for backwards-compatible clients, but display identity is
    // resolved from the selected workspace member by the server.
    approver: shortText("Approver", 200).optional(),
    due: requiredIsoDate("Approval due date"),
  }),
});

const decideApproval = z.object({
  entity: z.literal("approval"),
  action: z.literal("decide"),
  record: z.object({
    id: z.string().uuid(),
    status: z.enum(["Approved", "Changes requested"]),
    comment: z.string().trim().max(2_000).optional(),
    version: z.number().int().positive(),
    basisHash: sha256,
    documentVersion: z.number().int().positive(),
    documentSha256: sha256,
    confirmed: z.literal(true),
  }),
}).superRefine((value, context) => {
  if (value.record.status === "Changes requested" && !value.record.comment?.trim()) {
    context.addIssue({ code: "custom", path: ["record", "comment"], message: "A reason is required when requesting changes" });
  }
});

const claimApproval = z.object({
  entity: z.literal("approval"),
  action: z.literal("claim"),
  record: z.object({
    id: z.string().uuid(),
    version: z.number().int().nonnegative().optional(),
  }),
});

const ensureRequiredApprovals = z.object({
  entity: z.literal("approval"),
  action: z.literal("ensure_required"),
  record: z.object({
    agreementId,
    due: requiredIsoDate("Approval due date"),
  }),
});

const assessRisk = z.object({
  entity: z.literal("risk"),
  action: z.literal("assess"),
  record: z.object({
    agreementId,
    agreementVersion: z.number().int().positive(),
    level: z.enum(["Low", "Medium", "High"]),
    rationale: shortText("Risk assessment rationale", 2_000),
    basisHash: sha256,
    documentVersion: z.number().int().positive(),
    documentSha256: sha256,
    confirmed: z.literal(true),
  }),
});

const waiveRisk = z.object({
  entity: z.literal("risk"),
  action: z.literal("waive"),
  record: z.object({
    agreementId,
    agreementVersion: z.number().int().positive(),
    rationale: shortText("Risk waiver rationale", 2_000),
    basisHash: sha256,
    documentVersion: z.number().int().positive(),
    documentSha256: sha256,
    confirmed: z.literal(true),
  }),
});

const obligationRecurrence = z.object({
  unit: z.enum(["once", "week", "month", "year"]),
  interval: z.number().int().min(1).max(12),
  timezone: z.string().trim().min(1).max(100).refine(isValidObligationTimeZone, "A valid IANA time zone is required"),
  endDate: requiredIsoDate("Schedule end date").optional(),
  reminderLeadDays: z.array(z.number().int().min(0).max(365)).min(1).max(8).default([0]),
}).strict().superRefine((value, context) => {
  if (value.unit === "once" && value.interval !== 1) {
    context.addIssue({ code: "custom", path: ["interval"], message: "A one-time schedule must use interval 1" });
  }
  if (new Set(value.reminderLeadDays).size !== value.reminderLeadDays.length) {
    context.addIssue({ code: "custom", path: ["reminderLeadDays"], message: "Reminder lead days must be unique" });
  }
});

const createObligation = z.object({
  entity: z.literal("obligation"),
  action: z.literal("create"),
  record: z.object({
    agreementId,
    title: shortText("Obligation", 500),
    dueDate: requiredIsoDate("Obligation due date"),
    ownerUserId: z.string().trim().min(1).max(200).optional(),
    // Accepted for backwards-compatible clients; the server owns the display
    // name associated with ownerUserId.
    owner: shortText("Owner", 200).optional(),
    // Retained only as a backwards-compatible display hint. The server never
    // infers recurrence from free text and derives the canonical label itself.
    cadence: shortText("Cadence", 100).optional(),
    source: shortText("Source", 500),
    recurrence: obligationRecurrence.optional(),
    confirmed: z.literal(true),
  }),
}).superRefine((value, context) => {
  const recurrence = value.record.recurrence;
  if (recurrence?.endDate && recurrence.endDate < value.record.dueDate) {
    context.addIssue({ code: "custom", path: ["record", "recurrence", "endDate"], message: "Schedule end date cannot be before the first due date" });
  }
});

const completeObligation = z.object({
  entity: z.literal("obligation"),
  action: z.literal("complete"),
  record: z.object({
    id: z.string().uuid(),
    evidence: z.string().trim().min(1).max(2_000),
    overrideReason: z.string().trim().min(8).max(2_000).optional(),
    version: z.number().int().positive(),
    confirmed: z.literal(true),
  }),
});

const reassignObligationSchedule = z.object({
  entity: z.literal("obligation"),
  action: z.literal("reassign"),
  record: z.object({
    scheduleId: z.string().trim().min(1).max(200),
    version: z.number().int().positive(),
    newOwnerUserId: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(8).max(2_000),
    includeOpenOccurrences: z.literal(true),
    confirmed: z.literal(true),
  }).strict(),
});

const setObligationScheduleStatus = z.object({
  entity: z.literal("obligation"),
  action: z.literal("schedule_status"),
  record: z.object({
    scheduleId: z.string().trim().min(1).max(200),
    version: z.number().int().positive(),
    status: z.enum(["active", "paused", "ended"]),
    reason: z.string().trim().min(8).max(2_000),
    confirmed: z.literal(true),
  }).strict(),
});

const addComment = z.object({
  entity: z.literal("event"),
  action: z.literal("comment"),
  record: z.object({
    agreementId,
    eventType: z.enum(["Comment", "Redline", "Language", "Export"]).default("Comment"),
    detail: shortText("Comment", 4_000),
  }),
});

export const operationMutationSchema = z.discriminatedUnion("entity", [
  z.discriminatedUnion("action", [createApproval, ensureRequiredApprovals, claimApproval, decideApproval]),
  z.discriminatedUnion("action", [assessRisk, waiveRisk]),
  z.discriminatedUnion("action", [createObligation, completeObligation, reassignObligationSchedule, setObligationScheduleStatus]),
  addComment,
]);

export const documentLinkSchema = z.object({
  documentId: z.string().uuid(),
  agreementId,
});

export const documentVersionSchema = z.object({
  content: z.string().max(2_000_000).refine((value) => value.trim().length > 0, "Document content cannot be blank"),
  contentType: z.enum(["text/plain", "text/markdown"]).default("text/plain"),
  label: z.string().trim().min(1).max(120).default("Draft"),
  expectedAgreementVersion: z.number().int().nonnegative(),
});

export async function parseJson<TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema,
  maxBytes = 1_000_000,
): Promise<z.output<TSchema>> {
  let input: unknown;
  try {
    const bytes = await readBoundedBody(request, maxBytes, `Maximum JSON body size is ${maxBytes} bytes`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    input = JSON.parse(text);
  } catch (error) {
    if (error instanceof RequestValidationError) throw error;
    throw new RequestValidationError("Request body must be valid JSON", [{ path: [], message: "Invalid JSON" }]);
  }

  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RequestValidationError(
      "Request validation failed",
      result.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })),
    );
  }
  return result.data;
}

export async function readBoundedBody(
  request: Request,
  maxBytes: number,
  limitMessage = `Maximum request body size is ${maxBytes} bytes`,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive safe integer");
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const declaredLength = Number(declared);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new RequestValidationError("Content-Length is invalid", [{ path: [], message: "Content-Length must be a non-negative integer" }]);
    }
    if (declaredLength > maxBytes) {
      throw new RequestValidationError("Request body is too large", [{ path: [], message: limitMessage }], 413, "payload_too_large");
    }
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel("request body exceeds configured limit"); } catch { /* cancellation is best effort */ }
        throw new RequestValidationError("Request body is too large", [{ path: [], message: limitMessage }], 413, "payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* the stream may already be cancelled */ }
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export class RequestValidationError extends Error {
  readonly issues: Array<{ path: string[]; message: string }>;
  readonly status: number;
  readonly code: string;

  constructor(message: string, issues: Array<{ path: string[]; message: string }>, status = 400, code = "validation_failed") {
    super(message);
    this.name = "RequestValidationError";
    this.issues = issues;
    this.status = status;
    this.code = code;
  }
}
