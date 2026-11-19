// @effect-diagnostics nodeBuiltinImport:off -- The standalone launcher uses Node's SQLite lock.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const SERVICE_SERVING_LOCK_FILE = "service-serving.lock";

export function acquireServiceServingLock(baseDir: string): () => void {
  const db = new NodeSqlite.DatabaseSync(
    NodePath.join(baseDir, "runtime", SERVICE_SERVING_LOCK_FILE),
  );
  try {
    db.exec("PRAGMA busy_timeout = 250; BEGIN EXCLUSIVE");
    return () => db.close();
  } catch (cause) {
    db.close();
    throw cause;
  }
}

export function serviceServingLockHeld(baseDir: string): boolean {
  const path = NodePath.join(baseDir, "runtime", SERVICE_SERVING_LOCK_FILE);
  if (!NodeFS.existsSync(path)) return false;
  using db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
    return false;
  } catch (cause) {
    if (cause instanceof Error && "errcode" in cause && cause.errcode === 5) return true;
    throw cause;
  }
}
