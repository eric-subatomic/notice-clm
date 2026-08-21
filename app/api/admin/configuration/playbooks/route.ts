import { and, desc, eq, isNull, lt, max, notExists, or } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import { clausePlaybookCreationReceipts, clausePlaybooks, clausePlaybookVersions } from "../../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../../lib/api";
import {
  canonicalConfigurationCreationIdempotencyKey,
  configurationCreationKeyDigest,
  configurationCreationRequestDigest,
} from "../../../../lib/configuration-creation-idempotency";
import { executeEnterpriseMutation } from "../../../../lib/enterprise-api";
import {
  playbookPatchSchema,
  playbookPostSchema,
  repositoryDigest,
  RepositoryIntelligenceError,
} from "../../../../lib/repository-intelligence";
import { apiError, apiJson } from "../../../../lib/http";
import { isMutationGuardConflict } from "../../../../lib/persistence";
import { parseJson } from "../../../../lib/validation";

function routeError(error: unknown, requestId: string): Response {
  if (error instanceof RepositoryIntelligenceError) return apiError(error.code, error.message, { status: error.status, requestId });
  if (isMutationGuardConflict(error)) {
    return apiError("version_conflict", "The clause playbook changed before this action committed. Reload and try again.", { status: 409, requestId });
  }
  return handleRouteError(error, requestId, "Clause playbooks could not be updated.");
}

function uniqueError(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).toLowerCase().includes("unique constraint failed");
}

