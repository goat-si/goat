import { causeErrorTag } from "@goat/shared/observability";
import { resolveSpawnCommand } from "@goat/shared/shell";
import { collectUint8StreamText } from "@goat/shared/collectStreamText";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { providerProbeEnvironment } from "./probeEnvironment.ts";
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_BYTES = 256 * 1_024;

export const runProbe = Effect.fn("runProbe")(function* (
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  okExitCodes: ReadonlyArray<number> = [0],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const collect = Effect.gen(function* () {
    // Windows package managers are `.cmd` shims that need the shell.
    const probeEnv = providerProbeEnvironment(env);
    const resolved = yield* resolveSpawnCommand(command, args, { env: probeEnv, extendEnv: true });
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        env: probeEnv,
        extendEnv: true,
        shell: resolved.shell,
      }),
    );
    yield* Effect.addFinalizer(() => Effect.ignore(child.kill({ forceKillAfter: "1 second" })));
    // stderr is drained so a chatty tool cannot block on a full pipe.
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: PROBE_MAX_BYTES }),
        child.exitCode,
        Stream.runDrain(child.stderr),
      ],
      { concurrency: "unbounded" },
    );
    return !okExitCodes.includes(Number(exitCode)) || stdout.truncated ? null : stdout.text;
  });
  return yield* collect.pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(PROBE_TIMEOUT_MS)),
    Effect.map(Option.getOrNull),
    Effect.catchCause((cause) =>
      Effect.logWarning("Maintenance probe failed", {
        command,
        subcommand: args[0],
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as(null)),
    ),
  );
});
