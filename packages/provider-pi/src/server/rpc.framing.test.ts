import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makePiRpcConnection } from "./rpc.ts";
import { FAKE_PID } from "./test/fakePi.ts";

describe("PiRpc framing", () => {
  it.effect("reassembles records and warns when dropping oversized records", () => {
    const warnings: Array<ReadonlyArray<unknown>> = [];
    const warned = Deferred.makeUnsafe<void>();
    const logCapture = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Warn" && Array.isArray(message)) {
        warnings.push(message);
        Deferred.doneUnsafe(warned, Effect.void);
      }
    });
    return Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const push = (text: string) =>
        Queue.offer(stdout, new TextEncoder().encode(text)).pipe(Effect.asVoid);
      yield* push('{"type":"agent_');
      yield* push('start"}\r\n{"type":"agent_settled"}\nnot json\n{"type":"queue_update"}\n');

      const head = '{"type":"must_not_emit","text":"';
      yield* push(head);
      const chunk = new TextEncoder().encode("x".repeat(8 * 1024 * 1024));
      for (let index = 0; index < 32; index++) yield* Queue.offer(stdout, chunk);
      yield* Deferred.await(warned);
      yield* push('"}\n{"type":"after_oversized"}\n');

      const first = yield* Queue.take(connection.events);
      assert.equal(first["type"], "agent_start");
      const second = yield* Queue.take(connection.events);
      assert.equal(second["type"], "agent_settled");
      const third = yield* Queue.take(connection.events);
      assert.equal(third["type"], "queue_update");
      assert.equal((yield* Queue.take(connection.events))["type"], "after_oversized");
      assert.lengthOf(warnings, 1);
      const [text, annotations] = warnings[0] ?? [];
      assert.equal(text, "Dropping oversized pi stdout record.");
      assert.deepEqual(annotations, {
        recordLength: head.length + 28 * chunk.length,
        maxRecordLength: 232084864,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logCapture], { mergeWithExisting: false })),
      ),
    );
  });
});
