import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as Cause from "effect/Cause";
import {
  type LeaseStreamAttempt,
  type LeaseTransportUpdate,
  followLeaseStream,
} from "./ComputerUseLeaseStreamFollower.ts";

const fixture = Effect.fn("LeaseStreamFollowerTest.fixture")(function* (
  options: { readonly random?: () => number } = {},
) {
  const attempts = yield* Queue.unbounded<LeaseStreamAttempt>();
  const connects = yield* Queue.unbounded<number>();
  const lines = yield* Queue.unbounded<string>();
  const transport = yield* Queue.unbounded<LeaseTransportUpdate>();
  let count = 0;
  const fiber = yield* followLeaseStream({
    connect: Effect.suspend(() => {
      Queue.offerUnsafe(connects, ++count);
      return Queue.take(attempts);
    }),
    onLine: (line) =>
      Queue.offer(lines, line).pipe(
        Effect.as(line.includes('"ended"') ? ("end" as const) : ("continue" as const)),
      ),
    onTransport: (update) => Queue.offer(transport, update).pipe(Effect.asVoid),
    random: options.random ?? (() => 0),
  }).pipe(Effect.forkChild);
  const open = Effect.fn("LeaseStreamFollowerTest.open")(function* (heartbeatMs?: number) {
    const body = yield* Queue.unbounded<string, Cause.Done | Error>();
    yield* Queue.offer(attempts, {
      _tag: "open",
      lines: Stream.fromQueue(body),
      ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
    });
    return body;
  });
  return {
    attempts,
    connect: Queue.take(connects),
    connects: Queue.size(connects),
    line: Queue.take(lines),
    transport: Queue.take(transport),
    transportSize: Queue.size(transport),
    open,
    fiber,
  };
});

describe("lease stream follower", () => {
  it.effect("a quiet stream that keeps its heartbeat stays on one connection for minutes", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.connect;
      const body = yield* f.open(15_000);
      yield* Queue.offer(body, '{"state":"waiting"}');
      yield* f.line;
      for (let beat = 0; beat < 20; beat++) {
        yield* TestClock.adjust("15 seconds");
        yield* Queue.offer(body, "");
        yield* f.line;
      }
      assert.equal(yield* f.connects, 0);
      assert.equal(yield* f.transportSize, 0);
    }),
  );

  it.effect(
    "a stream silent past three heartbeats reconnects instead of waiting on the socket",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.connect;
        const body = yield* f.open(15_000);
        yield* Queue.offer(body, '{"state":"waiting"}');
        yield* f.line;
        yield* TestClock.adjust("45 seconds");
        assert.deepEqual(yield* f.transport, { state: "reconnecting" });
        assert.equal(yield* f.connect, 2);
        const next = yield* f.open(15_000);
        yield* Queue.offer(next, '{"state":"waiting"}');
        assert.equal(yield* f.line, '{"state":"waiting"}');
      }),
  );

  it.effect("a stream that fails reconnects, and one that ends with ended stops for good", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.connect;
      const body = yield* f.open();
      yield* Queue.fail(body, new Error("UND_ERR_BODY_TIMEOUT"));
      assert.deepEqual(yield* f.transport, { state: "reconnecting" });
      yield* f.connect;
      const next = yield* f.open();
      yield* Queue.offer(next, '{"state":"ended","reason":"unauthorized"}');
      yield* f.line;
      yield* Fiber.join(f.fiber);
      assert.equal(yield* f.connects, 0);
    }),
  );

  it.effect("reports transport_lost exactly two minutes into an outage and keeps trying", () =>
    Effect.gen(function* () {
      const transport = yield* Queue.unbounded<LeaseTransportUpdate>();
      const lines = yield* Queue.unbounded<string>();
      let connects = 0;
      let serverBack = false;
      yield* followLeaseStream({
        connect: Effect.sync((): LeaseStreamAttempt => {
          connects++;
          return serverBack
            ? {
                _tag: "open",
                lines: Stream.concat(Stream.make('{"state":"waiting"}'), Stream.never),
              }
            : { _tag: "retry" };
        }),
        onLine: (line) => Queue.offer(lines, line).pipe(Effect.as("continue" as const)),
        onTransport: (update) => Queue.offer(transport, update).pipe(Effect.asVoid),
        random: () => 1,
      }).pipe(Effect.forkChild);
      assert.deepEqual(yield* Queue.take(transport), { state: "reconnecting" });
      yield* TestClock.adjust(119_999);
      assert.equal(yield* Queue.size(transport), 0);
      // 250 ms doubling to a 5 s cap: about two dozen attempts in two minutes, never a tight loop.
      assert.isAtLeast(connects, 20);
      assert.isAtMost(connects, 40);
      yield* TestClock.adjust(1);
      assert.deepEqual(yield* Queue.take(transport), { state: "transport_lost" });
      const lostAt = connects;
      serverBack = true;
      yield* TestClock.adjust("30 seconds");
      assert.equal(yield* Queue.take(lines), '{"state":"waiting"}');
      assert.equal(connects, lostAt + 1);
    }),
  );

  it.effect(
    "a server that drops every stream right after its snapshot still gets growing backoff",
    () =>
      Effect.gen(function* () {
        let connects = 0;
        const reconnecting = yield* Queue.unbounded<LeaseTransportUpdate>();
        yield* followLeaseStream({
          connect: Effect.sync((): LeaseStreamAttempt => {
            connects++;
            return { _tag: "open", lines: Stream.make('{"state":"waiting"}') };
          }),
          onLine: () => Effect.succeed("continue" as const),
          onTransport: (update) => Queue.offer(reconnecting, update).pipe(Effect.asVoid),
          random: () => 1,
        }).pipe(Effect.forkChild);
        yield* Queue.take(reconnecting);
        yield* TestClock.adjust("30 seconds");
        // 250 ms, 500 ms, 1 s, 2 s, 4 s, then 5 s apart: a dozen at most, not one every 250 ms.
        assert.isAtMost(connects, 12);
      }),
  );
});
