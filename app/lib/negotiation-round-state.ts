import type { NegotiationRoundStatus, NegotiationSubmissionStatus } from "../../db/schema";

export type NegotiationDeliveryState = "not_queued" | "queued" | "processing" | "accepted" | "dead" | "manual_recorded";

export type NegotiationRoundAction = Readonly<{
  roundStatus: NegotiationRoundStatus;
  nextAction: string;
}>;

export function negotiationDeliveryState(input: Readonly<{
  deliveryMethod: "manual" | "email_gateway" | "portal" | null;
  outboxStatus?: "pending" | "processing" | "processed" | "dead" | null;
}>): NegotiationDeliveryState {
  if (input.deliveryMethod === "manual") return "manual_recorded";
  if (input.deliveryMethod !== "email_gateway") return "not_queued";
  if (input.outboxStatus === "processing") return "processing";
  if (input.outboxStatus === "processed") return "accepted";
  if (input.outboxStatus === "dead") return "dead";
  return "queued";
}

/**
 * Derive the one business queue action for an active round from all recorded
 * submissions. Higher-priority evidence can never be hidden by a later,
 * lower-priority message.
 */
export function deriveNegotiationRoundAction(input: Readonly<{
  roundNumber: number;
  currentStatus: NegotiationRoundStatus;
  submissionStatuses: readonly NegotiationSubmissionStatus[];
  deliveryState?: NegotiationDeliveryState;
}>): NegotiationRoundAction {
  const statuses = new Set(input.submissionStatuses);
  if (statuses.has("ready")) {
    return {
      roundStatus: "returned",
      nextAction: `Review returned counterparty file for negotiation round ${input.roundNumber}`,
    };
  }
  if (statuses.has("sender_review")) {
    return {
      roundStatus: "review",
      nextAction: `Verify the sender of a returned file for negotiation round ${input.roundNumber}`,
    };
  }
  if (statuses.has("quarantined")) {
    return {
      roundStatus: "review",
      nextAction: `Rescan a quarantined return for negotiation round ${input.roundNumber}`,
    };
  }
  if (statuses.has("rejected")) {
    return {
      roundStatus: "review",
      nextAction: `Request a safe replacement for negotiation round ${input.roundNumber}`,
    };
  }
  if (statuses.has("no_attachment")) {
    return {
      roundStatus: "review",
      nextAction: `Follow up: negotiation round ${input.roundNumber} received no attachment`,
    };
  }

  if (input.deliveryState === "dead") {
    return {
      roundStatus: "outbound",
      nextAction: `Close failed delivery round ${input.roundNumber} and prepare a new review round`,
    };
  }
  if (input.deliveryState === "queued" || input.deliveryState === "processing") {
    return {
      roundStatus: "outbound",
      nextAction: `Confirm gateway delivery for negotiation round ${input.roundNumber}`,
    };
  }
  if (input.currentStatus === "prepared") {
    return {
      roundStatus: "prepared",
      nextAction: `Send negotiation round ${input.roundNumber} to the counterparty`,
    };
  }
  return {
    roundStatus: "outbound",
    nextAction: `Await counterparty response for negotiation round ${input.roundNumber}`,
  };
}
