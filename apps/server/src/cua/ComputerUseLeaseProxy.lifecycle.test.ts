import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import { foregroundProxy, foregroundProxyLayer } from "./ComputerUseForeground.testkit.ts";
import { makeLeaseProxyLifecycle } from "./ComputerUseLeaseProxyLifecycle.ts";
import {
  active,
  call,
  CONTROL,
  foregroundActive,
  harness,
  refusedCall,
} from "./ComputerUseLeaseProxy.testkit.ts";

const shortForeground = () => {
  const update = foregroundActive();
  return {
    ...update,
    foreground: update.foreground.map((grant) => ({ ...grant, expiresAtMillis: 300_000 })),
  };
};

describe("proxy lifecycle ownership across foreground expiry", () => {
  it.effect("a typed screen lock pauses the control and rejects later calls", () =>
    Effect.gen(function* () {
      const h = yield* harness({ screenLock: true });
      yield* h.push(active());
      yield* h.applied;
      yield* h.send(call(77, "list_apps"));
      yield* h.nextToDriver;
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 77,
          result: {
            isError: true,
            content: [],
            structuredContent: { code: "screen_locked", effect: "refused" },
          },
        }),
      );
      assert.equal((yield* h.nextToProvider).id, 77);
      yield* h.screenLockedReported;
      yield* h.killed;
      yield* h.push(active());
      yield* h.applied;
      assert.equal(yield* h.liveDrivers, 0);
      yield* h.send(call(78, "list_apps"));
      assert.deepInclude((yield* h.nextToProvider).result, {
        isError: true,
        structuredContent: {
          refused: "screenLocked",
          detail: "screen_locked",
          code: "screen_locked",
          safety: {
            possibleCommit: false,
            retryClass: "never",
            writeStatus: "not_started",
            code: "write_refused_terminal",
          },
        },
      });
      yield* h.push({ ...active(), interruptions: { count: 1, last: "screen_locked" } });
      yield* h.applied;
      assert.equal(yield* h.liveDrivers, 1);
    }),
  );

  it.effect("a screen lock during the proxy's display proof pauses the session", () =>
    Effect.gen(function* () {
      const h = yield* harness({ screenLock: true, elsewhere: new Set() });
      yield* h.push(active());
      yield* h.send(call(82, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      const proof = yield* h.nextToDriver;
      assert.deepEqual(proof.params, { name: "list_windows", arguments: {} });
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: proof.id,
          result: { isError: true, content: [], structuredContent: { code: "screen_locked" } },
        }),
      );
      yield* h.screenLockedReported;
      yield* h.killed;
      const answer = yield* h.nextToProvider;
      assert.equal(answer.id, 82);
      assert.deepInclude(answer.result, { isError: true });
    }),
  );

  it.effect("a screen lock reported after cancellation still pauses the session", () =>
    Effect.gen(function* () {
      const h = yield* harness({ screenLock: true });
      yield* h.push(active());
      yield* h.send(call(80, "list_apps"));
      yield* h.nextToDriver;
      yield* h.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 80 },
        }),
      );
      yield* h.nextToDriver;
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 80,
          result: { isError: true, content: [], structuredContent: { code: "screen_locked" } },
        }),
      );
      yield* h.screenLockedReported;
      yield* h.killed;
      assert.equal(yield* h.providerQueued, 0);
    }),
  );

  it.effect("Escape stops the local driver when the server cannot accept the report", () =>
    Effect.gen(function* () {
      const h = yield* harness({ personStop: true, personStopAccepted: false });
      yield* h.push(active());
      yield* h.driverStarted;
      yield* h.escape;
      yield* h.escapeReported;
      yield* h.killed;
      yield* h.send(call(79, "list_apps"));
      assert.deepInclude((yield* h.nextToProvider).result, {
        isError: true,
        structuredContent: {
          refused: "userStoppedSession",
          detail: "stopped",
          code: "stopped_by_person",
          safety: {
            possibleCommit: false,
            retryClass: "never",
            writeStatus: "not_started",
            code: "write_refused_terminal",
          },
        },
      });
    }),
  );

  it.effect("a person Stop all cuts the call off with a terminal typed result", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      yield* h.send(call(81, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      yield* h.nextToDriver;
      yield* h.push({ state: "ended", reason: "stopped_all" });
      yield* h.killed;
      assert.deepInclude((yield* h.nextToProvider).result, {
        isError: true,
        structuredContent: {
          code: "stopped_by_person",
          detail: "stopped_all",
          effect: "unverifiable",
          safety: {
            possibleCommit: true,
            retryClass: "never",
            writeStatus: "may_have_applied",
            code: "write_indeterminate",
          },
        },
      });
    }),
  );

  it.effect("reports helper Escape from the active control", () =>
    Effect.gen(function* () {
      const h = yield* harness({ personStop: true });
      yield* h.push(active());
      yield* h.driverStarted;
      yield* h.escape;
      yield* h.escapeReported;
    }),
  );

  it.effect("Stop cuts off server-origin input and quarantines the late driver reply", () =>
    Effect.gen(function* () {
      const h = yield* harness({ humanInput: true });
      yield* h.push(active());
      const current = yield* h.driverStarted;
      yield* h.sendPrimitive({
        state: "primitive-request",
        requestId: "request:stop",
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
      const forwarded = yield* h.nextToDriver;
      assert.match(String(forwarded.id), /^goat:primitive:/);
      yield* h.push({ state: "ended", reason: "stopped" });
      assert.equal((yield* h.driverCutoff).connectionId, current.connectionId);
      assert.equal((yield* h.primitiveReply).status, "unknown_outcome");
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: forwarded.id,
          result: { content: [], structuredContent: { marker: "late" } },
        }),
      );
      assert.equal(yield* h.providerQueued, 0);
    }),
  );

  it.effect("a paused control does not replay a queued primitive on resume", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      const first = yield* h.driverStarted;
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
      assert.equal((yield* h.driverCutoff).connectionId, first.connectionId);
      yield* h.sendPrimitive({
        state: "primitive-request",
        requestId: "request:paused",
        registrationId: "registration:one",
        controlId: CONTROL,
        connectionGeneration: first.connectionId,
        runId: "run:one",
        turnId: "cell:one",
        callId: 0,
        deadlineMillis: 60_000,
        tool: "click",
        args: { pid: 4, window_id: 9 },
      });
      assert.equal((yield* h.primitiveReply).status, "not_started");
      yield* h.push(active());
      const next = yield* h.driverStarted;
      assert.equal(next.generation, first.generation + 1);
      assert.equal(yield* h.driverQueued, 0);
    }),
  );

  it.effect(
    "a cutoff report stalled after the local fence cannot forward a request for the cut generation",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const h = yield* harness({ driverCutoffGate: gate });
        yield* h.push(active());
        const current = yield* h.driverStarted;
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
        assert.equal((yield* h.driverCutoff).connectionId, current.connectionId);
        yield* h.sendPrimitive({
          state: "primitive-request",
          requestId: "request:cut",
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
        assert.equal((yield* h.primitiveReply).status, "not_started");
        assert.equal(yield* h.driverQueued, 0);
        yield* Deferred.succeed(gate, undefined);
        yield* h.killed;
      }),
  );

  it.effect(
    "each successful driver restart increments the generation exactly once and superseded acquisition reports nothing",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const acquiring = yield* Deferred.make<void>();
        const started = yield* Queue.unbounded<{ generation: number; connectionId: string }>();
        const lifecycle = yield* makeLeaseProxyLifecycle({
          connectionId: "proxy:test",
          active: () => true,
          deadline: () => 600_000,
          startDriver: Effect.gen(function* () {
            yield* Deferred.succeed(acquiring, undefined);
            yield* Deferred.await(gate);
            return { send: () => Effect.void, lines: Stream.empty, kill: Effect.void };
          }),
          onStarted: (current) => Queue.offer(started, current).pipe(Effect.asVoid),
        });
        const obsolete = yield* lifecycle.start().pipe(Effect.forkChild);
        yield* Deferred.await(acquiring);
        lifecycle.interrupt();
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(obsolete);
        assert.equal(yield* Queue.size(started), 0);
        yield* lifecycle.start();
        const first = yield* Queue.take(started);
        assert.deepEqual(
          { generation: first.generation, connectionId: first.connectionId },
          { generation: 0, connectionId: "proxy:test:0" },
        );
        lifecycle.interrupt();
        yield* lifecycle.start();
        const second = yield* Queue.take(started);
        assert.deepEqual(
          { generation: second.generation, connectionId: second.connectionId },
          { generation: 1, connectionId: "proxy:test:1" },
        );
      }).pipe(Effect.scoped),
  );

  it.effect.each(["expiry", "stop", "pause", "replacement", "idle"] as const)(
    "GOAT release at %s sends no focus restore and refuses later foreground dispatch",
    (ending) =>
      Effect.gen(function* () {
        yield* runMigrations();
        const cutoff = yield* Deferred.make<void>();
        const thread = ThreadId.make("thread:foreground-release");
        const { h, leases, control, admission } = yield* foregroundProxy(thread, {
          kill: (index) => (index === 0 ? Deferred.await(cutoff) : Effect.void),
        });
        const original = call(1, "type_text", {
          pid: 42,
          window_id: 7,
          text: "approved foreground work",
          delivery_mode: "foreground",
        });
        yield* h.send(original);
        const observed = yield* Effect.raceFirst(
          h.nextDispatch.pipe(Effect.map((dispatch) => ({ kind: "dispatch", ...dispatch }))),
          h.nextToProvider.pipe(Effect.map((message) => ({ kind: "answer", message, index: -1 }))),
        );
        assert.equal(observed.kind, "dispatch");
        const first = observed;
        assert.deepEqual(first.message, JSON.parse(original));
        const ticket = yield* h.nextReservation;
        assert.equal(ticket.action, "reserve");
        assert.equal((yield* h.nextValidation).action, "validate");
        if (ending === "expiry") yield* TestClock.adjust("5 minutes");
        else if (ending === "stop") assert.isTrue(yield* leases.stop(thread));
        else if (ending === "pause") yield* leases.pause("takeover");
        else if (ending === "replacement") yield* leases.control(thread, Option.none());
        else assert.isTrue(yield* leases.turnEnded(thread));
        yield* h.killed;
        const cancellation = yield* h.nextDispatch;
        assert.equal(cancellation.index, first.index);
        assert.equal(cancellation.message.method, "notifications/cancelled");
        assert.deepInclude(cancellation.message.params, { requestId: 1 });
        assert.deepEqual(
          h.reservations.map((request) => request.action),
          ["reserve", "validate"],
        );
        yield* Deferred.succeed(cutoff, undefined);
        const closed = yield* h.nextReservation;
        assert.equal(closed.action, "close");
        assert.equal(closed.connectionId, ticket.connectionId);
        assert.equal((yield* h.nextToProvider).id, 1);
        yield* h.send(
          call(2, "type_text", {
            pid: 42,
            window_id: 7,
            text: "after release",
            delivery_mode: "foreground",
          }),
        );
        const refused = yield* h.nextToProvider;
        assert.equal(refused.id, 2);
        const result = refused.result as {
          structuredContent: { detail: string };
          isError: boolean;
        };
        assert.isTrue(result.isError);
        assert.equal(
          result.structuredContent.detail,
          ending === "expiry"
            ? "foreground_not_approved"
            : ending === "pause"
              ? "waiting_for_human"
              : ending === "idle"
                ? "control_idle"
                : ending === "replacement"
                  ? "replaced"
                  : "stopped",
        );
        assert.deepEqual(
          h.log.filter((entry) => entry.startsWith("send ")),
          ["send type_text"],
        );
        const outbound = (yield* Effect.forEach(h.drivers, (driver) =>
          Queue.size(driver.toDriver).pipe(
            Effect.flatMap((count) => Queue.takeN(driver.toDriver, count)),
          ),
        ))
          .flat()
          .map((line) => JSON.parse(line));
        assert.deepEqual(outbound, [JSON.parse(original), cancellation.message]);
        if (ending === "pause" || ending === "idle" || ending === "expiry") {
          if (ending === "pause") yield* leases.resume;
          if (ending === "idle") {
            const reused = yield* leases.control(thread, Option.some(admission));
            assert.equal(reused.controlId, control.controlId);
          }
          yield* h.restarted;
          yield* h.send(
            call(3, "type_text", {
              pid: 42,
              window_id: 7,
              text: "old authority after resume",
              delivery_mode: "foreground",
            }),
          );
          const afterResume = yield* h.nextToProvider;
          assert.equal(afterResume.id, 3);
          assert.deepInclude(
            (afterResume.result as { structuredContent: object }).structuredContent,
            { detail: "foreground_not_approved" },
          );
          yield* h.send(call(4, "type_text", { pid: 42, window_id: 7, text: "background" }));
          assert.equal((yield* h.nextDispatch).message.id, 4);
          assert.equal((yield* h.nextReservation).action, "reserve");
          assert.equal((yield* h.nextValidation).action, "validate");
          yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 4, result: { content: [] } }));
          assert.equal((yield* h.nextToProvider).id, 4);
          assert.equal((yield* h.nextReservation).action, "release");
        }
      }).pipe(Effect.provide(foregroundProxyLayer)),
  );

  it.effect.each(["pause", "idle", "end"] as const)(
    "disposes a replacement acquired across %s and Stop leaves no stale child",
    (interruption) =>
      Effect.gen(function* () {
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const h = yield* harness({
          acquire: (index) =>
            index === 1
              ? Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
        });
        yield* h.push(shortForeground());
        yield* h.send(call(1, "run_script", { script: "opaque work" }));
        yield* h.nextDispatch;
        yield* h.nextReservation;
        yield* TestClock.adjust("5 minutes");
        yield* Deferred.await(acquired);
        assert.equal((yield* h.nextDispatch).message.method, "notifications/cancelled");
        const stale = yield* h.restarted;
        yield* h.nextReservation;
        yield* h.nextToProvider;
        yield* h.push(
          interruption === "pause"
            ? { state: "paused", controlId: CONTROL, reason: "takeover" }
            : interruption === "idle"
              ? { state: "idle", controlId: CONTROL }
              : { state: "ended", reason: "stopped" },
        );
        yield* h.send(call(2, "get_guide"));
        assert.equal((yield* h.nextToProvider).id, 2);
        yield* Deferred.succeed(release, undefined);
        assert.equal(yield* Deferred.await(stale.observed), "closed");
        assert.isTrue(yield* Deferred.isDone(stale.killed));
        assert.isTrue(yield* Deferred.isDone(stale.closed));
        if (interruption !== "end") {
          yield* h.push(active());
          yield* h.restarted;
          yield* h.send(call(3, "type_text", { pid: 42, window_id: 7, text: "background" }));
          const dispatched = yield* h.nextDispatch;
          assert.equal(dispatched.message.id, 3);
          yield* h.nextReservation;
          yield* h.push({ state: "ended", reason: "stopped" });
          const child = h.drivers[dispatched.index];
          assert.isDefined(child);
          yield* Deferred.await(child!.closed);
          yield* h.nextReservation;
        }
        for (const driver of h.drivers) assert.isTrue(yield* Deferred.isDone(driver.killed));
      }),
  );

  it.effect(
    "an expiry cutoff cannot overwrite a handback child or close its executing ticket",
    () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const h = yield* harness({
          kill: (index) => (index === 0 ? Deferred.await(release) : Effect.void),
        });
        yield* h.push(shortForeground());
        yield* h.send(call(1, "run_script", { script: "opaque work" }));
        yield* h.nextDispatch;
        const oldTicket = yield* h.nextReservation;
        yield* TestClock.adjust("5 minutes");
        yield* h.killed;
        assert.equal((yield* h.nextDispatch).message.method, "notifications/cancelled");
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
        yield* h.send(call(2, "get_guide"));
        assert.equal((yield* h.nextToProvider).id, 2);
        yield* h.push(active());
        const handback = yield* h.restarted;
        yield* h.send(call(3, "type_text", { pid: 42, window_id: 7, text: "background" }));
        assert.equal((yield* h.nextDispatch).index, 1);
        const ticket = yield* h.nextReservation;
        assert.notEqual(ticket.connectionId, oldTicket.connectionId);
        yield* Deferred.succeed(release, undefined);
        const oldClose = yield* h.nextReservation;
        assert.equal(oldClose.action, "close");
        assert.equal(oldClose.connectionId, oldTicket.connectionId);
        assert.equal((yield* h.nextToProvider).id, 1);
        yield* h.send(call(4, "type_text", { pid: 42, window_id: 7, text: "still owned" }));
        const next = yield* h.nextDispatch;
        assert.equal(next.message.id, 4);
        assert.equal(next.index, 1);
        assert.equal((yield* h.nextReservation).connectionId, ticket.connectionId);
        assert.isFalse(yield* Deferred.isDone(handback.killed));
        assert.isFalse(
          h.reservations.some(
            (request) => request.action === "close" && request.connectionId === ticket.connectionId,
          ),
        );
        yield* h.push({ state: "ended", reason: "stopped" });
        assert.equal((yield* h.nextToProvider).id, 3);
        const closed = yield* h.nextReservation;
        assert.equal(closed.action, "close");
        assert.equal(closed.connectionId, ticket.connectionId);
        assert.isTrue(yield* Deferred.isDone(handback.killed));
        assert.isTrue(yield* Deferred.isDone(handback.closed));
        assert.lengthOf(h.drivers, 2);
      }),
  );
});

