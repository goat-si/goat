import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const OUTPUT_LIMIT = 64 * 1024;
export const collectPreflightOutput = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.runFold(
      () => new Uint8Array(0),
      (output, chunk) => {
        const next = new Uint8Array(Math.min(OUTPUT_LIMIT, output.length + chunk.length));
        next.set(output);
        next.set(chunk.subarray(0, next.length - output.length), output.length);
        return next;
      },
    ),
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
  );

export const runPreflightProcess = (command: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          stdin: "ignore",
          shell: false,
          forceKillAfter: 2_000,
          env: { GH_PROMPT_DISABLED: "1", LC_ALL: "C" },
          extendEnv: true,
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectPreflightOutput(child.stdout),
          collectPreflightOutput(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return { exitCode, stdout, stderr };
    }),
  ).pipe(
    Effect.timeout("20 seconds"),
    Effect.orElseSucceed(() => ({
      exitCode: 255,
      stdout: "",
      stderr: "SSH preflight timed out or could not start the command.",
    })),
  );
