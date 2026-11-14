// @effect-diagnostics nodeBuiltinImport:off -- Shared with the standalone launcher.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { guardChild } from "@goat/shared/errorGuards";

const BTRFS_SUPER_MAGIC = 0x9123683e;
const ATTRIBUTE_TOOL_TIMEOUT_MS = 1500;
const ATTRIBUTE_TOOL_MAX_OUTPUT_BYTES = 16 * 1024;
const SQLITE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

const onBtrfs = (path: string) =>
  NodeFSP.statfs(path).then(
    (stats) => stats.type === BTRFS_SUPER_MAGIC,
    () => undefined,
  );

const definitelyAbsent = (path: string) =>
  NodeFSP.lstat(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

function runAttributeTool(command: "chattr" | "lsattr", args: ReadonlyArray<string>) {
  return new Promise<string | undefined>((resolve) => {
    const signal = AbortSignal.timeout(ATTRIBUTE_TOOL_TIMEOUT_MS);
    const finish = (output: string | undefined) => {
      signal.removeEventListener("abort", fail);
      resolve(output);
    };
    const fail = () => finish(undefined);
    signal.addEventListener("abort", fail, { once: true });
    try {
      guardChild(
        NodeChildProcess.execFile(
          command,
          args,
          {
            signal,
            encoding: "utf8",
            killSignal: "SIGKILL",
            maxBuffer: ATTRIBUTE_TOOL_MAX_OUTPUT_BYTES,
          },
          (error, stdout) => finish(error === null ? stdout : undefined),
        ),
        fail,
      );
    } catch {
      fail();
    }
  });
}

async function readNoCopyOnWrite(path: string): Promise<boolean | undefined> {
  const output = await runAttributeTool("lsattr", ["-d", path]);
  const flags = /^([a-zA-Z-]{15,40})[\t ]+\//u.exec(output ?? "")?.[1];
  return flags?.includes("C");
}

export async function prepareNewSqliteDirectory(
  databasePath: string,
  legacyDatabasePath: string,
): Promise<void> {
  const directory = NodePath.dirname(databasePath);
  if ((await onBtrfs(directory)) !== true) return;
  const entry = await NodeFSP.lstat(directory).catch(() => undefined);
  if (!entry?.isDirectory() || (entry.mode & 0o7777) !== 0o700) return;

  // A directory flag also changes the sidecars a legacy database would create after rollback.
  const absent = await Promise.all(
    [databasePath, legacyDatabasePath].flatMap((file) =>
      SQLITE_FILE_SUFFIXES.map((suffix) => definitelyAbsent(`${file}${suffix}`)),
    ),
  );
  if (absent.every(Boolean)) await runAttributeTool("chattr", ["+C", directory]);
}

/** On btrfs the destination must inherit the source's flag for reflink to work. */
export async function prepareSqliteBackupDestination(
  platform: NodeJS.Platform,
  source: string,
  directory: string,
): Promise<boolean> {
  if (platform !== "linux") return true;
  const destinationIsBtrfs = await onBtrfs(directory);
  if (destinationIsBtrfs === false) return true;
  if (destinationIsBtrfs === undefined || (await onBtrfs(source)) !== true) return false;

  const [sourceFlag, directoryFlag] = await Promise.all([
    readNoCopyOnWrite(source),
    readNoCopyOnWrite(directory),
  ]);
  if (sourceFlag === undefined || directoryFlag === undefined) return false;
  if (sourceFlag === directoryFlag) return true;
  const result = await runAttributeTool("chattr", [sourceFlag ? "+C" : "-C", directory]);
  return result !== undefined && (await readNoCopyOnWrite(directory)) === sourceFlag;
}
