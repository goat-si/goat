// @effect-diagnostics nodeBuiltinImport:off - runs synchronously before Electron is ready and before any layer exists, so no service may touch the state directory first.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Option from "effect/Option";

import {
  AUTOMATION_HOLD_FILE_NAME,
  CHANNEL_STATE_COPY_MARKER_FILE_NAME,
  encodeAutomationHold,
} from "@goat/contracts";
import { GOAT_HOME_DIR_NAME } from "@goat/shared/goatHome";

import {
  NIGHTLY_DESKTOP_HOME_DIR_NAME,
  STABLE_DESKTOP_HOME_DIR_NAME,
  resolveDesktopBaseDir,
} from "./DesktopStatePaths.ts";

/**
 * Written into the copy before it is published. Its presence in a published destination proves
 * the copy finished and passed verification; publishing is the rename of the whole directory.
 */
export const CHANNEL_STATE_MIGRATION_MARKER = CHANNEL_STATE_COPY_MARKER_FILE_NAME;

const STAGING_INFIX = ".migrating-";

/** Single files in userdata that carry user state. Logs, caches, locks and runtime files stay. */
const USERDATA_FILES = [
  "settings.json",
  "keybindings.json",
  "desktop-settings.json",
  "client-settings.json",
  "saved-environments.json",
  "connection-catalog.json",
  "environment-id",
  "anonymous-id",
  "thread-launch-watches.json",
  "note-work-intents.json",
  "imessage-channel-settings.json",
  "slack-channel-settings.json",
  "cloud-machines.json",
  "linux-device-scale-factor",
] as const;

/**
 * Directories whose regular files are copied recursively. Replicas, thread recovery, device and
 * browser state stay behind: they let a server resume another machine's work or are rebuilt.
 */
const USERDATA_DIRECTORIES = [
  "secrets",
  "attachments",
  "themes",
  "keybindings-migrations",
  "goat-bot",
  "memory-import",
] as const;
/**
 * Beside userdata. Worktrees, projects, scratch and the GOAT bot workspace are not copied: the
 * database points at them by absolute path, so both apps keep using the same folders.
 */
const BASE_DIRECTORIES = ["notes"] as const;

/** The first database that exists is snapshotted; the server copies V1 only when V2 is absent. */
const DATABASE_FILES = ["statev2.sqlite", "state.sqlite"] as const;

export interface ChannelStateMigrationOps {
  /** `sourceRoot` is the stable home's canonical path; nothing outside it may be read. */
  readonly copyFile: (source: string, destination: string, sourceRoot: string) => void;
  readonly rename: (from: string, to: string) => void;
  readonly snapshotDatabase: (source: string, destination: string) => void;
  readonly verifyDatabase: (path: string) => void;
  readonly isProcessAlive: (pid: number) => boolean;
}

export interface ChannelStateMigrationInput {
  /** The stable channel's GOAT home, which is only ever read. */
  readonly sourceBaseDir: string;
  readonly destinationBaseDir: string;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  /** ISO timestamp of the copy, recorded in the hold and the marker. */
  readonly copiedAt: string;
  readonly ops?: Partial<ChannelStateMigrationOps>;
}

export type ChannelStateMigrationResult =
  | { readonly _tag: "NoSource" }
  /** Stable's userdata resolves outside its home; a link is never followed, so nothing is copied. */
  | { readonly _tag: "SourceUnsafe" }
  | { readonly _tag: "DestinationExists" }
  | { readonly _tag: "Copied"; readonly files: number; readonly bytes: number }
  | { readonly _tag: "CopiedByAnotherLaunch" };

