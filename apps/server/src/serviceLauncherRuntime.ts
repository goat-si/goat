// @effect-diagnostics nodeBuiltinImport:off - the standalone launcher uses Node directly.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { restoreTarget } from "./serviceLauncherDatabase.ts";

const MIN_START_FREE_BYTES = 64 * 1024 ** 2;

export const runtimePaths = (baseDir: string, version: string) => {
  const versionDir = NodePath.join(baseDir, "runtime", "goat", "versions", version);
  // oxlint-disable-next-line goat/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const executableName = process.platform === "win32" ? "goat.exe" : "goat";
  return {
    versionDir,
    entryPath: NodePath.join(versionDir, executableName),
    sentinelPath: NodePath.join(versionDir, ".install-complete"),
  };
};

export async function runtimeExists(baseDir: string, version: string): Promise<boolean> {
  const paths = runtimePaths(baseDir, version);
  try {
    const [entry, sentinel] = await Promise.all([
      NodeFSP.stat(paths.entryPath),
      NodeFSP.readFile(paths.sentinelPath, "utf8"),
    ]);
    return entry.isFile() && sentinel.trim() === version;
  } catch {
    return false;
  }
}

export async function readAvailableBytes(directory: string): Promise<number> {
  for (;;) {
    try {
      const stats = await NodeFSP.statfs(directory);
      return stats.bavail * stats.bsize;
    } catch (cause) {
      const parent = NodePath.dirname(directory);
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || parent === directory) throw cause;
      directory = parent;
    }
  }
}

export function logDiskWait(reason: string, write: (line: string) => void): void {
  try {
    write(`[service-launcher] ${reason} Waiting for free space before retrying.\n`);
  } catch {
    // The diagnostic destination may be on the full volume.
  }
}

export async function startupDiskBlocker(input: {
  readonly baseDir: string;
  readonly statePath: string;
  readonly version: string;
  readonly dbPath: string;
  readonly readAvailableBytes: (directory: string) => Promise<number>;
}): Promise<string | undefined> {
  try {
    const database = await restoreTarget(input.dbPath);
    const directories = new Set([
      NodePath.dirname(input.statePath),
      NodePath.dirname(database),
      runtimePaths(input.baseDir, input.version).versionDir,
    ]);
    for (const directory of directories) {
      const free = await input.readAvailableBytes(directory);
      if (free < MIN_START_FREE_BYTES) {
        return `GOAT needs ${MIN_START_FREE_BYTES} bytes free on ${directory}; ${free} bytes available.`;
      }
    }
  } catch (cause) {
    return `Could not check disk capacity: ${cause instanceof Error ? cause.message : String(cause)}.`;
  }
}
