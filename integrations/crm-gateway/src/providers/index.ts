import { CustomWebhookAdapter } from "./custom";
import { HubSpotAdapter } from "./hubspot";
import { SalesforceAdapter } from "./salesforce";
import type { CrmAdapter } from "./types";
import { readProviderName } from "./validation";

export type {
  AgreementProjection,
  AgreementTombstone,
  CanonicalCrmEvent,
  CrmAdapter,
  CrmProvider,
  CrmUpsertResult,
} from "./types";
export { CrmProviderError } from "./types";

export function createCrmAdapter(env: Record<string, unknown>): CrmAdapter {
  const provider = readProviderName(env);
  if (provider === "hubspot") return new HubSpotAdapter(env);
  if (provider === "salesforce") return new SalesforceAdapter(env);
  return new CustomWebhookAdapter(env);
}
