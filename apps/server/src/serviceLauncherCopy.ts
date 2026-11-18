// @effect-diagnostics nodeBuiltinImport:off -- The standalone launcher copies files before Effect starts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

export function runCp(args: ReadonlyArray<string>, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile("cp", args, { signal }, (error) => resolve(error === null));
  });
}

// macOS fs.copyFile clone flags fall back to full copies.
export async function copyDatabaseFile(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  // oxlint-disable-next-line goat/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = process.platform;
  // cp -c replaces files and breaks hard links; copy into hard-linked destinations instead.
  const hardLinked =
    platform === "darwin" &&
    ((await NodeFSP.stat(destination).catch(() => undefined))?.nlink ?? 1) > 1;
  const args =
    platform === "darwin" && !hardLinked
      ? ["-c", source, destination]
      : platform === "linux"
        ? ["--reflink=auto", source, destination]
        : undefined;
  if (args !== undefined && (await runCp(args, signal))) return;
  signal?.throwIfAborted();
  await NodeFSP.copyFile(source, destination);
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