export class ChannelStateMigrationError extends Error {
  readonly step: string;
  readonly path: string;
  constructor(step: string, path: string, cause: unknown) {
    super(`Could not copy desktop state (${step} at ${path}): ${describe(cause)}`, { cause });
    this.name = "ChannelStateMigrationError";
    this.step = step;
    this.path = path;
  }
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Only a packaged nightly on the default home migrates. Stable owns the source, development
 * builds have their own home, and an explicit GOAT_HOME is a home the person chose.
 */
export function resolveChannelStateMigration(input: {
  readonly homeDirectory: string;
  readonly appVersion: string;
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
  readonly goatHome: string | undefined;
}): { readonly sourceBaseDir: string; readonly destinationBaseDir: string } | null {
  if (!input.isPackaged || input.isDevelopment || (input.goatHome?.trim() ?? "") !== "") {
    return null;
  }
  const destinationBaseDir = resolveDesktopBaseDir({
    homeDirectory: input.homeDirectory,
    joinPath: NodePath.join,
    goatHome: Option.none(),
    isDevelopment: false,
    appVersion: input.appVersion,
  });
  if (NodePath.basename(destinationBaseDir) !== NIGHTLY_DESKTOP_HOME_DIR_NAME) return null;
  return {
    sourceBaseDir: NodePath.join(
      input.homeDirectory,
      GOAT_HOME_DIR_NAME,
      STABLE_DESKTOP_HOME_DIR_NAME,
    ),
    destinationBaseDir,
  };
}

const errorCode = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;

const exists = (path: string) => {
  try {
    NodeFS.lstatSync(path);
    return true;
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
};

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists under another user.
    return errorCode(cause) === "EPERM";
  }
};

// A read-only connection never checkpoints into the source, and VACUUM INTO reads one
// transaction, so the snapshot is consistent while the stable server keeps writing.
const snapshotDatabase = (source: string, destination: string) => {
  const db = new NodeSqlite.DatabaseSync(source, { readOnly: true, timeout: 10_000 });
  try {
    db.prepare("VACUUM INTO ?").run(destination);
  } finally {
    db.close();
  }
};

const verifyDatabase = (path: string) => {
  const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA quick_check").all();
    const result = rows.map((row) => Object.values(row)[0]).join("; ");
    if (result !== "ok") throw new Error(`quick_check reported: ${result}`);
  } finally {
    db.close();
  }
};

const insideRoot = (root: string, path: string) => {
  const relative = NodePath.relative(root, path);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

/**
 * Copies one file without following a link at any step: the open refuses a final link, and the
 * opened file must be the one its resolved path names inside the stable home, so a component
 * swapped for a link after the listing fails the copy instead of reading outside it.
 */
export const copyFileWithin = (source: string, destination: string, sourceRoot: string) => {
  // Windows has no O_NOFOLLOW; the resolved-path check below still applies there.
  const input = NodeFS.openSync(
    source,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = NodeFS.fstatSync(input);
    if (!opened.isFile()) throw new Error("not a regular file");
    const resolved = NodeFS.realpathSync(source);
    const atResolved = NodeFS.statSync(resolved);
    if (
      !insideRoot(sourceRoot, resolved) ||
      atResolved.ino !== opened.ino ||
      atResolved.dev !== opened.dev
    ) {
      throw new Error("resolves outside GOAT's folder");
    }
    const output = NodeFS.openSync(destination, "wx", 0o600);
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const read = NodeFS.readSync(input, buffer, 0, buffer.length, null);
        if (read === 0) break;
        for (let written = 0; written < read;) {
          written += NodeFS.writeSync(output, buffer, written, read - written);
        }
      }
      NodeFS.fchmodSync(output, opened.mode & 0o777);
    } finally {
      NodeFS.closeSync(output);
    }
  } finally {
    NodeFS.closeSync(input);
  }
};

const defaultOps: ChannelStateMigrationOps = {
  copyFile: copyFileWithin,
  rename: NodeFS.renameSync,
  snapshotDatabase,
  verifyDatabase,
  isProcessAlive,
};

const fsyncPath = (platform: NodeJS.Platform, path: string, directory: boolean) => {
  // Windows cannot open a directory for fsync; NTFS journals the rename itself.
  if (directory && platform === "win32") return;
  if (platform !== "win32") {
    // POSIX flushes through a read-only descriptor, so read-only files (Git objects) need no mode change.
    const fd = NodeFS.openSync(path, "r");
    try {
      NodeFS.fsyncSync(fd);
    } finally {
      NodeFS.closeSync(fd);
    }
    return;
  }
  // Windows flushes only through a writable handle, so a read-only copy is made writable briefly.
  const { mode } = NodeFS.statSync(path);
  const writable = (mode & 0o200) !== 0;
  if (!writable) NodeFS.chmodSync(path, mode | 0o200);
  try {
    const fd = NodeFS.openSync(path, "r+");
    try {
      NodeFS.fsyncSync(fd);
    } finally {
      NodeFS.closeSync(fd);
    }
  } finally {
    if (!writable) NodeFS.chmodSync(path, mode);
  }
};

