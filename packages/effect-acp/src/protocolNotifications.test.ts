import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as AcpProtocol from "./protocol.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const MIB = 1024 * 1024;
const decodeIndex = Schema.decodeUnknownSync(Schema.Struct({ index: Schema.Number }));
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();
const largeNotification = (index: number, textLength: number) =>
  encoder.encode(
    `${encodeUnknownJsonString({
      jsonrpc: "2.0",
      method: "x/large",
      params: { index, text: "x".repeat(textLength) },
    })}\n`,
  );

it.layer(NodeServices.layer)("effect-acp protocol notifications", (it) => {
  it.effect("keeps only recent raw notifications after their callbacks run", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const handled = yield* Deferred.make<void>();
      let handledCount = 0;
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onNotification: () =>
          Effect.sync(() => ++handledCount).pipe(
            Effect.flatMap((count) =>
              count === 64 ? Deferred.succeed(handled, undefined).pipe(Effect.asVoid) : Effect.void,
            ),
          ),
      });

      const messages = Array.from({ length: 64 }, (_, index) =>
        encodeUnknownJsonString({
          jsonrpc: "2.0",
          method: "x/performance",
          params: { index },
        }),
      );
      yield* Queue.offer(input, encoder.encode(`${messages.join("\n")}\n`));
      yield* Deferred.await(handled);

      const retained = yield* transport.incoming.pipe(Stream.take(32), Stream.runCollect);

      assert.equal(handledCount, 64);
      assert.equal(retained.length, 32);
      assert.deepEqual(retained[0]?.params, { index: 32 });
      assert.deepEqual(retained[31]?.params, { index: 63 });
    }),
  );

  it.effect("keeps the newest unread raw notifications whose JSON fits in 16Mi characters", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const handled = yield* Queue.unbounded<number>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onNotification: (notification) =>
          Queue.offer(handled, decodeIndex(notification.params).index).pipe(Effect.asVoid),
      });

      // Ten 3 MiB notifications: only the newest five fit in the budget.
      for (let index = 0; index < 10; index++) {
        yield* Queue.offer(input, largeNotification(index, 3 * MIB));
        assert.equal(yield* Queue.take(handled), index);
      }

      const retained = yield* transport.incoming.pipe(Stream.take(5), Stream.runCollect);
      assert.deepEqual(
        retained.map((notification) => decodeIndex(notification.params).index),
        [5, 6, 7, 8, 9],
      );
    }),
  );

  it.effect("keeps a single unread raw notification just under the budget", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const handled = yield* Queue.unbounded<number>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onNotification: (notification) =>
          Queue.offer(handled, decodeIndex(notification.params).index).pipe(Effect.asVoid),
      });

      // A 16 Mi-character frame cap rejects a larger line before the callback, so
      // the single-item case uses just under the unread budget instead.
      yield* Queue.offer(input, largeNotification(0, 2 * MIB));
      yield* Queue.take(handled);
      const retainedIndex = 15 * MIB;
      yield* Queue.offer(input, largeNotification(1, retainedIndex));
      yield* Queue.take(handled);

      const [retained] = yield* transport.incoming.pipe(Stream.take(1), Stream.runCollect);
      assert.equal(decodeIndex(retained?.params).index, 1);
    }),
  );

  it.effect("evicts unread raw notifications while a slow reader handles an earlier one", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const handled = yield* Queue.unbounded<number>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onNotification: (notification) =>
          Queue.offer(handled, decodeIndex(notification.params).index).pipe(Effect.asVoid),
      });
      const send = (index: number, textLength: number) =>
        Queue.offer(input, largeNotification(index, textLength)).pipe(
          Effect.andThen(Queue.take(handled)),
        );

      yield* send(1, 6 * MIB);
      yield* send(2, 6 * MIB);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const reader = yield* transport.incoming.pipe(
        Stream.map((notification) => decodeIndex(notification.params).index),
        Stream.tap((index) =>
          index === 1
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);

      // Notification 2 is still unread, so 3 and 4 push it past the budget.
      yield* send(3, 6 * MIB);
      yield* send(4, 6 * MIB);
      yield* send(5, 1);
      yield* Deferred.succeed(release, undefined);

      assert.deepEqual(yield* Fiber.join(reader), [1, 3, 4, 5]);
    }),
  );

  it.effect("delivers every raw notification to a reader that keeps up, then ends", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });
      const received = yield* Queue.unbounded<number>();
      const reader = yield* transport.incoming.pipe(
        Stream.map((notification) => decodeIndex(notification.params).index),
        Stream.tap((index) => Queue.offer(received, index)),
        Stream.runCollect,
        Effect.forkScoped,
      );

      // 30 MiB in total, well past the unread budget.
      for (let index = 0; index < 10; index++) {
        yield* Queue.offer(input, largeNotification(index, 3 * MIB));
        assert.equal(yield* Queue.take(received), index);
      }
      yield* Queue.end(input);

      assert.deepEqual(yield* Fiber.join(reader), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }),
  );

  it.effect("ends the raw notification stream when the connection scope closes", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const connection = yield* Scope.make();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      }).pipe(Scope.provide(connection));
      const reader = yield* transport.incoming.pipe(Stream.runCollect, Effect.forkScoped);

      yield* Scope.close(connection, Exit.void);

      assert.deepEqual(yield* Fiber.join(reader), []);
    }),
  );

  it.effect("keeps the ended raw backlog intact when notifications arrive after termination", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const handled = yield* Queue.unbounded<number>();
      const terminated = yield* Deferred.make<void>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio: Stdio.make({
          args: stdio.args,
          stdin: stdio.stdin,
          stdout: () => Sink.forEach(() => Effect.die("stdout failed")),
          stderr: () => Sink.drain,
        }),
        serverRequestMethods: new Set(),
        onNotification: (notification) =>
          Queue.offer(handled, decodeIndex(notification.params).index).pipe(Effect.asVoid),
        onTermination: () => Deferred.succeed(terminated, undefined).pipe(Effect.asVoid),
      });
      const deliver = (index: number) =>
        Queue.offer(
          input,
          encoder.encode(
            `${encodeUnknownJsonString({ jsonrpc: "2.0", method: "x/late", params: { index } })}\n`,
          ),
        ).pipe(Effect.andThen(Queue.take(handled)));

      for (let index = 0; index < 32; index++) {
        assert.equal(yield* deliver(index), index);
      }
      // A failed write terminates the connection while the reader keeps running.
      yield* transport.notify("x/fail", {}).pipe(Effect.exit);
      yield* Deferred.await(terminated);
      assert.equal(yield* deliver(32), 32);

      const retained = yield* transport.incoming.pipe(
        Stream.map((notification) => decodeIndex(notification.params).index),
        Stream.runCollect,
      );
      assert.deepEqual(
        retained,
        Array.from({ length: 32 }, (_, index) => index),
      );
    }),
  );
});
