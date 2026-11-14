import { it } from "@effect/vitest";
import { assert } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { runSshCommand } from "./command.ts";
import { SshCommandError } from "./errors.ts";
const encoder = new TextEncoder();

it.effect("keeps redacted output the command emitted before timing out", () => {
  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        stdout: Stream.concat(
          Stream.make(
            encoder.encode(
              'PROGRESS: extracting\n{"credential":"pairing-secret"}\n{"token":"partial\\"secret',
            ),
          ),
          Stream.never,
        ),
        stderr: Stream.concat(
          Stream.make(encoder.encode("REMOTE: waiting for archive extraction\n")),
          Stream.never,
        ),
        all: Stream.empty,
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    ),
  );
  const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

  return Effect.gen(function* () {
    const fiber = yield* runSshCommand(
      { alias: "devbox", hostname: "devbox", username: null, port: null },
      { remoteCommandArgs: ["sh", "-s"], timeoutMs: 1_000, keepErrorOutputTail: true },
    ).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("1 second");
    const failure = yield* Fiber.join(fiber);

    assert.instanceOf(failure, SshCommandError);
    assert.equal(failure.exitCode, null);
    assert.equal(
      failure.stdout,
      'PROGRESS: extracting\n{"credential":"[redacted]"}\n{"token":"[redacted]',
    );
    assert.equal(failure.stderr, "REMOTE: waiting for archive extraction\n");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, layerSpawner)));
});
