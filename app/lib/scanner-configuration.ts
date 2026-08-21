import { NoticeConfigurationError } from "./notice-config";
import {
  isValidCustomerHostedOcrIdentifier,
  type CustomerHostedOcrProfile,
  type ScannerConfiguration,
} from "./document-security";

export type ScannerConfigurationSource = Record<string, unknown>;

function sourceBinding(source: ScannerConfigurationSource, name: string): string | null {
  const value = source[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sourceFlag(source: ScannerConfigurationSource, name: string): boolean | null {
  const value = sourceBinding(source, name);
  return value === "true" ? true : value === "false" ? false : null;
}

/**
 * Resolve the runtime scanner/OCR profile with the same exact lowercase
 * boolean and provider semantics enforced by deployment readiness.
 */
export function scannerConfigurationFromSource(source: ScannerConfigurationSource): ScannerConfiguration {
  const scannerReady = sourceFlag(source, "NOTICE_SCAN_ENABLED") === true
    && sourceBinding(source, "NOTICE_SCAN_PROVIDER") === "scan-gateway"
    && sourceFlag(source, "NOTICE_SCAN_CONFIGURED") === true;
  const ocrSelectionValue = sourceBinding(source, "NOTICE_SCAN_OCR_ENABLED");
  const ocrSelection = sourceFlag(source, "NOTICE_SCAN_OCR_ENABLED");
  const modelId = sourceBinding(source, "NOTICE_SCAN_OCR_MODEL_ID");
  const profileId = sourceBinding(source, "NOTICE_SCAN_OCR_PROFILE_ID");
  let ocr: CustomerHostedOcrProfile | null = null;
  if (ocrSelectionValue !== null && ocrSelection === null) {
    throw new NoticeConfigurationError("NOTICE_SCAN_OCR_ENABLED must explicitly select or disable customer-hosted OCR.");
  }
  if (ocrSelection === null) {
    throw new NoticeConfigurationError("NOTICE_SCAN_OCR_ENABLED must explicitly select or disable customer-hosted OCR.");
  }
  if (ocrSelection === true) {
    if (!modelId || !profileId || !isValidCustomerHostedOcrIdentifier(modelId) || !isValidCustomerHostedOcrIdentifier(profileId)) {
      throw new NoticeConfigurationError("Customer-hosted OCR requires bounded non-secret model and profile identifiers.");
    }
    ocr = Object.freeze({ modelId, profileId });
  } else if (modelId || profileId) {
    throw new NoticeConfigurationError("Disabled customer-hosted OCR must not retain model or profile identifiers.");
  }
  if (!scannerReady) {
    // Preserve a valid selection through an attestation window. The null
    // endpoint keeps new uploads quarantined and makes a previously clean
    // PDF/DOCX fail closed instead of looking explicitly OCR-disabled.
    return { endpoint: null, secret: null, ocr };
  }
  const secret = sourceBinding(source, "NOTICE_SCAN_GATEWAY_SECRET");
  return {
    endpoint: sourceBinding(source, "NOTICE_SCAN_GATEWAY_URL"),
    secret: secret && secret.length >= 32 ? secret : null,
    ocr,
  };
}
