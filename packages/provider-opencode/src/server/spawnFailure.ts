import * as Data from "effect/Data";
import { ProviderCommandNotFoundError } from "@goat/provider-core/server/snapshotProbe";

export const classifyStartupExit = (stderr: string) =>
  /SQLITE_BUSY|database is locked/i.test(stderr) ? ("databaseLocked" as const) : undefined;

export class OpenCodeSpawnFailure extends Data.TaggedError("OpenCodeSpawnFailure")<{
  readonly spawnCwd: string | undefined;
  readonly spawnPath?: string | undefined;
  readonly cause: unknown;
}> {
  static notFound = commandNotFoundDetails;
}

export const spawnFailureFor =
  (spawnCwd: string | undefined, environment?: NodeJS.ProcessEnv) => (cause: unknown) =>
    new OpenCodeSpawnFailure({ spawnCwd, spawnPath: environment?.PATH ?? process.env.PATH, cause });

export function findSpawnFailure(
  cause: unknown,
): { cwd: string | undefined; path: string | undefined } | undefined {
  const seen = new Set<unknown>();
  let current = cause;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("spawnCwd" in current)
      return {
        cwd: typeof current.spawnCwd === "string" ? current.spawnCwd : undefined,
        path:
          "spawnPath" in current && typeof current.spawnPath === "string"
            ? current.spawnPath
            : undefined,
      };
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
