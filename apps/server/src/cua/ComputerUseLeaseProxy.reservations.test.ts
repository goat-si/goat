import { assert, describe, it } from "@effect/vitest";
import {
  ThreadId,
  type ComputerUseCallAdmission,
  type ComputerUsePrimitiveRequest,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeComputerUseHistory } from "./ComputerUseHistory.ts";
import { recordAdmittedCall } from "./ComputerUseHistoryAdmission.ts";
import {
  active,
  reobserveRefusalSafety,
  terminalRefusalSafety,
  foregroundActive,
  call,
  CONTROL,
  harness,
} from "./ComputerUseLeaseProxy.testkit.ts";

describe("proxy execution ownership", () => {
  it.effect("an expired primitive cannot start display proof after placement stalls", () =>
    Effect.gen(function* () {
      const placement = yield* Deferred.make<void>();
      const h = yield* harness({ elsewhere: new Set(), placementGate: placement });
      yield* h.push(active());
      const current = yield* h.driverStarted;
      yield* h.sendPrimitive({
        state: "primitive-request",
        requestId: "request:placement",
        registrationId: "registration:one",
        controlId: CONTROL,
        connectionGeneration: current.connectionId,
        runId: "run:one",
        turnId: "cell:one",
        callId: 0,
        deadlineMillis: 1_000,
        tool: "click",
        args: { pid: 4, window_id: 9 },
      });
      yield* h.checking;
      yield* TestClock.adjust("1001 millis");
      yield* Deferred.succeed(placement, undefined);
      assert.equal((yield* h.primitiveReply).status, "not_started");
      assert.equal(yield* h.driverQueued, 0);
    }),
  );
  it.effect("a primitive whose admission outlives its cell deadline never reaches the driver", () =>
    Effect.gen(function* () {
      const admission = yield* Deferred.make<void>();
      const h = yield* harness({
        reservation: (call) =>
          call.action === "reserve"
            ? Deferred.await(admission).pipe(
                Effect.as({ status: "admitted" as const, reservationId: "ticket:late" }),
              )
            : Effect.succeed({ status: "released" as const }),
      });
      yield* h.push(active());
      const current = yield* h.driverStarted;
      yield* h.sendPrimitive({
        state: "primitive-request",
        requestId: "request:late",
        registrationId: "registration:one",
        controlId: CONTROL,
        connectionGeneration: current.connectionId,
        runId: "run:one",
        turnId: "cell:one",
        callId: 0,
        deadlineMillis: 1_000,
        tool: "click",
        args: { pid: 4, window_id: 9 },
      });
      assert.equal((yield* h.nextReservation).action, "reserve");
      yield* TestClock.adjust("1001 millis");
      yield* Deferred.succeed(admission, undefined);
      assert.equal((yield* h.primitiveReply).status, "not_started");
      assert.equal(yield* h.driverQueued, 0);
    }),
  );

  it.effect("a delivered primitive cancelled during admission never reaches the driver", () =>
    Effect.gen(function* () {
      const admission = yield* Deferred.make<void>();
      const cancelled = new Set<string>();
      const h = yield* harness({
        primitiveCancelled: (requestId) => cancelled.has(requestId),
        reservation: (call) =>
          call.action === "reserve"
            ? Deferred.await(admission).pipe(
                Effect.as({ status: "admitted" as const, reservationId: "ticket:cancelled" }),
              )
            : Effect.succeed({ status: "released" as const }),
      });
      yield* h.push(active());
      const current = yield* h.driverStarted;
      yield* h.sendPrimitive({
        state: "primitive-request",
        requestId: "request:cancelled",
        registrationId: "registration:one",
        controlId: CONTROL,
        connectionGeneration: current.connectionId,
        runId: "run:one",
        turnId: "cell:one",
        callId: 0,
        deadlineMillis: 60_000,
        tool: "click",
        args: { pid: 4, window_id: 9 },
      });
      assert.equal((yield* h.nextReservation).action, "reserve");
      cancelled.add("request:cancelled");
      yield* Deferred.succeed(admission, undefined);
      assert.equal((yield* h.primitiveReply).status, "not_started");
      assert.equal(yield* h.driverQueued, 0);
    }),
  );
  it.effect(
    "a reverse primitive uses display proof, start report and ticket validation before input",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ elsewhere: new Set(), humanInput: true });
        yield* h.push(active());
        const current = yield* h.driverStarted;
        yield* h.sendPrimitive({
          state: "primitive-request",
          requestId: "request:proof",
          registrationId: "registration:one",
          controlId: CONTROL,
          connectionGeneration: current.connectionId,
          runId: "run:one",
          turnId: "cell:one",
          callId: 0,
          deadlineMillis: 60_000,
          tool: "click",
          args: { pid: 4, window_id: 9, x: 1, y: 1 },
        });
        const proof = yield* h.nextToDriver;
        assert.deepEqual(proof.params, { name: "list_windows", arguments: {} });
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: proof.id,
            result: { content: [], structuredContent: { windows: [{ pid: 4, window_id: 9 }] } },
          }),
        );
        const forwarded = yield* h.nextToDriver;
        assert.equal((forwarded.params as { name: string }).name, "click");
        assert.match(String(forwarded.id), /^goat:primitive:/);
        assert.deepEqual(
          h.reservations.slice(0, 2).map((call) => call.action),
          ["reserve", "validate"],
        );
        assert.match(yield* h.agentCall, /^start /);
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: forwarded.id,
            result: { content: [], structuredContent: { pid: 4, window_id: 9 } },
          }),
        );
        assert.equal((yield* h.primitiveReply).status, "settled");
      }),
  );

  it.effect("server and provider input to one window share one reservation", () =>
    Effect.gen(function* () {
      const h = yield* harness({ humanInput: true });
      yield* h.push(active());
      const current = yield* h.driverStarted;
      const primitive: ComputerUsePrimitiveRequest = {
        state: "primitive-request",
        requestId: "request:server",
        registrationId: "registration:one",
        controlId: CONTROL,
        connectionGeneration: current.connectionId,
        runId: "run:one",
        turnId: "cell:one",
        callId: 0,
        deadlineMillis: 60_000,
        tool: "click",
        args: { pid: 4, window_id: 9, x: 1, y: 1 },
      };
      yield* h.sendPrimitive(primitive);
      const serverCall = yield* h.nextToDriver;
      assert.match(String(serverCall.id), /^goat:primitive:/);
      assert.equal(h.reservations[0]?.action, "reserve");
      assert.equal(h.reservations[1]?.action, "validate");
      yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      const providerCall = yield* h.nextToDriver;
      assert.equal(providerCall.id, 1);
      assert.equal(h.reservations[2]?.action, "reserve");
      assert.equal(h.reservations[3]?.action, "validate");
      yield* h.reply(
        JSON.stringify({ jsonrpc: "2.0", id: serverCall.id, result: { content: [] } }),
      );
      assert.equal((yield* h.primitiveReply).status, "settled");
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
      assert.equal((yield* h.nextToProvider).id, 1);
    }),
  );

  it.effect.each(["missing", "empty", "substituted", "no-permissions"] as const)(
    "refuses %s execution ticket authority without forwarding or retaining input cover",
    (invalid) =>
      Effect.gen(function* () {
        const h = yield* harness({
          humanInput: true,
          overlay: true,
          reservation: (request) =>
            Effect.succeed(
              request.action === "reserve"
                ? {
                    status: "admitted",
                    reservationId:
                      invalid === "missing" ? null : invalid === "empty" ? "" : "original",
                  }
                : request.action === "validate"
                  ? {
                      status: "admitted",
                      reservationId:
                        invalid === "substituted" ? "replacement" : request.reservationId,
                      ...(invalid === "no-permissions"
                        ? {}
                        : { permissions: { validUntilMillis: 1_800_000 } }),
                    }
                  : { status: "released" },
            ),
        });
        yield* h.push(active());
        yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
        const observed = yield* Effect.raceFirst(
          h.nextToDriver.pipe(Effect.map((message) => ({ kind: "dispatched", message }))),
          h.nextToProvider.pipe(Effect.map((message) => ({ kind: "answer", message }))),
        );
        assert.equal(observed.kind, "answer");
        assert.deepInclude(
          (observed.message.result as { structuredContent: object }).structuredContent,
          { detail: "unauthorized" },
        );
        assert.equal((yield* h.nextReservation).action, "reserve");
        if (invalid === "missing" || invalid === "empty") {
          assert.equal(yield* h.agentCallsQueued, 0);
          assert.equal(h.reservations.length, 1);
        } else {
          assert.equal(yield* h.agentCall, "start 1");
          assert.equal(yield* h.agentCall, "end 1");
          const validation = yield* h.nextValidation;
          const released = yield* h.nextReservation;
          assert.deepEqual(validation, {
            action: "validate",
            controlId: CONTROL,
            connectionId: validation.connectionId,
            reservationId: "original",
          });
          assert.deepEqual(released, {
            action: "release",
            controlId: CONTROL,
            connectionId: validation.connectionId,
            reservationId: "original",
            notSent: true,
          });
          assert.deepEqual(
            h.reservations.map((request) => request.action),
            ["reserve", "validate", "release"],
          );
        }
        assert.include(
          h.log.findLast((entry) => entry.startsWith("draw ")),
          '"phase":"resting"',
        );
      }),
  );

  it.effect(
    "settles the acting overlay when a cancelled call receives its terminal reply (#1490)",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ overlay: true });
        yield* h.push(active());
        yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
        yield* h.nextToDriver;
        yield* h.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: 1 },
          }),
        );
        yield* h.nextToDriver;
        const shown = { op: "show", pid: 4, windowId: 9 };
        assert.deepEqual(
          [...h.log],
          ["draw " + JSON.stringify({ ...shown, phase: "acting" }), "send click"],
        );
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
        yield* h.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
        yield* h.nextToDriver;
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }));
        assert.equal((yield* h.nextToProvider).id, 2);
        assert.equal(yield* h.providerQueued, 0);
        assert.deepEqual(
          [...h.log],
          [
            "draw " + JSON.stringify({ ...shown, phase: "acting" }),
            "send click",
            "draw " + JSON.stringify({ ...shown, phase: "resting" }),
          ],
        );
      }),
  );

  it.effect(
    "refuses an unsent mutation when its admitted permission expires during the input report",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const h = yield* harness({
          humanInput: true,
          agentInputGate: gate,
          reservation: (request) =>
            Effect.succeed(
              request.action === "reserve" || request.action === "validate"
                ? {
                    status: "admitted" as const,
                    reservationId: "expiry-ticket",
                    permissions: { validUntilMillis: 60_000 },
                  }
                : { status: "released" as const },
            ),
        });
        yield* h.push(active());
        yield* h.send(call(1, "type_text", { pid: 4, window_id: 9, text: "hello" }));
        yield* h.nextReservation;
        assert.equal(yield* h.agentCall, "start 1");
        yield* TestClock.adjust("1 minute");
        yield* Deferred.succeed(gate, undefined);
        const observed = yield* Effect.raceFirst(
          h.nextToDriver.pipe(Effect.map((message) => ({ kind: "dispatched", message }))),
          h.nextToProvider.pipe(Effect.map((message) => ({ kind: "answer", message }))),
        );
        assert.equal(observed.kind, "answer");
        assert.equal(
          (observed.message.result as { structuredContent: { detail: string } }).structuredContent
            .detail,
          "expired",
        );
        assert.equal((yield* h.nextReservation).action, "release");
        assert.equal(yield* h.agentCall, "end 1");
      }),
  );
  it.effect("suppresses cancellation received after Stop while native closure is pending", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const h = yield* harness({ kill: Deferred.await(gate) });
      yield* h.push(active());
      yield* h.send(call(1, "type_text", { pid: 4, window_id: 9, text: "hello" }));
      yield* h.nextToDriver;
      yield* h.nextReservation;
      yield* h.push({ state: "ended", reason: "stopped" });
      yield* h.killed;
      yield* h.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 1 },
        }),
      );
      yield* h.send(call(99, "get_guide"));
      assert.equal((yield* h.nextToProvider).id, 99);
      yield* Deferred.succeed(gate, undefined);
      assert.equal((yield* h.nextReservation).action, "close");
      yield* h.close;
      yield* Fiber.join(h.proxy);
      assert.equal(yield* h.providerQueued, 0);
    }),
  );

  it.effect.each(["kill", "close"] as const)(
    "suppresses cancellation while cutoff awaits %s acknowledgement",
    (wait) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const held = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        );
        const h = yield* harness({
          manifestStamp: () => "v1",
          kill: wait === "kill" ? held : Effect.void,
          reservation: (request) =>
            request.action === "reserve"
              ? Effect.succeed({ status: "admitted", reservationId: "held" } as const)
              : (wait === "close" && request.action === "close" ? held : Effect.void).pipe(
                  Effect.as({ status: "released" } as const),
                ),
        });
        yield* h.push(active());
        yield* h.send(call(1, "type_text", { pid: 4, window_id: 9, text: "hello" }));
        assert.equal((yield* h.nextToDriver).id, 1);
        yield* h.nextReservation;
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
        yield* Deferred.await(entered);
        yield* h.nextToDriver;
        yield* h.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: 1 },
          }),
        );
        yield* h.send(call(99, "get_guide"));
        assert.equal((yield* h.nextToProvider).id, 99);
        yield* Deferred.succeed(gate, undefined);
        assert.equal((yield* h.nextReservation).action, "close");
        yield* h.push(active());
        yield* h.restarted;
        yield* h.send(call(2, "get_guide"));
        assert.equal((yield* h.nextToDriver).id, 2);
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }));
        assert.equal((yield* h.nextToProvider).id, 2);
      }),
  );

  it.effect(
    "ends the control as lost, not as a helper restart, if restarting after foreground expiry fails",
    () =>
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
        const result = (yield* h.nextToProvider).result as {
          structuredContent: { detail: string };
        };
        // A failure in GOAT's own deadline handling is not a helper event: no "restart" advice.
        assert.equal(result.structuredContent.detail, "lost");
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
          ["move_cursor", { scope: "desktop", x: 1, y: 1 }],
          ["click", { pid: 42, window_id: 7, delivery_mode: "foreground" }],
          ["click", { pid: 42, window_id: 7, delivery_mode: "FOREGROUND" }],
          ["press_key", { pid: 42, window_id: 7, delivery_mode: "FoReGrOuNd" }],
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

  it.effect("suppresses a cancelled call when its driver is later cut off", () =>
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
      const validated = yield* h.nextValidation;
      assert.deepEqual(h.reservations, [acquired, validated]);
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
      assert.equal((yield* h.nextReservation).action, "close");
      assert.equal(yield* h.agentCall, "end 1");
      yield* h.push(active());
      yield* h.restarted;
      yield* h.send(call(2, "get_guide"));
      yield* h.nextToDriver;
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }));
      assert.equal((yield* h.nextToProvider).id, 2);
    }),
  );

  it.effect("waits for the target report before reserving or posting input", () =>
    Effect.gen(function* () {
      const targetGate = yield* Deferred.make<void>();
      const h = yield* harness({ onTarget: () => true, targetGate, humanInput: true });
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      yield* h.reported;
      assert.deepEqual(h.reservations, []);
      assert.equal(yield* h.driverQueued, 0);
      assert.equal(yield* h.agentCallsQueued, 0);
      yield* h.push({ state: "idle", controlId: CONTROL });
      assert.equal((yield* h.nextReservation).action, "close");
      yield* h.push({ ...active(), idleEpoch: 1 });
      yield* h.restarted;
      yield* Deferred.succeed(targetGate, undefined);
      const answer = (yield* h.nextToProvider).result as { structuredContent: object };
      assert.deepEqual(answer.structuredContent, {
        refused: "targetRefused",
        detail: "control_idle",
        safety: terminalRefusalSafety,
      });
      assert.isFalse(h.reservations.some((request) => request.action === "reserve"));
      assert.equal(yield* h.driverQueued, 0);
      assert.equal(yield* h.agentCallsQueued, 0);
    }),
  );

  it.effect("releases a late admission without dispatching across a driver replacement", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const h = yield* harness({
        reservation: (request) =>
          request.action === "reserve"
            ? Deferred.await(gate).pipe(
                Effect.as({ status: "admitted", reservationId: "late" } as const),
              )
            : Effect.succeed({ status: "released" } as const),
      });
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      const acquired = yield* h.nextReservation;
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
      assert.equal((yield* h.nextReservation).action, "close");
      yield* h.push(active());
      yield* h.restarted;
      yield* Deferred.succeed(gate, undefined);
      assert.deepEqual(yield* h.nextReservation, {
        action: "release",
        controlId: CONTROL,
        connectionId: acquired.connectionId,
        reservationId: "late",
        notSent: true,
      });
      const answer = (yield* h.nextToProvider).result as { structuredContent: object };
      assert.deepEqual(answer.structuredContent, {
        refused: "userIntervened",
        detail: "waiting_for_human",
        safety: terminalRefusalSafety,
      });
      assert.equal(yield* h.driverQueued, 0);
    }),
  );

  it.effect(
    "suppresses a reply cancelled during asynchronous reply processing while releasing its ticket",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const history = yield* makeComputerUseHistory;
        const threadId = ThreadId.make("thread:history-cancellation");
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const h = yield* harness({
          reservation: (request) =>
            request.action === "reserve"
              ? recordAdmittedCall(history, threadId, request, "ticket:cancelled").pipe(
                  Effect.orDie,
                  Effect.as<ComputerUseCallAdmission>({
                    status: "admitted",
                    reservationId: "ticket:cancelled",
                  }),
                )
              : Effect.succeed<ComputerUseCallAdmission>({ status: "released" }),
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
        const historyEntries = yield* history.listForThread(threadId);
        assert.equal(historyEntries.length, 1);
        assert.equal(historyEntries[0]?.method, "click");
        assert.equal(historyEntries[0]?.verdict, "unknown_outcome");
        yield* h.send(call(8, "get_guide"));
        yield* h.nextToDriver;
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 8, result: { content: [] } }));
        assert.equal((yield* h.nextToProvider).id, 8);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
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
        safety: reobserveRefusalSafety,
        holderThreadId: "thread:holder",
      });
      assert.equal(yield* h.driverQueued, 0);
    }),
  );

  it.effect("a call the server refuses to reserve leaves the agent cursor at rest", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        overlay: true,
        reservation: (request) =>
          Effect.succeed(
            request.action === "reserve"
              ? { status: "refused", detail: "screen_shared" }
              : { status: "released" },
          ),
      });
      yield* h.push(foregroundActive());
      yield* h.send(
        call(1, "click", { pid: 42, window_id: 7, x: 1, y: 1, dispatch: "foreground" }),
      );
      const result = (yield* h.nextToProvider).result as { structuredContent: object };
      assert.deepInclude(result.structuredContent, { detail: "screen_shared" });
      const draws = h.log.filter((entry) => entry.startsWith("draw "));
      assert.include(draws.at(0), '"phase":"acting"');
      assert.include(draws.at(-1), '"phase":"resting"');
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
        const validated = yield* h.nextValidation;
        assert.deepEqual(h.reservations, [acquired, validated]);
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

