import { sha256Hex } from "./document-security";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type GovernedConfigurationKind = "governed_template" | "clause_playbook";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function canonicalConfigurationCreationIdempotencyKey(value: string | null): string | null {
  if (value === null || !CANONICAL_UUID.test(value)) return null;
  return value;
}

/** Persist only a one-way, tenant- and human-bound lookup for the caller key. */
export function configurationCreationKeyDigest(input: Readonly<{
  kind: GovernedConfigurationKind;
  workspaceId: string;
  userId: string;
  idempotencyKey: string;
}>): Promise<string> {
  return sha256Hex(canonicalJson({ schema: "notice.configuration-creation-key.v1", ...input }));
}

/** Canonical material digest used to reject one key reused for different paper. */
export function configurationCreationRequestDigest(
  kind: GovernedConfigurationKind,
  payload: unknown,
  maxBytes: number,
): Promise<string> {
  const canonical = canonicalJson({ schema: "notice.configuration-creation-request.v1", kind, payload });
  if (new TextEncoder().encode(canonical).byteLength > maxBytes) {
    throw new RangeError("Configuration creation request exceeds its validated size bound");
  }
  return sha256Hex(canonical);
}