describe("proxy expiry follows the server", () => {
  it.effect("a later expiry from the server keeps the control past its first deadline", () =>
    Effect.gen(function* () {
      const h = yield* harness({ expiresAt: "1970-01-01T01:00:00.000Z" });
      yield* h.push(active("1970-01-01T01:00:00.000Z"));
      assert.equal(yield* h.applied, "active");
      yield* TestClock.adjust("50 minutes");
      // The thread's next turn reused the control: it now lasts an hour from that use.
      yield* h.push(active("1970-01-01T01:50:00.000Z"));
      assert.equal(yield* h.applied, "active");
      yield* TestClock.adjust("20 minutes");
      yield* h.send(call(1, "list_apps"));
      assert.equal((yield* h.nextToDriver).id, 1);
      assert.isFalse(yield* h.isKilled);
      yield* TestClock.adjust("40 minutes");
      yield* h.killed;
      yield* h.send(call(2, "click"));
      assert.equal((yield* h.nextToProvider).id, 1);
      assert.deepEqual(yield* h.nextToProvider, refusedCall(2, "expired"));
    }),
  );
});

describe("a full access grant follows its control's later expiry", () => {
  it.effect(
    "a foreground call after the grant's first expiry goes out once the server moved it",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ expiresAt: "1970-01-01T01:00:00.000Z" });
        yield* h.push(foregroundActive("1970-01-01T01:00:00.000Z"));
        assert.equal(yield* h.applied, "active");
        yield* TestClock.adjust("50 minutes");
        yield* h.push(foregroundActive("1970-01-01T01:50:00.000Z"));
        assert.equal(yield* h.applied, "active");
        yield* TestClock.adjust("20 minutes");
        yield* h.send(call(1, "bring_to_front", { pid: 42 }));
        assert.equal((yield* h.nextToDriver).id, 1);
      }),
  );
});
