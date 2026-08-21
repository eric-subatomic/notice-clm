const PUBLIC_SIGNER_FIELDS = ["role", "email", "name", "submitterId", "status"] as const;

export const FINAL_SIGNATURE_REVIEW_CONFIRMATION = "I confirm I reviewed the final signed artifact and its exact approved agreement basis.";

type CompletedSignatureReviewBinding = Readonly<{
  packet: Readonly<{
    status: string;
    activeKey: string | null;
    completedAt: string | null;
    basisHash: string;
    documentVersion: number;
    documentSha256: string;
    evidenceDocumentId: string | null;
    signers: unknown;
  }>;
  agreement: Readonly<{
    version: number;
    stage: string;
    signatureStatus: string;
    nextAction: string;
  }>;
  currentBasis: Readonly<{
    hash: string;
    documentVersion: number;
    documentSha256: string;
  }>;
  artifact: Readonly<{
    id: string;
    sha256: string;
  }>;
  review: Readonly<{
    agreementVersion: number;
    basisHash: string;
    documentVersion: number;
    documentSha256: string;
    evidenceDocumentId: string;
    finalArtifactSha256: string;
    confirmed: true;
    confirmation: string;
  }>;
}>;

/**
 * A human activation decision is valid only for the exact provider evidence,
 * agreement version, current approved paper, and retained artifact the reviewer
 * saw. This pure predicate is repeated by guarded database predicates at the
 * commit boundary so a stale decision cannot win a concurrent mutation.
 */
export function completedSignatureReviewBindingMatches(input: CompletedSignatureReviewBinding): boolean {
  const { packet, agreement, currentBasis, artifact, review } = input;
  const everySignerCompleted = Array.isArray(packet.signers)
    && packet.signers.length > 0
    && packet.signers.every((signer) => Boolean(signer) && typeof signer === "object" && (signer as Record<string, unknown>).status === "completed");
  return packet.status === "completed_review_required"
    && typeof packet.activeKey === "string"
    && packet.activeKey.length > 0
    && typeof packet.completedAt === "string"
    && packet.completedAt.length > 0
    && everySignerCompleted
    && agreement.version === review.agreementVersion
    && agreement.stage === "Signature"
    && agreement.signatureStatus === "completed_review_required"
    && agreement.nextAction === "Review completed signature evidence"
    && packet.basisHash === review.basisHash
    && packet.documentVersion === review.documentVersion
    && packet.documentSha256 === review.documentSha256
    && packet.evidenceDocumentId === review.evidenceDocumentId
    && currentBasis.hash === review.basisHash
    && currentBasis.documentVersion === review.documentVersion
    && currentBasis.documentSha256 === review.documentSha256
    && artifact.id === review.evidenceDocumentId
    && artifact.sha256 === review.finalArtifactSha256
    && review.confirmed === true
    && review.confirmation === FINAL_SIGNATURE_REVIEW_CONFIRMATION;
}

export function isTerminalSignaturePacketStatus(status: string): boolean {
  // Provider reconciliation is terminal once complete evidence is retained,
  // even though a current packet remains workflow-actionable until an
  // authorized human reviews that exact evidence.
  return status === "completed_review_required"
    || status === "completed"
    || status === "completed_superseded";
}

type SignaturePacketRecord = Readonly<{
  signers: unknown;
  [key: string]: unknown;
}>;

/**
 * Signing URLs are bearer capabilities. Production never exposes or stores
 * provider signer URLs. List, audit, and offboarding responses expose only
 * durable signer evidence.
 */
export function sanitizeSignaturePacket<T extends SignaturePacketRecord>(packet: T): Omit<T, "signers"> & {
  signers: Array<Record<(typeof PUBLIC_SIGNER_FIELDS)[number], unknown>>;
} {
  const signers = Array.isArray(packet.signers)
    ? packet.signers.map((candidate) => sanitizeSigner(candidate))
    : [];
  return { ...packet, signers };
}

/**
 * Refresh durable signer evidence from the authoritative completed submission
 * without ever copying provider capabilities or additive unknown fields.
 */
export function reconcileCompletedSignerEvidence(
  storedSigners: unknown,
  providerSubmitters: unknown,
): Array<Record<(typeof PUBLIC_SIGNER_FIELDS)[number], unknown>> {
  return reconcileProviderSignerEvidence(storedSigners, providerSubmitters, null, "completed");
}

/** Map a provider creation/recovery response without retaining its signing
 * capabilities. Missing provider status remains pending rather than becoming
 * false completion evidence. */
export function reconcilePendingSignerEvidence(
  storedSigners: unknown,
  providerSubmitters: unknown,
): Array<Record<(typeof PUBLIC_SIGNER_FIELDS)[number], unknown>> {
  return reconcileProviderSignerEvidence(storedSigners, providerSubmitters, "pending");
}

