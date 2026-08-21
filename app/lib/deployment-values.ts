const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;

const EXACT_PLACEHOLDER_VALUES = new Set([
  "change-me",
  "example",
  "none",
  "replace-me",
  "replace with organization name",
  "replace with customer-approved workspace name",
  "replace-with-permanent-workspace-id",
  "replace-with-workspace-slug",
  "todo",
  "unset",
]);

const EXAMPLE_HOSTNAMES = new Set([
  "example.com",
  "example.net",
  "example.org",
]);

/**
 * Identify deployment-template markers without rejecting ordinary customer
 * values that happen to contain words such as "replace" later in the value.
 */
export function isPlaceholderDeploymentValue(candidate: string): boolean {
  const normalized = candidate.trim().toLowerCase();
  if (!normalized || EXACT_PLACEHOLDER_VALUES.has(normalized)) return true;

  return /^(?:replace|change[-_\s]*me)(?:$|[-_\s])/.test(normalized)
    || /^(?:todo|tbd|unset)(?:$|[-_\s:])/.test(normalized);
}

export function hasConfiguredDeploymentValue(candidate: string): boolean {
  return Boolean(candidate.trim()) && !isPlaceholderDeploymentValue(candidate);
}

export function isProductionSecretValue(candidate: string): boolean {
  return candidate.trim().length >= 32 && !isPlaceholderDeploymentValue(candidate);
}

/** `.invalid` and the IANA example domains are documentation-only names. */
export function isPlaceholderHostname(candidate: string): boolean {
  const hostname = candidate.trim().toLowerCase().replace(/\.$/, "");
  if (!hostname) return true;
  if (hostname === "invalid" || hostname.endsWith(".invalid")) return true;

  return [...EXAMPLE_HOSTNAMES].some(
    (example) => hostname === example || hostname.endsWith(`.${example}`),
  );
}

export function isValidDeploymentEmail(candidate: string): boolean {
  const email = candidate.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || isPlaceholderDeploymentValue(email)) return false;

  const separator = email.lastIndexOf("@");
  return separator > 0 && !isPlaceholderHostname(email.slice(separator + 1));
}

export function isValidWorkspaceId(candidate: string): boolean {
  const trimmed = candidate.trim();
  return WORKSPACE_ID_PATTERN.test(trimmed) && !isPlaceholderDeploymentValue(trimmed);
}

export function isValidWorkspaceName(candidate: string): boolean {
  const normalized = candidate.trim();
  return normalized.length >= 2
    && normalized.length <= 120
    && !isPlaceholderDeploymentValue(normalized);
}

export function isSafeDeploymentEndpoint(candidate: string): boolean {
  try {
    const endpoint = new URL(candidate);
    const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
    return !endpoint.username
      && !endpoint.password
      && !isPlaceholderHostname(endpoint.hostname)
      && (endpoint.protocol === "https:" || (local && endpoint.protocol === "http:"));
  } catch {
    return false;
  }
}

/**
 * Validate the canonical browser-facing application origin. Unlike service
 * endpoints used by the local evidence suite, this value is emitted in public
 * metadata and provider redirects, so it must be a stable HTTPS origin rather
 * than a loopback, preview, or path-scoped URL.
 */
export function isSafePublicApplicationUrl(candidate: string): boolean {
  try {
    const endpoint = new URL(candidate);
    const hostname = endpoint.hostname.toLowerCase().replace(/\.$/, "");
    const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
    const isDirectPlatformHostname = ["workers.dev", "pages.dev"].some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
    return endpoint.protocol === "https:"
      && !endpoint.username
      && !endpoint.password
      && !isPlaceholderHostname(hostname)
      && !isLoopback
      && !isDirectPlatformHostname
      && endpoint.pathname === "/"
      && !endpoint.search
      && !endpoint.hash;
  } catch {
    return false;
  }
}

export function isLoopbackRequestUrl(candidate: string): boolean {
  try {
    const endpoint = new URL(candidate);
    const hostname = endpoint.hostname.toLowerCase();
    return (endpoint.protocol === "http:" || endpoint.protocol === "https:")
      && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]");
  } catch {
    return false;
  }
}
