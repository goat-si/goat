// @effect-diagnostics nodeBuiltinImport:off
// The standalone launcher's view of who owns a GOAT home, mirroring acquireServerOwnership.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  legacyOwnerStartedBeforeRecord,
  legacyOwnerStartTimeCommand,
} from "./legacyServerOwner.ts";

/** Hold the SQLite lock used by servers that predate the generation log. */
export function tryAcquireLegacyServerOwnerLock(stateDir: string): (() => void) | undefined {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "server-owner.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (cause) {
    db.close();
    if (
      cause instanceof Error &&
      (("errcode" in cause && cause.errcode === 5) || cause.message === "database is locked")
    )
      return undefined;
    throw cause;
  }
  return () => db.close();
}

export async function stateDirOwned(stateDir: string): Promise<boolean> {
  try {
    const release = tryAcquireLegacyServerOwnerLock(stateDir);
    if (release === undefined) return true;
    release();
  } catch {
    // Lock errors other than a competing holder are server startup's to report.
  }
  return livePreLockServerOwner(stateDir);
}

export async function livePreLockServerOwner(stateDir: string): Promise<boolean> {
  let record: unknown;
  try {
    record = JSON.parse(
      await NodeFSP.readFile(NodePath.join(stateDir, "server-runtime.json"), "utf8"),
    );
  } catch {
    return false;
  }
  if (typeof record !== "object" || record === null || "ownerId" in record) return false;
  const pid = "pid" in record ? record.pid : undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM")) return false;
  }
  const recordedAt = Date.parse(
    "startedAt" in record && typeof record.startedAt === "string" ? record.startedAt : "",
  );
  if (!Number.isFinite(recordedAt)) return true;
  // oxlint-disable-next-line goat/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = process.platform;
  const { command, args, env } = legacyOwnerStartTimeCommand(pid, platform);
  const output = await new Promise<string | undefined>((resolve) => {
    NodeChildProcess.execFile(
      command,
      args,
      { env: { ...process.env, ...env }, timeout: 2_000, maxBuffer: 16_384 },
      (error, stdout) => resolve(error === null ? stdout : undefined),
    );
  });
  return legacyOwnerStartedBeforeRecord(output, recordedAt, platform);
}
