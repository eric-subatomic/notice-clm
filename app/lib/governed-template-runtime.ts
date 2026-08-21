import { z } from "zod";
import { enterpriseContentDigest } from "./enterprise-domain";

export const GOVERNED_TEMPLATE_BODY_MAX_LENGTH = 500_000;
export const GOVERNED_TEMPLATE_OUTPUT_MAX_BYTES = 800_000;
export const GOVERNED_TEMPLATE_VARIABLE_MAX_COUNT = 64;
export const GOVERNED_TEMPLATE_VARIABLE_VALUE_MAX_LENGTH = 4_000;
export const GOVERNED_TEMPLATE_VARIABLES_MAX_BYTES = 32_768;

const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const UNSAFE_BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_VARIABLE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g;

const SYSTEM_VARIABLES = new Set(["organization"]);
const AGREEMENT_VARIABLES = new Set([
  "party",
  "side",
  "type",
  "effectiveDate",
  "expirationDate",
  "governingLaw",
  "due",
  "department",
  "currencyCode",
]);
const PROTECTED_VARIABLES = new Set([...SYSTEM_VARIABLES, ...AGREEMENT_VARIABLES]);

const variableNameSchema = z.string().regex(VARIABLE_NAME);
const variableDefinitionSchema = z.object({
  type: z.literal("string"),
  source: z.enum(["system", "agreement", "input"]),
  required: z.boolean(),
  maxLength: z.number().int().min(1).max(GOVERNED_TEMPLATE_VARIABLE_VALUE_MAX_LENGTH),
}).strict();

/**
 * Governed template variable schema v1.
 *
 * Bodies use exact `{{variableName}}` placeholders. `organization` is the sole
 * system variable. The agreement source accepts only the names listed in
 * `AGREEMENT_VARIABLES`; their values come from the validated creation
 * request. Every other name must use the input source and be supplied through
 * `templateVariables`. All schema and definition objects are closed.
 */
export const governedTemplateVariableSchemaV1 = z.object({
  version: z.literal(1),
  variables: z.record(variableNameSchema, variableDefinitionSchema),
}).strict().superRefine((schema, context) => {
  const entries = Object.entries(schema.variables);
  if (entries.length > GOVERNED_TEMPLATE_VARIABLE_MAX_COUNT) {
    context.addIssue({
      code: "too_big",
      origin: "object",
      maximum: GOVERNED_TEMPLATE_VARIABLE_MAX_COUNT,
      inclusive: true,
      path: ["variables"],
      message: `A governed template may declare at most ${GOVERNED_TEMPLATE_VARIABLE_MAX_COUNT} variables.`,
    });
  }
  for (const [name, definition] of entries) {
    const validSource = definition.source === "system"
      ? SYSTEM_VARIABLES.has(name)
      : definition.source === "agreement"
        ? AGREEMENT_VARIABLES.has(name)
        : !PROTECTED_VARIABLES.has(name);
    if (!validSource) {
      context.addIssue({
        code: "custom",
        path: ["variables", name, "source"],
        message: `Variable ${name} does not belong to the declared source.`,
      });
    }
  }
});

export type GovernedTemplateVariableSchemaV1 = z.infer<typeof governedTemplateVariableSchemaV1>;

export class GovernedTemplateRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
    this.name = "GovernedTemplateRuntimeError";
  }
}

export async function governedTemplateContentDigest(input: Readonly<{
  body: string;
  variableSchema: Record<string, unknown>;
  languageBlockIds: readonly number[];
}>): Promise<string> {
  return enterpriseContentDigest({
    body: input.body,
    variableSchema: input.variableSchema,
    languageBlockIds: input.languageBlockIds,
  }, 600_000);
}

export function validateGovernedTemplateArtifact(
  input: Readonly<{ body: string; variableSchema: unknown }>,
  status: 400 | 409 = 400,
): GovernedTemplateVariableSchemaV1 {
  if (typeof input.body !== "string" || input.body.length < 1 || input.body.length > GOVERNED_TEMPLATE_BODY_MAX_LENGTH) {
    throw new GovernedTemplateRuntimeError(
      "invalid_template_body",
      "The governed template body is empty or exceeds the supported length.",
      status,
    );
  }
  if (UNSAFE_BODY_CONTROL.test(input.body)) {
    throw new GovernedTemplateRuntimeError(
      "unsafe_template_body",
      "The governed template body contains unsupported control or directional formatting characters.",
      status,
    );
  }

  const parsedSchema = governedTemplateVariableSchemaV1.safeParse(input.variableSchema);
  if (!parsedSchema.success) {
    throw new GovernedTemplateRuntimeError(
      "invalid_template_variable_schema",
      "The governed template does not use the supported governed variable schema v1.",
      status,
    );
  }

  const placeholders = [...input.body.matchAll(PLACEHOLDER)];
  for (const placeholder of placeholders) {
    const name = placeholder[1];
    if (!Object.hasOwn(parsedSchema.data.variables, name)) {
      throw new GovernedTemplateRuntimeError(
        "unknown_template_placeholder",
        `Template placeholder ${name} is not declared by the governed variable schema.`,
        status,
      );
    }
  }
  const bodyWithoutPlaceholders = input.body.replace(PLACEHOLDER, "");
  if (bodyWithoutPlaceholders.includes("{{") || bodyWithoutPlaceholders.includes("}}")) {
    throw new GovernedTemplateRuntimeError(
      "invalid_template_placeholder",
      "The governed template contains a malformed placeholder.",
      status,
    );
  }
  return parsedSchema.data;
}

