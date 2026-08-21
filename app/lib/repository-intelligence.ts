import { z } from "zod";
import { sha256Hex } from "./document-security";

export const REPOSITORY_FRAGMENT_MAX_BATCH = 50;
export const REPOSITORY_FRAGMENT_MAX_TOTAL = 500;
export const REPOSITORY_SEARCH_MAX_LIMIT = 50;
export const INGESTION_MAX_ITEMS = 50;
export const EXTRACTION_MAX_CITATIONS = 20;

const digest = z.string().regex(/^[a-f0-9]{64}$/, "Must be a lowercase SHA-256 digest");
const uuid = z.string().uuid();
const boundedText = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum);

export class RepositoryIntelligenceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RepositoryIntelligenceError";
  }
}

export const playbookScopeSchema = z.object({
  agreementTypes: z.array(boundedText(1, 120)).max(20).default([]),
  sides: z.array(z.enum(["Sell-side", "Buy-side", "Corporate"])).max(3).default([]),
  jurisdictions: z.array(boundedText(1, 120)).max(20).default([]),
}).strict();

const clauseRuleSchema = z.object({
  key: boundedText(1, 100).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  title: boundedText(1, 160),
  category: boundedText(1, 120),
  position: z.enum(["required", "preferred", "acceptable", "prohibited"]),
  preferredText: boundedText(1, 20_000),
  alternatives: z.array(boundedText(1, 20_000)).max(10).default([]),
  reviewGuidance: boundedText(3, 4_000),
  risk: z.enum(["low", "medium", "high", "critical"]),
}).strict();

export const playbookRulesSchema = z.object({
  clauses: z.array(clauseRuleSchema).min(1).max(200),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.clauses.forEach((clause, index) => {
    if (seen.has(clause.key)) context.addIssue({ code: "custom", path: ["clauses", index, "key"], message: "Clause keys must be unique" });
    seen.add(clause.key);
  });
});

export const playbookPostSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_with_version"),
    name: boundedText(1, 160),
    description: z.string().trim().max(2_000).default(""),
    scope: playbookScopeSchema,
    rules: playbookRulesSchema,
    changeSummary: boundedText(3, 2_000),
  }).strict(),
  z.object({
    action: z.literal("create_version"),
    playbookId: uuid,
    playbookVersion: z.number().int().positive(),
    rules: playbookRulesSchema,
    changeSummary: boundedText(3, 2_000),
  }).strict(),
]);

export const playbookPatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update_playbook"),
    id: uuid,
    version: z.number().int().positive(),
    name: boundedText(1, 160).optional(),
    description: z.string().trim().max(2_000).optional(),
    scope: playbookScopeSchema.optional(),
  }).strict().refine((input) => input.name !== undefined || input.description !== undefined || input.scope !== undefined, "At least one playbook field is required"),
  z.object({
    action: z.literal("publish_version"),
    playbookId: uuid,
    playbookVersion: z.number().int().positive(),
    versionId: uuid,
    reason: boundedText(3, 2_000),
  }).strict(),
  z.object({
    action: z.literal("retire_playbook"),
    playbookId: uuid,
    playbookVersion: z.number().int().positive(),
    reason: boundedText(3, 2_000),
  }).strict(),
]);

const fragmentInputSchema = z.object({
  ordinal: z.number().int().min(0).max(100_000),
  startOffset: z.number().int().min(0).max(20_000_000),
  endOffset: z.number().int().positive().max(20_000_000),
  content: z.string().min(1).max(12_000),
}).strict().refine((value) => value.endOffset > value.startOffset, { path: ["endOffset"], message: "End offset must follow start offset" });

export const fragmentPostSchema = z.object({
  documentVersionId: uuid,
  documentVersion: z.number().int().positive(),
  documentSha256: digest,
  sourceTextSha256: digest,
  extractor: boundedText(1, 120),
  extractorVersion: boundedText(1, 120),
  fragments: z.array(fragmentInputSchema).min(1).max(REPOSITORY_FRAGMENT_MAX_BATCH),
}).strict().superRefine((value, context) => {
  const ordinals = new Set<number>();
  const sorted = [...value.fragments].sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
  value.fragments.forEach((fragment, index) => {
    if (ordinals.has(fragment.ordinal)) context.addIssue({ code: "custom", path: ["fragments", index, "ordinal"], message: "Fragment ordinals must be unique" });
    ordinals.add(fragment.ordinal);
    if (codePointLength(fragment.content) !== fragment.endOffset - fragment.startOffset) {
      context.addIssue({ code: "custom", path: ["fragments", index, "content"], message: "Content must exactly match the citation offset span" });
    }
  });
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.startOffset < sorted[index - 1]!.endOffset) {
      context.addIssue({ code: "custom", path: ["fragments"], message: "Fragment offset spans cannot overlap" });
      break;
    }
  }
});

const extractionAgreementFields = [
  "party", "type", "side", "valueMinor", "currencyCode", "department", "effectiveDate", "expirationDate",
] as const;

const proposalTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agreement_field"), field: z.enum(extractionAgreementFields) }).strict(),
  z.object({ type: z.literal("custom_field"), field: boundedText(1, 100), definitionId: uuid }).strict(),
]);