describe("proxy release of a call that never ran", () => {
  it.effect.each([
    {
      name: "refused by the driver",
      result: {
        content: [{ type: "text", text: "click: unknown argument targetRef" }],
        structuredContent: {
          status: "refused",
          refusal: { code: "invalid_arguments", message: "click: unknown argument targetRef" },
        },
        isError: true,
      },
      notSent: true,
    },
    {
      name: "acted on",
      result: { content: [], structuredContent: { effect: "confirmed" } },
      notSent: false,
    },
  ])("a call $name releases its ticket saying whether it was sent", ({ result, notSent }) =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      const sent = yield* h.nextToDriver;
      assert.equal((yield* h.nextReservation).action, "reserve");
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result }));
      yield* h.nextToProvider;
      const released = yield* h.nextReservation;
      assert.deepInclude(released, { action: "release", completed: true });
      assert.equal("notSent" in released && released.notSent === true, notSent);
    }),
  );

  it.effect("a call refused after its reservation releases its ticket as not sent", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        reservation: (request) =>
          Effect.succeed(
            request.action === "reserve"
              ? { status: "admitted", reservationId: "ticket:shared" }
              : request.action === "validate"
                ? { status: "refused", detail: "screen_shared" }
                : { status: "released" },
          ),
        humanInput: true,
      });
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      assert.equal((yield* h.nextReservation).action, "reserve");
      yield* h.nextToProvider;
      assert.deepInclude(yield* h.nextReservation, {
        action: "release",
        reservationId: "ticket:shared",
        notSent: true,
      });
      assert.equal(yield* h.driverQueued, 0);
    }),
  );
});

