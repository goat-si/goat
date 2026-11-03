import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

// A tool's own PATH may be restricted, so the wrapper is found at a fixed system location.
const NICE_CANDIDATES = ["/usr/bin/nice", "/bin/nice"];

/** The system `nice` on macOS and Linux, or undefined when tools cannot be lowered here. */
export const resolveNice = Effect.fn("ToolPriority.resolveNice")(function* (
  platform: NodeJS.Platform,
) {
  if (platform !== "darwin" && platform !== "linux") return undefined;
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of NICE_CANDIDATES) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return candidate;
    }
  }
  yield* Effect.logWarning("Agent tools run at normal priority: no system nice found");
  return undefined;
});

export function toolPriorityLaunch(
  nice: string | undefined,
  command: string,
  args: ReadonlyArray<string> = [],
  lower = true,
) {
  return lower && nice !== undefined
    ? { command: nice, args: ["-n", "10", command, ...args] }
    : { command, args };
}

// Node runs `shell: true` as `/bin/sh -c <command>` on Unix, so this is the same launch, lowered.
export function toolPriorityShellLaunch(nice: string | undefined, commandLine: string) {
  return nice !== undefined
    ? { command: nice, args: ["-n", "10", "/bin/sh", "-c", commandLine], shell: false }
    : { command: commandLine, args: [], shell: true };
}
