const lawPatterns = [
  "Delaware",
  "New York",
  "California",
  "Texas",
  "Illinois",
  "Massachusetts",
  "Washington",
  "England and Wales",
  "England & Wales",
  "Germany",
  "France",
];

/**
 * Produce conservative metadata suggestions from readable document text.
 * These are deterministic heuristics for human review, not policy or accuracy
 * conclusions. Callers must not present them as playbook approval.
 */
export function extractDocumentMetadata(text: string, fileName: string) {
  // An unavailable parser or an image-only document is not evidence for any
  // agreement field. Preserve the complete response shape so the UI can offer
  // manual entry without turning filename/default heuristics into suggestions.
  if (!text.trim()) {
    return {
      tags: [] as string[],
      riskFlags: [] as string[],
      extracted: {
        side: "",
        type: "",
        governingLaw: "",
        paymentTerms: "",
        renewalNotice: "",
        counterparty: "",
        agreementValue: "",
        effectiveDate: "",
        expirationDate: "",
        liabilityCap: "",
      },
    };
  }

  const corpus = `${fileName}\n${text}`;
  const lower = corpus.toLowerCase();
  const corporate = /employment|employee|lease|partnership|shareholder|board consent|equity|separation agreement/.test(lower);
  const buySide = /supplier|vendor|procurement|purchase|we are the customer|software subscription|licensor/.test(lower);
  const side = corporate ? "Corporate" : buySide ? "Buy-side" : "Sell-side";
  const type = /non[- ]?disclosure|\bnda\b/.test(lower)
    ? "Mutual NDA"
    : /order form/.test(lower)
      ? "Order Form"
      : /data processing|\bdpa\b/.test(lower)
        ? "Data Processing Addendum"
        : /professional services|statement of work|\bsow\b/.test(lower)
          ? "Professional Services Agreement"
          : /software subscription|subscription agreement/.test(lower)
            ? "Software Subscription Agreement"
            : /employment agreement/.test(lower)
              ? "Employment Agreement"
              : /lease|tenancy/.test(lower)
                ? "Lease Agreement"
                : /partnership|referral agreement/.test(lower)
                  ? "Partnership Agreement"
                  : "Master Services Agreement";
  const law = lawPatterns.find((candidate) => lower.includes(candidate.toLowerCase())) ?? "Not detected";
  const paymentMatch = lower.match(/(?:net\s*(\d{2,3})|within\s+(\d{2,3})\s*days?)/);
  const payment = paymentMatch?.[1] ?? paymentMatch?.[2];
  const notice = lower.match(/(\d{1,3})\s*(?:days?)[^\n.]{0,70}(?:non-renewal|renewal notice|written notice)/)?.[1];
  const moneyMatch = corpus.match(/(?:USD|US\$|\$)\s?([\d]+(?:,[\d]{3})*(?:\.[\d]{1,2})?)/i)?.[1];
  const effectiveMatch = corpus.match(/effective(?:\s+date|\s+as\s+of)?[:\s]+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i)?.[1];
  const expirationMatch = corpus.match(/(?:expiration|expiry|end)\s+date[:\s]+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i)?.[1];
  const liability = /unlimited liability/.test(lower)
    ? "Unlimited"
    : lower.match(/(?:liability|aggregate liability)[^\n.]{0,100}(two times|three times|[123]x|fees paid[^\n.]{0,50})/)?.[1] ?? "Not detected";
  const tags = [side, type === "Master Services Agreement" ? "MSA" : type, law === "Not detected" ? "Law unconfirmed" : `${law} law`];
  if (/auto(?:matic(?:ally)?)?[- ]?renew|renews automatically/.test(lower)) tags.push("Auto-renew");
  if (/data processing|\bdpa\b/.test(lower)) tags.push("DPA attached");
  if (/two times|three times|[23]x|2×|3×/.test(lower)) tags.push("Liability multiplier detected");
  if (/personally identifiable|personal data|customer data|confidential information/.test(lower)) tags.push("Data terms");
  if (/change of control/.test(lower)) tags.push("Change of control");

  const riskFlags: string[] = [];
  if (tags.includes("Liability multiplier detected") || liability === "Unlimited") {
    riskFlags.push("Liability language needs comparison with the workspace's approved position.");
  }
  if (tags.includes("Auto-renew") && !notice) {
    riskFlags.push("Auto-renewal language was found without a clearly extracted notice window; confirm the source text.");
  }
  if (/exclusive|exclusivity/.test(lower)) {
    riskFlags.push("Exclusivity language was found; confirm the required business review.");
  }
  if (/assign(?:ment)?[^\n.]{0,60}consent/.test(lower)) {
    riskFlags.push("Assignment-consent language was found; confirm the approved legal position.");
  }

  return {
    tags: Array.from(new Set(tags)),
    riskFlags,
    extracted: {
      side,
      type,
      governingLaw: law,
      paymentTerms: payment ? `Net ${payment}` : "Not detected",
      renewalNotice: notice ? `${notice} days` : "Not detected",
      counterparty: fileName.split(/[—_-]/)[0]?.replace(/\.(pdf|docx?|txt|rtf)$/i, "").trim() || "Imported counterparty",
      agreementValue: moneyMatch ? `$${moneyMatch}` : "Not detected",
      effectiveDate: effectiveMatch ?? "Not detected",
      expirationDate: expirationMatch ?? "Not detected",
      liabilityCap: liability,
    },
  };
}
