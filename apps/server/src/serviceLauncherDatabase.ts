// @effect-diagnostics nodeBuiltinImport:off
// The launcher's database backup and restore; Node built-ins only, like the launcher itself.
import { copyDatabaseFile, runCp, syncDirectory } from "./serviceLauncherCopy.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import type { PendingServiceUpdate } from "./cloud/serviceProtocol.ts";
import {
  serverOwnerLogFileIdentity,
  serverOwnerLogPath,
  tryAcquireServerOwnerLock,
} from "./serverOwnerLockFile.ts";
import { replaceFileDurably } from "./serviceUnitRepoint.ts";
import { livePreLockServerOwner, tryAcquireLegacyServerOwnerLock } from "./serviceLauncherOwner.ts";

const DB_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;
const UNTRACKED_OWNER_MARKER = ".untracked-owner";
type DatabaseSuffix = (typeof DB_FILE_SUFFIXES)[number];

// Owner tags in the server-owner.lock generation log. Only these may own
// the userdata between an update's backup and its restore.
const launcherOwner = (updateId: string) => `service-launcher:${updateId}`;
const trialOwner = (updateId: string) => `service-trial:${updateId}`;
export const ownerLockDir = (pending: PendingServiceUpdate) => NodePath.dirname(pending.dbPath);

const databaseBackupDir = (baseDir: string, updateId: string) =>
  NodePath.join(baseDir, "runtime", "db-backup", updateId);

const databaseBackupFile = (backupDir: string, suffix: DatabaseSuffix) =>
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

const phasePath = (baseDir: string, updateId: string) =>
  NodePath.join(baseDir, "runtime", `db-update-${encodeURIComponent(updateId)}.phase`);

export async function databasePhase(baseDir: string, updateId: string) {
  try {
    const file = phasePath(baseDir, updateId);
    if (await pathExists(file)) {
      const phase = (await NodeFSP.readFile(file, "utf8")).trim();
      if (phase === "trial" || phase === "restore" || phase === "keep-live") return phase;
      return "unknown";
    }
    const backupDir = databaseBackupDir(baseDir, updateId);
    return (await pathExists(backupDir)) || (await pathExists(`${backupDir}.staging`))
      ? "unknown"
      : "fresh";
  } catch {
    return "unknown";
  }
}

export interface DatabaseSnapshot {
  readonly updateId: string;
  readonly generation: number;
  readonly identity: string;
  readonly logFile: string;
  readonly files: ReadonlySet<DatabaseSuffix>;
}

function acquireDatabaseOwnerLock(stateDir: string, owner: string) {
  try {
    return tryAcquireServerOwnerLock(stateDir, owner);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `The database ownership log at ${serverOwnerLogPath(stateDir)} could not be opened (${detail}).`,
      { cause },
    );
  }
}

export async function backupDatabase(
  baseDir: string,
  pending: PendingServiceUpdate,
  signal: AbortSignal,
): Promise<DatabaseSnapshot | undefined> {
  signal.throwIfAborted();
  const stateDir = ownerLockDir(pending);
  const lock = acquireDatabaseOwnerLock(stateDir, launcherOwner(pending.id));
  if (lock === undefined) return undefined;
  let releaseLegacy: (() => void) | undefined;
  try {
    releaseLegacy = tryAcquireLegacyServerOwnerLock(stateDir);
    if (releaseLegacy === undefined || (await livePreLockServerOwner(stateDir))) return undefined;
    if ((await databasePhase(baseDir, pending.id)) !== "fresh") {
      throw databaseRecoveryRequired(
        baseDir,
        pending,
        "This update already has database artifacts.",
      );
    }
    const mainTarget = await restoreTarget(pending.dbPath);
    if (!(await usableDatabase(mainTarget)))
      throw new Error("The live SQLite file set is unusable.");
    signal.throwIfAborted();
    const identity = NodeCrypto.randomUUID();
    const logFile = serverOwnerLogFileIdentity(stateDir);
    lock.writeSnapshotIdentity(identity);
    await replaceFileDurably(phasePath(baseDir, pending.id), "trial\n");

    const backupDir = databaseBackupDir(baseDir, pending.id);
    const stagingDir = `${backupDir}.staging`;
    await NodeFSP.mkdir(stagingDir, { recursive: true, mode: 0o700 });
    const files = new Set<DatabaseSuffix>();
    for (const suffix of DB_FILE_SUFFIXES) {
      signal.throwIfAborted();
      const source = `${mainTarget}${suffix}`;
      if (suffix !== "" && !(await pathExists(source))) continue;
      const destination = databaseBackupFile(stagingDir, suffix);
      await copyDatabaseFile(source, destination, signal);
      await syncFile(destination);
      files.add(suffix);
    }
    signal.throwIfAborted();
    await syncDirectory(stagingDir);
    await NodeFSP.rename(stagingDir, backupDir);
    await syncDirectory(NodePath.dirname(backupDir));
    return { updateId: pending.id, generation: lock.generation, identity, logFile, files };
  } finally {
    try {
      releaseLegacy?.();
    } finally {
      lock.release();
    }
  }
}

