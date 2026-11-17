// @effect-diagnostics nodeBuiltinImport:off
// The launcher's database backup and restore; Node built-ins only, like the launcher itself.
import { copyDatabaseFile, runCp } from "./serviceLauncherCopy.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { PendingServiceUpdate } from "./cloud/serviceProtocol.ts";
import { tryAcquireServerOwnerLock } from "./serverOwnerLockFile.ts";

const DB_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;
const RESTORE_MARKER = ".restore-pending";
const ROLLBACK_MARKER = ".rollback-pending";
const OWNER_GENERATION_FILE = "owner-generation";

// Owner tags in the server-owner.lock generation log. Only these two may own
// the userdata between an update's backup and its restore.
export const launcherOwner = (updateId: string) => `service-launcher:${updateId}`;
const trialOwner = (updateId: string) => `service-trial:${updateId}`;
const probationOwner = (updateId: string) => `service-probation:${updateId}`;
export const ownerLockDir = (pending: PendingServiceUpdate) => NodePath.dirname(pending.dbPath);

const databaseBackupDir = (baseDir: string, updateId: string) =>
  NodePath.join(baseDir, "runtime", "db-backup", updateId);

const databaseBackupFile = (backupDir: string, suffix: (typeof DB_FILE_SUFFIXES)[number]) =>
  NodePath.join(backupDir, suffix === "" ? "database" : `database${suffix}`);

