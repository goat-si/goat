import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  active,
  foregroundActive,
  call,
  CONTROL,
  harness,
} from "./ComputerUseLeaseProxy.testkit.ts";

describe("proxy execution ownership", () => {
  it.effect("ends the control if restarting after foreground expiry fails", () =>
    Effect.gen(function* () {
      const h = yield* harness({ restartFailure: "fixture restart failure" });
      const update = foregroundActive();
      yield* h.push({
        ...update,
        foreground: update.foreground.map((grant) => ({ ...grant, expiresAtMillis: 300_000 })),
      });
      yield* h.send(call(1, "run_script", { script: "opaque work" }));
      yield* h.nextToDriver;
      yield* TestClock.adjust("5 minutes");
      yield* h.nextToProvider;
      yield* h.send(call(2, "get_guide"));
      const result = (yield* h.nextToProvider).result as { structuredContent: { detail: string } };
      assert.equal(result.structuredContent.detail, "helper_restarted");
    }),
  );
  it.effect("cuts off foreground expiry on its own clock while a lease stream is silent", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const update = foregroundActive();
      yield* h.push({
        ...update,
        foreground: update.foreground.map((grant) => ({ ...grant, expiresAtMillis: 300_000 })),
      });
      yield* h.send(call(1, "run_script", { script: "opaque work" }));
      yield* h.nextToDriver;
      yield* h.nextReservation;
      yield* TestClock.adjust("5 minutes");
      yield* h.killed;
      assert.equal((yield* h.nextReservation).action, "close");
      const result = (yield* h.nextToProvider).result as { structuredContent: { detail: string } };
      assert.equal(result.structuredContent.detail, "foreground_not_approved");
      yield* h.restarted;
      yield* h.send(call(2, "type_text", { pid: 42, window_id: 7, text: "background" }));
      assert.equal((yield* h.nextToDriver).id, 2);
    }),
  );
  it.effect(
    "refuses foreground and opaque routes without an explicit foreground grant before dispatch",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push(active());
        const routes = [
          ["bring_to_front", { pid: 42, window_id: 7 }],
          ["launch_app", { bundle_id: "com.example.Build" }],
          ["move_cursor", { x: 1, y: 1 }],
          ["click", { pid: 42, window_id: 7, delivery_mode: "foreground" }],
          ["press_key", { pid: 42, window_id: 7, dispatch: "foreground" }],
          ["run_steps", { foreground_fallback: true, steps: [{ delivery_mode: "foreground" }] }],
          ["run_steps", { steps: [{ type: "click", pid: 42, window_id: 7 }] }],
          ["run_script", { script: "opaque work" }],
        ] as const;
        let id = 0;
        for (const [name, args] of routes) {
          const mutationId = ++id;
          const discoveryId = ++id;
          yield* h.send(call(mutationId, name, args));
          yield* h.send(JSON.stringify({ jsonrpc: "2.0", id: discoveryId, method: "tools/list" }));
          assert.equal((yield* h.nextToDriver).id, discoveryId);
          const refused = (yield* h.nextToProvider).result as {
            structuredContent: { detail: string };
          };
          assert.equal(refused.structuredContent.detail, "foreground_not_approved");
          yield* h.reply(
            JSON.stringify({ jsonrpc: "2.0", id: discoveryId, result: { tools: [] } }),
          );
          yield* h.nextToProvider;
        }
        assert.equal(h.reservations.length, 0);
      }),
  );

  it.effect(
    "suppresses a reply cancelled during asynchronous reply processing while releasing its ticket",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const h = yield* harness({
          overlay: (command) =>
            command.op === "show" && command.phase === "resting"
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate)))
              : Effect.void,
        });
        yield* h.push(active());
        yield* h.send(call(7, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
        yield* h.nextToDriver;
        yield* h.nextReservation;
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            result: { content: [{ type: "text", text: "clicked" }] },
          }),
        );
        yield* Deferred.await(entered);
        yield* h.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: 7 },
          }),
        );
        yield* h.nextToDriver;
        yield* Deferred.succeed(gate, undefined);
        assert.equal((yield* h.nextReservation).action, "release");
        yield* h.send(call(8, "get_guide"));
        yield* h.nextToDriver;
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 8, result: { content: [] } }));
        assert.equal((yield* h.nextToProvider).id, 8);
      }),
  );
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

  it.effect(
    "keeps cancelled execution ownership and input attribution until the terminal reply",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ humanInput: true });
        yield* h.push(foregroundActive());
        yield* h.send(call(1, "run_script", { code: "opaque" }));
        yield* h.nextToDriver;
        const acquired = yield* h.nextReservation;
        assert.equal(yield* h.agentCall, "start 1");
        yield* h.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: 1 },
          }),
        );
        yield* h.nextToDriver;
        assert.deepEqual(h.reservations, [acquired]);
        assert.equal(yield* h.agentCallsQueued, 0);
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
        assert.equal((yield* h.nextReservation).action, "release");
        assert.equal(yield* h.agentCall, "end 1");
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
