import { and, eq, gte, isNull, lte, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import {
  agreements,
  approvalRequests,
  obligationSchedules,
  obligations,
  signaturePackets,
} from "../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import { apiError, apiJson } from "../../../lib/http";
import {
  addUtcCalendarDays,
  boundedReportCount,
  exactMinorTotal,
  isoCalendarDate,
  parsePortfolioReportQuery,
  PortfolioReportQueryError,
} from "../../../lib/portfolio-report";

type GroupRow = Readonly<{ key: string; count: unknown }>;

function normalizedCounts(rows: readonly GroupRow[]) {
  return rows.map((row) => ({ key: row.key, count: boundedReportCount(row.count) }));
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:read", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    await ensureStorageSchema();
    const query = parsePortfolioReportQuery(request);
    const db = getDb();
    const generatedAt = new Date();
    const today = isoCalendarDate(generatedAt);
    const renewalThrough = addUtcCalendarDays(generatedAt, query.renewalWindowDays);
    const agreementScope: Array<SQL | undefined> = [
      eq(agreements.workspaceId, auth.context.workspace.id),
      isNull(agreements.deletedAt),
      query.stage ? eq(agreements.stage, query.stage) : undefined,
      query.risk ? eq(agreements.risk, query.risk) : undefined,
      query.ownerUserId ? eq(agreements.ownerUserId, query.ownerUserId) : undefined,
      query.legalEntityId ? eq(agreements.legalEntityId, query.legalEntityId) : undefined,
      query.counterpartyId ? eq(agreements.primaryCounterpartyId, query.counterpartyId) : undefined,
      query.currencyCode ? eq(agreements.currencyCode, query.currencyCode) : undefined,
    ];
    const scope = and(...agreementScope);
    const activeAgreementJoin = (workspaceId: SQLWrapper, agreementId: SQLWrapper) => and(
      sql`${agreements.workspaceId} = ${workspaceId}`,
      sql`${agreements.id} = ${agreementId}`,
      scope,
    );

    const [
      agreementTotals,
      stageRows,
      riskRows,
      currencyRows,
      renewalRows,
      approvalTotals,
      signatureRows,
      obligationTotals,
      scheduleRows,
    ] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(agreements).where(scope),
      db.select({ key: agreements.stage, count: sql<number>`count(*)` }).from(agreements).where(scope).groupBy(agreements.stage),
      db.select({ key: agreements.risk, count: sql<number>`count(*)` }).from(agreements).where(scope).groupBy(agreements.risk),
      db.select({
        currencyCode: agreements.currencyCode,
        count: sql<number>`count(*)`,
        valueMinorHigh: sql<string>`cast(coalesce(sum(${agreements.valueMinor} / 1000000), 0) as text)`,
        valueMinorLow: sql<string>`cast(coalesce(sum(${agreements.valueMinor} % 1000000), 0) as text)`,
      }).from(agreements).where(scope).groupBy(agreements.currencyCode),
      db.select({ count: sql<number>`count(*)` }).from(agreements).where(and(
        scope,
        sql`${agreements.expirationDate} <> ''`,
        gte(agreements.expirationDate, today),
        lte(agreements.expirationDate, renewalThrough),
      )),
      db.select({
        pending: sql<number>`coalesce(sum(case when ${approvalRequests.status} = 'Pending' then 1 else 0 end), 0)`,
        overdue: sql<number>`coalesce(sum(case when ${approvalRequests.status} = 'Pending' and ${approvalRequests.due} < ${today} then 1 else 0 end), 0)`,
        changesRequested: sql<number>`coalesce(sum(case when ${approvalRequests.status} = 'Changes requested' then 1 else 0 end), 0)`,
      }).from(approvalRequests).innerJoin(agreements, activeAgreementJoin(approvalRequests.workspaceId, approvalRequests.agreementId)),
      db.select({ key: signaturePackets.status, count: sql<number>`count(*)` }).from(signaturePackets)
        .innerJoin(agreements, activeAgreementJoin(signaturePackets.workspaceId, signaturePackets.agreementId))
        .groupBy(signaturePackets.status),
      db.select({
        open: sql<number>`coalesce(sum(case when ${obligations.status} = 'Open' then 1 else 0 end), 0)`,
        overdue: sql<number>`coalesce(sum(case when ${obligations.status} = 'Open' and ${obligations.dueDate} < ${today} then 1 else 0 end), 0)`,
        complete: sql<number>`coalesce(sum(case when ${obligations.status} = 'Complete' then 1 else 0 end), 0)`,
      }).from(obligations).innerJoin(agreements, activeAgreementJoin(obligations.workspaceId, obligations.agreementId)),
      db.select({ key: obligationSchedules.status, count: sql<number>`count(*)` }).from(obligationSchedules)
        .innerJoin(agreements, activeAgreementJoin(obligationSchedules.workspaceId, obligationSchedules.agreementId))
        .groupBy(obligationSchedules.status),
    ]);

    const approval = approvalTotals[0] ?? { pending: 0, overdue: 0, changesRequested: 0 };
    const obligation = obligationTotals[0] ?? { open: 0, overdue: 0, complete: 0 };
    return apiJson({
      generatedAt: generatedAt.toISOString(),
      asOfDate: today,
      filters: query,
      portfolio: {
        agreements: boundedReportCount(agreementTotals[0]?.count),
        stages: normalizedCounts(stageRows),
        risks: normalizedCounts(riskRows),
        currencies: currencyRows.map((row) => ({
          currencyCode: row.currencyCode,
          agreements: boundedReportCount(row.count),
          valueMinor: exactMinorTotal(row.valueMinorHigh, row.valueMinorLow),
        })),
        renewals: {
          through: renewalThrough,
          count: boundedReportCount(renewalRows[0]?.count),
        },
      },
      work: {
        approvals: {
          pending: boundedReportCount(approval.pending),
          overdue: boundedReportCount(approval.overdue),
          changesRequested: boundedReportCount(approval.changesRequested),
        },
        signatures: normalizedCounts(signatureRows),
        obligations: {
          open: boundedReportCount(obligation.open),
          overdue: boundedReportCount(obligation.overdue),
          complete: boundedReportCount(obligation.complete),
        },
        obligationSchedules: normalizedCounts(scheduleRows),
      },
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    if (error instanceof PortfolioReportQueryError) {
      return apiError("invalid_report_query", error.message, { status: 400, requestId: auth.requestId, headers: auth.headers });
    }
    return handleRouteError(error, auth.requestId, "Portfolio report could not be generated.");
  }
}
