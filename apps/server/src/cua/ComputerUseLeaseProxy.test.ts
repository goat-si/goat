import { assert, describe, it } from "@effect/vitest";
import type { ComputerUseLeaseUpdate } from "@goat/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { LEASE_END_MESSAGES, leaseUpdateLines, runLeaseProxy } from "./ComputerUseLeaseProxy.ts";

const HANDOFF = "handoff:grant";
const call = (id: number, name: string, args: object = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const active = (expiresAt = "1970-01-01T00:30:00.000Z"): ComputerUseLeaseUpdate => ({
  state: "active",
  handoffId: HANDOFF,
  expiresAt,
});

/** A proxy over in-memory stdio, lease stream and driver, on the TestClock (epoch 0). */
const harness = Effect.fn(function* (
  options: {
    readonly expiresAt?: string;
    /** Stands in for `cua-driver revoke`; defaults to recording and returning at once. */
    readonly revoke?: (sessions: ReadonlyArray<string>) => Effect.Effect<void>;
  } = {},
) {
  const input = yield* Queue.unbounded<string, Cause.Done>();
  const output = yield* Queue.unbounded<string>();
  const updates = yield* Queue.unbounded<ComputerUseLeaseUpdate, Cause.Done | string>();
  const driverIn = yield* Queue.unbounded<string>();
  const driverOut = yield* Queue.unbounded<string, Cause.Done>();
  const killed = yield* Deferred.make<void>();
  const revokeCalled = yield* Deferred.make<void>();
  const revoked: Array<ReadonlyArray<string>> = [];
  const proxy = yield* runLeaseProxy({
    handoffId: HANDOFF,
    expiresAt: DateTime.makeUnsafe(options.expiresAt ?? "1970-01-01T00:30:00.000Z"),
    input: Stream.fromQueue(input),
    output: (line) => Queue.offer(output, line).pipe(Effect.asVoid),
    leaseUpdates: Stream.fromQueue(updates),
    startDriver: Effect.succeed({
      send: (line: string) => Queue.offer(driverIn, line).pipe(Effect.asVoid),
      lines: Stream.fromQueue(driverOut),
      kill: Deferred.succeed(killed, undefined).pipe(Effect.andThen(Queue.end(driverOut))),
    }),
    revokeSessions: (sessions) =>
      Effect.sync(() => void revoked.push(sessions)).pipe(
        Effect.andThen(Deferred.succeed(revokeCalled, undefined)),
        Effect.andThen(options.revoke?.(sessions) ?? Effect.void),
      ),
  }).pipe(Effect.scoped, Effect.forkChild);
  const json = (line: string) => JSON.parse(line) as Record<string, unknown>;
  return {
    send: (line: string) => Queue.offer(input, line),
    close: Queue.end(input),
    push: (update: ComputerUseLeaseUpdate) => Queue.offer(updates, update),
    failLeaseStream: Queue.fail(updates, "connection reset"),
    reply: (line: string) => Queue.offer(driverOut, line),
    nextToDriver: Queue.take(driverIn).pipe(Effect.map(json)),
    nextToProvider: Queue.take(output).pipe(Effect.map(json)),
    driverQueued: Queue.size(driverIn),
    killed: Deferred.await(killed),
    isKilled: Deferred.isDone(killed),
    revokeCalled: Deferred.await(revokeCalled),
    revoked,
    proxy,
  };
});

const refusedCall = (id: number, reason: keyof typeof LEASE_END_MESSAGES) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: LEASE_END_MESSAGES[reason] }], isError: true },
});