export async function pathExists(target: string): Promise<boolean> {
  try {
    await NodeFSP.access(target);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

// Opened read-write: Windows refuses to flush a handle without write access.
async function syncFile(filePath: string): Promise<void> {
  const handle = await NodeFSP.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Fsync makes renames durable; Windows returns EPERM and NTFS journals them itself.
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await NodeFSP.open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  } finally {
    await handle.close();
  }
}

const GIB = 1024 ** 3;
// Cloned backups still need headroom for trial writes and migrations to diverge.
const CLONED_BACKUP_MIN_HEADROOM_BYTES = GIB;
const CLONED_BACKUP_HEADROOM_FRACTION = 0.1;

async function statDatabaseFiles(dbPath: string): Promise<ReadonlyArray<NodeFS.Stats>> {
  const stats: Array<NodeFS.Stats> = [];
  const mainTarget = await restoreTarget(dbPath);
  for (const suffix of DB_FILE_SUFFIXES) {
    const filePath = suffix === "" ? dbPath : `${mainTarget}${suffix}`;
    const stat = await NodeFSP.stat(filePath).catch((cause: unknown) => {
      if (suffix !== "" && (cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    });
    if (stat !== undefined) stats.push(stat);
  }
  return stats;
}

// cp -c silently copies across volumes; require one device matching the APFS system volume's filesystem type.
async function backupCanClone(dbPath: string, backupRoot: string): Promise<boolean> {
  // oxlint-disable-next-line goat/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = process.platform;
  if (platform === "darwin") {
    const [backupDirectory, backupFs, systemFs] = await Promise.all([
      NodeFSP.stat(backupRoot),
      NodeFSP.statfs(backupRoot),
      NodeFSP.statfs("/"),
    ]);
    if (backupFs.type !== systemFs.type) return false;
    return (await statDatabaseFiles(dbPath)).every(
      (source) => source.dev === backupDirectory.dev && source.nlink === 1,
    );
  }
  if (platform !== "linux") return false;
  const probe = NodePath.join(backupRoot, `.clone-probe-${NodeCrypto.randomUUID()}`);
  try {
    for (const suffix of DB_FILE_SUFFIXES) {
      const source = `${dbPath}${suffix}`;
      if (suffix !== "" && !(await pathExists(source))) continue;
      if (!(await runCp(["--reflink=always", source, `${probe}${suffix}`]))) return false;
    }
    return true;
  } finally {
    for (const suffix of DB_FILE_SUFFIXES) {
      await NodeFSP.rm(`${probe}${suffix}`, { force: true }).catch(() => undefined);
    }
  }
}

export interface BackupSpaceProbe {
  readonly readFreeBytes: (directory: string) => Promise<number>;
  readonly canClone: (dbPath: string, backupRoot: string) => Promise<boolean>;
}

const filesystemBackupSpaceProbe: BackupSpaceProbe = {
  readFreeBytes: async (directory) => {
    const stats = await NodeFSP.statfs(directory);
    return stats.bavail * stats.bsize;
  },
  canClone: backupCanClone,
};

/** Check before stopping the server so full disks refuse updates without an outage. */
export async function databaseBackupBlocker(
  baseDir: string,
  dbPath: string,
  probe: Partial<BackupSpaceProbe> = {},
): Promise<string | undefined> {
  const { readFreeBytes, canClone } = { ...filesystemBackupSpaceProbe, ...probe };
  const backupRoot = NodePath.join(baseDir, "runtime", "db-backup");
  await NodeFSP.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const [files, free] = await Promise.all([statDatabaseFiles(dbPath), readFreeBytes(backupRoot)]);
  const size = files.reduce((total, file) => total + file.size, 0);
  const fullCopyBytes = size * 1.05;
  if (free >= fullCopyBytes) return undefined;
  const clonedBytes = Math.max(
    CLONED_BACKUP_MIN_HEADROOM_BYTES,
    size * CLONED_BACKUP_HEADROOM_FRACTION,
  );
  const needed = (await canClone(dbPath, backupRoot)) ? clonedBytes : fullCopyBytes;
  if (free >= needed) return undefined;
  const gb = (bytes: number) => (bytes / GIB).toFixed(1);
  return `Not enough free disk space to back up the database before updating: ${gb(needed)} GB needed, ${gb(free)} GB free. Free up disk space and try again. The server was not stopped.`;
}

/**
 * Snapshots the database once per update before the first trial, while the
 * caller holds server-owner.lock at `generation`. A completed backup is never
 * overwritten because a restarted launcher may be looking at database writes
 * from an earlier attempt by the same trial.
 */
export async function backupDatabaseOnce(
  baseDir: string,
  pending: PendingServiceUpdate,
  generation: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (await pathExists(backupDir)) return;

  const stagingDir = `${backupDir}.staging`;
  await NodeFSP.rm(stagingDir, { recursive: true, force: true });
  await NodeFSP.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  try {
    // SQLite keeps -wal and -shm beside the resolved database file, not beside a symlink to it.
    const mainTarget = await restoreTarget(pending.dbPath);
    for (const suffix of DB_FILE_SUFFIXES) {
      signal.throwIfAborted();
      const source = suffix === "" ? pending.dbPath : `${mainTarget}${suffix}`;
      if (suffix !== "" && !(await pathExists(source))) continue;
      const destination = databaseBackupFile(stagingDir, suffix);
      await copyDatabaseFile(source, destination, signal);
      await syncFile(destination);
    }
    signal.throwIfAborted();
    const generationPath = NodePath.join(stagingDir, OWNER_GENERATION_FILE);
    await NodeFSP.writeFile(generationPath, `${generation}\n`, { mode: 0o600 });
    await syncFile(generationPath);
    await NodeFSP.rename(stagingDir, backupDir);
    await syncDirectory(NodePath.dirname(backupDir));
  } catch (cause) {
    await NodeFSP.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

/** A rollback was decided, or its restore started, and recovery must finish it. */
export async function databaseRestorePending(
  baseDir: string,
  pending: PendingServiceUpdate,
): Promise<boolean> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  return (
    (await pathExists(NodePath.join(backupDir, ROLLBACK_MARKER))) ||
    (await pathExists(NodePath.join(backupDir, RESTORE_MARKER)))
  );
}

async function writeMarker(backupDir: string, marker: string): Promise<void> {
  const markerPath = NodePath.join(backupDir, marker);
  if (!(await pathExists(markerPath))) {
    const handle = await NodeFSP.open(markerPath, "wx", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(backupDir);
  }
}

// Resolve symlink targets even if a crashed cp -c left the final target missing.
async function restoreTarget(path: string): Promise<string> {
  let current = path;
  for (let hops = 0; hops < 40; hops++) {
    try {
      return await NodeFSP.realpath(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    const link = await NodeFSP.readlink(current).catch((cause: unknown) => {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EINVAL") return undefined;
      throw cause;
    });
    if (link === undefined) return current;
    // Do not normalize .. before following directory symlinks; match filesystem resolution.
    current = NodePath.isAbsolute(link)
      ? link
      : `${await NodeFSP.realpath(NodePath.dirname(current))}${NodePath.sep}${link}`;
  }
  throw new Error(`Too many symbolic links resolving ${path}.`);
}

// Restores the backup under server-owner.lock. `busy`: another process holds the lock and the
// rollback stays pending. `kept`: a server other than this update's launcher and trial owned the
// data since the backup, so its writes win. A started copy leaves the live files partial, so later
// attempts finish it regardless; retryable after any crash while the backup remains.
export async function restoreDatabaseBackup(
  baseDir: string,
  pending: PendingServiceUpdate,
): Promise<"restored" | "busy" | "kept"> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (!(await pathExists(backupDir))) return "restored";
  await writeMarker(backupDir, ROLLBACK_MARKER);

  const lock = tryAcquireServerOwnerLock(ownerLockDir(pending), launcherOwner(pending.id));
  if (lock === undefined) return "busy";
  try {
    if (!(await pathExists(NodePath.join(backupDir, RESTORE_MARKER)))) {
      const recorded = await NodeFSP.readFile(
        NodePath.join(backupDir, OWNER_GENERATION_FILE),
        "utf8",
      ).catch(() => "");
      const generation = Number.parseInt(recorded, 10);
      const ours = new Set([
        launcherOwner(pending.id),
        trialOwner(pending.id),
        probationOwner(pending.id),
      ]);
      // A backup without a recorded generation cannot prove nobody else wrote.
      if (
        !Number.isSafeInteger(generation) ||
        lock.ownersSince(generation).some((owner) => !ours.has(owner))
      ) {
        return "kept";
      }
      await writeMarker(backupDir, RESTORE_MARKER);
    }
    const directories = new Set([NodePath.dirname(pending.dbPath)]);
    // SQLite keeps -wal and -shm beside the resolved database file, not beside a symlink to it.
    const mainTarget = await restoreTarget(pending.dbPath);
    for (const suffix of DB_FILE_SUFFIXES) {
      const livePath = suffix === "" ? pending.dbPath : `${mainTarget}${suffix}`;
      if (livePath !== `${pending.dbPath}${suffix}`) {
        await NodeFSP.rm(`${pending.dbPath}${suffix}`, { force: true });
      }
      const source = databaseBackupFile(backupDir, suffix);
      if (await pathExists(source)) {
        // Restore through the link: cloning replaces its destination.
        const target = await restoreTarget(livePath);
        await copyDatabaseFile(source, target);
        await syncFile(target);
        directories.add(NodePath.dirname(target));
      } else {
        await NodeFSP.rm(livePath, { force: true });
      }
    }
    for (const directory of directories) await syncDirectory(directory);
    // A completed copy goes back to the ownership check if the launcher
    // crashes before recording the rollback, so a server that writes after
    // this point is never overwritten by a second copy.
    await NodeFSP.rm(NodePath.join(backupDir, RESTORE_MARKER), { force: true });
    await syncDirectory(backupDir);
    return "restored";
  } finally {
    lock.release();
  }
}

export async function discardDatabaseBackup(baseDir: string, updateId: string): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, updateId);
  if (!(await pathExists(backupDir))) return;
  await NodeFSP.rm(backupDir, { recursive: true, force: true });
  await syncDirectory(NodePath.dirname(backupDir));
}