export async function markUntrackedDatabaseOwner(baseDir: string, updateId: string): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, updateId);
  if (await pathExists(backupDir)) {
    await replaceFileDurably(NodePath.join(backupDir, UNTRACKED_OWNER_MARKER), "");
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

export function databaseRecoveryRequired(
  baseDir: string,
  pending: PendingServiceUpdate,
  reason: string,
): Error {
  return new Error(
    `Database recovery required for ${pending.dbPath}. ${reason} ` +
      `The live files and any snapshot files at ${databaseBackupDir(baseDir, pending.id)} were kept. ` +
      `After verifying the live files, acknowledge recovery at ${phasePath(baseDir, pending.id)}. ` +
      "Follow the recovery steps at https://trygoat.ai/docs/user/updating#recover-an-interrupted-database-restore",
  );
}

async function fileDigest(path: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  const file = await NodeFSP.open(path, "r");
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    while (true) {
      const { bytesRead } = await file.read(chunk);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
}

async function matchesSnapshot(
  live: string,
  backupDir: string,
  expected: ReadonlySet<DatabaseSuffix>,
): Promise<boolean> {
  const backupFiles = new Set(await NodeFSP.readdir(backupDir));
  for (const suffix of DB_FILE_SUFFIXES) {
    const source = databaseBackupFile(backupDir, suffix);
    const target = `${live}${suffix}`;
    if (backupFiles.delete(NodePath.basename(source)) !== expected.has(suffix)) return false;
    if ((await pathExists(target)) !== expected.has(suffix)) return false;
    if (!expected.has(suffix)) continue;
    const [saved, current] = await Promise.all([NodeFSP.lstat(source), NodeFSP.stat(target)]);
    if (!saved.isFile() || !current.isFile() || saved.size !== current.size) return false;
    if (saved.dev === current.dev && saved.ino === current.ino) return false;
    const [left, right] = await Promise.all([fileDigest(source), fileDigest(target)]);
    if (left !== right) return false;
  }
  return backupFiles.size === 0;
}

async function validWal(path: string): Promise<boolean> {
  const stat = await NodeFSP.stat(path);
  if (!stat.isFile()) return false;
  if (stat.size === 0) return true;

  await using wal = await NodeFSP.open(path, "r");
  const header = Buffer.alloc(32);
  if ((await wal.read(header)).bytesRead !== header.length) return false;
  const magic = header.readUInt32BE(0);
  const pageSize = header.readUInt32BE(8);
  const frameSize = pageSize + 24;
  if (
    (magic !== 0x377f0682 && magic !== 0x377f0683) ||
    header.readUInt32BE(4) !== 3007000 ||
    pageSize < 512 ||
    pageSize > 65536 ||
    (pageSize & (pageSize - 1)) !== 0 ||
    (stat.size - header.length) % frameSize !== 0
  ) {
    return false;
  }

  // SQLite's WAL checksum runs across the header and all frame payloads.
  const littleEndian = magic === 0x377f0682;
  let first = 0;
  let second = 0;
  const checksum = (view: DataView, start: number, end: number) => {
    for (let offset = start; offset < end; offset += 8) {
      first = (first + view.getUint32(offset, littleEndian) + second) >>> 0;
      second = (second + view.getUint32(offset + 4, littleEndian) + first) >>> 0;
    }
  };
  checksum(new DataView(header.buffer, header.byteOffset, header.length), 0, 24);
  if (first !== header.readUInt32BE(24) || second !== header.readUInt32BE(28)) return false;

  const frame = Buffer.alloc(frameSize);
  const frameView = new DataView(frame.buffer, frame.byteOffset, frame.length);
  for (let offset = header.length; offset < stat.size; offset += frameSize) {
    if ((await wal.read(frame)).bytesRead !== frameSize) return false;
    if (
      frame.readUInt32BE(0) === 0 ||
      frame.readUInt32BE(8) !== header.readUInt32BE(16) ||
      frame.readUInt32BE(12) !== header.readUInt32BE(20)
    ) {
      return false;
    }
    checksum(frameView, 0, 8);
    checksum(frameView, 24, frameSize);
    if (first !== frame.readUInt32BE(16) || second !== frame.readUInt32BE(20)) return false;
  }
  return true;
}

async function usableDatabase(file: string): Promise<boolean> {
  let scratch: string | undefined;
  try {
    const stat = await NodeFSP.stat(file);
    if (!stat.isFile() || stat.size < 512 || (await pathExists(`${file}-journal`))) return false;
    const shm = await NodeFSP.stat(`${file}-shm`).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    });
    if (shm !== undefined && (!shm.isFile() || shm.size === 0 || shm.size % 32768 !== 0)) {
      return false;
    }
    const walPath = `${file}-wal`;
    let uri = NodeURL.pathToFileURL(file);
    if (await pathExists(walPath)) {
      if (!(await validWal(walPath))) return false;
      // SQLite may create or rewrite the WAL index even on a read-only connection.
      scratch = await NodeFSP.mkdtemp(NodePath.join(NodePath.dirname(file), ".goat-db-check-"));
      const copy = NodePath.join(scratch, "database");
      const clone = NodeFS.constants.COPYFILE_FICLONE;
      await NodeFSP.copyFile(file, copy, clone);
      await NodeFSP.copyFile(walPath, `${copy}-wal`, clone);
      uri = NodeURL.pathToFileURL(copy);
    } else {
      uri.searchParams.set("immutable", "1");
    }
    using db = new NodeSqlite.DatabaseSync(uri.href, { readOnly: true });
    // Full index verification can be slow on large databases and runs only before a trial or rollback.
    return db.prepare("PRAGMA integrity_check(1)").get()?.integrity_check === "ok";
  } catch {
    return false;
  } finally {
    if (scratch !== undefined) await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

export async function selectDatabaseRollback(
  baseDir: string,
  pending: PendingServiceUpdate,
  snapshot: DatabaseSnapshot | undefined,
  snapshotRequired: boolean,
  select: () => Promise<void>,
): Promise<"done" | "busy"> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  const phase = await databasePhase(baseDir, pending.id);
  const requireRecovery = (reason: string) => databaseRecoveryRequired(baseDir, pending, reason);
  const canKeep = phase === "keep-live" || (phase === "fresh" && !snapshotRequired);
  if (!canKeep && (phase !== "trial" || snapshot?.updateId !== pending.id)) {
    throw requireRecovery("No continuous ownership proof is available for this database update.");
  }

  const stateDir = ownerLockDir(pending);
  const owner = launcherOwner(pending.id);
  let lock: ReturnType<typeof acquireDatabaseOwnerLock>;
  try {
    lock = acquireDatabaseOwnerLock(stateDir, owner);
  } catch (cause) {
    throw requireRecovery(cause instanceof Error ? cause.message : String(cause));
  }
  if (lock === undefined) {
    if (canKeep) return "busy";
    throw requireRecovery("Another process holds the database ownership log.");
  }
  let releaseLegacy: (() => void) | undefined;
  try {
    try {
      releaseLegacy = tryAcquireLegacyServerOwnerLock(stateDir);
    } catch (cause) {
      throw requireRecovery(cause instanceof Error ? cause.message : String(cause));
    }
    if (releaseLegacy === undefined || (await livePreLockServerOwner(stateDir))) {
      if (canKeep) return "busy";
      throw requireRecovery("A legacy server is using the database.");
    }
    const live = await restoreTarget(pending.dbPath).catch(() => undefined);
    if (live === undefined) throw requireRecovery("The live SQLite path could not be resolved.");
    if (!canKeep && snapshot !== undefined) {
      let continuous = false;
      try {
        const distance = lock.generation - snapshot.generation;
        if (
          (distance === 1 || distance === 2) &&
          lock.snapshotIdentity() === snapshot.identity &&
          serverOwnerLogFileIdentity(stateDir) === snapshot.logFile
        ) {
          const owners = lock.ownersSince(snapshot.generation - 1);
          continuous =
            owners.length === distance + 1 &&
            owners[0] === owner &&
            owners.at(-1) === owner &&
            (distance === 1 || owners[1] === trialOwner(pending.id));
        }
      } catch {
        // A damaged or replaced log cannot authorize snapshot deletion.
      }
      if (!continuous) {
        throw requireRecovery("The original database ownership history could not be verified.");
      }

      // Legacy SQLite-only owners leave no log entry, so changed bytes have unknown provenance.
      if (!(await matchesSnapshot(live, backupDir, snapshot.files).catch(() => false))) {
        throw requireRecovery(
          "The live and snapshot files differ, or part of the snapshot is missing.",
        );
      }
    }
    if (!(await usableDatabase(live)))
      throw requireRecovery("The live SQLite file set is unusable.");
    if (!canKeep) {
      // The live files already match the verified snapshot; only the runtime selection needs restoring.
      await replaceFileDurably(phasePath(baseDir, pending.id), "restore\n");
    }
    await select();
    if (!canKeep) {
      await NodeFSP.rm(backupDir, { recursive: true });
      await syncDirectory(NodePath.dirname(backupDir));
    }
    if (phase !== "fresh") {
      await NodeFSP.rm(phasePath(baseDir, pending.id));
      await syncDirectory(NodePath.join(baseDir, "runtime"));
    }
    return "done";
  } finally {
    try {
      releaseLegacy?.();
    } finally {
      lock.release();
    }
  }
}
