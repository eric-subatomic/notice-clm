import { z } from "zod";
import { enterpriseContentDigest, EnterpriseError } from "./enterprise-domain";

const SAFE_LANE = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/u;
const boundedText = (label: string, max: number) => z.string().trim().min(1, `${label} is required`).max(max)
  .regex(SAFE_LANE, `${label} contains unsafe formatting characters`);
const uniqueTextList = (label: string, maxItems: number, itemMax: number) => z.array(boundedText(label, itemMax)).min(1).max(maxItems)
  .refine((values) => new Set(values).size === values.length, `${label} values must be unique`);

const workflowConditionSchema = z.object({
  sides: z.array(z.enum(["Sell-side", "Buy-side", "Corporate"])).min(1).max(3).optional(),
  agreementTypes: uniqueTextList("Agreement type", 50, 120).optional(),
  departments: uniqueTextList("Department", 50, 120).optional(),
  riskLevels: z.array(z.enum(["Unassessed", "Low", "Medium", "High"])).min(1).max(4)
    .refine((values) => new Set(values).size === values.length, "Risk levels must be unique").optional(),
  riskDispositions: z.array(z.enum(["pending", "assessed", "waived"])).min(1).max(3)
    .refine((values) => new Set(values).size === values.length, "Risk dispositions must be unique").optional(),
  currencyCodes: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(50)
    .refine((values) => new Set(values).size === values.length, "Currency codes must be unique").optional(),
  minimumValueMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maximumValueMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().superRefine((condition, context) => {
  if (condition.minimumValueMinor !== undefined && condition.maximumValueMinor !== undefined
    && condition.minimumValueMinor > condition.maximumValueMinor) {
    context.addIssue({ code: "custom", path: ["maximumValueMinor"], message: "Maximum value must be greater than or equal to minimum value" });
  }
});

const workflowLaneSchema = z.object({
  lane: boundedText("Approval lane", 120),
  when: workflowConditionSchema.optional(),
}).strict();

/**
 * Notice's first governed workflow contract is deliberately narrow: it only
 * replaces approval-lane routing. Every condition is ANDed; values inside one
 * condition are ORed. At least one unconditional lane ensures every agreement
 * has a fail-closed human review path.
 */
export const governedWorkflowDefinitionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  approvalLanes: z.array(workflowLaneSchema).min(1).max(20),
}).strict().superRefine((definition, context) => {
  const normalized = definition.approvalLanes.map((entry) => entry.lane.toLocaleLowerCase("en-US"));
  if (new Set(normalized).size !== normalized.length) {
    context.addIssue({ code: "custom", path: ["approvalLanes"], message: "Approval lane names must be unique" });
  }
  if (!definition.approvalLanes.some((entry) => entry.when === undefined)) {
    context.addIssue({ code: "custom", path: ["approvalLanes"], message: "At least one approval lane must apply unconditionally" });
  }
});

export type GovernedWorkflowDefinition = z.infer<typeof governedWorkflowDefinitionSchema>;

export type WorkflowPolicyAgreement = Readonly<{
  side: string;
  type: string;
  department: string;
  risk: string;
  riskDisposition?: string | null;
  value: number;
  valueMinor?: number;
  currencyCode?: string;
}>;

export function parseGovernedWorkflowDefinition(value: unknown): GovernedWorkflowDefinition {
  const result = governedWorkflowDefinitionSchema.safeParse(value);
  if (!result.success) {
    throw new EnterpriseError(422, "invalid_workflow_definition", "Workflow definitions must use the supported governed approval-policy format.", {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}

function conditionMatches(condition: z.infer<typeof workflowConditionSchema>, agreement: WorkflowPolicyAgreement): boolean {
  const valueMinor = agreement.valueMinor ?? agreement.value * 100;
  const currencyCode = agreement.currencyCode ?? "USD";
  const riskDisposition = agreement.riskDisposition === "assessed" || agreement.riskDisposition === "waived"
    ? agreement.riskDisposition
    : "pending";
  return (condition.sides === undefined || condition.sides.includes(agreement.side as "Sell-side" | "Buy-side" | "Corporate"))
    && (condition.agreementTypes === undefined || condition.agreementTypes.includes(agreement.type))
    && (condition.departments === undefined || condition.departments.includes(agreement.department))
    && (condition.riskLevels === undefined || condition.riskLevels.includes(agreement.risk as "Unassessed" | "Low" | "Medium" | "High"))
    && (condition.riskDispositions === undefined || condition.riskDispositions.includes(riskDisposition))
    && (condition.currencyCodes === undefined || condition.currencyCodes.includes(currencyCode))
    && (condition.minimumValueMinor === undefined || valueMinor >= condition.minimumValueMinor)
    && (condition.maximumValueMinor === undefined || valueMinor <= condition.maximumValueMinor);
}

export function evaluateGovernedWorkflowApprovalLanes(
  definition: GovernedWorkflowDefinition,
  agreement: WorkflowPolicyAgreement,
): string[] {
  return definition.approvalLanes
    .filter((entry) => entry.when === undefined || conditionMatches(entry.when, agreement))
    .map((entry) => entry.lane);
}

export async function governedWorkflowSnapshot(
  definitionValue: unknown,
  agreement: WorkflowPolicyAgreement,
): Promise<Readonly<{ definition: GovernedWorkflowDefinition; policySha256: string; approvalLanes: string[] }>> {
  const definition = parseGovernedWorkflowDefinition(definitionValue);
  const approvalLanes = evaluateGovernedWorkflowApprovalLanes(definition, agreement);
  // The schema guarantees at least one unconditional lane; keep the runtime
  // assertion so future schema changes cannot silently create an open route.
  if (approvalLanes.length === 0) {
    throw new EnterpriseError(422, "workflow_has_no_review_path", "The workflow does not produce a required approval lane for this agreement.");
  }
  return {
    definition,
    policySha256: await enterpriseContentDigest(definition),
    approvalLanes,
  };
}
