import type { NegotiationRoundStatus, NegotiationSubmissionSource, NegotiationSubmissionStatus } from "../../db/schema";

const ACCEPTING_ROUND_STATUSES = new Set<NegotiationRoundStatus>(["prepared", "outbound", "returned", "review"]);

export function roundAcceptsNegotiationIngress(input: Readonly<{
  source: NegotiationSubmissionSource;
  roundStatus: NegotiationRoundStatus;
  active: boolean;
}>): boolean {
  return input.active
    && ACCEPTING_ROUND_STATUSES.has(input.roundStatus)
    && (input.source !== "email" || input.roundStatus !== "prepared");
}

export function shouldAdvanceNegotiationRound(statuses: readonly NegotiationSubmissionStatus[]): boolean {
  return statuses.some((status) => status === "ready");
}