function reconcileProviderSignerEvidence(
  storedSigners: unknown,
  providerSubmitters: unknown,
  fallbackStatus: "pending" | null,
  requiredStatus?: "completed",
): Array<Record<(typeof PUBLIC_SIGNER_FIELDS)[number], unknown>> {
  const stored = Array.isArray(storedSigners) ? storedSigners : [];
  const provider = Array.isArray(providerSubmitters)
    ? providerSubmitters.filter((candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === "object")
    : [];
  if (stored.length === 0 || provider.length !== stored.length) {
    throw new Error("DocuSeal signer evidence did not match the expected signer count");
  }
  const unusedProviderIndexes = new Set(provider.map((_, index) => index));

  return stored.map((candidate, index) => {
    const safe = sanitizeSigner(candidate);
    const submitterId = safe.submitterId;
    const email = typeof safe.email === "string" ? safe.email.toLowerCase() : null;
    const storedId = submitterId === undefined || submitterId === null ? null : String(submitterId);
    const matchedIndex = provider.findIndex((entry, providerIndex) => {
      if (!unusedProviderIndexes.has(providerIndex)) return false;
      const providerId = entry.id === undefined || entry.id === null ? null : String(entry.id);
      const providerEmail = typeof entry.email === "string" ? entry.email.trim().toLowerCase() : null;
      const providerStatus = typeof entry.status === "string" ? entry.status.trim().toLowerCase() : null;
      const requiresVerifiedEmail = Boolean(requiredStatus) || providerStatus === "completed" || providerStatus === "declined";
      const atLeastOneIdentifierMatches = (storedId !== null && providerId === storedId) || (email !== null && providerEmail === email);
      const idsAgree = storedId === null || providerId === null || providerId === storedId;
      const emailsAgree = email === null || providerEmail === null || providerEmail === email;
      const terminalEmailVerified = !requiresVerifiedEmail || (email !== null && providerEmail === email);
      return atLeastOneIdentifierMatches && idsAgree && emailsAgree && terminalEmailVerified;
    });
    if (matchedIndex < 0) throw new Error(`DocuSeal signer evidence did not match expected signer ${index + 1}`);
    const matched = provider[matchedIndex];
    unusedProviderIndexes.delete(matchedIndex);
    const status = typeof matched?.status === "string" && matched.status.trim()
      ? matched.status.trim().slice(0, 100)
      : fallbackStatus;
    if (!status) throw new Error(`DocuSeal signer ${index + 1} has no verified completion status`);
    if (requiredStatus && status !== requiredStatus) throw new Error(`DocuSeal signer ${index + 1} is not completed`);
    const reconciled = {
      ...safe,
      ...(matched && (typeof matched.id === "number" || typeof matched.id === "string") ? { submitterId: matched.id } : {}),
      status,
    };
    return sanitizeSigner(reconciled);
  });
}

/**
 * Apply one authenticated form-level provider event to the matching durable
 * signer without retaining links, slugs, IP addresses, user agents, or other
 * provider payload fields.
 */
export function reconcileSignerEventEvidence(
  storedSigners: unknown,
  providerSubmitter: unknown,
  status: "completed" | "declined",
): { signers: Array<Record<(typeof PUBLIC_SIGNER_FIELDS)[number], unknown>>; matched: boolean } {
  const stored = Array.isArray(storedSigners) ? storedSigners.map((candidate) => sanitizeSigner(candidate)) : [];
  const provider = providerSubmitter && typeof providerSubmitter === "object"
    ? providerSubmitter as Record<string, unknown>
    : {};
  const providerId = typeof provider.id === "number" || typeof provider.id === "string" ? String(provider.id) : null;
  const providerEmail = typeof provider.email === "string" ? provider.email.trim().toLowerCase() : null;
  let matched = false;
  const signers = stored.map((signer) => {
    const signerId = signer.submitterId === undefined || signer.submitterId === null ? null : String(signer.submitterId);
    const signerEmail = typeof signer.email === "string" ? signer.email.trim().toLowerCase() : null;
    const atLeastOneIdentifierMatches = (providerId !== null && signerId === providerId) || (providerEmail !== null && signerEmail === providerEmail);
    const idsAgree = providerId === null || signerId === null || signerId === providerId;
    const emailsAgree = providerEmail === null || signerEmail === null || signerEmail === providerEmail;
    const eventEmailVerified = signerEmail !== null && providerEmail === signerEmail;
    if (!matched && atLeastOneIdentifierMatches && idsAgree && emailsAgree && eventEmailVerified) {
      matched = true;
      return sanitizeSigner({
        ...signer,
        ...(providerId !== null && signerId === null ? { submitterId: provider.id } : {}),
        status,
      });
    }
    return signer;
  });
  return { signers, matched };
}

function sanitizeSigner(candidate: unknown): Record<(typeof PUBLIC_SIGNER_FIELDS)[number], unknown> {
  const source = candidate && typeof candidate === "object"
    ? candidate as Record<string, unknown>
    : {};
  return Object.fromEntries(
    PUBLIC_SIGNER_FIELDS
      .filter((field) => Object.hasOwn(source, field))
      .map((field) => [field, source[field]]),
  ) as Record<(typeof PUBLIC_SIGNER_FIELDS)[number], unknown>;
}
