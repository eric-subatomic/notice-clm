import { z } from "zod";
import { assertBoundedJson, normalizeCounterpartyDomain, validateDefinitionOptions } from "./enterprise-domain";
import { normalizeIsoDate } from "./iso-date";
import { canonicalCurrencyCode, MAX_MONEY_MINOR } from "./money";

const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/u;
const text = (label: string, max = 200) => z.string().trim().min(1, `${label} is required`).max(max).regex(SAFE_TEXT, `${label} contains unsafe formatting characters`);
const optionalText = (max = 500) => z.string().trim().max(max)
  .refine((value) => value === "" || SAFE_TEXT.test(value), "Text contains unsafe formatting characters").default("");
const optionalInputText = (max = 500) => z.string().trim().max(max)
  .refine((value) => value === "" || SAFE_TEXT.test(value), "Text contains unsafe formatting characters");
const counterpartyDomain = optionalInputText(253).refine((value) => {
  const host = normalizeCounterpartyDomain(value);
  return host === "" || (host.length <= 253 && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host));
}, "Domain must contain a valid DNS host name");
const id = z.string().uuid();
const version = z.number().int().positive();
const currency = z.string().trim().regex(/^[A-Z]{3}$/, "Currency must be an uppercase ISO-style three-letter code");
const reason = text("Reason", 500).min(8, "Reason must contain at least 8 characters");
const confirmation = { confirmed: z.literal(true), reason } as const;
const jsonObject = (maxBytes: number) => z.record(z.string(), z.unknown()).superRefine((value, context) => {
  try {
    assertBoundedJson(value, { maxBytes });
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid JSON content" });
  }
});

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  status: z.string().trim().max(40).optional(),
  id: z.string().uuid().optional(),
}).strict();

export const legalEntityCreateSchema = z.object({
  legalName: text("Legal name"),
  displayName: text("Display name"),
  entityType: text("Entity type", 80).default("company"),
  jurisdiction: optionalText(100),
  registrationNumber: optionalText(120),
  defaultCurrencyCode: currency.default("USD"),
}).strict();

export const legalEntityPatchSchema = z.object({
  id,
  version,
  legalName: text("Legal name").optional(),
  displayName: text("Display name").optional(),
  entityType: text("Entity type", 80).optional(),
  jurisdiction: optionalInputText(100).optional(),
  registrationNumber: optionalInputText(120).optional(),
  defaultCurrencyCode: currency.optional(),
  status: z.enum(["active", "inactive"]).optional(),
}).strict().refine((input) => Object.keys(input).some((key) => key !== "id" && key !== "version"), "At least one field must be changed");

export const counterpartyCreateSchema = z.object({
  legalName: text("Legal name"),
  displayName: text("Display name"),
  domain: counterpartyDomain.default(""),
  jurisdiction: optionalText(100),
  registrationNumber: optionalText(120),
  externalId: optionalText(200),
}).strict();

export const counterpartyPatchSchema = z.object({
  id,
  version,
  legalName: text("Legal name").optional(),
  displayName: text("Display name").optional(),
  domain: counterpartyDomain.optional(),
  jurisdiction: optionalInputText(100).optional(),
  registrationNumber: optionalInputText(120).optional(),
  externalId: optionalInputText(200).optional(),
  status: z.enum(["active", "inactive", "blocked"]).optional(),
}).strict().refine((input) => Object.keys(input).some((key) => key !== "id" && key !== "version"), "At least one field must be changed");

const groupFields = z.object({
  name: text("Group name", 160),
  description: optionalText(1_000),
  externalProvider: z.string().trim().min(1).max(100).optional(),
  externalId: z.string().trim().min(1).max(300).optional(),
}).strict().superRefine((value, context) => {
  if ((value.externalProvider === undefined) !== (value.externalId === undefined)) {
    context.addIssue({ code: "custom", message: "External provider and external ID must be supplied together" });
  }
});

export const workspaceGroupPostSchema = z.discriminatedUnion("action", [
  groupFields.extend({ action: z.literal("create_group") }),
  z.object({ action: z.literal("add_member"), groupId: id, groupVersion: version, userId: id }).strict(),
]);

export const workspaceGroupPatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update_group"), id, version,
    name: text("Group name", 160).optional(),
    description: optionalInputText(1_000).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  }).strict().refine((input) => input.name !== undefined || input.description !== undefined || input.status !== undefined, "At least one field must be changed"),
  z.object({ action: z.literal("remove_member"), groupId: id, groupVersion: version, userId: id, reason }).strict(),
]);

export const customFieldDataTypeSchema = z.enum(["text", "number", "date", "boolean", "single_select", "multi_select"]);
export const customFieldResourceTypeSchema = z.enum(["agreement", "counterparty", "legal_entity"]);