export const proposalPostSchema = z.object({
  documentVersionId: uuid,
  agreementId: z.number().int().positive(),
  ingestionItemId: uuid.nullable().optional(),
  documentVersion: z.number().int().positive(),
  documentSha256: digest,
  sourceTextSha256: digest,
  target: proposalTargetSchema,
  proposedValue: z.json(),
  confidence: z.number().min(0).max(1),
  extractor: boundedText(1, 120),
  extractorVersion: boundedText(1, 120),
  citations: z.array(z.object({
    fragmentId: uuid,
    startOffset: z.number().int().min(0),
    endOffset: z.number().int().positive(),
    quote: z.string().min(1).max(12_000),
  }).strict().refine((citation) => citation.endOffset > citation.startOffset, { path: ["endOffset"], message: "End offset must follow start offset" })).min(1).max(EXTRACTION_MAX_CITATIONS),
}).strict();

export const proposalReviewSchema = z.object({
  id: uuid,
  decision: z.enum(["accept", "reject"]),
  reason: boundedText(3, 4_000),
}).strict();

const ingestionItemInputSchema = z.object({
  fileName: boundedText(1, 180),
  contentType: boundedText(1, 160),
  size: z.number().int().min(1).max(20 * 1024 * 1024),
  sha256: digest,
  documentId: uuid.optional(),
}).strict();

export const ingestionPostSchema = z.object({
  items: z.array(ingestionItemInputSchema).min(1).max(INGESTION_MAX_ITEMS),
}).strict();

export const ingestionPatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link_document"), itemId: uuid, documentId: uuid }).strict(),
  z.object({ action: z.literal("review_item"), itemId: uuid, decision: z.enum(["accept", "reject"]), reason: boundedText(3, 4_000) }).strict(),
]);

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function codePointSlice(value: string, start: number, end: number): string {
  return Array.from(value).slice(start, end).join("");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

export function canonicalRepositoryJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function repositoryDigest(value: unknown): Promise<string> {
  return sha256Hex(canonicalRepositoryJson(value));
}

export function ingestionIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RepositoryIntelligenceError(400, "invalid_idempotency_key", "Idempotency-Key must be a UUID.");
  }
  return value.toLowerCase();
}

export function repositorySearchTerms(raw: string): readonly string[] {
  const normalized = raw.normalize("NFKC").toLocaleLowerCase("en-US").trim();
  if (normalized.length < 2 || normalized.length > 200) {
    throw new RepositoryIntelligenceError(400, "invalid_query", "Search text must contain 2 to 200 characters.");
  }
  const terms = [...new Set(normalized.split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 2))];
  if (terms.length < 1 || terms.length > 8) {
    throw new RepositoryIntelligenceError(400, "invalid_query", "Search must contain between 1 and 8 meaningful terms.");
  }
  return Object.freeze(terms);
}

type SearchCursorPayload = Readonly<{ v: 1; b: string; s: string; t: string; i: string }>;
type SearchCursorEnvelope = SearchCursorPayload & Readonly<{ c: string }>;

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function cursorPayloadJson(payload: SearchCursorPayload): string {
  return JSON.stringify({ v: payload.v, b: payload.b, s: payload.s, t: payload.t, i: payload.i });
}

export async function repositorySearchBinding(input: Readonly<{
  workspaceId: string;
  terms: readonly string[];
  agreementId: number | null;
  documentVersionId: string | null;
  limit: number;
}>): Promise<string> {
  return repositoryDigest({ v: 1, ...input });
}

export async function encodeRepositorySearchCursor(payload: SearchCursorPayload): Promise<string> {
  const c = await sha256Hex(cursorPayloadJson(payload));
  return base64UrlEncode(JSON.stringify({ ...payload, c } satisfies SearchCursorEnvelope));
}

export async function decodeRepositorySearchCursor(candidate: string | null, expectedBinding: string): Promise<SearchCursorPayload | null> {
  if (candidate === null) return null;
  if (candidate.length < 20 || candidate.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(candidate)) {
    throw new RepositoryIntelligenceError(400, "invalid_cursor", "Search cursor is invalid.");
  }
  try {
    const decoded = base64UrlDecode(candidate);
    const record = JSON.parse(decoded) as Record<string, unknown>;
    if (!record || Array.isArray(record) || Object.keys(record).sort().join(",") !== "b,c,i,s,t,v"
      || record.v !== 1 || record.b !== expectedBinding || typeof record.c !== "string"
      || typeof record.s !== "string" || typeof record.t !== "string" || typeof record.i !== "string"
      || !/^[a-f0-9]{64}$/.test(record.b as string) || !/^[a-f0-9]{64}$/.test(record.c)
      || record.i.length < 1 || record.i.length > 200
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.s)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.t)) throw new TypeError();
    const payload = { v: 1, b: record.b, s: record.s, t: record.t, i: record.i } as SearchCursorPayload;
    const checksum = await sha256Hex(cursorPayloadJson(payload));
    if (checksum !== record.c || decoded !== JSON.stringify({ ...payload, c: record.c }) || base64UrlEncode(decoded) !== candidate) throw new TypeError();
    return payload;
  } catch (error) {
    if (error instanceof RepositoryIntelligenceError) throw error;
    throw new RepositoryIntelligenceError(400, "invalid_cursor", "Search cursor is invalid.");
  }
}