describe("proxy reservations of a call its driver never answers", () => {
  it.effect("an unanswered click releases its driver's reservations once its deadline passes", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      const current = yield* h.driverStarted;
      yield* h.sendPrimitive({
        state: "primitive-request",
        requestId: "request:unanswered",
        registrationId: "registration:one",
        controlId: CONTROL,
        connectionGeneration: current.connectionId,
        runId: "run:one",
        turnId: "cell:one",
        callId: 0,
        deadlineMillis: 30_000,
        tool: "click",
        args: { pid: 4, window_id: 9, x: 1, y: 1 },
      });
      assert.equal((yield* h.nextReservation).action, "reserve");
      assert.deepInclude((yield* h.nextToDriver).params as object, { name: "click" });
      // Until now the app stayed reserved to the stuck call, and other threads heard app_busy.
      yield* TestClock.adjust("31 seconds");
      const closed = yield* h.nextReservation;
      assert.equal(closed.action, "close");
      assert.equal(closed.connectionId, current.connectionId);
      assert.equal((yield* h.primitiveReply).status, "unknown_outcome");
    }),
  );
});

describe("proxy reservations of a call its driver answered late in processing", () => {
  it.effect("a reply GOAT is still processing at the deadline keeps its driver", () =>
    Effect.gen(function* () {
      const releaseGate = yield* Deferred.make<void>();
      const h = yield* harness({
        reservation: (call) =>
          call.action === "release"
            ? Deferred.await(releaseGate).pipe(Effect.as({ status: "released" as const }))
            : Effect.succeed(
                call.action === "reserve"
                  ? { status: "admitted" as const, reservationId: "ticket:slow" }
                  : { status: "released" as const },
              ),
      });
      yield* h.push(active());
      const current = yield* h.driverStarted;
      yield* h.sendPrimitive({
        state: "primitive-request",
        requestId: "request:processing",
        registrationId: "registration:one",
        controlId: CONTROL,
        connectionGeneration: current.connectionId,
        runId: "run:one",
        turnId: "cell:one",
        callId: 0,
        deadlineMillis: 30_000,
        tool: "list_apps",
        args: {},
      });
      assert.equal((yield* h.nextReservation).action, "reserve");
      const sent = yield* h.nextToDriver;
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { content: [] } }));
      // The reply arrived; GOAT is still releasing its reservation when the deadline passes.
      assert.equal((yield* h.nextReservation).action, "release");
      yield* TestClock.adjust("31 seconds");
      yield* Deferred.succeed(releaseGate, undefined);
      assert.equal((yield* h.primitiveReply).status, "settled");
      assert.isFalse(yield* h.isKilled);
      assert.equal(h.drivers.length, 1);
    }),
  );
});

