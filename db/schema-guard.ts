export const NOTICE_SCHEMA_MARKER_ID = "primary";
export const NOTICE_SCHEMA_VERSION = 21;

export const LOCAL_SCHEMA_BOOTSTRAP_BINDING = "NOTICE_INTERNAL_LOCAL_SCHEMA_BOOTSTRAP";
export const LOCAL_SCHEMA_BOOTSTRAP_VALUE = "local-production-evidence-v1";

export type StorageSchemaMode = "bootstrap" | "verify";

export class StorageSchemaError extends Error {
  readonly code = "STORAGE_SCHEMA_INCOMPLETE";
  readonly status = 503;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StorageSchemaError";
  }
}

export function storageSchemaMode(source: Readonly<Record<string, unknown>>): StorageSchemaMode {
  const appMode = typeof source.NOTICE_APP_MODE === "string"
    ? source.NOTICE_APP_MODE.trim().toLowerCase()
    : "production";
  const localBootstrap = source[LOCAL_SCHEMA_BOOTSTRAP_BINDING];

  if (appMode === "evaluation" || localBootstrap === LOCAL_SCHEMA_BOOTSTRAP_VALUE) return "bootstrap";
  return "verify";
}

type SchemaMarkerRow = { version: number };

/**
 * Production's only schema operation: read the committed marker and require an
 * exact application/schema match. No CREATE, ALTER, INSERT, or PRAGMA occurs.
 */
export async function verifyStorageSchema(d1: D1Database): Promise<void> {
  let marker: SchemaMarkerRow | null;
  try {
    marker = await d1.prepare(
      "SELECT version FROM notice_schema_state WHERE id = ? LIMIT 1",
    ).bind(NOTICE_SCHEMA_MARKER_ID).first<SchemaMarkerRow>();
  } catch (error) {
    throw new StorageSchemaError(
      `Notice storage schema marker is unavailable; apply committed migrations through version ${NOTICE_SCHEMA_VERSION}.`,
      error,
    );
  }

  if (!marker || marker.version !== NOTICE_SCHEMA_VERSION) {
    const actual = marker ? String(marker.version) : "missing";
    throw new StorageSchemaError(
      `Notice storage schema version mismatch: required ${NOTICE_SCHEMA_VERSION}, found ${actual}.`,
    );
  }
}

export async function enforceStorageSchemaPolicy(
  d1: D1Database,
  source: Readonly<Record<string, unknown>>,
  bootstrap: (database: D1Database) => Promise<void>,
): Promise<void> {
  if (storageSchemaMode(source) === "bootstrap") {
    await bootstrap(d1);
    return;
  }
  await verifyStorageSchema(d1);
}

/** Cache successful verification/bootstrap work per Worker isolate; retry failures. */
export function cacheSuccessfulSchemaCheck(operation: () => Promise<void>): () => Promise<void> {
  let cached: Promise<void> | undefined;

  return function run(): Promise<void> {
    if (cached) return cached;
    const attempt = operation().catch((error) => {
      if (cached === attempt) cached = undefined;
      throw error;
    });
    cached = attempt;
    return attempt;
  };
}
