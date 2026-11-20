// @effect-diagnostics nodeBuiltinImport:off
// The service launcher imports this, so it stays on Node built-ins.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const SERVER_OWNER_LOCK_FILE = "server-owner.lock";
export const serverOwnerLogPath = (stateDir: string) =>
  NodePath.join(stateDir, SERVER_OWNER_LOCK_FILE);

export function serverOwnerLogFileIdentity(stateDir: string): string {
  const { dev, ino } = NodeFS.statSync(serverOwnerLogPath(stateDir), { bigint: true });
  return `${dev}:${ino}`;
}

// The exclusive SQLite lock admits one process at a time. Each acquisition records its owner
// so a launcher can check who held the database between its snapshot and rollback.
interface ServerOwnerLock {
  readonly generation: number;
  /** Owners that acquired the lock after `generation`, oldest first. */
  readonly ownersSince: (generation: number) => ReadonlyArray<string>;
  readonly writeSnapshotIdentity: (identity: string) => void;
  readonly snapshotIdentity: () => string | undefined;
  readonly release: () => void;
}

const isBusy = (cause: unknown) =>
  cause instanceof Error &&
  (("errcode" in cause && cause.errcode === 5) || cause.message === "database is locked");

/** Probe an existing generation lock without recording an owner. */
export function serverOwnerLockHeld(stateDir: string): boolean {
  const path = serverOwnerLogPath(stateDir);
  if (!NodeFS.existsSync(path)) return false;
  using db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 0");
  try {
    db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
    return false;
  } catch (cause) {
    if (isBusy(cause)) return true;
    throw cause;
  }
}

/** Takes the lock without waiting, or returns undefined while another process holds it. */
export function tryAcquireServerOwnerLock(
  stateDir: string,
  owner: string,
): ServerOwnerLock | undefined {
  const db = new NodeSqlite.DatabaseSync(serverOwnerLogPath(stateDir));
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
      writeSnapshotIdentity: (identity) => {
        db.exec(
          "CREATE TABLE IF NOT EXISTS service_snapshot (slot INTEGER PRIMARY KEY, identity TEXT NOT NULL)",
        );
        db.prepare("INSERT OR REPLACE INTO service_snapshot VALUES (1, ?)").run(identity);
      },
      snapshotIdentity: () => {
        if (
          db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'service_snapshot'").get() ===
          undefined
        ) {
          return undefined;
        }
        const identity = db
          .prepare("SELECT identity FROM service_snapshot WHERE slot = 1")
          .get()?.identity;
        return typeof identity === "string" ? identity : undefined;
      },
      release: () => db.close(),
    };
  } catch (cause) {
    db.close();
    throw cause;
  }
}
