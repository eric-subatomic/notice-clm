import { apiError } from "./http";
import { crmProviderForAgreementSelection } from "./integration-events";
import { getCrmConfiguration } from "./providers";

/** Keep every agreement-creation path behind the same attested CRM boundary. */
export function configuredCrmSelectionError(
  selection: string,
  requestId: string,
  headers: HeadersInit,
): Response | null {
  const target = crmProviderForAgreementSelection(selection);
  if (selection === "None") return null;
  try {
    const configuration = getCrmConfiguration();
    if (target && configuration?.provider === target) return null;
  } catch {
    // Configuration errors are mapped to one stable, non-secret operator action.
  }
  return apiError(
    "crm_provider_unavailable",
    "The selected CRM is not the currently configured and attested provider. Ask an administrator to finish that provider setup before linking this record.",
    { status: 409, requestId, headers },
  );
}
