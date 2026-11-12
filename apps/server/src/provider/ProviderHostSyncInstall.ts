import { resolveSpawnCommand } from "@goat/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { CliAnswer } from "./ProviderCliGate.ts";
import { versionCore } from "./ProviderHostSyncRecipes.ts";

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
 * Why a pinned install did not take: the CLI still reports another version. Undefined when it
 * matches, when nothing was pinned, or when the installer only installs the latest.
 */
export const pinnedMismatch = (
  name: string,
  requested: string | null,
  found: string | null,
  command: { readonly latestOnly: boolean } | null,
): string | undefined =>
  requested === null ||
  found === null ||
  command === null ||
  command.latestOnly ||
  versionCore(found) === requested
    ? undefined
    : `The installer finished, but ${name} is still ${versionCore(found) ?? found}, not ${requested}.`;
