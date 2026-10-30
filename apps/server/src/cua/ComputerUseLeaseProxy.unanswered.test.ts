import { assert, describe, it } from "@effect/vitest";
import type { ComputerUsePrimitiveReply } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  active,
  call,
  CONTROL,
  foregroundActive,
  harness,
  type ToolAnswer,
} from "./ComputerUseLeaseProxy.testkit.ts";

const listApps = (requestId: string, connectionGeneration: string, deadlineMillis: number) => ({
  state: "primitive-request" as const,
  requestId,
  registrationId: "registration:one",
  controlId: CONTROL,
  connectionGeneration,
  runId: "run:one",
  turnId: "cell:one",
  callId: 0,
  deadlineMillis,
  tool: "list_apps",
  args: {},
});
/** How long a call stays unanswered before its driver is judged stuck. */
const STUCK_MS = 20_000;
const sentListApps = (log: ReadonlyArray<string>) =>
  log.filter((entry) => entry === "send list_apps").length;

/** A first call the driver leaves unanswered until it is judged stuck, and a second call then. */
const overdue = Effect.fn(function* (
  options: Parameters<typeof harness>[0] = {},
  secondDeadline = 60_000,
) {
  const h = yield* harness(options);
  yield* h.push(active());
  const first = yield* h.driverStarted;
  yield* h.sendPrimitive(listApps("request:stuck", first.connectionId, 2_000));
  const stuck = yield* h.nextToDriver;
  yield* TestClock.adjust(STUCK_MS);
  yield* h.sendPrimitive(listApps("request:next", first.connectionId, secondDeadline));
  /** Replies by request id, as they settle. */
  const replies = (count: number) =>
    Effect.forEach(Array.from({ length: count }), () => h.primitiveReply).pipe(
      Effect.map(
        (all) =>
          new Map<string, ComputerUsePrimitiveReply>(all.map((reply) => [reply.requestId, reply])),
      ),
    );
  return { h, first, stuck, replies };
});

