import { z } from "zod";

const id = z.string().uuid();

export const portfolioReportQuerySchema = z.object({
  stage: z.enum(["Intake", "Draft", "Review", "Negotiation", "Signature", "Active"]).optional(),
  risk: z.enum(["Unassessed", "Low", "Medium", "High"]).optional(),
  ownerUserId: id.optional(),
  legalEntityId: id.optional(),
  counterpartyId: id.optional(),
  currencyCode: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  renewalWindowDays: z.coerce.number().int().min(1).max(365).default(90),
}).strict();

export type PortfolioReportQuery = z.infer<typeof portfolioReportQuerySchema>;

export class PortfolioReportQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortfolioReportQueryError";
  }
}

export function parsePortfolioReportQuery(request: Request): PortfolioReportQuery {
  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key in raw) throw new PortfolioReportQueryError(`${key} may be supplied only once.`);
    raw[key] = value;
  }
  const parsed = portfolioReportQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new PortfolioReportQueryError(parsed.error.issues[0]?.message ?? "Report filters are invalid.");
  }
  return parsed.data;
}

export function isoCalendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addUtcCalendarDays(date: Date, days: number): string {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
  return isoCalendarDate(next);
}

export function boundedReportCount(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error("Report count is outside the supported range.");
  return numeric;
}

export function exactMinorTotal(highUnits: unknown, lowUnits: unknown, base = BigInt(1_000_000)): string {
  const high = String(highUnits ?? "0");
  const low = String(lowUnits ?? "0");
  if (!/^-?[0-9]+$/.test(high) || !/^-?[0-9]+$/.test(low) || base < BigInt(2)) {
    throw new Error("Report monetary total is outside the supported range.");
  }
  return (BigInt(high) * base + BigInt(low)).toString();
}
