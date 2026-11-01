// @effect-diagnostics nodeBuiltinImport:off
// The service launcher imports this, so it stays on Node built-ins.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const SERVER_OWNER_LOCK_FILE = "server-owner.lock";

/**
 * Ownership of one userdata directory. `<userdata>/server-owner.lock` is a
 * SQLite file whose exclusive lock admits one process at a time to that
 * userdata's database, and the OS drops the lock when its holder dies.
 *
 * Every acquisition also appends its owner to a generation log in the same
 * file. A holder that records its generation can later list who owned the
 * data since then, even owners that came and went while it was not holding
 * the lock. The service launcher relies on this to never restore a database
 * backup over another server's writes, so every acquirer must go through
 * here: the launcher tags itself `service-launcher:<updateId>` and expects a
 * trial server to tag itself `service-trial:<updateId>`.
 */
interface ServerOwnerLock {
  readonly generation: number;
  /** Owners that acquired the lock after `generation`, oldest first. */
  readonly ownersSince: (generation: number) => ReadonlyArray<string>;
  readonly release: () => void;
}

const isBusy = (cause: unknown) =>
  cause instanceof Error &&
  (("errcode" in cause && cause.errcode === 5) || cause.message === "database is locked");

/** Takes the lock without waiting, or returns undefined while another process holds it. */
export function tryAcquireServerOwnerLock(
  stateDir: string,
  owner: string,
): ServerOwnerLock | undefined {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, SERVER_OWNER_LOCK_FILE));
  try {
    // Exclusive locking mode keeps the lock past the commit below, until close.
    db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
  } catch (cause) {
    db.close();
    if (isBusy(cause)) return undefined;
    throw cause;
  }
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS owner_generations (generation INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL)",
    );
    const row = db
      .prepare("INSERT INTO owner_generations (owner) VALUES (?) RETURNING generation")
      .get(owner);
    db.exec("COMMIT");
    return {
      generation: Number(row?.generation),
      ownersSince: (generation) =>
        db
          .prepare("SELECT owner FROM owner_generations WHERE generation > ? ORDER BY generation")
          .all(generation)
          .map((entry) => String(entry.owner)),
      release: () => db.close(),
    };
  } catch (cause) {
    db.close();
    throw cause;
  }
}