const customFieldOptions = z.array(text("Option", 200)).max(100).default([]);
export const customFieldCreateSchema = z.object({
  resourceType: customFieldResourceTypeSchema,
  key: z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/, "Key must use lower snake case"),
  label: text("Label", 200),
  description: optionalText(1_000),
  dataType: customFieldDataTypeSchema,
  options: customFieldOptions,
  required: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  try { validateDefinitionOptions(value.dataType, value.options); } catch (error) {
    context.addIssue({ code: "custom", path: ["options"], message: error instanceof Error ? error.message : "Invalid options" });
  }
});

export const customFieldPatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update"), id, version,
    label: text("Label", 200).optional(),
    description: optionalInputText(1_000).optional(),
    options: z.array(text("Option", 200)).max(100).optional(),
    required: z.boolean().optional(),
  }).strict().refine((input) => input.label !== undefined || input.description !== undefined || input.options !== undefined || input.required !== undefined, "At least one field must be changed"),
  z.object({ action: z.literal("retire"), id, version, ...confirmation }).strict(),
]);

export const customFieldValuePutSchema = z.object({
  definitionId: id,
  definitionVersion: version,
  resourceType: customFieldResourceTypeSchema,
  resourceId: z.string().trim().min(1).max(200),
  value: z.unknown(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable().default(null),
}).strict();

export const customFieldValueDeleteSchema = z.object({
  definitionId: id,
  definitionVersion: version,
  resourceType: customFieldResourceTypeSchema,
  resourceId: z.string().trim().min(1).max(200),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  reason,
}).strict();

export const templatePostSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_with_version"), name: text("Template name"), description: optionalText(1_000),
    agreementType: text("Agreement type", 120), side: z.enum(["Sell-side", "Buy-side", "Corporate"]),
    body: z.string().min(1).max(500_000), variableSchema: jsonObject(65_536),
    languageBlockIds: z.array(z.number().int().positive()).max(0, "Language-block composition is unavailable until immutable block snapshots are supported.").default([]),
    changeSummary: text("Change summary", 1_000),
  }).strict(),
  z.object({
    action: z.literal("create_version"), templateId: id, templateVersion: version,
    body: z.string().min(1).max(500_000), variableSchema: jsonObject(65_536),
    languageBlockIds: z.array(z.number().int().positive()).max(0, "Language-block composition is unavailable until immutable block snapshots are supported.").default([]),
    changeSummary: text("Change summary", 1_000),
  }).strict(),
]);

export const templatePatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update_template"), id, version,
    name: text("Template name").optional(), description: optionalInputText(1_000).optional(),
    agreementType: text("Agreement type", 120).optional(), side: z.enum(["Sell-side", "Buy-side", "Corporate"]).optional(),
  }).strict().refine((input) => Object.keys(input).some((key) => key !== "action" && key !== "id" && key !== "version"), "At least one field must be changed"),
  z.object({ action: z.literal("publish_version"), templateId: id, templateVersion: version, versionId: id, ...confirmation }).strict(),
  z.object({ action: z.literal("retire_template"), templateId: id, templateVersion: version, ...confirmation }).strict(),
]);

export const workflowPostSchema = z.object({
  name: text("Workflow name"), description: optionalText(1_000), definition: jsonObject(65_536),
}).strict();

export const workflowPatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("publish"), id, version, ...confirmation }).strict(),
  z.object({ action: z.literal("retire"), id, version, ...confirmation }).strict(),
]);

export const approvalAuthorityCreateSchema = z.object({
  lane: text("Approval lane", 120), subjectType: z.enum(["user", "group"]), subjectId: id,
  currencyCode: currency.default("USD"), amountLimitMinor: z.number().int().min(0).max(9_000_000_000_000_000).nullable().default(null),
  ...confirmation,
}).strict();

export const approvalAuthorityPatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update"), id, version, currencyCode: currency.optional(),
    amountLimitMinor: z.number().int().min(0).max(9_000_000_000_000_000).nullable().optional(), ...confirmation,
  }).strict().refine((input) => input.currencyCode !== undefined || input.amountLimitMinor !== undefined, "At least one authority scope must be changed"),
  z.object({ action: z.literal("revoke"), id, version, ...confirmation }).strict(),
]);

export const savedViewCreateSchema = z.object({
  ownerUserId: id, resourceType: text("Resource type", 80), name: text("View name", 160),
  filter: jsonObject(16_384), sort: jsonObject(4_096), shared: z.boolean().default(false),
}).strict();

export const savedViewPatchSchema = z.object({
  id, version, name: text("View name", 160).optional(), filter: jsonObject(16_384).optional(),
  sort: jsonObject(4_096).optional(), shared: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).some((key) => key !== "id" && key !== "version"), "At least one field must be changed");

export const savedViewDeleteSchema = z.object({ id, version, reason }).strict();