describe("ComputerUseLeaseProxy holds calls behind an overdue one", () => {
  it.effect(
    "a click past its 3 s cap keeps a slow driver: its late answer lands and the next call goes to the same driver",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push(active());
        const first = yield* h.driverStarted;
        yield* h.sendPrimitive({
          ...listApps("click:slow", first.connectionId, 3_000),
          tool: "click",
          args: { pid: 42, window_id: 7 },
        });
        const slow = yield* h.nextToDriver;
        yield* TestClock.adjust(10_000);
        assert.isFalse(yield* h.isKilled);
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: slow.id, result: { content: [] } }));
        assert.equal((yield* h.primitiveReply).status, "settled");
        yield* h.sendPrimitive(listApps("request:next", first.connectionId, 60_000));
        assert.deepEqual((yield* h.nextToDriver).params, { name: "list_apps", arguments: {} });
        assert.equal(h.drivers.length, 1);
      }),
  );

  it.effect(
    "a click left unanswered for 20 s is a stuck driver: it is replaced and the click may have acted",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push(active());
        const first = yield* h.driverStarted;
        yield* h.sendPrimitive({
          ...listApps("click:stuck", first.connectionId, 3_000),
          tool: "click",
          args: { pid: 42, window_id: 7 },
        });
        yield* h.nextToDriver;
        yield* TestClock.adjust(20_000);
        assert.isFalse(yield* h.isKilled);
        yield* TestClock.adjust(1_000);
        const reply = yield* h.primitiveReply;
        assert.equal(reply.status, "unknown_outcome");
        const structured = (reply.result as { structuredContent: Record<string, unknown> })
          .structuredContent;
        assert.equal(structured.detail, "helper_restarted");
        assert.include(structured.safety as object, { possibleCommit: true });
        assert.isTrue(yield* h.isKilled);
        yield* h.driverStarted;
      }),
  );

  it.effect(
    "a click its cell gave up on is replaced when the cell ends, so the next cell reaches a fresh driver",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push(active());
        const first = yield* h.driverStarted;
        yield* h.sendPrimitive({
          ...listApps("click:abandoned", first.connectionId, 3_000),
          tool: "click",
          args: { pid: 42, window_id: 7 },
        });
        yield* h.nextToDriver;
        yield* TestClock.adjust(5_000);
        assert.isFalse(yield* h.isKilled);
        yield* h.cancelPrimitive("click:abandoned");
        yield* TestClock.adjust(1_000);
        const reply = yield* h.primitiveReply;
        assert.equal(reply.status, "unknown_outcome");
        assert.isTrue(yield* h.isKilled);
        const second = yield* h.driverStarted;
        yield* h.sendPrimitive(listApps("request:next", second.connectionId, 60_000));
        assert.deepEqual((yield* h.nextToDriver).params, { name: "list_apps", arguments: {} });
      }),
  );

  it.effect(
    "a click queued behind a long call is replaced when its cell ends, not when the long call ends",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push(foregroundActive());
        const first = yield* h.driverStarted;
        yield* h.send(call("script", "run_script", { script: "1", timeout_ms: 120_000 }));
        yield* h.nextToDriver;
        yield* h.sendPrimitive({
          ...listApps("click:queued", first.connectionId, 3_000),
          tool: "click",
          args: { pid: 42, window_id: 7 },
        });
        yield* h.nextToDriver;
        yield* TestClock.adjust(5_000);
        assert.isFalse(yield* h.isKilled);
        yield* h.cancelPrimitive("click:queued");
        yield* TestClock.adjust(1_000);
        assert.equal((yield* h.primitiveReply).status, "unknown_outcome");
        assert.isTrue(yield* h.isKilled);
      }),
  );

  it.effect(
    "a call queued behind one still being admitted is answered at its own deadline as never sent",
    () =>
      Effect.gen(function* () {
        const reserving = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let reserves = 0;
        const h = yield* harness({
          reservation: (request) =>
            request.action === "reserve" && ++reserves === 1
              ? Deferred.succeed(reserving, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.as({ status: "admitted" as const, reservationId: null }),
                )
              : Effect.succeed(
                  request.action === "reserve"
                    ? { status: "admitted" as const, reservationId: null }
                    : { status: "released" as const },
                ),
        });
        yield* h.push(active());
        const first = yield* h.driverStarted;
        yield* h.sendPrimitive(listApps("request:slow", first.connectionId, 60_000));
        yield* Deferred.await(reserving);
        yield* h.sendPrimitive(listApps("request:queued", first.connectionId, 4_000));
        yield* TestClock.adjust(4_000);
        const reply = yield* h.primitiveReply;
        assert.equal(reply.requestId, "request:queued");
        assert.equal(reply.status, "not_started");
        const structured = (reply.result as { structuredContent: Record<string, unknown> })
          .structuredContent;
        assert.equal(structured.detail, "expired");
        assert.include(
          (reply.result as { content: Array<{ text: string }> }).content[0]?.text ?? "",
          "nothing was sent",
        );
        yield* Deferred.succeed(gate, undefined);
        assert.deepEqual((yield* h.nextToDriver).params, { name: "list_apps", arguments: {} });
        assert.equal(sentListApps(h.log), 1);
      }),
  );

  it.effect("a call made while an earlier call is overdue never reaches the stuck child", () =>
    Effect.gen(function* () {
      const { h, replies } = yield* overdue();
      yield* TestClock.adjust(1_000);
      const settled = yield* replies(2);
      assert.equal(settled.get("request:stuck")?.status, "unknown_outcome");
      assert.equal(settled.get("request:next")?.status, "not_started");
      assert.equal(sentListApps(h.log), 1);
      assert.equal(h.drivers.length, 2);
    }),
  );

  it.effect("a held call goes to the same child when the overdue reply lands in the grace", () =>
    Effect.gen(function* () {
      const { h, stuck } = yield* overdue();
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: stuck.id, result: { content: [] } }));
      assert.deepEqual((yield* h.nextToDriver).params, { name: "list_apps", arguments: {} });
      yield* TestClock.adjust(1_000);
      assert.equal(h.drivers.length, 1);
    }),
  );

  it.effect("a held call is refused, nothing sent, when the replacement fails", () =>
    Effect.gen(function* () {
      const { h, replies } = yield* overdue({ restartFailure: "driver did not start" });
      yield* TestClock.adjust(1_000);
      const settled = yield* replies(2);
      assert.equal(settled.get("request:next")?.status, "not_started");
      assert.equal(sentListApps(h.log), 1);
    }),
  );

  it.effect("a held call that reaches its own deadline first is refused, nothing sent", () =>
    Effect.gen(function* () {
      const { h } = yield* overdue({}, STUCK_MS + 500);
      yield* TestClock.adjust(500);
      const reply = yield* h.primitiveReply;
      assert.equal(reply.requestId, "request:next");
      assert.equal(reply.status, "not_started");
      assert.equal(sentListApps(h.log), 1);
    }),
  );

  it.effect(
    "a call that passed the hold before an earlier call fell overdue is refused, never sent",
    () =>
      Effect.gen(function* () {
        const reserving = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let reserves = 0;
        const h = yield* harness({
          reservation: (request) =>
            request.action === "reserve" && ++reserves === 2
              ? Deferred.succeed(reserving, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.as({ status: "admitted" as const, reservationId: "ticket:second" }),
                )
              : Effect.succeed(
                  request.action === "reserve"
                    ? { status: "admitted" as const, reservationId: `ticket:${request.callId}` }
                    : request.action === "validate"
                      ? {
                          status: "admitted" as const,
                          reservationId: request.reservationId,
                          permissions: { validUntilMillis: 1_800_000 },
                        }
                      : { status: "released" as const },
                ),
        });
        yield* h.push(active());
        const first = yield* h.driverStarted;
        yield* h.sendPrimitive(listApps("request:stuck", first.connectionId, 2_000));
        yield* h.nextToDriver;
        yield* h.sendPrimitive(listApps("request:next", first.connectionId, 60_000));
        yield* Deferred.await(reserving);
        yield* TestClock.adjust(STUCK_MS);
        yield* Deferred.succeed(gate, undefined);
        const reply = yield* h.primitiveReply;
        assert.equal(reply.requestId, "request:next");
        assert.equal(reply.status, "not_started");
        assert.equal(sentListApps(h.log), 1);
      }),
  );

  it.effect("a provider call held across a replacement is refused, not sent to the new child", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      const first = yield* h.driverStarted;
      yield* h.sendPrimitive(listApps("request:stuck", first.connectionId, 2_000));
      yield* h.nextToDriver;
      yield* TestClock.adjust(STUCK_MS);
      yield* h.send(call(7, "list_apps"));
      yield* TestClock.adjust(1_000);
      yield* h.driverStarted;
      const answer = (yield* h.nextToProvider) as unknown as ToolAnswer;
      assert.equal(answer.id, 7);
      assert.isTrue(answer.result.isError);
      assert.equal(sentListApps(h.log), 1);
    }),
  );

  it.effect("a new driver that never starts holds back neither a held call nor a pause", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        acquire: (index) => (index === 0 ? Effect.void : Effect.never),
      });
      yield* h.push(active());
      yield* h.applied;
      const first = yield* h.driverStarted;
      yield* h.sendPrimitive(listApps("request:stuck", first.connectionId, 2_000));
      yield* h.nextToDriver;
      yield* TestClock.adjust(STUCK_MS);
      yield* h.send(call(7, "list_apps"));
      yield* TestClock.adjust(1_000);
      assert.equal(((yield* h.nextToProvider) as unknown as ToolAnswer).id, 7);
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "human_input" });
      assert.equal(yield* h.applied, "paused");
      assert.equal(sentListApps(h.log), 1);
    }),
  );

  it.effect("a held provider call goes on to the same child when the late reply lands", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      const first = yield* h.driverStarted;
      yield* h.sendPrimitive(listApps("request:stuck", first.connectionId, 2_000));
      const stuck = yield* h.nextToDriver;
      yield* TestClock.adjust(STUCK_MS);
      yield* h.send(call(7, "list_apps"));
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: stuck.id, result: { content: [] } }));
      assert.equal((yield* h.nextToDriver).id, 7);
      assert.equal(h.drivers.length, 1);
    }),
  );

  it.effect(
    "a late reply that lands while the replacement waits for the lock keeps the child",
    () =>
      Effect.gen(function* () {
        const lockGate = yield* Deferred.make<void>();
        const holding = yield* Deferred.make<void>();
        let applied = 0;
        const h = yield* harness({
          afterApplied: () =>
            ++applied === 2
              ? Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(lockGate)))
              : Effect.void,
        });
        yield* h.push(active());
        const first = yield* h.driverStarted;
        yield* h.sendPrimitive(listApps("request:stuck", first.connectionId, 2_000));
        const stuck = yield* h.nextToDriver;
        yield* h.push(active());
        yield* Deferred.await(holding);
        // Past the deadline and its grace: the replacement now waits for the lock.
        yield* TestClock.adjust(STUCK_MS + 1_000);
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: stuck.id, result: { content: [] } }));
        assert.equal((yield* h.primitiveReply).status, "settled");
        yield* Deferred.succeed(lockGate, undefined);
        yield* h.sendPrimitive(listApps("request:next", first.connectionId, 60_000));
        assert.deepEqual((yield* h.nextToDriver).params, { name: "list_apps", arguments: {} });
        assert.equal(h.drivers.length, 1);
      }),
  );

  it.effect("a held call is refused while the old chain's cutoff report is still stuck", () =>
    Effect.gen(function* () {
      const driverCutoffGate = yield* Deferred.make<void>();
      const h = yield* harness({ driverCutoffGate });
      yield* h.push(active());
      const first = yield* h.driverStarted;
      yield* h.sendPrimitive(listApps("request:stuck", first.connectionId, 2_000));
      yield* h.nextToDriver;
      yield* TestClock.adjust(STUCK_MS);
      yield* h.send(call(7, "list_apps"));
      yield* TestClock.adjust(1_000);
      assert.equal(
        yield* h.driverCutoff.pipe(Effect.map((cut) => cut.connectionId)),
        first.connectionId,
      );
      const answer = (yield* h.nextToProvider) as unknown as ToolAnswer;
      assert.equal(answer.id, 7);
      assert.isTrue(answer.result.isError);
      assert.equal(sentListApps(h.log), 1);
      yield* Deferred.succeed(driverCutoffGate, undefined);
    }),
  );

  it.effect(
    "a primitive queued behind provider calls tracks the active head call's cap, full grace, and lock recheck",
    () =>
      Effect.gen(function* () {
        let lockGate = yield* Deferred.make<void>();
        let holding = yield* Deferred.make<void>();
        let holdLock = false;
        const h = yield* harness({
          afterApplied: () =>
            holdLock
              ? Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(lockGate)))
              : Effect.void,
        });
        yield* h.push(foregroundActive());
        const current = yield* h.driverStarted;
        // (a) A 10 s provider run_steps batch (cap 60 s) followed by a 1.5 s auxiliary read is not cut off at 6.5 s.
        yield* h.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "prov:batch",
            method: "tools/call",
            params: {
              name: "run_actions",
              arguments: {
                pid: 42,
                window_id: 1,
                steps: [
                  { tool: "click", args: { pid: 42, window_id: 1, element_token: "s1:3" } },
                  { get_window_state: { timeout_ms: 120_000 } },
                  ...Array.from({ length: 62 }, () => ({
                    zoom: { window_id: 1, x1: 0, y1: 0, x2: 10, y2: 10 },
                  })),
                ],
              },
            },
          }),
        );
        const provBatch = yield* h.nextToDriver;
        yield* h.sendPrimitive({
          state: "primitive-request",
          requestId: "req:aux1",
          registrationId: "registration:one",
          controlId: CONTROL,
          connectionGeneration: current.connectionId,
          runId: "run:one",
          turnId: "cell:one",
          callId: 0,
          deadlineMillis: 1_500,
          tool: "list_windows",
          args: { pid: 42 },
        });
        const aux1 = yield* h.nextToDriver;
        // A driver-origin request (carrying method) with provBatch's id must not be mistaken for provBatch's reply.
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: provBatch.id, method: "ping" }));
        assert.equal((yield* h.nextToProvider).method, "ping");
        // Even at 200 s (60 s batch steps + trailing get_window_state + 62 trailing zoom steps), provBatch is not cut off at 143 s.
        yield* TestClock.adjust("200 seconds");
        assert.isFalse(yield* h.isKilled);
        assert.equal(h.drivers.length, 1);
        yield* h.reply(
          JSON.stringify({ jsonrpc: "2.0", id: provBatch.id, result: { content: [] } }),
        );
        assert.equal((yield* h.nextToProvider).id, "prov:batch");
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: aux1.id, result: { content: [] } }));
        assert.equal((yield* h.primitiveReply).status, "settled");

        // Reusing the same provider request ID ("prov:batch") for a get_window_state with string timeout_ms: "10000"
        // (macOS driver bound = 2000 + 2 * 10000 + 5000 + 7000 = 34000 ms) must not inherit the old reply marker and must not be cut off at 13 s.
        yield* h.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "prov:batch",
            method: "tools/call",
            params: {
              name: "get_window_state",
              arguments: { pid: 42, window_id: 1, timeout_ms: "10000" },
            },
          }),
        );
        const reusedRead = yield* h.nextToDriver;
        yield* h.sendPrimitive({
          state: "primitive-request",
          requestId: "req:auxReused",
          registrationId: "registration:one",
          controlId: CONTROL,
          connectionGeneration: current.connectionId,
          runId: "run:one",
          turnId: "cell:one",
          callId: 10,
          deadlineMillis: 201_500,
          tool: "list_windows",
          args: { pid: 42 },
        });
        const auxReused = yield* h.nextToDriver;
        yield* TestClock.adjust("15 seconds");
        assert.isFalse(yield* h.isKilled);
        assert.equal(h.drivers.length, 1);
        yield* h.reply(
          JSON.stringify({ jsonrpc: "2.0", id: reusedRead.id, result: { content: [] } }),
        );
        assert.equal((yield* h.nextToProvider).id, "prov:batch");
        yield* h.reply(
          JSON.stringify({ jsonrpc: "2.0", id: auxReused.id, result: { content: [] } }),
        );
        assert.equal((yield* h.primitiveReply).status, "settled");

        // Default-delay type_text (omitted delay_ms -> 30 ms + 24 ms physical synthesis = 54 ms/char + 20 s overhead)
        // typing 1,000 uppercase characters (~54 s) is not cut off at 45 s.
        yield* h.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "prov:defaultRead",
            method: "tools/call",
            params: {
              name: "type_text",
              arguments: { pid: 42, window_id: 1, text: "A".repeat(1_000) },
            },
          }),
        );
        const defaultRead = yield* h.nextToDriver;
        yield* h.sendPrimitive({
          state: "primitive-request",
          requestId: "req:auxDefaultRead",
          registrationId: "registration:one",
          controlId: CONTROL,
          connectionGeneration: current.connectionId,
          runId: "run:one",
          turnId: "cell:one",
          callId: 11,
          deadlineMillis: 216_500,
          tool: "list_windows",
          args: { pid: 42 },
        });
        const auxDefaultRead = yield* h.nextToDriver;
        yield* TestClock.adjust("55 seconds");
        assert.isFalse(yield* h.isKilled);
        assert.equal(h.drivers.length, 1);
        yield* h.reply(
          JSON.stringify({ jsonrpc: "2.0", id: defaultRead.id, result: { content: [] } }),
        );
        assert.equal((yield* h.nextToProvider).id, "prov:defaultRead");
        yield* h.reply(
          JSON.stringify({ jsonrpc: "2.0", id: auxDefaultRead.id, result: { content: [] } }),
        );
        assert.equal((yield* h.primitiveReply).status, "settled");

        // verify_state(timeout_ms: 0) has an 11 s sample bound (2 s list_windows + 9 s walk), so
        // the 20 s floor judges it stuck; a first watcher's reply keeps the second's overdue fence
        // up, and a second watcher's reply under the lifecycle lock stops replacement even while
        // the head is unanswered.
        yield* h.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "prov:verifyDefault",
            method: "tools/call",
            params: {
              name: "verify_state",
              arguments: {
                pid: 42,
                window_id: 1,
                timeout_ms: 0,
                expect: [{ element: { selector: { role: "AXButton" } } }],
              },
            },
          }),
        );
        const verifyDefault = yield* h.nextToDriver;
        yield* h.sendPrimitive({
          state: "primitive-request",
          requestId: "req:auxConcurrent1",
          registrationId: "registration:one",
          controlId: CONTROL,
          connectionGeneration: current.connectionId,
          runId: "run:one",
          turnId: "cell:one",
          callId: 12,
          deadlineMillis: 271_500,
          tool: "list_windows",
          args: { pid: 42 },
        });
        const auxConcurrent1 = yield* h.nextToDriver;
        yield* h.sendPrimitive({
          state: "primitive-request",
          requestId: "req:auxConcurrent2",
          registrationId: "registration:one",
          controlId: CONTROL,
          connectionGeneration: current.connectionId,
          runId: "run:one",
          turnId: "cell:one",
          callId: 13,
          deadlineMillis: 271_500,
          tool: "list_windows",
          args: { pid: 42 },
        });
        const auxConcurrent2 = yield* h.nextToDriver;
        // At +17.4 s, past its 11 s sample bound, the child is still alive.
        yield* TestClock.adjust("17400 millis");
        assert.isFalse(yield* h.isKilled);
        // At +2.8 s (20.2 s total, 200 ms into verifyDefault's 1 s grace after the 20 s floor), auxConcurrent1 answers first.
        yield* TestClock.adjust("2800 millis");
        assert.isFalse(yield* h.isKilled);
        yield* h.reply(
          JSON.stringify({ jsonrpc: "2.0", id: auxConcurrent1.id, result: { content: [] } }),
        );
        assert.equal((yield* h.primitiveReply).status, "settled");
        // auxConcurrent2 is still in grace, so the overdue fence stays up: a new provider call sent now is held, not dispatched yet.
        const sentAppsBefore = sentListApps(h.log);
        yield* h.send(call(99, "list_apps"));
        yield* Effect.yieldNow;
        assert.equal(sentListApps(h.log), sentAppsBefore);
        // Hold the lifecycle lock before auxConcurrent2's grace expires, let grace expire so auxConcurrent2's replace waits on the lock,
        // then reply to auxConcurrent2 while verifyDefault is STILL unanswered.
        holdLock = true;
        yield* h.push(foregroundActive());
        yield* Deferred.await(holding);
        yield* TestClock.adjust("900 millis");
        yield* h.reply(
          JSON.stringify({ jsonrpc: "2.0", id: auxConcurrent2.id, result: { content: [] } }),
        );
        assert.equal((yield* h.primitiveReply).status, "settled");
        holdLock = false;
        yield* Deferred.succeed(lockGate, undefined);
        // Child was not replaced even though verifyDefault was still unanswered when the lock released!
        yield* TestClock.adjust("1 second");
        assert.isFalse(yield* h.isKilled);
        assert.equal(h.drivers.length, 1);
        // The held call 99 was released once auxConcurrent2 settled and now reaches the driver.
        const held99 = yield* h.nextToDriver;
        assert.equal(held99.id, 99);
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 99, result: { content: [] } }));
        assert.equal((yield* h.nextToProvider).id, 99);
        yield* h.reply(
          JSON.stringify({ jsonrpc: "2.0", id: verifyDefault.id, result: { content: [] } }),
        );
        assert.equal((yield* h.nextToProvider).id, "prov:verifyDefault");

        // (a2) A 90 s provider run_script (timeout_ms: 120_000, cap 121.5 s) followed by a 1.5 s auxiliary read is not cut off at 61 s;
        // an unrelated reply during grace does not end grace early; and a head reply while replacement waits for the lifecycle lock
        // keeps the child and gives the queued read its own 1.5 s budget.
        yield* h.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "prov:script",
            method: "tools/call",
            params: { name: "run_script", arguments: { script: "1", timeout_ms: "120000" } },
          }),
        );
        const provScript = yield* h.nextToDriver;
        yield* TestClock.adjust("50 seconds");
        yield* h.sendPrimitive({
          state: "primitive-request",
          requestId: "req:auxScript",
          registrationId: "registration:one",
          controlId: CONTROL,
          connectionGeneration: current.connectionId,
          runId: "run:one",
          turnId: "cell:one",
          callId: 1,
          deadlineMillis: 344_600,
          tool: "list_windows",
          args: { pid: 42 },
        });
        const auxScript = yield* h.nextToDriver;
        yield* TestClock.adjust("40 seconds");
        assert.isFalse(yield* h.isKilled);
        // 100 ms into prov:script's 1 s grace (after its 121.5 s cap), an unrelated reply arrives; it must not end grace early.
        yield* TestClock.adjust("31600 millis");
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: "unrelated:late", result: {} }));
        yield* TestClock.adjust("800 millis");
        assert.isFalse(yield* h.isKilled);
        // Hold the lifecycle lock before grace expires, let grace expire so replace(head.key) waits on the lock, then reply to prov:script.
        lockGate = yield* Deferred.make<void>();
        holding = yield* Deferred.make<void>();
        holdLock = true;
        yield* h.push(foregroundActive());
        yield* Deferred.await(holding);
        yield* TestClock.adjust("200 millis");
        yield* h.reply(
          JSON.stringify({ jsonrpc: "2.0", id: provScript.id, result: { content: [] } }),
        );
        assert.equal((yield* h.nextToProvider).id, "prov:script");
        // Even if the provider immediately reuses id "prov:script" while replace(head.key, head.call) is still waiting on the lock,
        // the replacement check is bound to the old head.call object
        // and must not kill the child for the newly sent call.
        yield* h.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "prov:script",
            method: "tools/call",
            params: { name: "list_apps", arguments: {} },
          }),
        );
        const reusedUnderLock = yield* h.nextToDriver;
        holdLock = false;
        yield* Deferred.succeed(lockGate, undefined);
        // Child was not replaced, and auxScript now gets its own 1.5 s budget.
        yield* TestClock.adjust("1 second");
        assert.isFalse(yield* h.isKilled);
        assert.equal(h.drivers.length, 1);
        yield* h.reply(
          JSON.stringify({ jsonrpc: "2.0", id: reusedUnderLock.id, result: { content: [] } }),
        );
        assert.equal((yield* h.nextToProvider).id, "prov:script");
        yield* h.reply(
          JSON.stringify({ jsonrpc: "2.0", id: auxScript.id, result: { content: [] } }),
        );
        assert.equal((yield* h.primitiveReply).status, "settled");

        // (a3) A short run_script (timeout_ms: 5000, cap 6.5 s) that wedges the child is replaced after the 20 s floor + 1 s grace (21 s), not 120 s.
        yield* h.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "prov:shortScript",
            method: "tools/call",
            params: {
              name: "run_script",
              arguments: { script: "while(true){}", timeout_ms: 5_000 },
            },
          }),
        );
        yield* h.nextToDriver;
        yield* h.sendPrimitive({
          state: "primitive-request",
          requestId: "req:auxShortScript",
          registrationId: "registration:one",
          controlId: CONTROL,
          connectionGeneration: current.connectionId,
          runId: "run:one",
          turnId: "cell:one",
          callId: 2,
          deadlineMillis: 418_200,
          tool: "list_windows",
          args: { pid: 42 },
        });
        yield* h.nextToDriver;
        yield* TestClock.adjust("20 seconds");
        assert.isFalse(yield* h.isKilled);
        yield* TestClock.adjust("1600 millis");
        assert.isTrue(yield* h.isKilled);
        assert.equal(h.drivers.length, 2);
        const second = yield* h.driverStarted;

        // (b) Three provider scroll calls (each 10 s cap) are queued and the first is wedged, followed by a 1.5 s auxiliary read
        // arriving 8 s after prov:s1 was sent: the child is replaced 13 s later (12 s left of the 20 s floor + 1 s grace), not after 30 s.
        for (const id of ["prov:s1", "prov:s2", "prov:s3"]) {
          yield* h.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name: "scroll", arguments: {} },
            }),
          );
          yield* h.nextToDriver;
        }
        yield* TestClock.adjust("8 seconds");
        yield* h.sendPrimitive({
          state: "primitive-request",
          requestId: "req:aux2",
          registrationId: "registration:one",
          controlId: CONTROL,
          connectionGeneration: second.connectionId,
          runId: "run:one",
          turnId: "cell:one",
          callId: 3,
          deadlineMillis: 447_800,
          tool: "list_windows",
          args: { pid: 42 },
        });
        yield* h.nextToDriver;
        yield* TestClock.adjust("12500 millis");
        assert.equal(h.drivers.length, 2);
        yield* TestClock.adjust("600 millis");
        assert.equal(h.drivers.length, 3);
      }),
  );
});
