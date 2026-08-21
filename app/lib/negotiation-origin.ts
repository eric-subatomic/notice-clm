export function negotiationPublicOrigin(
  config: Readonly<{ mode: "evaluation" | "production"; publicBaseUrl: string | null }>,
  requestUrl: string,
): string {
  if (config.mode === "production") {
    if (!config.publicBaseUrl) throw new Error("Production negotiation links require the canonical public base URL.");
    return config.publicBaseUrl;
  }
  return config.publicBaseUrl ?? new URL(requestUrl).origin;
}