function assertSafeVariable(name: string, value: string, maxLength: number): void {
  if (value.length > maxLength) {
    throw new GovernedTemplateRuntimeError(
      "template_variable_too_long",
      `Template variable ${name} exceeds its published maximum length.`,
    );
  }
  if (UNSAFE_VARIABLE_CONTROL.test(value)) {
    throw new GovernedTemplateRuntimeError(
      "unsafe_template_variable",
      `Template variable ${name} contains control or directional formatting characters.`,
    );
  }
}

function exactSourceValue(
  name: string,
  source: "system" | "agreement" | "input",
  systemVariables: Readonly<Record<string, string>>,
  agreementVariables: Readonly<Record<string, string>>,
  inputVariables: Readonly<Record<string, string>>,
): string | undefined {
  const variables = source === "system"
    ? systemVariables
    : source === "agreement"
      ? agreementVariables
      : inputVariables;
  return Object.hasOwn(variables, name) ? variables[name] : undefined;
}

export async function renderGovernedTemplate(input: Readonly<{
  body: string;
  variableSchema: unknown;
  languageBlockIds: readonly number[];
  contentSha256: string;
  organization: string;
  agreementVariables: Readonly<Record<string, string>>;
  templateVariables?: Readonly<Record<string, string>>;
}>): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(input.contentSha256)) {
    throw new GovernedTemplateRuntimeError(
      "invalid_template_digest",
      "The published template digest is invalid.",
      409,
    );
  }
  const schema = validateGovernedTemplateArtifact({
    body: input.body,
    variableSchema: input.variableSchema,
  }, 409);

  let digest: string;
  try {
    digest = await governedTemplateContentDigest({
      body: input.body,
      variableSchema: input.variableSchema as Record<string, unknown>,
      languageBlockIds: input.languageBlockIds,
    });
  } catch {
    throw new GovernedTemplateRuntimeError(
      "invalid_template_artifact",
      "The published template artifact exceeds the supported deterministic bounds.",
      409,
    );
  }
  if (digest !== input.contentSha256) {
    throw new GovernedTemplateRuntimeError(
      "template_digest_mismatch",
      "The published template no longer matches its immutable digest.",
      409,
    );
  }

  const templateVariables = input.templateVariables ?? {};
  const templateVariableEntries = Object.entries(templateVariables);
  if (templateVariableEntries.length > GOVERNED_TEMPLATE_VARIABLE_MAX_COUNT) {
    throw new GovernedTemplateRuntimeError(
      "too_many_template_variables",
      `At most ${GOVERNED_TEMPLATE_VARIABLE_MAX_COUNT} template variables may be supplied.`,
    );
  }
  if (new TextEncoder().encode(JSON.stringify(templateVariables)).byteLength > GOVERNED_TEMPLATE_VARIABLES_MAX_BYTES) {
    throw new GovernedTemplateRuntimeError(
      "template_variables_too_large",
      `Template variables may use at most ${GOVERNED_TEMPLATE_VARIABLES_MAX_BYTES} encoded bytes.`,
    );
  }
  const definitions = new Map(Object.entries(schema.variables));
  for (const [name, value] of templateVariableEntries) {
    const definition = definitions.get(name);
    if (!definition) {
      throw new GovernedTemplateRuntimeError(
        "unknown_template_variable",
        `Template variable ${name} is not declared by the published schema.`,
      );
    }
    if (definition.source !== "input") {
      throw new GovernedTemplateRuntimeError(
        "protected_template_variable",
        `Template variable ${name} is owned by the server and cannot be supplied by the caller.`,
      );
    }
    if (typeof value !== "string") {
      throw new GovernedTemplateRuntimeError(
        "invalid_template_variable",
        `Template variable ${name} must be plain text.`,
      );
    }
  }

  const systemVariables = { organization: input.organization };
  const resolved = new Map<string, string>();
  for (const [name, definition] of Object.entries(schema.variables)) {
    const value = exactSourceValue(
      name,
      definition.source,
      systemVariables,
      input.agreementVariables,
      templateVariables,
    );
    if (value !== undefined && typeof value !== "string") {
      throw new GovernedTemplateRuntimeError(
        "invalid_template_variable",
        `Template variable ${name} must be plain text.`,
      );
    }
    if (value === undefined || (definition.required && value.length === 0)) {
      if (definition.required) {
        throw new GovernedTemplateRuntimeError(
          "missing_template_variable",
          `Required template variable ${name} is missing.`,
        );
      }
      continue;
    }
    assertSafeVariable(name, value, definition.maxLength);
    resolved.set(name, value);
  }

  const placeholders = [...input.body.matchAll(PLACEHOLDER)];
  for (const placeholder of placeholders) {
    const name = placeholder[1];
    if (!definitions.has(name)) {
      throw new GovernedTemplateRuntimeError(
        "unknown_template_placeholder",
        `Template placeholder ${name} is not declared by the published schema.`,
        409,
      );
    }
    if (!resolved.has(name)) {
      throw new GovernedTemplateRuntimeError(
        "unresolved_template_placeholder",
        `Template placeholder ${name} has no value.`,
      );
    }
  }

  const rendered = input.body.replace(PLACEHOLDER, (_placeholder, name: string) => resolved.get(name) ?? "");
  if (rendered.includes("{{") || rendered.includes("}}")) {
    throw new GovernedTemplateRuntimeError(
      "unresolved_template_placeholder",
      "The published template contains an invalid or unresolved placeholder.",
      409,
    );
  }
  if (new TextEncoder().encode(rendered).byteLength > GOVERNED_TEMPLATE_OUTPUT_MAX_BYTES) {
    throw new GovernedTemplateRuntimeError(
      "template_output_too_large",
      "The rendered template exceeds the supported output size.",
    );
  }
  return rendered;
}
