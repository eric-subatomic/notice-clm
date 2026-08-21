export function canMarkNegotiationSubmissionReady(input: Readonly<{
  submissionStatus: string;
  documentScanStatus: string;
  roundIsCurrentAndActive: boolean;
}>): boolean {
  return input.roundIsCurrentAndActive
    && input.documentScanStatus === "clean"
    && (input.submissionStatus === "sender_review" || input.submissionStatus === "quarantined");
}
