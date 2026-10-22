import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import * as HostProcess from "@goat/shared/HostProcess";
import { probeHostKey } from "./hostKey.ts";
import { runPreflightProcess } from "./preflightProcess.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "preflight process cleanup",
  () => {
    it.effect.each(["preflight", "fingerprint"] as const)(
      "%s timeout escalates past SIGTERM and reaps the real child",
      (runner) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "goat-preflight-cleanup-",
          });
          const marker = `${directory}/term-received`;
          const ready = yield* Deferred.make<void>();
          const spawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
          const native = yield* ChildProcessSpawner.ChildProcessSpawner;
          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (command._tag !== "StandardCommand")
                return yield* Effect.die("Unexpected pipeline");
              expect(command.options.forceKillAfter).toBe(2_000);
              const child = yield* native.spawn(
                ChildProcess.make(
                  process.execPath,
                  [
                    "-e",
                    `
          const fs = require('node:fs');
          process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(marker)}, 'ignored'));
          process.stdout.write('ready');
          setInterval(() => {}, 2147483647);
        `,
                  ],
                  command.options,
                ),
              );
              yield* Deferred.succeed(spawned, child);
              return {
                ...child,
                stdout: child.stdout.pipe(Stream.tap(() => Deferred.succeed(ready, undefined))),
              };
            }),
          );
          const work =
            runner === "preflight"
              ? runPreflightProcess("fixture", []).pipe(
                  Effect.map((output) => {
                    expect(output.exitCode).toBe(255);
                    expect(output.stderr).toContain("timed out");
                  }),
                )
              : probeHostKey({
                  target: "fixture",
                  resolvedSettings: new Map([
                    ["hostname", "fixture"],
                    ["port", "22"],
                  ]),
                }).pipe(
                  Effect.result,
                  Effect.map((result) => {
                    expect(result._tag).toBe("Failure");
                    if (result._tag === "Failure")
                      expect(result.failure._tag).toBe("SshHostKeyProbeError");
                  }),
                );
          const fiber = yield* work.pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.forkChild,
          );
          const child = yield* Deferred.await(spawned);
          yield* Deferred.await(ready);
          yield* TestClock.adjust("20 seconds");
          yield* Fiber.join(fiber);
          expect(yield* fs.readFileString(marker)).toBe("ignored");
          expect(yield* child.isRunning).toBe(false);
          const exit = yield* child.exitCode.pipe(Effect.flip);
          expect(String(exit.cause)).toContain("SIGKILL");
        }).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
