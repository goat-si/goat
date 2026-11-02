import * as Data from "effect/Data";
import { ProviderCommandNotFoundError } from "@goat/provider-core/server/snapshotProbe";

export const classifyStartupExit = (stderr: string) =>
  /SQLITE_BUSY|database is locked/i.test(stderr) ? ("databaseLocked" as const) : undefined;

export class OpenCodeSpawnFailure extends Data.TaggedError("OpenCodeSpawnFailure")<{
  readonly spawnCwd: string;
  readonly cause: unknown;
}> {
  static notFound = commandNotFoundDetails;
}

export function findSpawnCwd(cause: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = cause;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("spawnCwd" in current && typeof current.spawnCwd === "string") return current.spawnCwd;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function commandNotFoundDetails(
  binaryPath: string,
  exitCode: number,
  stdout: string,
  stderr: string,
) {
  return {
    detail: `spawn ${binaryPath} ENOENT`,
    cause: new ProviderCommandNotFoundError({
      binaryPath,
      exitCode,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
    }),
  };
}
