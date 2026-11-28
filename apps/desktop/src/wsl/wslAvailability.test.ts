import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { makeIsAvailable } from "./wslAvailability.ts";

const SERVICES_ROOT = "HKLM\\SYSTEM\\CurrentControlSet\\Services";

it.effect.each([
  { exists: true, service: "WSLService", expected: true },
  { exists: true, service: "LxssManager", expected: true },
  { exists: true, service: "", expected: false },
  { exists: false, service: "WSLService", expected: false },
])(
  "requires both the executable and a registered WSL service: $service",
  ({ exists, service, expected }) => {
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: Effect.succeed(
            ChildProcessSpawner.ExitCode(
              command._tag === "StandardCommand" &&
                (command.args.includes(SERVICES_ROOT) ||
                  (service !== "" &&
                    command.args.some((arg) => typeof arg === "string" && arg.endsWith(service))))
                ? 0
                : 1,
            ),
          ),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      ),
    );
    return makeIsAvailable("win32", "/windows").pipe(
      Effect.tap((actual) => Effect.sync(() => assert.strictEqual(actual, expected))),
      Effect.provide(
        Layer.mergeAll(
          Path.layer,
          Layer.succeed(
            FileSystem.FileSystem,
            FileSystem.makeNoop({ exists: () => Effect.succeed(exists) }),
          ),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  },
);

it.effect("keeps WSL when registry tools are disabled by policy and reg.exe cannot answer", () =>
  Effect.gen(function* () {
    const denied = new TextEncoder().encode(
      "ERROR: Registry editing has been disabled by your administrator.\r\n",
    );
    const blockedRegistry = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          stdout: Stream.empty,
          stderr: Stream.make(denied),
          all: Stream.make(denied),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      ),
    );
    const available = yield* makeIsAvailable("win32", "/windows").pipe(
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            exists: (path) => Effect.succeed(path === "/windows/System32/wsl.exe"),
          }),
          Path.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, blockedRegistry),
        ),
      ),
    );
    assert.isTrue(available);
  }),
);
