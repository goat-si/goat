import { ConnectionTransientError } from "@goat/client-runtime/connection";
import * as Effect from "effect/Effect";

export function makeThreadWriteOrder() {
  const threadWrites = new Map<string, object>();
  const threadWrite = <A, E>(key: string, run: (isCurrent: () => boolean) => Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      const token = {};
      threadWrites.set(key, token);
      const isCurrent = () => threadWrites.get(key) === token;
      return run(isCurrent).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (isCurrent()) threadWrites.delete(key);
          }),
        ),
      );
    });
  return { threadWrites, threadWrite };
}

export function catalogError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the local connection catalog: ${String(cause)}`,
  });
}

export function writeDatabaseValueOnConnection(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  value: unknown,
  isCurrent: () => boolean = () => true,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    try {
      if (!isCurrent()) return resume(Effect.void);
      const transaction = database.transaction(storeName, "readwrite");
      // Commit failures can fire abort without error; every failed write fires abort.
      transaction.addEventListener("abort", () => {
        resume(
          Effect.fail(catalogError("write", transaction.error ?? "Unknown IndexedDB write error")),
        );
      });
      transaction.addEventListener("complete", () => {
        resume(Effect.void);
      });
      transaction.objectStore(storeName).put(value, key);
    } catch (cause) {
      resume(Effect.fail(catalogError("write", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.writeDatabaseValue"));
}

export function removeDatabaseValueOnConnection(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  isCurrent: () => boolean = () => true,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    try {
      if (!isCurrent()) return resume(Effect.void);
      const transaction = database.transaction(storeName, "readwrite");
      transaction.addEventListener("abort", () => {
        resume(
          Effect.fail(
            catalogError("remove", transaction.error ?? "Unknown IndexedDB remove error"),
          ),
        );
      });
      transaction.addEventListener("complete", () => {
        resume(Effect.void);
      });
      transaction.objectStore(storeName).delete(key);
    } catch (cause) {
      resume(Effect.fail(catalogError("remove", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValue"));
}
