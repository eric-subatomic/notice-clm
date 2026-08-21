import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { integrationDiagnostics } from "../../db/schema";
import {
  integrationIds,
  type IntegrationId,
  type IntegrationLiveTest,
  type IntegrationStatusSource,
} from "./integration-status";
import {
  integrationConfigurationFingerprint,
  isCurrentIntegrationDiagnostic,
  type CurrentIntegrationDiagnostics,
} from "./integration-diagnostic-policy";

export {
  attachCurrentIntegrationDiagnostics,
  requireCurrentIntegrationDiagnostics,
} from "./integration-diagnostic-policy";

export async function loadCurrentIntegrationDiagnostics(
  workspaceId: string,
  source: IntegrationStatusSource,
): Promise<CurrentIntegrationDiagnostics> {
  const db = getDb();
  const rows = await db.select().from(integrationDiagnostics)
    .where(eq(integrationDiagnostics.workspaceId, workspaceId));
  const fingerprints = new Map(await Promise.all(integrationIds.map(async (id) => [
    id,
    await integrationConfigurationFingerprint(source, id),
  ] as const)));

  const current: CurrentIntegrationDiagnostics = {};
  for (const row of rows) {
    if (!integrationIds.includes(row.integrationId as IntegrationId)) continue;
    const id = row.integrationId as IntegrationId;
    if (row.configurationFingerprint !== fingerprints.get(id)) continue;
    if (!isCurrentIntegrationDiagnostic(row.testedAt)) continue;
    current[id] = Object.freeze({
      status: row.status,
      testedAt: row.testedAt,
      detail: row.detail,
    });
  }
  return current;
}

export async function recordIntegrationDiagnostic(input: {
  workspaceId: string;
  testedByUserId: string;
  source: IntegrationStatusSource;
  id: IntegrationId;
  result: IntegrationLiveTest;
}): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const configurationFingerprint = await integrationConfigurationFingerprint(input.source, input.id);
  await db.insert(integrationDiagnostics).values({
    workspaceId: input.workspaceId,
    integrationId: input.id,
    configurationFingerprint,
    status: input.result.status,
    testedAt: input.result.testedAt,
    detail: input.result.detail.slice(0, 1_000),
    testedByUserId: input.testedByUserId,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [integrationDiagnostics.workspaceId, integrationDiagnostics.integrationId],
    set: {
      configurationFingerprint,
      status: input.result.status,
      testedAt: input.result.testedAt,
      detail: input.result.detail.slice(0, 1_000),
      testedByUserId: input.testedByUserId,
      updatedAt: now,
    },
  });
}
