import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Schema from "effect/Schema";
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
    }).pipe(Effect.provide(Layer.merge(layer, NodeCrypto.layer)));
  }).pipe(Effect.scoped),
);

it.effect("lets an ACP prompt finish after more than the finite request budgets", () =>
  Effect.gen(function* () {
    const inbound = yield* Queue.unbounded<Uint8Array>();
    const promptRequests = yield* Queue.unbounded<number>();
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const finished = yield* Deferred.make<void>();
    const respond = (id: number, result: unknown) =>
      Queue.offer(
        inbound,
        new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`),
      );
    const decodeRequest = Schema.decodeEffect(
      Schema.fromJsonString(Schema.Struct({ id: Schema.Number, method: Schema.String })),
    );
    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(124),
      exitCode: Deferred.await(exit),
      isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
      kill: () => Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
      stdin: Sink.forEach((chunk: Uint8Array) =>
        decodeRequest(new TextDecoder().decode(chunk)).pipe(
          Effect.orDie,
          Effect.flatMap((request) => {
            switch (request.method) {
              case "initialize":
                return respond(request.id, {
                  protocolVersion: 1,
                  agentCapabilities: {},
                  authMethods: [],
                });
              case "session/new":
                return respond(request.id, { sessionId: "long-prompt" });
              case "session/prompt":
                return Queue.offer(promptRequests, request.id);
              default:
                return Effect.die(`Unexpected request: ${request.method}`);
            }
          }),
        ),
      ),
      stdout: Stream.fromQueue(inbound),
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
      yield* runtime.start();
      const prompt = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "Keep working." }] })
        .pipe(Effect.ensuring(Deferred.succeed(finished, undefined)), Effect.forkScoped);
      const requestId = yield* Queue.take(promptRequests);
      yield* TestClock.adjust("2 minutes");
      assert.isFalse(yield* Deferred.isDone(finished));
      yield* respond(requestId, { stopReason: "end_turn" });
      assert.equal((yield* Fiber.join(prompt)).stopReason, "end_turn");
    }).pipe(Effect.provide(Layer.merge(layer, NodeCrypto.layer)));
  }).pipe(Effect.scoped),
);
