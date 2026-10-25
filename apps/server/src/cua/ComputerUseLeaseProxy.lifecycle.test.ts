import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import { foregroundProxy, foregroundProxyLayer } from "./ComputerUseForeground.testkit.ts";
import {
  active,
  call,
  CONTROL,
  foregroundActive,
  harness,
} from "./ComputerUseLeaseProxy.testkit.ts";

const shortForeground = () => {
  const update = foregroundActive();
  return {
    ...update,
    foreground: update.foreground.map((grant) => ({ ...grant, expiresAtMillis: 300_000 })),
  };
};

describe("proxy lifecycle ownership across foreground expiry", () => {
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