describe("proxy replies queued behind one GOAT is still processing", () => {
  it.effect("a reply waiting behind another past its deadline keeps its driver", () =>
    Effect.gen(function* () {
      const releaseGate = yield* Deferred.make<void>();
      const h = yield* harness({
        reservation: (call) =>
          call.action === "release"
            ? Deferred.await(releaseGate).pipe(Effect.as({ status: "released" as const }))
            : Effect.succeed(
                call.action === "reserve"
                  ? { status: "admitted" as const, reservationId: `ticket:${call.callId}` }
                  : { status: "released" as const },
              ),
      });
      yield* h.push(active());
      const current = yield* h.driverStarted;
      const listApps = (requestId: string, deadlineMillis: number) => ({
        state: "primitive-request" as const,
        requestId,
        registrationId: "registration:one",
        controlId: CONTROL,
        connectionGeneration: current.connectionId,
        runId: "run:one",
        turnId: "cell:one",
        callId: 0,
        deadlineMillis,
        tool: "list_apps",
        args: {},
      });
      yield* h.sendPrimitive(listApps("request:first", 60_000));
      const first = yield* h.nextToDriver;
      yield* h.sendPrimitive(listApps("request:second", 30_000));
      const second = yield* h.nextToDriver;
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: first.id, result: { content: [] } }));
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: second.id, result: { content: [] } }));
      // GOAT is still releasing the first reply's reservation; the second reply waits behind it.
      yield* h.nextReservation;
      yield* h.nextReservation;
      assert.equal((yield* h.nextReservation).action, "release");
      yield* TestClock.adjust("31 seconds");
      yield* Deferred.succeed(releaseGate, undefined);
      assert.equal((yield* h.primitiveReply).status, "settled");
      assert.equal((yield* h.primitiveReply).status, "settled");
      assert.isFalse(yield* h.isKilled);
    }),
  );
});
