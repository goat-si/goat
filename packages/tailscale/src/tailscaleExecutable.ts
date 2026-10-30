import * as HostProcess from "@goat/shared/HostProcess";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * Where macOS installs keep the CLI when PATH has none. Standard CLI locations
 * (the app's optional launcher, Homebrew) outrank the app bundle binary.
 * https://tailscale.com/docs/reference/tailscale-cli (macOS)
 */
const MAC_FALLBACK_PATHS = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

/**
 * The app bundle binary opens the GUI unless it sees terminal variables
 * (SHLVL, TERM, ...), which a Dock-launched GOAT lacks. This forces CLI mode.
 */
const MAC_CLI_ENV = { TAILSCALE_BE_CLI: "1" } as const;

export class TailscaleSpawnFailure extends Data.TaggedError("TailscaleSpawnFailure")<{
  readonly executable: string;
  readonly cause: unknown;
}> {}

const isNotFound = (failure: TailscaleSpawnFailure): boolean =>
  PlatformError.isPlatformError(failure.cause) && failure.cause.reason._tag === "NotFound";

export const spawnTailscale = Effect.fn("tailscale.spawnTailscale")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly forceKillAfter: Duration.Input },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnOnce = (executable: string, env?: Record<string, string>) =>
    spawner
      .spawn(
        ChildProcess.make(executable, [...args], {
          forceKillAfter: options.forceKillAfter,
          ...(env === undefined ? {} : { env, extendEnv: true }),
        }),
      )
      .pipe(
        Effect.map((handle) => ({ handle, executable })),
        Effect.mapError((cause) => new TailscaleSpawnFailure({ executable, cause })),
        // A non-directory PATH entry makes node throw ENOTDIR synchronously,
        // which surfaces as a defect rather than a typed error.
        Effect.catchDefect((cause) =>
          Effect.fail(new TailscaleSpawnFailure({ executable, cause })),
        ),
      );

  const first = spawnOnce(command);
  if ((yield* HostProcess.Platform) !== "darwin") {
    return yield* first;
  }
  const tryFallback = (
    index: number,
    pathMiss: TailscaleSpawnFailure,
  ): ReturnType<typeof spawnOnce> => {
    const executable = MAC_FALLBACK_PATHS[index];
    return executable === undefined
      ? Effect.fail(pathMiss)
      : spawnOnce(executable, MAC_CLI_ENV).pipe(
          Effect.catchIf(isNotFound, () => tryFallback(index + 1, pathMiss)),
        );
  };
  return yield* first.pipe(Effect.catchIf(isNotFound, (pathMiss) => tryFallback(0, pathMiss)));
});
