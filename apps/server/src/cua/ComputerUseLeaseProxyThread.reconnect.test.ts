import type { ComputerUseCallAdmission } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { call } from "./ComputerUseLeaseProxy.testkit.ts";
import { snapshot, threadHarness } from "./ComputerUseLeaseProxyThread.testkit.ts";

const work = (id: number) => call(id, "type_text", { pid: 42, window_id: 7, text: "fixture work" });
const detail = (answer: { result?: { structuredContent?: Record<string, unknown> } }) =>
  answer.result?.structuredContent?.detail;

describe("thread lease proxy across a dropped lease stream", () => {
  it.effect("reconnect cannot replace a person's stopped control with a retry hint", () =>
    Effect.gen(function* () {
      const h = yield* threadHarness();
      yield* h.push(snapshot("A"));
      yield* h.started;
      yield* h.applied;
      yield* h.push({ state: "control-ended", controlId: "A", reason: "stopped" });
      yield* h.closed;
      yield* h.push({ state: "reconnecting" });
      yield* h.send(work(900));
      const answer = yield* h.next;
      assert.include(JSON.stringify(answer), '"code":"stopped_by_person"');
      assert.notInclude(JSON.stringify(answer), "Try again");
      yield* h.send(call("goat-proxy:reserved", "list_apps"));
      assert.include(JSON.stringify(yield* h.next), '"code":"stopped_by_person"');
    }),
  );
  it.effect("a call already being admitted when the stream drops never reaches the driver", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const reserving = yield* Queue.unbounded<void>();
      const h = yield* threadHarness({
        reservation: (call) =>
          call.action === "reserve"
            ? Queue.offer(reserving, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.as<ComputerUseCallAdmission>({
                  status: "admitted",
                  reservationId: `ticket:${call.callId}`,
                }),
              )
            : Effect.succeed<ComputerUseCallAdmission>(
                call.action === "validate"
                  ? {
                      status: "admitted",
                      reservationId: call.reservationId,
                      permissions: { validUntilMillis: 3_600_000 },
                    }
                  : { status: "released" },
              ),
      });
      yield* h.push(snapshot("A"));
      const driver = yield* h.started;
      yield* h.applied;
      yield* h.send(work(1));
      yield* Queue.take(reserving);
      yield* h.push({ state: "reconnecting" });
      yield* Deferred.succeed(gate, undefined);
      assert.equal(detail(yield* h.next), "reconnecting");
      assert.equal(yield* Queue.size(driver.sent), 0);
    }),
  );

  it.effect("a screen read in flight when the stream drops is cut off, not answered later", () =>
    Effect.gen(function* () {
      const h = yield* threadHarness();
      yield* h.push(snapshot("A"));
      const driver = yield* h.started;
      yield* h.applied;
      yield* h.send(call(1, "get_window_state", { pid: 42, window_id: 7 }));
      assert.equal(JSON.parse(yield* Queue.take(driver.sent)).id, 1);
      yield* h.push({ state: "reconnecting" });
      yield* Deferred.await(driver.killed);
      const cut = yield* h.next;
      assert.equal(cut.id, 1);
      assert.equal(detail(cut), "reconnecting");
    }),
  );

  it.effect("a revived control numbers its drivers after the ones it had before", () =>
    Effect.gen(function* () {
      const h = yield* threadHarness();
      yield* h.push(snapshot("A"));
      yield* h.started;
      yield* h.applied;
      const before = yield* h.driverStarted;
      yield* h.push({ state: "reconnecting" });
      yield* h.push({ state: "transport_lost" });
      yield* h.push(snapshot("A"));
      yield* h.started;
      yield* h.applied;
      const after = yield* h.driverStarted;
      assert.equal(after.controlId, "A");
      assert.isAbove(after.generation, before.generation);
    }),
  );

  it.effect("a pause already known keeps its own refusal while the stream reconnects", () =>
    Effect.gen(function* () {
      const h = yield* threadHarness();
      yield* h.push(snapshot("A"));
      yield* h.started;
      yield* h.applied;
      yield* h.push({ ...snapshot("A"), state: "paused", reason: "private" });
      yield* h.applied;
      yield* h.push({ state: "reconnecting" });
      yield* h.send(work(1));
      assert.equal(detail(yield* h.next), "private_mode");
    }),
  );

  it.effect("a call cut off by an unauthorized end is never told it did not run", () =>
    Effect.gen(function* () {
      const h = yield* threadHarness();
      yield* h.push(snapshot("A"));
      const driver = yield* h.started;
      yield* h.applied;
      yield* h.send(work(1));
      assert.equal(JSON.parse(yield* Queue.take(driver.sent)).id, 1);
      yield* h.push({ state: "ended", reason: "unauthorized" });
      const cut = JSON.stringify(yield* h.next);
      assert.include(cut, "may already have acted");
      assert.notInclude(cut, "nothing ran");
    }),
  );

  it.effect(
    "holds screen calls as reconnecting without sending them, then the same control and driver serve after the server's snapshot",
    () =>
      Effect.gen(function* () {
        const h = yield* threadHarness();
        yield* h.push(snapshot("A"));
        const driver = yield* h.started;
        yield* h.applied;
        yield* h.push({ state: "reconnecting" });
        yield* h.send(work(1));
        const held = yield* h.next;
        assert.equal(detail(held), "reconnecting");
        assert.equal(held.result?.structuredContent?.refused, "targetRefused");
        assert.equal(yield* Queue.size(driver.sent), 0);
        // A read that shows no screen content still reaches the same driver.
        yield* h.send(call(2, "check_permissions"));
        assert.equal(JSON.parse(yield* Queue.take(driver.sent)).id, 2);
        yield* Queue.offer(
          driver.replies,
          JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }),
        );
        assert.equal((yield* h.next).id, 2);
        // A screen read could show a private field the proxy cannot hear about while away.
        yield* h.send(call(3, "get_window_state", { pid: 42, window_id: 7 }));
        assert.equal(detail(yield* h.next), "reconnecting");
        yield* h.push(snapshot("A"));
        yield* h.applied;
        yield* h.send(work(4));
        assert.equal(JSON.parse(yield* Queue.take(driver.sent)).id, 4);
        assert.isFalse(yield* Deferred.isDone(driver.killed));
        assert.deepEqual(h.log, ["start 0"]);
      }),
  );

  it.effect("a Stop the server reports on reconnect wins before any call reaches the driver", () =>
    Effect.gen(function* () {
      const h = yield* threadHarness();
      yield* h.push(snapshot("A"));
      const driver = yield* h.started;
      yield* h.applied;
      yield* h.push({ state: "reconnecting" });
      yield* h.send(call(1, "check_permissions"));
      assert.equal(JSON.parse(yield* Queue.take(driver.sent)).id, 1);
      yield* h.push({ state: "control-ended", controlId: "A", reason: "stopped" });
      yield* h.push({ state: "waiting" });
      yield* h.send(work(2));
      const stopped = yield* h.next;
      // The read cut off by Stop answers first; the new call is refused as stopped.
      const answers = [stopped, yield* h.next];
      const refusal = answers.find((answer) => answer.id === 2);
      assert.equal(detail(refusal ?? {}), "stopped");
      yield* Deferred.await(driver.killed);
      // Only the Stop's cancellation of the cut-off read may follow; the new call never does.
      const sent = (yield* Queue.takeAll(driver.sent)).map(
        (line) => JSON.parse(line) as { id?: number; method?: string },
      );
      assert.isTrue(sent.every((message) => message.method === "notifications/cancelled"));
    }),
  );

  it.effect(
    "ends the control as transport_lost after the reconnect window, and a fresh snapshot of the same control serves again",
    () =>
      Effect.gen(function* () {
        const h = yield* threadHarness();
        yield* h.push(snapshot("A"));
        const first = yield* h.started;
        yield* h.applied;
        yield* h.push({ state: "reconnecting" });
        yield* h.push({ state: "transport_lost" });
        yield* Deferred.await(first.killed);
        yield* h.send(work(1));
        const lost = yield* h.next;
        assert.equal(detail(lost), "transport_lost");
        assert.include(JSON.stringify(lost), "did not run");
        yield* h.push(snapshot("A"));
        const second = yield* h.started;
        yield* h.applied;
        yield* h.send(work(2));
        assert.equal(JSON.parse(yield* Queue.take(second.sent)).id, 2);
      }),
  );
});