async function replayInitialPlaybookCreation(db: ReturnType<typeof getDb>, input: Readonly<{
  workspaceId: string;
  userId: string;
  keyDigest: string;
  requestSha256: string;
  requestId: string;
  headers: HeadersInit;
}>): Promise<Response | null> {
  const [receipt] = await db.select().from(clausePlaybookCreationReceipts).where(and(
    eq(clausePlaybookCreationReceipts.workspaceId, input.workspaceId),
    eq(clausePlaybookCreationReceipts.userId, input.userId),
    eq(clausePlaybookCreationReceipts.idempotencyKeySha256, input.keyDigest),
  )).limit(1);
  if (!receipt) return null;
  if (receipt.requestSha256 !== input.requestSha256) {
    throw new RepositoryIntelligenceError(409, "idempotency_key_conflict", "This playbook-creation key was already used for different governed positions.");
  }
  const [[playbook], [playbookVersion]] = await Promise.all([
    db.select().from(clausePlaybooks).where(and(
      eq(clausePlaybooks.workspaceId, input.workspaceId),
      eq(clausePlaybooks.id, receipt.playbookId),
    )).limit(1),
    db.select().from(clausePlaybookVersions).where(and(
      eq(clausePlaybookVersions.workspaceId, input.workspaceId),
      eq(clausePlaybookVersions.playbookId, receipt.playbookId),
      eq(clausePlaybookVersions.id, receipt.playbookVersionId),
      eq(clausePlaybookVersions.version, 1),
    )).limit(1),
  ]);
  if (!playbook || !playbookVersion) {
    throw new RepositoryIntelligenceError(409, "idempotency_target_unavailable", "The prior playbook-creation receipt no longer has its exact governed targets.");
  }
  const headers = new Headers(input.headers);
  headers.set("Idempotency-Replayed", "true");
  return apiJson({ playbook, playbookVersion, replay: true, requestId: input.requestId }, {
    requestId: input.requestId,
    headers,
  });
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin");
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !["id", "status", "limit"].includes(key))) {
      throw new RepositoryIntelligenceError(400, "invalid_query", "Unsupported playbook query parameter.");
    }
    const id = url.searchParams.get("id");
    const status = url.searchParams.get("status");
    if (id !== null && !/^[0-9a-f-]{36}$/i.test(id)) throw new RepositoryIntelligenceError(400, "invalid_query", "Playbook ID is invalid.");
    if (status !== null && !["draft", "published", "retired"].includes(status)) throw new RepositoryIntelligenceError(400, "invalid_query", "Playbook status is invalid.");
    const limitRaw = url.searchParams.get("limit") ?? "50";
    if (!/^[1-9][0-9]?$|^100$/.test(limitRaw)) throw new RepositoryIntelligenceError(400, "invalid_query", "Limit must be between 1 and 100.");
    await ensureStorageSchema();
    const db = getDb();
    const conditions = [eq(clausePlaybooks.workspaceId, auth.context.workspace.id)];
    if (id) conditions.push(eq(clausePlaybooks.id, id));
    if (status) conditions.push(eq(clausePlaybooks.status, status as "draft" | "published" | "retired"));
    const playbooks = await db.select().from(clausePlaybooks).where(and(...conditions))
      .orderBy(desc(clausePlaybooks.updatedAt), desc(clausePlaybooks.id)).limit(Number(limitRaw));
    const versions = id === null ? [] : await db.select().from(clausePlaybookVersions).where(and(
      eq(clausePlaybookVersions.workspaceId, auth.context.workspace.id),
      eq(clausePlaybookVersions.playbookId, id),
    )).orderBy(desc(clausePlaybookVersions.version)).limit(100);
    return apiJson({ playbooks, versions, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return routeError(error, auth.requestId);
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, playbookPostSchema, 300_000);
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    const now = new Date().toISOString();
    if (input.action === "create_with_version") {
      const rawIdempotencyKey = request.headers.get("idempotency-key");
      if (rawIdempotencyKey === null) {
        throw new RepositoryIntelligenceError(400, "idempotency_key_required", "A canonical UUID Idempotency-Key is required for atomic playbook creation.");
      }
      const idempotencyKey = canonicalConfigurationCreationIdempotencyKey(rawIdempotencyKey);
      if (!idempotencyKey) {
        throw new RepositoryIntelligenceError(400, "invalid_idempotency_key", "Idempotency-Key must be one canonical lowercase UUID.");
      }
      const [keyDigest, requestSha256] = await Promise.all([
        configurationCreationKeyDigest({
          kind: "clause_playbook",
          workspaceId,
          userId: auth.context.user.id,
          idempotencyKey,
        }),
        configurationCreationRequestDigest("clause_playbook", input, 310_000),
      ]);
      const replay = await replayInitialPlaybookCreation(db, {
        workspaceId,
        userId: auth.context.user.id,
        keyDigest,
        requestSha256,
        requestId: auth.requestId,
        headers: auth.headers,
      });
      if (replay) return replay;
      const contentSha256 = await repositoryDigest(input.rules);

      const playbook = {
        id: crypto.randomUUID(), workspaceId, version: 1, name: input.name, description: input.description,
        scope: input.scope, status: "draft" as const, currentPublishedVersion: null,
        createdByUserId: auth.context.user.id, createdAt: now, updatedByUserId: auth.context.user.id, updatedAt: now,
      };
      const playbookVersion = {
        id: crypto.randomUUID(), workspaceId, playbookId: playbook.id, version: 1, status: "draft" as const,
        rules: input.rules, contentSha256, changeSummary: input.changeSummary,
        createdByUserId: auth.context.user.id, createdAt: now, publishedByUserId: null, publishedAt: null,
      };
      try {
        await executeEnterpriseMutation(db, {
          workspaceId, actor: auth.context.user, type: "ClausePlaybookInitialized",
          detail: {
            action: "clause_playbook.initial_version_created",
            playbookId: playbook.id,
            versionId: playbookVersion.id,
            semanticVersion: 1,
            contentSha256,
          },
          steps: [
            { statement: db.insert(clausePlaybooks).values(playbook) },
            { statement: db.insert(clausePlaybookVersions).values(playbookVersion) },
            { statement: db.insert(clausePlaybookCreationReceipts).values({
              workspaceId,
              userId: auth.context.user.id,
              idempotencyKeySha256: keyDigest,
              requestSha256,
              playbookId: playbook.id,
              playbookVersionId: playbookVersion.id,
              createdAt: now,
            }) },
          ],
          createdAt: now,
        });
      } catch (error) {
        const concurrentReplay = await replayInitialPlaybookCreation(db, {
          workspaceId,
          userId: auth.context.user.id,
          keyDigest,
          requestSha256,
          requestId: auth.requestId,
          headers: auth.headers,
        });
        if (concurrentReplay) return concurrentReplay;
        if (uniqueError(error)) {
          throw new RepositoryIntelligenceError(409, "playbook_exists", "A clause playbook with this name already exists.");
        }
        throw error;
      }
      const headers = new Headers(auth.headers);
      headers.set("Idempotency-Replayed", "false");
      return apiJson({ playbook, playbookVersion, replay: false, requestId: auth.requestId }, {
        status: 201,
        requestId: auth.requestId,
        headers,
      });
    }
    const [playbook] = await db.select().from(clausePlaybooks).where(and(
      eq(clausePlaybooks.workspaceId, workspaceId), eq(clausePlaybooks.id, input.playbookId),
    )).limit(1);
    if (!playbook) throw new RepositoryIntelligenceError(404, "playbook_not_found", "Clause playbook was not found.");
    if (playbook.version !== input.playbookVersion) throw new RepositoryIntelligenceError(409, "version_conflict", "Clause playbook changed; reload before adding a version.");
    if (playbook.status === "retired") throw new RepositoryIntelligenceError(409, "playbook_retired", "A retired playbook cannot receive another version.");
    const [latest] = await db.select({ version: max(clausePlaybookVersions.version) }).from(clausePlaybookVersions).where(and(
      eq(clausePlaybookVersions.workspaceId, workspaceId), eq(clausePlaybookVersions.playbookId, playbook.id),
    ));
    const semanticVersion = (latest?.version ?? 0) + 1;
    const artifact = {
      id: crypto.randomUUID(), workspaceId, playbookId: playbook.id, version: semanticVersion, status: "draft" as const,
      rules: input.rules, contentSha256: await repositoryDigest(input.rules), changeSummary: input.changeSummary,
      createdByUserId: auth.context.user.id, createdAt: now, publishedByUserId: null, publishedAt: null,
    };
    try {
      await executeEnterpriseMutation(db, {
        workspaceId, actor: auth.context.user, type: "ClausePlaybookVersionCreated",
        detail: { action: "clause_playbook.version_created", playbookId: playbook.id, semanticVersion, contentSha256: artifact.contentSha256 },
        steps: [
          { statement: db.insert(clausePlaybookVersions).values(artifact) },
          { statement: db.update(clausePlaybooks).set({ version: playbook.version + 1, updatedByUserId: auth.context.user.id, updatedAt: now }).where(and(
            eq(clausePlaybooks.workspaceId, workspaceId), eq(clausePlaybooks.id, playbook.id), eq(clausePlaybooks.version, playbook.version),
          )), guardOperation: "clause-playbook.version-create" },
        ], createdAt: now,
      });
    } catch (error) {
      if (uniqueError(error)) {
        throw new RepositoryIntelligenceError(409, "version_conflict", "Another clause playbook version was created first. Reload before adding a version.");
      }
      throw error;
    }
    return apiJson({ playbookVersion: artifact, playbookVersionToken: playbook.version + 1, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return routeError(error, auth.requestId);
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 40 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, playbookPatchSchema, 80_000);
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    const playbookId = input.action === "update_playbook" ? input.id : input.playbookId;
    const expectedVersion = input.action === "update_playbook" ? input.version : input.playbookVersion;
    const [playbook] = await db.select().from(clausePlaybooks).where(and(
      eq(clausePlaybooks.workspaceId, workspaceId), eq(clausePlaybooks.id, playbookId),
    )).limit(1);
    if (!playbook) throw new RepositoryIntelligenceError(404, "playbook_not_found", "Clause playbook was not found.");
    if (playbook.version !== expectedVersion) throw new RepositoryIntelligenceError(409, "version_conflict", "Clause playbook changed; reload before updating it.");
    if (playbook.status === "retired") throw new RepositoryIntelligenceError(409, "playbook_retired", "A retired clause playbook is immutable.");
    const now = new Date().toISOString();

    if (input.action === "update_playbook") {
      if (input.scope !== undefined) {
        const [existingVersion] = await db.select({ id: clausePlaybookVersions.id }).from(clausePlaybookVersions).where(and(
          eq(clausePlaybookVersions.workspaceId, workspaceId), eq(clausePlaybookVersions.playbookId, playbook.id),
        )).limit(1);
        if (existingVersion) {
          throw new RepositoryIntelligenceError(409, "playbook_scope_immutable", "Playbook applicability cannot change after its first governed version is created.");
        }
      }
      const changes = { name: input.name, description: input.description, scope: input.scope };
      const saved = { ...playbook, ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)), version: playbook.version + 1, updatedByUserId: auth.context.user.id, updatedAt: now };
      try {
        await executeEnterpriseMutation(db, {
          workspaceId, actor: auth.context.user, type: "ClausePlaybookUpdated",
          detail: { action: "clause_playbook.updated", playbookId: playbook.id, previousVersion: playbook.version, version: saved.version },
          steps: [{ statement: db.update(clausePlaybooks).set({ ...changes, version: saved.version, updatedByUserId: saved.updatedByUserId, updatedAt: now }).where(and(
            eq(clausePlaybooks.workspaceId, workspaceId), eq(clausePlaybooks.id, playbook.id), eq(clausePlaybooks.version, playbook.version),
            input.scope !== undefined ? notExists(db.select({ id: clausePlaybookVersions.id }).from(clausePlaybookVersions).where(and(
              eq(clausePlaybookVersions.workspaceId, workspaceId), eq(clausePlaybookVersions.playbookId, playbook.id),
            )).limit(1)) : undefined,
          )), guardOperation: "clause-playbook.update" }], createdAt: now,
        });
      } catch (error) {
        if (uniqueError(error)) throw new RepositoryIntelligenceError(409, "playbook_exists", "A clause playbook with this name already exists.");
        throw error;
      }
      return apiJson({ playbook: saved, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }

    if (input.action === "retire_playbook") {
      if (playbook.status !== "published" || playbook.currentPublishedVersion === null) throw new RepositoryIntelligenceError(409, "published_playbook_required", "Only a published playbook can be retired.");
      await executeEnterpriseMutation(db, {
        workspaceId, actor: auth.context.user, type: "ClausePlaybookRetired",
        detail: { action: "clause_playbook.retired", playbookId: playbook.id, reason: input.reason, previousVersion: playbook.version, version: playbook.version + 1 },
        steps: [{ statement: db.update(clausePlaybooks).set({ status: "retired", version: playbook.version + 1, updatedByUserId: auth.context.user.id, updatedAt: now }).where(and(
          eq(clausePlaybooks.workspaceId, workspaceId), eq(clausePlaybooks.id, playbook.id), eq(clausePlaybooks.version, playbook.version), eq(clausePlaybooks.status, "published"),
        )), guardOperation: "clause-playbook.retire" }], createdAt: now,
      });
      return apiJson({ playbook: { ...playbook, status: "retired", version: playbook.version + 1, updatedAt: now }, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }

    const [artifact] = await db.select().from(clausePlaybookVersions).where(and(
      eq(clausePlaybookVersions.workspaceId, workspaceId), eq(clausePlaybookVersions.playbookId, playbook.id), eq(clausePlaybookVersions.id, input.versionId),
    )).limit(1);
    if (!artifact) throw new RepositoryIntelligenceError(404, "playbook_version_not_found", "Clause playbook version was not found.");
    if (artifact.status !== "draft") throw new RepositoryIntelligenceError(409, "playbook_version_immutable", "Only a draft playbook version can be published.");
    if (artifact.version <= (playbook.currentPublishedVersion ?? 0)) {
      throw new RepositoryIntelligenceError(409, "playbook_version_superseded", "Publish a version newer than the current governed playbook version.");
    }
    if (artifact.createdByUserId === auth.context.user.id) throw new RepositoryIntelligenceError(409, "independent_publisher_required", "A different workspace administrator must publish this playbook version.");
    if (await repositoryDigest(artifact.rules) !== artifact.contentSha256) throw new RepositoryIntelligenceError(409, "content_digest_mismatch", "Playbook content no longer matches its immutable digest.");
    await executeEnterpriseMutation(db, {
      workspaceId, actor: auth.context.user, type: "ClausePlaybookPublished",
      detail: { action: "clause_playbook.published", playbookId: playbook.id, versionId: artifact.id, semanticVersion: artifact.version, reason: input.reason, contentSha256: artifact.contentSha256 },
      steps: [
        { statement: db.update(clausePlaybookVersions).set({ status: "published", publishedByUserId: auth.context.user.id, publishedAt: now }).where(and(
        eq(clausePlaybookVersions.workspaceId, workspaceId), eq(clausePlaybookVersions.id, artifact.id), eq(clausePlaybookVersions.status, "draft"),
      )), guardOperation: "clause-playbook.publish-version" },
        { statement: db.update(clausePlaybooks).set({ status: "published", currentPublishedVersion: artifact.version, version: playbook.version + 1, updatedByUserId: auth.context.user.id, updatedAt: now }).where(and(
        eq(clausePlaybooks.workspaceId, workspaceId), eq(clausePlaybooks.id, playbook.id), eq(clausePlaybooks.version, playbook.version),
        or(isNull(clausePlaybooks.currentPublishedVersion), lt(clausePlaybooks.currentPublishedVersion, artifact.version)),
      )), guardOperation: "clause-playbook.publish-parent" },
      ], createdAt: now,
    });
    return apiJson({
      playbook: { ...playbook, status: "published", currentPublishedVersion: artifact.version, version: playbook.version + 1, updatedAt: now },
      playbookVersion: { ...artifact, status: "published", publishedByUserId: auth.context.user.id, publishedAt: now },
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return routeError(error, auth.requestId);
  }
}