/** Links are never followed, so every byte copied comes from inside the stable home. */
const regularEntry = (path: string): "file" | "directory" | null => {
  let stats: NodeFS.Stats;
  try {
    stats = NodeFS.lstatSync(path);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return null;
    throw cause;
  }
  return stats.isFile() ? "file" : stats.isDirectory() ? "directory" : null;
};

const stagingPrefix = (destinationBaseDir: string) =>
  `${NodePath.basename(destinationBaseDir)}${STAGING_INFIX}`;

/** Removes staging directories left by launches that died mid-copy. Live ones are racing us. */
const removeAbandonedStaging = (destinationBaseDir: string, ops: ChannelStateMigrationOps) => {
  const parent = NodePath.dirname(destinationBaseDir);
  const prefix = stagingPrefix(destinationBaseDir);
  let entries: string[];
  try {
    entries = NodeFS.readdirSync(parent);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return;
    throw cause;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const pid = Number.parseInt(entry.slice(prefix.length).split("-")[0] ?? "", 10);
    if (Number.isSafeInteger(pid) && pid > 0 && ops.isProcessAlive(pid)) {
      continue;
    }
    NodeFS.rmSync(NodePath.join(parent, entry), { recursive: true, force: true });
  }
};

interface CopyTally {
  readonly sourceRoot: string;
  files: number;
  bytes: number;
}

const copyVerifiedFile = (
  platform: NodeJS.Platform,
  source: string,
  destination: string,
  ops: ChannelStateMigrationOps,
  tally: CopyTally,
) => {
  try {
    ops.copyFile(source, destination, tally.sourceRoot);
    const expected = NodeFS.statSync(source).size;
    const actual = NodeFS.statSync(destination).size;
    if (actual !== expected) {
      throw new Error(`copied ${actual} of ${expected} bytes`);
    }
    fsyncPath(platform, destination, false);
    tally.files += 1;
    tally.bytes += actual;
  } catch (cause) {
    throw new ChannelStateMigrationError("copy", source, cause);
  }
};

const copyDirectory = (
  platform: NodeJS.Platform,
  source: string,
  destination: string,
  ops: ChannelStateMigrationOps,
  tally: CopyTally,
) => {
  if (regularEntry(source) !== "directory") return;
  let entries: NodeFS.Dirent[];
  try {
    entries = NodeFS.readdirSync(source, { withFileTypes: true });
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return;
    throw new ChannelStateMigrationError("read", source, cause);
  }
  NodeFS.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const from = NodePath.join(source, entry.name);
    const to = NodePath.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(platform, from, to, ops, tally);
    // Half-written temp files belong to a writer in the middle of an atomic rename.
    else if (entry.isFile() && !entry.name.endsWith(".tmp"))
      copyVerifiedFile(platform, from, to, ops, tally);
  }
  fsyncPath(platform, destination, true);
};

/**
 * Seeds a channel's empty GOAT home from the stable channel's home, once. The source is only read.
 * Everything is copied into a sibling staging directory, verified, marked, and published by one
 * rename, so the destination either does not exist or holds a complete copy. Any failure removes
 * the staging copy and throws; the caller must not start, so the next launch retries.
 */
