import { z } from "zod";
import type { ActionId } from "./action-registry";
import type {
  RequiredApprovalRoutingInspection,
  RequiredApprovalRoutingPreview,
} from "./approval-routing-service";
import { normalizeIsoDate } from "./iso-date";
import { RequestValidationError } from "./validation";

const MAX_AGENT_RECORD_FIELDS = 100;

export const boundedAgentRecordSchema = z.record(
  z.string().min(1).max(128),
  z.unknown(),
).superRefine((value, context) => {
  if (Object.keys(value).length > MAX_AGENT_RECORD_FIELDS) {
    context.addIssue({ code: "custom", message: `At most ${MAX_AGENT_RECORD_FIELDS} top-level fields are allowed.` });
  }
});

const approvalDueSchema = z.string().length(10).refine(
  (value) => normalizeIsoDate(value) !== null,
  "Approval due date must be a valid date in YYYY-MM-DD format.",
);

/**
 * The agent chooses only the routing mode and due date. Roles, lane changes,
 * approval status, next action, actor attribution, and every durable effect
 * are derived from authoritative server state.
 */
export const approvalRequestInputSchema = z.object({
  mode: z.literal("ensure_required"),
  due: approvalDueSchema,
}).strict();

export type ApprovalRequestAgentInput = z.output<typeof approvalRequestInputSchema>;
export type ParsedAgentActionInput = ApprovalRequestAgentInput | Record<string, unknown>;

function validationError(error: z.ZodError, prefix: string): RequestValidationError {
  return new RequestValidationError(
    "Agent action input validation failed",
    error.issues.map((issue) => ({
      path: [prefix, ...issue.path.map(String)],
      message: issue.message,
    })),
    400,
    "invalid_action_input",
  );
}

export function parseAgentActionInput(
  actionId: "approval.request",
  input: unknown,
): ApprovalRequestAgentInput;
export function parseAgentActionInput(
  actionId: ActionId,
  input: unknown,
): ParsedAgentActionInput;
export function parseAgentActionInput(
  actionId: ActionId,
  input: unknown,
): ParsedAgentActionInput {
  const schema = actionId === "approval.request"
    ? approvalRequestInputSchema
    : boundedAgentRecordSchema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error, "input");
  return parsed.data;
}

function parseCallerProposedDiff(value: unknown): Record<string, unknown> {
  const parsed = boundedAgentRecordSchema.safeParse(value ?? {});
  if (!parsed.success) throw validationError(parsed.error, "proposedDiff");
  return parsed.data;
}

export type DerivedAgentActionPlanFields = Readonly<{
  input: ParsedAgentActionInput;
  preview: RequiredApprovalRoutingPreview | null;
  proposedDiff: Record<string, unknown>;
}>;

/**
 * Resolve the plan fields an agent is permitted to author. Approval routing is
 * deliberately asymmetric: any caller-authored proposed mutation is rejected,
 * and the exact preview/effect comes only from the shared server inspection.
 * Other actions retain the existing generic record planning contract.
 */
export function deriveAgentActionPlanFields(input: Readonly<{
  actionId: ActionId;
  actionInput: unknown;
  callerProposedDiff?: unknown;
  approvalRouting?: RequiredApprovalRoutingInspection | null;
}>): DerivedAgentActionPlanFields {
  const parsedInput = parseAgentActionInput(input.actionId, input.actionInput);
  const callerProposedDiff = parseCallerProposedDiff(input.callerProposedDiff ?? {});
  if (input.actionId !== "approval.request") {
    return { input: parsedInput, preview: null, proposedDiff: callerProposedDiff };
  }

  if (Object.keys(callerProposedDiff).length > 0) {
    throw new RequestValidationError(
      "Approval routing effects are derived by the server",
      [{
        path: ["proposedDiff"],
        message: "Do not submit approval roles, statuses, lane changes, or other mutation semantics.",
      }],
      400,
      "caller_authored_effect_forbidden",
    );
  }
  const routing = input.approvalRouting;
  if (!routing) {
    throw new RequestValidationError(
      "Approval routing preview is required",
      [{ path: ["input"], message: "The server could not derive the exact approval routing preview." }],
      409,
      "approval_routing_preview_required",
    );
  }
  const approvalInput = parsedInput as ApprovalRequestAgentInput;
  if (
    routing.preview.actionId !== "approval.request"
    || routing.preview.mode !== "ensure_required"
    || routing.preview.input.mode !== approvalInput.mode
    || routing.preview.input.due !== approvalInput.due
  ) {
    throw new RequestValidationError(
      "Approval routing preview does not match the action input",
      [{ path: ["input"], message: "Re-inspect the exact target using the submitted mode and due date." }],
      409,
      "approval_routing_preview_mismatch",
    );
  }
  return {
    input: approvalInput,
    preview: routing.preview,
    // Bind the target, exact existing lanes, policy reasons, blockers, and
    // resulting effect into the reviewed/digested plan—not just the patch.
    proposedDiff: { ...routing.preview },
  };
}