const intakeFieldSchema = z.object({
  key: z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/, "Field key must use lower snake case"),
  label: text("Field label", 200), type: customFieldDataTypeSchema, required: z.boolean().default(false),
  options: customFieldOptions,
}).strict().superRefine((value, context) => {
  try { validateDefinitionOptions(value.type, value.options); } catch (error) {
    context.addIssue({ code: "custom", path: ["options"], message: error instanceof Error ? error.message : "Invalid options" });
  }
});

export const intakeFormSchema = z.object({
  fields: z.array(intakeFieldSchema).min(1).max(100),
  submitLabel: text("Submit label", 80).optional(),
}).strict().superRefine((value, context) => {
  const keys = value.fields.map((field) => field.key);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["fields"], message: "Field keys must be unique" });
  try { assertBoundedJson(value, { maxBytes: 65_536 }); } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid form schema" });
  }
});

export const intakeFormCreateSchema = z.object({
  name: text("Form name"), description: optionalText(1_000), formSchema: intakeFormSchema,
  templateId: id.nullable().default(null), workflowDefinitionId: id.nullable().default(null),
}).strict();

export const intakeFormPatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update_draft"), id, version, name: text("Form name").optional(),
    description: optionalInputText(1_000).optional(), formSchema: intakeFormSchema.optional(),
    templateId: id.nullable().optional(), workflowDefinitionId: id.nullable().optional(),
  }).strict().refine((input) => Object.keys(input).some((key) => key !== "action" && key !== "id" && key !== "version"), "At least one field must be changed"),
  z.object({ action: z.literal("publish"), id, version, ...confirmation }).strict(),
  z.object({ action: z.literal("retire"), id, version, ...confirmation }).strict(),
]);

const answersSchema = jsonObject(131_072);
export const intakeSubmissionCreateSchema = z.object({ formId: id, answers: answersSchema }).strict();
export const intakeSubmissionPatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update_draft"), id, version, answers: answersSchema }).strict(),
  z.object({ action: z.literal("submit"), id, version, answers: answersSchema.optional(), confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal("reject"), id, version, reason, confirmed: z.literal(true) }).strict(),
]);
export const intakeSubmissionDeleteSchema = z.object({ id, version, reason }).strict();

const intakeAgreementCurrency = z.string().trim().transform((value) => value.toUpperCase()).refine(
  (value) => canonicalCurrencyCode(value) !== null,
  "Currency must be a three-letter ISO-4217 code",
);
const intakeAgreementDate = (label: string) => z.string().trim().max(10).refine(
  (value) => value === "" || normalizeIsoDate(value) !== null,
  `${label} must be a valid date in YYYY-MM-DD format`,
).transform((value) => value === "" ? "" : normalizeIsoDate(value)!);
const intakeAgreementTags = z.array(text("Tag", 80)).max(40).default([]).transform(
  (values) => Array.from(new Set(values)),
);

/**
 * A submitted intake record is only a request. Conversion deliberately asks a
 * human to supply the bounded agreement projection and to confirm every
 * immutable configuration pin that was presented during review. Lifecycle,
 * risk, approval, ownership labels, and template/workflow state remain
 * server-owned.
 */
export const intakeSubmissionConvertSchema = z.object({
  version,
  formVersion: version,
  templateVersionId: id.nullable(),
  workflowDefinitionId: id.nullable(),
  ...confirmation,
  agreement: z.object({
    party: text("Counterparty"),
    side: z.enum(["Sell-side", "Buy-side", "Corporate"]),
    type: text("Agreement type", 200),
    value: z.coerce.number().int().nonnegative().max(9_000_000_000_000).default(0),
    valueMinor: z.coerce.number().int().nonnegative().max(MAX_MONEY_MINOR).optional(),
    currencyCode: intakeAgreementCurrency.default("USD"),
    ownerUserId: z.string().trim().min(1).max(200).optional(),
    primaryCounterpartyId: id.nullable().default(null),
    legalEntityId: id.nullable().default(null),
    due: text("Due", 100).default("Unscheduled"),
    crm: z.enum(["Salesforce", "HubSpot", "Custom CRM", "None"]).default("None"),
    crmRecord: optionalText(500),
    tags: intakeAgreementTags,
    department: text("Department", 100).default("Legal"),
    effectiveDate: intakeAgreementDate("Effective date").default(""),
    expirationDate: intakeAgreementDate("Expiration date").default(""),
  }).strict().superRefine((agreement, context) => {
    if (agreement.effectiveDate && agreement.expirationDate && agreement.expirationDate < agreement.effectiveDate) {
      context.addIssue({
        code: "custom",
        path: ["expirationDate"],
        message: "Expiration date must be on or after the effective date",
      });
    }
  }),
}).strict();
