import * as Data from "effect/Data";

export const classifyStartupExit = (stderr: string) =>
  /SQLITE_BUSY|database is locked/i.test(stderr) ? ("databaseLocked" as const) : undefined;

export class OpenCodeSpawnFailure extends Data.TaggedError("OpenCodeSpawnFailure")<{
  readonly spawnCwd: string;
  readonly cause: unknown;
}> {}

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
