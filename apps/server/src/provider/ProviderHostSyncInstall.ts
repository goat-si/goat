import { resolveSpawnCommand } from "@goat/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { CliAnswer } from "./ProviderCliGate.ts";
import { installedButNotFound, versionCore } from "./ProviderHostSyncRecipes.ts";

const INSTALL_DEADLINE = Duration.minutes(10);
const OUTPUT_LIMIT = 16_384;

/** Runs a fixed installer argv. Output is kept only to classify a failure. */
export const runInstaller = Effect.fn("ProviderHostSync.runInstaller")(
  function* (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const resolved = yield* resolveSpawnCommand(command, args);
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        shell: resolved.shell,
        env: { CI: "1", npm_config_yes: "true" },
        extendEnv: true,
        stdin: "ignore",
      }),
    );
    yield* Effect.addFinalizer(() => Effect.ignore(child.kill({ forceKillAfter: "1 second" })));
    let tail = "";
    const decoder = new TextDecoder();
    const keep = (chunk: Uint8Array) =>
      Effect.sync(() => {
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(-OUTPUT_LIMIT);
      });
    const [, , exitCode] = yield* Effect.all(
      [
        Stream.runForEach(child.stdout, keep),
        Stream.runForEach(child.stderr, keep),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { exitCode: Number(exitCode), output: tail };
  },
  Effect.scoped,
  Effect.timeoutOption(INSTALL_DEADLINE),
  Effect.map((result) =>
    Option.getOrElse(result, () => ({ exitCode: null as number | null, output: "" })),
  ),
);

/**
 * A matrix row as the instance's own probe sees it, for drivers whose probe runs their CLI: only a
 * probed present counts as installed, so a snapshot that was never probed never skips an install.
 */
export const withProbedCli = <
  Row extends { readonly installed: boolean; readonly version: string | null },
>(
  row: Row | undefined,
  answer: CliAnswer | undefined,
): Row | undefined =>
  answer === undefined || row === undefined
    ? row
    : {
        ...row,
        installed: answer.kind === "present",
        version: answer.kind === "present" ? answer.provider.version : null,
      };

/**
 * Why a pinned install did not take: the CLI reports another version, or none GOAT can read.
 * Undefined when it matches or when nothing was pinned.
 */
const pinnedMismatch = (
  name: string,
  requested: string | null,
  found: string | null,
  command: object | null,
): string | undefined =>
  requested === null || command === null
    ? undefined
    : found === null
      ? `The installer finished, but GOAT could not read ${name}'s version to confirm ${requested}.`
      : versionCore(found) === requested
        ? undefined
        : `The installer finished, but ${name} is still ${versionCore(found) ?? found}, not ${requested}.`;

/** Why an install did not take, judged after it: no CLI found or confirmed, or another pin. */
export const installFailure = (
  recipe: { readonly binary: string; readonly displayName: string },
  requested: string | null,
  seen: {
    readonly after: { readonly installed: boolean; readonly version: string | null } | undefined;
    readonly answer: CliAnswer | undefined;
    readonly host: Parameters<typeof installedButNotFound>[1];
  },
  command: object | null,
): { readonly message: string; readonly version?: string | null } | undefined => {
  if (seen.after?.installed !== true)
    return {
      message:
        seen.answer?.kind === "unknown"
          ? `Installed, but GOAT could not confirm ${recipe.binary} runs here.`
          : installedButNotFound(recipe.binary, seen.host),
    };
  const stale = pinnedMismatch(recipe.displayName, requested, seen.after.version, command);
  return stale === undefined ? undefined : { message: stale, version: seen.after.version };
};
