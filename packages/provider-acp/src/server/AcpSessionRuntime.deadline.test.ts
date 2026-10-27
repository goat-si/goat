import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

it.effect("retires an ACP runtime after a silent initialize", () =>
  Effect.gen(function* () {
    const writes = yield* Queue.unbounded<Uint8Array>();
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const finished = yield* Deferred.make<void>();
    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(123),
      exitCode: Deferred.await(exit),
      isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
      kill: () => Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
      stdin: Sink.forEach((chunk: Uint8Array) => Queue.offer(writes, chunk)),
      stdout: Stream.never,
      stderr: Stream.empty,
      all: Stream.never,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
    const layer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.succeed(handle)),
    );
    yield* Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.make({
        spawn: { command: "fake-acp", args: [], shell: false },
        cwd: "/repo",
        clientInfo: { name: "test", version: "0" },
      });
      const first = yield* runtime
        .initialize()
        .pipe(
          Effect.exit,
          Effect.ensuring(Deferred.succeed(finished, undefined)),
          Effect.forkScoped,
        );
      assert.include(new TextDecoder().decode(yield* Queue.take(writes)), "initialize");
      yield* TestClock.adjust("61 seconds");
      assert.isTrue(yield* Deferred.isDone(finished));
      assert.equal((yield* Fiber.join(first))._tag, "Failure");
      assert.equal((yield* Effect.exit(runtime.initialize()))._tag, "Failure");
      assert.equal(yield* Queue.size(writes), 0);
    }).pipe(Effect.provide(layer), Effect.provide(NodeCrypto.layer));
  }).pipe(Effect.scoped),
);