it.effect("round7 duplicate-id producer must not make a known lock retryable", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const h = yield* threadHarness({
      reservation: (request) =>
        request.action === "reserve"
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as({ status: "refused", detail: "reconnecting" }),
            )
          : Effect.succeed({ status: "released" }),
    });
    yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
    yield* h.push(snapshot("A"));
    yield* h.started;
    yield* h.applied;
    yield* h.send(work(973));
    yield* Deferred.await(entered);
    yield* h.push({ ...snapshot("A"), state: "paused", reason: "screen_locked" });
    yield* h.applied;
    yield* h.send(work(973));
    const answer = yield* h.next;
    assert.equal(answer.result?.structuredContent?.code, "screen_locked");
  }),
);
it.effect("round7 reserved-id producer preserves an already known lock", () =>
  Effect.gen(function* () {
    const h = yield* threadHarness();
    yield* h.push(snapshot("A"));
    yield* h.started;
    yield* h.applied;
    yield* h.push({ ...snapshot("A"), state: "paused", reason: "screen_locked" });
    yield* h.applied;
    yield* h.send(call("goat-proxy:reserved-lock", "list_apps"));
    const answer = yield* h.next;
    assert.equal(answer.result?.structuredContent?.code, "screen_locked");
  }),
);
it.effect("round7 screen lock stays terminal after reconnect window expires", () =>
  Effect.gen(function* () {
    const h = yield* threadHarness();
    yield* h.push(snapshot("A"));
    yield* h.started;
    yield* h.applied;
    yield* h.push({ ...snapshot("A"), state: "paused", reason: "screen_locked" });
    yield* h.applied;
    yield* h.push({ state: "reconnecting" });
    yield* h.push({ state: "transport_lost" });
    yield* h.send(work(970));
    const answer = yield* h.next;
    assert.equal(answer.result?.structuredContent?.code, "screen_locked");
  }),
);
it.effect("round7 new control does not inherit predecessor stop while native closure waits", () =>
  Effect.gen(function* () {
    const killGate = yield* Deferred.make<void>();
    const h = yield* threadHarness({ killGate });
    yield* Effect.addFinalizer(() => Deferred.succeed(killGate, undefined));
    yield* h.push(snapshot("A"));
    const a = yield* h.started;
    yield* h.applied;
    yield* h.push({ state: "control-ended", controlId: "A", reason: "stopped" });
    yield* Deferred.await(a.killed);
    yield* h.push(snapshot("B"));
    yield* h.send(work(971));
    const answer = yield* h.next;
    assert.notEqual(answer.result?.structuredContent?.code, "stopped_by_person");
  }),
);
