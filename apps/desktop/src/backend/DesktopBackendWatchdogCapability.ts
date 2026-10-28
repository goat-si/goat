import type { ManagedWatchdogBootstrap } from "@goat/contracts";
import {
  decodeRuntimeManifest,
  ownRuntimeManifest,
  supportsManagedWatchdog,
} from "@goat/shared/runtimeManifest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const resolveWslWatchdog = Effect.fn("desktop.backendConfiguration.resolveWslWatchdog")(
  function* (input: {
    readonly version: string;
    readonly arch: string;
    readonly generation: string;
    readonly distro: string;
    readonly command: ReadonlyArray<string>;
    readonly path: string;
  }) {
    const profile = `wsl-${input.arch}`;
    if (!supportsManagedWatchdog(ownRuntimeManifest({ version: input.version }), profile)) return;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const manifest = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(
            "wsl.exe",
            [
              "-d",
              input.distro,
              "--exec",
              "env",
              `PATH=${input.path}`,
              ...input.command,
              "__ssh-helper",
              "runtime-manifest",
            ],
            { stdin: "ignore", stdout: "pipe", stderr: "pipe", forceKillAfter: "1 second" },
          ),
        );
        const [exitCode, output] = yield* Effect.all(
          [
            child.exitCode,
            child.stdout.pipe(
              Stream.runFold(
                () => ({ bytes: 0, text: "" }),
                (state, chunk) => {
                  const bytes = state.bytes + chunk.byteLength;
                  return {
                    bytes,
                    text: bytes <= 4096 ? state.text + Buffer.from(chunk).toString("utf8") : "",
                  };
                },
              ),
            ),
            child.stderr.pipe(Stream.runDrain),
          ],
          { concurrency: "unbounded" },
        );
        return exitCode === 0 && output.bytes <= 4096
          ? decodeRuntimeManifest(output.text)
          : undefined;
      }).pipe(Effect.timeout("10 seconds")),
    ).pipe(Effect.orElseSucceed(() => undefined));
    if (manifest === undefined || !supportsManagedWatchdog(manifest, profile)) {
      yield* Effect.logWarning(
        "WSL backend does not provide verified managed health; using exit-only recovery",
      );
      return;
    }
    return {
      protocol: 1,
      mode: "self-observer",
      generation: input.generation,
    } satisfies ManagedWatchdogBootstrap;
  },
);