describe("ComputerUseLeaseProxy", () => {
  it.effect("holds a call until the server confirms the lease, then forwards it", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }));
      // The handshake needs no lease; the driver answers it.
      assert.equal((yield* h.nextToDriver).method, "initialize");
      yield* h.send(call(1, "list_apps"));
      yield* h.push(active());
      assert.deepEqual((yield* h.nextToDriver).params, { name: "list_apps", arguments: {} });
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
      assert.deepEqual((yield* h.nextToProvider).id, 1);
    }),
  );

  it.effect(
    "on revoke cancels the call in flight, revokes its session, kills the driver, refuses the next",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push(active());
        yield* h.send(call(7, "run_script", { script: "/* long */", session: "work" }));
        assert.equal((yield* h.nextToDriver).id, 7);
        // The person ends it while run_script is still running and the provider stays up.
        yield* h.push({ state: "ended", reason: "revoked" });
        yield* h.killed;
        assert.deepEqual(yield* h.nextToDriver, {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 7, reason: LEASE_END_MESSAGES.revoked },
        });
        assert.deepEqual(yield* h.nextToProvider, refusedCall(7, "revoked"));
        yield* h.revokeCalled;
        assert.deepEqual(h.revoked, [["work"]]);
        // A late answer from the dead driver never reaches the provider.
        yield* h.send(call(8, "click", { pid: 1, x: 1, y: 1 }));
        assert.deepEqual(yield* h.nextToProvider, refusedCall(8, "revoked"));
        assert.equal(yield* h.driverQueued, 0);
        yield* h.close;
        assert.equal(yield* Fiber.join(h.proxy), "revoked");
      }),
  );

  it.effect("expires on its own clock with a long call outstanding and no new call", () =>
    Effect.gen(function* () {
      const h = yield* harness({ expiresAt: "1970-01-01T00:10:00.000Z" });
      yield* h.push(active("1970-01-01T00:10:00.000Z"));
      yield* h.send(call(3, "run_steps", { steps: [] }));
      assert.equal((yield* h.nextToDriver).id, 3);
      yield* TestClock.adjust("9 minutes");
      assert.isFalse(yield* h.isKilled);
      yield* TestClock.adjust("1 minute");
      yield* h.killed;
      assert.equal((yield* h.nextToDriver).method, "notifications/cancelled");
      assert.deepEqual(yield* h.nextToProvider, refusedCall(3, "expired"));
      yield* h.send(call(4, "click"));
      assert.deepEqual(yield* h.nextToProvider, refusedCall(4, "expired"));
    }),
  );

  it.effect.each(["revoked", "expired"] as const)(
    "kills the driver and answers the provider while a session revoke is stuck (%s)",
    (reason) =>
      Effect.gen(function* () {
        const stuck = yield* Deferred.make<void>();
        const h = yield* harness({
          expiresAt: "1970-01-01T00:10:00.000Z",
          revoke: () => Deferred.await(stuck),
        });
        yield* h.push(active("1970-01-01T00:10:00.000Z"));
        yield* h.send(call(7, "run_script", { script: "/* long */", session: "work" }));
        assert.equal((yield* h.nextToDriver).id, 7);
        if (reason === "revoked") yield* h.push({ state: "ended", reason: "revoked" });
        else yield* TestClock.adjust("10 minutes");
        yield* h.killed;
        assert.equal((yield* h.nextToDriver).method, "notifications/cancelled");
        assert.deepEqual(yield* h.nextToProvider, refusedCall(7, reason));
        // The revoke started after the kill and has still not returned.
        yield* h.revokeCalled;
        assert.isFalse(yield* Deferred.isDone(stuck));
        // Nor does it hold up refusing the next call.
        yield* h.send(call(8, "click"));
        assert.deepEqual(yield* h.nextToProvider, refusedCall(8, reason));
      }),
  );

  it.effect("keeps the earlier of its own deadline and the server's", () =>
    Effect.gen(function* () {
      const h = yield* harness({ expiresAt: "1970-01-01T00:30:00.000Z" });
      yield* h.push(active("1970-01-01T00:05:00.000Z"));
      yield* h.send(call(1, "list_apps"));
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* TestClock.adjust("5 minutes");
      // The timer slept for the original deadline; a call after the server's is still refused.
      yield* h.send(call(2, "click"));
      assert.deepEqual((yield* h.nextToProvider).id, 1);
      assert.deepEqual(yield* h.nextToProvider, refusedCall(2, "expired"));
    }),
  );

  it.effect("fails closed when the lease stream drops, and before any confirmation", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.send(call(1, "click"));
      yield* h.failLeaseStream;
      yield* h.killed;
      assert.deepEqual(yield* h.nextToProvider, refusedCall(1, "lost"));
      assert.equal(yield* h.driverQueued, 0);
    }),
  );

  it.effect("treats a lease for another handoff, or computer use turned off, as ended", () =>
    Effect.gen(function* () {
      const other = yield* harness();
      yield* other.push({ ...active(), handoffId: "handoff:other" } as ComputerUseLeaseUpdate);
      yield* other.killed;
      yield* other.send(call(1, "click"));
      assert.deepEqual(yield* other.nextToProvider, refusedCall(1, "lost"));

      const disabled = yield* harness();
      yield* disabled.push(active());
      yield* disabled.push({ state: "ended", reason: "disabled" });
      yield* disabled.killed;
      yield* disabled.send(call(2, "click"));
      assert.deepEqual(yield* disabled.nextToProvider, refusedCall(2, "disabled"));
    }),
  );

  it.effect("reads NDJSON lease lines and drops ones it cannot decode", () =>
    Effect.gen(function* () {
      const updates = yield* Stream.runCollect(
        leaseUpdateLines(
          Stream.make(
            JSON.stringify(active()),
            "not json",
            JSON.stringify({ state: "paused" }),
            "",
            JSON.stringify({ state: "ended", reason: "expired" }),
          ),
        ),
      );
      assert.deepEqual(updates, [active(), { state: "ended", reason: "expired" }]);
    }),
  );
});