export function migrateChannelState(
  input: ChannelStateMigrationInput,
): ChannelStateMigrationResult {
  const ops: ChannelStateMigrationOps = { ...defaultOps, ...input.ops };
  const platform = input.platform;
  const destination = input.destinationBaseDir;
  if (exists(destination)) return { _tag: "DestinationExists" };
  const sourceUserdata = NodePath.join(input.sourceBaseDir, "userdata");
  if (!exists(sourceUserdata)) return { _tag: "NoSource" };
  // The home itself may live on another disk behind a link; nothing below it may leave it.
  const sourceRoot = NodeFS.realpathSync(input.sourceBaseDir);
  if (!insideRoot(sourceRoot, NodeFS.realpathSync(sourceUserdata))) return { _tag: "SourceUnsafe" };

  const parent = NodePath.dirname(destination);
  NodeFS.mkdirSync(parent, { recursive: true, mode: 0o700 });
  removeAbandonedStaging(destination, ops);
  const staging = NodePath.join(
    parent,
    `${stagingPrefix(destination)}${process.pid}-${NodeCrypto.randomUUID().slice(0, 8)}`,
  );
  const stagingUserdata = NodePath.join(staging, "userdata");
  const tally: CopyTally = { sourceRoot, files: 0, bytes: 0 };
  try {
    NodeFS.mkdirSync(stagingUserdata, { recursive: true, mode: 0o700 });

    const database = DATABASE_FILES.find(
      (name) => regularEntry(NodePath.join(sourceUserdata, name)) === "file",
    );
    if (database !== undefined) {
      const from = NodePath.join(sourceUserdata, database);
      const to = NodePath.join(stagingUserdata, database);
      try {
        if (!insideRoot(sourceRoot, NodeFS.realpathSync(from))) {
          throw new Error("resolves outside GOAT's folder");
        }
        ops.snapshotDatabase(from, to);
        ops.verifyDatabase(to);
        fsyncPath(platform, to, false);
      } catch (cause) {
        throw new ChannelStateMigrationError("snapshot", from, cause);
      }
      tally.files += 1;
      tally.bytes += NodeFS.statSync(to).size;
    }
    for (const name of USERDATA_FILES) {
      const from = NodePath.join(sourceUserdata, name);
      if (regularEntry(from) === "file") {
        copyVerifiedFile(platform, from, NodePath.join(stagingUserdata, name), ops, tally);
      }
    }
    for (const name of USERDATA_DIRECTORIES) {
      copyDirectory(
        platform,
        NodePath.join(sourceUserdata, name),
        NodePath.join(stagingUserdata, name),
        ops,
        tally,
      );
    }
    for (const name of BASE_DIRECTORIES) {
      copyDirectory(
        platform,
        NodePath.join(input.sourceBaseDir, name),
        NodePath.join(staging, name),
        ops,
        tally,
      );
    }

    const copiedAt = input.copiedAt;
    writeDurably(
      platform,
      NodePath.join(stagingUserdata, AUTOMATION_HOLD_FILE_NAME),
      encodeAutomationHold({ reason: "channel-copy", heldAt: copiedAt }),
    );
    fsyncPath(platform, stagingUserdata, true);
    writeDurably(
      platform,
      NodePath.join(staging, CHANNEL_STATE_MIGRATION_MARKER),
      `${JSON.stringify(
        {
          version: 1,
          source: input.sourceBaseDir,
          copiedAt,
          appVersion: input.appVersion,
          files: tally.files,
          bytes: tally.bytes,
        },
        null,
        2,
      )}\n`,
    );
    fsyncPath(platform, staging, true);
  } catch (cause) {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    throw cause instanceof ChannelStateMigrationError
      ? cause
      : new ChannelStateMigrationError("stage", staging, cause);
  }

  try {
    ops.rename(staging, destination);
  } catch (cause) {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    // Another first launch published its verified copy first; use it.
    if (exists(NodePath.join(destination, CHANNEL_STATE_MIGRATION_MARKER))) {
      return { _tag: "CopiedByAnotherLaunch" };
    }
    if (exists(destination)) return { _tag: "DestinationExists" };
    throw new ChannelStateMigrationError("publish", destination, cause);
  }
  try {
    fsyncPath(platform, parent, true);
  } catch {
    // Already published: the rename stands, and the next launch finds the copy either way.
  }
  return { _tag: "Copied", files: tally.files, bytes: tally.bytes };
}

const writeDurably = (platform: NodeJS.Platform, path: string, contents: string) => {
  NodeFS.writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
  fsyncPath(platform, path, false);
};
