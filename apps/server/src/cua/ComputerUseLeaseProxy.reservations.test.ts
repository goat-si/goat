import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { active, call, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";

describe("proxy execution ownership", () => {
  it.effect("returns the holding thread without dispatching a denied mutation", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        reservation: (request) =>
          Effect.succeed(
            request.action === "reserve"
              ? {
                  status: "refused",
                  detail: "target_busy",
                  holderThreadId: ThreadId.make("thread:holder"),
                }
              : { status: "released" },
          ),
      });
      yield* h.push(active());
      yield* h.send(call(1, "type_text", { pid: 42, window_id: 7, text: "hello" }));
      yield* h.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
      assert.equal((yield* h.nextToDriver).id, 2);
      const result = (yield* h.nextToProvider).result as { structuredContent: object };
      assert.deepEqual(result.structuredContent, {
        refused: "targetRefused",
        detail: "target_busy",
        holderThreadId: "thread:holder",
      });
      assert.equal(yield* h.driverQueued, 0);
    }),
  );

  it.effect("keeps a cancelled execution reserved until the driver's terminal reply", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      yield* h.send(call(1, "run_script", { code: "opaque" }));
      yield* h.nextToDriver;
      const acquired = yield* h.nextReservation;
      yield* h.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 1 },
        }),
      );
      yield* h.nextToDriver;
      assert.deepEqual(h.reservations, [acquired]);
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
      assert.equal((yield* h.nextReservation).action, "release");
      assert.equal(yield* h.providerQueued, 0);
    }),
  );

  it.effect("waits for acknowledged driver cutoff before releasing outstanding executions", () =>
    Effect.gen(function* () {
      const cutoff = yield* Deferred.make<void>();
      const h = yield* harness({ kill: Deferred.await(cutoff) });
      yield* h.push(active());
      yield* h.send(call(1, "type_text", { pid: 42, window_id: 7, text: "hello" }));
      yield* h.nextToDriver;
      yield* h.nextReservation;
      yield* h.push({ state: "ended", reason: "stopped" });
      yield* h.killed;
      const closedEarly = h.reservations.some((request) => request.action === "close");
      yield* Deferred.succeed(cutoff, undefined);
      assert.equal((yield* h.nextReservation).action, "close");
      assert.isFalse(closedEarly);
      assert.equal((yield* h.nextToProvider).id, 1);
    }),
  );

  it.effect("closes an idle driver generation and resumes with a different generation", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      yield* h.send(call(1, "type_text", { pid: 42, window_id: 7, text: "hello" }));
      yield* h.nextToDriver;
      const first = yield* h.nextReservation;
      yield* h.push({ state: "idle", controlId: CONTROL });
      assert.equal((yield* h.nextReservation).action, "close");
      assert.equal((yield* h.nextToProvider).id, 1);
      yield* h.send(call(2, "type_text", { pid: 42, window_id: 7, text: "hello" }));
      const refused = (yield* h.nextToProvider).result as { structuredContent: { detail: string } };
      assert.equal(refused.structuredContent.detail, "control_idle");
      yield* h.push(active());
      yield* h.restarted;
      yield* h.send(call(3, "type_text", { pid: 42, window_id: 7, text: "hello" }));
      yield* h.nextToDriver;
      assert.notEqual((yield* h.nextReservation).connectionId, first.connectionId);
    }),
  );

  it.effect("cuts off and releases a call at expiry without another agent request", () =>
    Effect.gen(function* () {
      const h = yield* harness({ expiresAt: "1970-01-01T00:01:00.000Z" });
      yield* h.push(active("1970-01-01T00:01:00.000Z"));
      yield* h.send(call(1, "type_text", { pid: 42, window_id: 7, text: "hello" }));
      yield* h.nextToDriver;
      yield* h.nextReservation;
      yield* TestClock.adjust("1 minute");
      assert.equal((yield* h.nextReservation).action, "close");
      assert.isTrue(yield* h.isKilled);
    }),
  );

  it.effect("cuts off old work when idle and reuse arrive as one active update", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      yield* h.send(call(1, "type_text", { pid: 42, window_id: 7, text: "hello" }));
      yield* h.nextToDriver;
      const first = yield* h.nextReservation;
      yield* h.push({ ...active(), state: "active", idleEpoch: 1 });
      assert.equal((yield* h.nextReservation).action, "close");
      assert.equal((yield* h.nextToProvider).id, 1);
      yield* h.restarted;
      yield* h.send(call(2, "type_text", { pid: 42, window_id: 7, text: "new turn" }));
      yield* h.nextToDriver;
      assert.notEqual((yield* h.nextReservation).connectionId, first.connectionId);
    }),
  );
});
