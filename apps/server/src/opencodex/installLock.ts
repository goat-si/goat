// @effect-diagnostics nodeBuiltinImport:off - The install lock is a native SQLite handle held for one install.
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";

/** In the install prefix; it never holds data and is never unlinked. */
export const INSTALL_LOCK_FILE = ".install-lock.sqlite";

const isSqliteBusy = (cause: unknown) =>
  cause instanceof Error &&
  (("errcode" in cause && cause.errcode === 5) ||
    ("code" in cause && cause.code === "SQLITE_BUSY"));

/**
 * Holds one machine-wide OpenCodex install lock until the scope closes: an exclusive transaction
 * on a file that never holds data and is never unlinked. The OS releases it when the holder exits,
 * even on SIGKILL, so no stale lock is ever reclaimed. As serverOwnership.ts does.
 */
export const acquireInstallLock = Effect.fn("OpenCodexInstallLock.acquire")(function* <E>(
  file: string,
  busy: () => E,
  failed: (cause: unknown) => E,
) {
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const db = new NodeSqlite.DatabaseSync(file);
        try {
          db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
        } catch (cause) {
          db.close();
          throw cause;
        }
        return db;
      },
      catch: (cause) => (isSqliteBusy(cause) ? busy() : failed(cause)),
    }),
    (db) =>
      Effect.sync(() => {
        if (db.isTransaction) db.exec("ROLLBACK;");
        db.close();
      }),
  );
});
