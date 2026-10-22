import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { lazyChildProcessSpawner } from "./lazyChildProcessSpawner.ts";

it.effect("records a command only when its effect runs", () =>
  Effect.gen(function* () {
    const commands: Array<string> = [];
    const spawner = lazyChildProcessSpawner((command) => {
      if (command._tag !== "StandardCommand") return Effect.die("unexpected pipe");
      commands.push(command.command);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    const pending = spawner.exitCode(ChildProcess.make("claude", ["auth", "logout"]));
    assert.deepEqual(commands, []);
    assert.equal(Number(yield* pending), 0);
    assert.deepEqual(commands, ["claude"]);
  }),
);
