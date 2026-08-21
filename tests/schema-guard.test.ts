import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheSuccessfulSchemaCheck,
  enforceStorageSchemaPolicy,
  LOCAL_SCHEMA_BOOTSTRAP_BINDING,
  LOCAL_SCHEMA_BOOTSTRAP_VALUE,
  NOTICE_SCHEMA_MARKER_ID,
  NOTICE_SCHEMA_VERSION,
  StorageSchemaError,
  storageSchemaMode,
  verifyStorageSchema,
} from "../db/schema-guard";

function markerDatabase(version: number | null, queries: string[] = []): D1Database {
  return {
    prepare(query: string) {
      queries.push(query);
      return {
        bind(...values: unknown[]) {
          assert.deepEqual(values, [NOTICE_SCHEMA_MARKER_ID]);
          return {
            async first() {
              return version === null ? null : { version };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

test("ordinary production schema policy is verification-only", async () => {
  assert.equal(storageSchemaMode({}), "verify");
  assert.equal(storageSchemaMode({ NOTICE_APP_MODE: "production" }), "verify");
  assert.equal(storageSchemaMode({
    NOTICE_APP_MODE: "production",
    [LOCAL_SCHEMA_BOOTSTRAP_BINDING]: "wrong-value",
  }), "verify");

  const queries: string[] = [];
  let bootstrapCalls = 0;
  await enforceStorageSchemaPolicy(
    markerDatabase(NOTICE_SCHEMA_VERSION, queries),
    { NOTICE_APP_MODE: "production" },
    async () => { bootstrapCalls += 1; },
  );

  assert.equal(bootstrapCalls, 0);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^SELECT version FROM notice_schema_state/i);
  assert.doesNotMatch(queries[0], /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|PRAGMA)\b/i);
});

test("only evaluation and the exact local evidence marker may bootstrap", async () => {
  assert.equal(storageSchemaMode({ NOTICE_APP_MODE: "evaluation" }), "bootstrap");
  assert.equal(storageSchemaMode({
    NOTICE_APP_MODE: "production",
    [LOCAL_SCHEMA_BOOTSTRAP_BINDING]: LOCAL_SCHEMA_BOOTSTRAP_VALUE,
  }), "bootstrap");

  let bootstrapCalls = 0;
  await enforceStorageSchemaPolicy(
    markerDatabase(null),
    {
      NOTICE_APP_MODE: "production",
      [LOCAL_SCHEMA_BOOTSTRAP_BINDING]: LOCAL_SCHEMA_BOOTSTRAP_VALUE,
    },
    async () => { bootstrapCalls += 1; },
  );
  assert.equal(bootstrapCalls, 1);
});

test("schema verification fails closed for missing, stale, and future markers", async () => {
  await assert.rejects(
    verifyStorageSchema(markerDatabase(null)),
    (error) => error instanceof StorageSchemaError && error.status === 503 && error.code === "STORAGE_SCHEMA_INCOMPLETE",
  );
  await assert.rejects(
    verifyStorageSchema(markerDatabase(NOTICE_SCHEMA_VERSION - 1)),
    (error) => error instanceof StorageSchemaError && new RegExp(`required ${NOTICE_SCHEMA_VERSION}, found ${NOTICE_SCHEMA_VERSION - 1}`).test(error.message),
  );
  await assert.rejects(
    verifyStorageSchema(markerDatabase(NOTICE_SCHEMA_VERSION + 1)),
    (error) => error instanceof StorageSchemaError && new RegExp(`required ${NOTICE_SCHEMA_VERSION}, found ${NOTICE_SCHEMA_VERSION + 1}`).test(error.message),
  );
});

test("schema checks cache success but clear a failed attempt for retry", async () => {
  let successes = 0;
  const successful = cacheSuccessfulSchemaCheck(async () => { successes += 1; });
  await Promise.all([successful(), successful(), successful()]);
  await successful();
  assert.equal(successes, 1);

  let attempts = 0;
  const retrying = cacheSuccessfulSchemaCheck(async () => {
    attempts += 1;
    if (attempts === 1) throw new StorageSchemaError("synthetic failure");
  });
  await assert.rejects(retrying(), StorageSchemaError);
  await retrying();
  assert.equal(attempts, 2);
});
