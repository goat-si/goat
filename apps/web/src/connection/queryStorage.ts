import type { EnvironmentId } from "@goat/contracts";
import { EnvironmentQueryStore } from "@goat/client-runtime/state/query-persistence";
import { ConnectionTransientError } from "@goat/client-runtime/connection";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

function catalogError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the local connection catalog: ${String(cause)}`,
  });
}
export const QUERY_STORE_NAME = "query";
export const QUERY_UPDATED_INDEX_NAME = "environment-updated";
const QUERY_MAX_ROWS = 256;
const QUERY_MAX_BYTES = 32 * 1024 * 1024;
const QUERY_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const QUERY_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
// A stats answer saves one row per listed PR, so the bounds index is walked once per batch of
// saves. Each walk trims a batch below the caps, so the caps hold between walks. The batch count
// lives in the database, so tabs sharing it share one count.
const QUERY_PRUNE_BATCH_ROWS = 32;
const QUERY_PRUNE_BATCH_BYTES = 1024 * 1024;
const isStoredQuery = Schema.is(
  Schema.Struct({ environmentId: Schema.String, payload: Schema.String, updatedAt: Schema.Number }),
);
const isQueryBatch = Schema.is(Schema.Struct({ rows: Schema.Number, bytes: Schema.Number }));
function queryCacheKey(environmentId: EnvironmentId, key: string) {
  return `${environmentId}:v1:${key}`;
}

function queryBatchKey(environmentId: EnvironmentId) {
  return `${environmentId}:batch`;
}

// Mirrors mobile's pull-request cache bounds, per environment.
function saveQueryOnConnection(
  database: IDBDatabase,
  environmentId: EnvironmentId,
  key: string,
  payload: string,
  updatedAt: number,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    try {
      const bytes = new TextEncoder().encode(payload).length;
      const transaction = database.transaction(QUERY_STORE_NAME, "readwrite");
      transaction.addEventListener("abort", () => {
        resume(
          Effect.fail(catalogError("write", transaction.error ?? "Unknown IndexedDB write error")),
        );
      });
      transaction.addEventListener("complete", () => {
        resume(Effect.void);
      });
      const store = transaction.objectStore(QUERY_STORE_NAME);
      // An answer too large to keep must not leave its older copy to paint on the next start.
      if (bytes > QUERY_MAX_PAYLOAD_BYTES) {
        store.delete(queryCacheKey(environmentId, key));
        return;
      }
      store.put({ environmentId, payload, updatedAt, bytes }, queryCacheKey(environmentId, key));
      const batchKey = queryBatchKey(environmentId);
      const batchRequest = store.get(batchKey);
      batchRequest.addEventListener("success", () => {
        const batch: unknown = batchRequest.result;
        const rows = (isQueryBatch(batch) ? batch.rows : 0) + 1;
        const written = (isQueryBatch(batch) ? batch.bytes : 0) + bytes;
        if (
          isQueryBatch(batch) &&
          rows < QUERY_PRUNE_BATCH_ROWS &&
          written < QUERY_PRUNE_BATCH_BYTES
        ) {
          store.put({ rows, bytes: written }, batchKey);
          return;
        }
        store.put({ rows: 0, bytes: 0 }, batchKey);
        const request = store
          .index(QUERY_UPDATED_INDEX_NAME)
          .openKeyCursor(IDBKeyRange.bound([environmentId], [environmentId, []]), "prev");
        let kept = 0;
        let totalBytes = 0;
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (cursor === null) return;
          const [, rowUpdatedAt, rowBytes] = cursor.key as [string, number, number];
          kept += 1;
          totalBytes += rowBytes;
          if (
            kept > QUERY_MAX_ROWS - QUERY_PRUNE_BATCH_ROWS ||
            totalBytes > QUERY_MAX_BYTES - QUERY_PRUNE_BATCH_BYTES ||
            rowUpdatedAt < updatedAt - QUERY_MAX_AGE_MS
          ) {
            store.delete(cursor.primaryKey);
          }
          cursor.continue();
        });
      });
    } catch (cause) {
      resume(Effect.fail(catalogError("write", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.saveQuery"));
}

export function makeQueryStore(options: {
  readonly read: (
    environmentId: EnvironmentId,
    key: string,
  ) => Effect.Effect<unknown, ConnectionTransientError>;
  readonly withDatabase: <A>(
    use: (database: IDBDatabase) => Effect.Effect<A, ConnectionTransientError>,
  ) => Effect.Effect<A, ConnectionTransientError>;
}) {
  const queryStore: NonNullable<typeof EnvironmentQueryStore.Service> = {
    load: Effect.fn("EnvironmentQueryStore.load")(
      function* (environmentId, key) {
        const stored = yield* options.read(environmentId, queryCacheKey(environmentId, key));
        const now = yield* Clock.currentTimeMillis;
        return isStoredQuery(stored) &&
          stored.environmentId === environmentId &&
          stored.updatedAt >= now - QUERY_MAX_AGE_MS
          ? Option.some(stored.payload)
          : Option.none();
      },
      Effect.catch(() => Effect.succeedNone),
    ),
    save: (environmentId, key, payload) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          options.withDatabase((opened) =>
            saveQueryOnConnection(opened, environmentId, key, payload, now),
          ),
        ),
        Effect.catch(() => Effect.logWarning("Offline query database save failed")),
      ),
  };

  return queryStore;
}
