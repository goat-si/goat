import { assert, describe, it } from "@effect/vitest";
import type { ComputerUseCallReservation } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Statement from "effect/sql/Statement";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { ORPHAN_CALL_GRACE_MS } from "./ComputerUseCallReservations.ts";
import { APP_LEASE_IDLE_MS } from "./ComputerUseAppLeases.ts";
import {
  database,
  fixture,
  openProxy,
  serviceLayer,
} from "./ComputerUseCallReservations.testkit.ts";
import { active, call, harness } from "./ComputerUseLeaseProxy.testkit.ts";
import { foregroundGrant, revokeForegroundGrant } from "./ComputerUseForeground.testkit.ts";
import { grant } from "./ComputerUseLeases.projection.testkit.ts";

describe("server computer-use call reservations", () => {
  it.effect.each([
    {
      name: "a proxy lost without close blocks its window during grace and admits it exactly at grace expiry",
      held: { pid: 42, window_id: 7 },
      next: { pid: 42, window_id: 7 },
    },
    {
      name: "a lost desktop ticket blocks an unrelated window only until grace expiry",
      held: { text: "desktop" },
      next: { pid: 99, window_id: 8 },
    },
    {
      name: "a lost window ticket blocks the desktop only until grace expiry",
      held: { pid: 42, window_id: 7 },
      next: { text: "desktop" },
    },
  ])("$name", ({ held, next }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const disconnect = yield* openProxy(f.a, f.first.controlId);
        const ticket = yield* f.reserve(f.a, held);
        if (ticket.status !== "admitted" || ticket.reservationId === null)
          return assert.fail("expected orphan ticket");
        yield* disconnect;
        yield* TestClock.adjust(ORPHAN_CALL_GRACE_MS - 1);
        assert.deepEqual(yield* f.reserve(f.b, next), {
          status: "refused",
          detail: "target_busy",
          holderThreadId: f.a,
        });
        yield* TestClock.adjust(1);
        assert.equal((yield* f.reserve(f.b, next)).status, "admitted");
        assert.deepEqual(
          yield* f.leases.callReservation(f.a, {
            action: "validate",
            controlId: f.first.controlId,
            connectionId: "driver:1",
            reservationId: ticket.reservationId,
          }),
          { status: "refused", detail: "replaced" },
        );
      }),
    ).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "expiry fences late old-generation reserve and release without touching a replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const disconnect = yield* openProxy(f.a, f.first.controlId);
          const ticket = yield* f.reserve();
          if (ticket.status !== "admitted" || ticket.reservationId === null)
            return assert.fail("expected orphan ticket");
          yield* disconnect;
          yield* TestClock.adjust(ORPHAN_CALL_GRACE_MS);
          const validation = {
            action: "validate" as const,
            controlId: f.first.controlId,
            connectionId: "driver:1",
            reservationId: ticket.reservationId,
          };
          assert.deepEqual(yield* f.leases.callReservation(f.a, validation), {
            status: "refused",
            detail: "replaced",
          });
          const disconnectReplacement = yield* openProxy(f.a, f.first.controlId);
          assert.deepEqual(yield* f.reserve(), { status: "refused", detail: "replaced" });
          const replacement = yield* f.reserve(
            f.a,
            { pid: 42, window_id: 7 },
            "type_text",
            "driver:2",
          );
          if (replacement.status !== "admitted" || replacement.reservationId === null)
            return assert.fail("expected replacement ticket");
          yield* f.release(f.a, ticket.reservationId);
          yield* f.release(f.a, replacement.reservationId);
          yield* f.close();
          assert.deepEqual(
            yield* f.leases.callReservation(f.a, {
              ...validation,
              connectionId: "driver:2",
              reservationId: replacement.reservationId,
            }),
            replacement,
          );
          assert.deepEqual(yield* f.reserve(f.b), {
            status: "refused",
            detail: "target_busy",
            holderThreadId: f.a,
          });
          yield* disconnectReplacement;
        }),
      ).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "closing one of two live lease streams does not expire their active window ticket",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const first = yield* openProxy(f.a, f.first.controlId);
          const last = yield* openProxy(f.a, f.first.controlId);
          const ticket = yield* f.reserve();
          if (ticket.status !== "admitted" || ticket.reservationId === null)
            return assert.fail("expected live ticket");
          yield* first;
          yield* TestClock.adjust(APP_LEASE_IDLE_MS + ORPHAN_CALL_GRACE_MS);
          assert.deepInclude(yield* f.reserve(f.b, { pid: 42, window_id: 8 }), {
            status: "refused",
            detail: "app_busy",
            holderThreadId: f.a,
          });
          assert.deepEqual(
            yield* f.leases.callReservation(f.a, {
              action: "validate",
              controlId: f.first.controlId,
              connectionId: "driver:1",
              reservationId: ticket.reservationId,
            }),
            ticket,
          );
          yield* last;
          yield* TestClock.adjust(ORPHAN_CALL_GRACE_MS - 1);
          assert.deepEqual(yield* f.reserve(f.b), {
            status: "refused",
            detail: "target_busy",
            holderThreadId: f.a,
          });
          yield* TestClock.adjust(1);
          assert.equal((yield* f.reserve(f.b)).status, "admitted");
        }),
      ).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "a stopped control's window ticket is discovered before targetBusy and reclaimed after grace (#1689)",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.equal((yield* f.reserve()).status, "admitted");
        yield* f.leases.stop(f.a);
        assert.deepEqual(yield* f.reserve(f.b), {
          status: "refused",
          detail: "target_busy",
          holderThreadId: f.a,
        });
        yield* TestClock.adjust(ORPHAN_CALL_GRACE_MS - 1);
        assert.deepEqual(yield* f.reserve(f.b), {
          status: "refused",
          detail: "target_busy",
          holderThreadId: f.a,
        });
        yield* TestClock.adjust(1);
        assert.equal((yield* f.reserve(f.b)).status, "admitted");
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect.each(["stop", "turn end", "replacement"] as const)(
    "a ticket left by a control's %s is reclaimed one grace after it, with no conflicting call in between",
    (how) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.equal((yield* f.reserve()).status, "admitted");
        if (how === "stop") yield* f.leases.stop(f.a);
        else if (how === "turn end") assert.isTrue(yield* f.leases.turnEnded(f.a));
        else {
          yield* grant(f.a, "grant:replacement", ["app.a"]);
          const lease = Option.getOrThrow(yield* f.leases.active(f.a));
          const next = yield* f.leases.control(f.a, Option.some(lease));
          assert.notEqual(next.controlId, f.first.controlId);
        }
        yield* TestClock.adjust(ORPHAN_CALL_GRACE_MS);
        assert.equal((yield* f.reserve(f.b)).status, "admitted");
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect("notification settle is an observation, so it takes no mutation reservation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const holder = yield* f.reserve(f.a);
      assert.equal(holder.status, "admitted");
      const settle = yield* f.reserve(f.b, { pid: 42, window_id: 7 }, "wait_for_window_settle");
      assert.deepInclude(settle, { status: "admitted", reservationId: null });
    }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "admits overlay cursor moves on a shared screen but refuses desktop moves (#1501)",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* grant(f.a, "grant:a", ["app.a"]);
        const focus = yield* foregroundGrant(f.a, "grant:cursor-focus");
        yield* grant(f.b, "grant:b", ["app.b"]);
        for (const args of [
          { x: 1, y: 1 },
          { scope: "window", x: 1, y: 1 },
          { pid: 42, window_id: 7, x: 1, y: 1 },
          { target: { kind: "window", pid: 42, window_id: 7 }, x: 1, y: 1 },
        ]) {
          assert.equal((yield* f.reserve(f.a, args, "move_cursor")).status, "admitted");
        }
        for (const args of [
          { scope: "desktop", x: 1, y: 1 },
          { target: { kind: "desktop", display_id: "primary" }, x: 1, y: 1 },
        ])
          assert.deepEqual(
            yield* f.reserve(f.a, args, "move_cursor", "driver:1", 0, focus.handoffId),
            {
              status: "refused",
              detail: "screen_shared",
            },
          );
        yield* f.close(f.a);
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect("overlay delivery flags do not grant authority to move the real pointer", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const args of [
        { x: 1, y: 1, delivery_mode: "foreground" },
        { pid: 42, window_id: 7, dispatch: "foreground" },
        { scope: "desktop", pid: 42, window_id: 7, x: 1, y: 1 },
      ])
        assert.equal((yield* f.reserve(f.a, args, "move_cursor")).status, "admitted");
      for (const args of [
        { scope: "desktop", x: 1, y: 1 },
        { target: { kind: "desktop", display_id: "primary" }, x: 1, y: 1 },
      ])
        assert.deepEqual(yield* f.reserve(f.a, args, "move_cursor"), {
          status: "refused",
          detail: "foreground_not_approved",
        });
      yield* f.close();
    }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "validates only the original ticket owner and retains the same conflicting execution",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const original = yield* f.reserve();
        if (original.status !== "admitted" || original.reservationId === null)
          return assert.fail("expected execution ticket");
        const validation = {
          action: "validate" as const,
          controlId: f.first.controlId,
          connectionId: "driver:1",
          reservationId: original.reservationId,
        };
        assert.deepEqual(yield* f.leases.callReservation(f.a, validation), original);
        for (const [owner, request] of [
          [f.b, validation],
          [f.a, { ...validation, controlId: f.second.controlId }],
          [f.a, { ...validation, connectionId: "driver:forged" }],
          [f.a, { ...validation, reservationId: "ticket:forged" }],
        ] as const)
          assert.deepEqual(yield* f.leases.callReservation(owner, request), {
            status: "refused",
            detail: "replaced",
          });
        assert.deepEqual(yield* f.reserve(f.b), {
          status: "refused",
          detail: "target_busy",
          holderThreadId: f.a,
        });
        yield* f.release(f.a, original.reservationId);
        assert.deepEqual(yield* f.leases.callReservation(f.a, validation), {
          status: "refused",
          detail: "replaced",
        });
        const next = yield* f.reserve();
        if (next.status !== "admitted" || next.reservationId === null)
          return assert.fail("expected next ticket");
        yield* f.close();
        assert.deepEqual(
          yield* f.leases.callReservation(f.a, {
            ...validation,
            reservationId: next.reservationId,
          }),
          { status: "refused", detail: "replaced" },
        );
        assert.equal((yield* f.reserve(f.b)).status, "admitted");
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "confirmation cannot substitute a safe call or fresh grant for cancelled foreground authority",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const grant = yield* foregroundGrant(f.a, "handoff:confirm-original");
        const original = yield* f.reserve(
          f.a,
          { pid: 42, window_id: 7, dispatch: "foreground" },
          "click",
          "driver:1",
          0,
          grant.handoffId,
        );
        if (original.status !== "admitted" || original.reservationId === null)
          return assert.fail("expected ticket");
        yield* revokeForegroundGrant(grant.handoffId);
        const fresh = yield* foregroundGrant(f.a, "handoff:confirm-unrelated");
        const forged = {
          action: "validate" as const,
          controlId: f.first.controlId,
          connectionId: "driver:1",
          reservationId: original.reservationId,
          name: "list_apps",
          args: {},
          foregroundGrantId: fresh.handoffId,
        };
        assert.deepEqual(yield* f.leases.callReservation(f.a, forged), {
          status: "refused",
          detail: "foreground_not_approved",
        });
        assert.deepEqual(yield* f.reserve(f.b, { pid: 99, window_id: 8 }), {
          status: "refused",
          detail: "target_busy",
          holderThreadId: f.a,
        });
        yield* f.release(f.a, original.reservationId);
        assert.equal((yield* f.reserve(f.b, { pid: 99, window_id: 8 })).status, "admitted");
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect.each(["release", "close"] as const)(
    "refuses confirmation when %s removes its ticket during a yielding state read",
    (ending) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const original = yield* f.reserve();
        if (original.status !== "admitted" || original.reservationId === null)
          return assert.fail("expected ticket");
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const validation = {
          action: "validate" as const,
          controlId: f.first.controlId,
          connectionId: "driver:1",
          reservationId: original.reservationId,
        };
        const confirmed = yield* f.leases.callReservation(f.a, validation).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as(statement),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        if (ending === "release") yield* f.release(f.a, original.reservationId);
        else yield* f.close();
        yield* Deferred.succeed(gate, undefined);
        assert.deepEqual(yield* Fiber.join(confirmed), { status: "refused", detail: "replaced" });
        // A released ticket leaves A's app lease (D17) until its idle window passes; a closed
        // driver ends both at once.
        if (ending === "release") {
          assert.deepInclude(yield* f.reserve(f.b), { detail: "app_busy", holderThreadId: f.a });
          yield* TestClock.adjust(APP_LEASE_IDLE_MS);
        }
        assert.equal((yield* f.reserve(f.b)).status, "admitted");
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect("confirmation repeats shared-screen admission without releasing the held desktop", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* grant(f.a, "grant:confirm-a", ["app.a"]);
      const focus = yield* foregroundGrant(f.a, "grant:confirm-focus");
      const original = yield* f.reserve(
        f.a,
        { pid: 42, window_id: 7, dispatch: "foreground" },
        "click",
        "driver:1",
        0,
        focus.handoffId,
      );
      if (original.status !== "admitted" || original.reservationId === null)
        return assert.fail("expected desktop ticket");
      yield* grant(f.b, "grant:confirm-b", ["app.b"]);
      assert.deepEqual(
        yield* f.leases.callReservation(f.a, {
          action: "validate",
          controlId: f.first.controlId,
          connectionId: "driver:1",
          reservationId: original.reservationId,
        }),
        { status: "refused", detail: "screen_shared" },
      );
      assert.deepEqual(yield* f.reserve(f.b, { pid: 99, window_id: 8 }), {
        status: "refused",
        detail: "target_busy",
        holderThreadId: f.a,
      });
      yield* f.release(f.a, original.reservationId);
      assert.equal((yield* f.reserve(f.b, { pid: 99, window_id: 8 })).status, "admitted");
    }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect("does not borrow another thread's foreground scope for background input", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const focus = yield* foregroundGrant(f.a, "handoff:background-scope-proof");
      assert.deepEqual(
        yield* f.reserve(
          f.b,
          { pid: 43, window_id: 8 },
          "type_text",
          "driver:1",
          0,
          focus.handoffId,
        ),
        { status: "refused", detail: "foreground_not_approved" },
      );
      assert.equal((yield* f.reserve(f.b, { pid: 43, window_id: 8 })).status, "admitted");
    }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect("rejects invalid window identities before foreground broadens the reservation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const focus = yield* foregroundGrant(f.a, "handoff:validation-focus");
      for (const args of [
        { pid: -1, window_id: 7, delivery_mode: "foreground" },
        { pid: 42, window_id: 0, foreground: true },
        { target: { kind: "app", pid: -1 } },
        { pid: -1, window_id: 7, delivery_mode: "FOREGROUND" },
        { pid: 42, window_id: 0, delivery_mode: "fOrEgRoUnD" },
      ]) {
        assert.deepEqual(
          yield* f.leases.callReservation(f.a, {
            action: "reserve",
            controlId: f.first.controlId,
            connectionId: "driver:validation",
            callId: "invalid",
            interruptions: 0,
            idleEpoch: 0,
            name: "type_text",
            args,
            foregroundGrantId: focus.handoffId,
          }),
          { status: "refused", detail: "invalid_target" },
        );
      }
      assert.equal((yield* f.reserve(f.b)).status, "admitted");
    }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "refuses a call that takes the screen once another thread holds a grant, whatever the proxy has heard",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        // Disjoint grants: both admitted, so the screen is shared.
        yield* grant(f.a, "grant:a", ["app.a"]);
        const focus = yield* foregroundGrant(f.a, "grant:focus");
        yield* grant(f.b, "grant:b", ["app.b"]);
        const window = { pid: 42, window_id: 7, x: 1, y: 1 };
        assert.deepEqual(
          yield* f.reserve(
            f.a,
            { ...window, delivery_mode: "foreground" },
            "click",
            "driver:1",
            0,
            focus.handoffId,
          ),
          { status: "refused", detail: "screen_shared" },
        );
        assert.equal((yield* f.reserve(f.a, window, "click")).status, "admitted");
        yield* f.close(f.a);
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "a foreground call admitted before another thread's grant keeps every other thread off the desktop until it ends",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* grant(f.a, "grant:a", ["app.a"]);
        const focus = yield* foregroundGrant(f.a, "grant:focus");
        const click = { pid: 42, window_id: 7, x: 1, y: 1 };
        const first = yield* f.reserve(
          f.a,
          { ...click, dispatch: "Foreground" },
          "click",
          "driver:1",
          0,
          focus.handoffId,
        );
        if (first.status !== "admitted" || first.reservationId === null)
          return assert.fail("a foreground click reserves the desktop");
        // B is approved while A's click is on its way: B acts on nothing until it ends.
        yield* grant(f.b, "grant:b", ["app.b"]);
        assert.deepEqual(yield* f.reserve(f.b, { pid: 9, window_id: 3, x: 1, y: 1 }, "click"), {
          status: "refused",
          detail: "target_busy",
          holderThreadId: f.a,
        });
        yield* f.release(f.a, first.reservationId);
        // A's next call that would take the screen meets the shared screen.
        assert.deepEqual(
          yield* f.reserve(
            f.a,
            { ...click, dispatch: "Foreground" },
            "click",
            "driver:1",
            0,
            focus.handoffId,
          ),
          {
            status: "refused",
            detail: "screen_shared",
          },
        );
        assert.equal(
          (yield* f.reserve(f.b, { pid: 9, window_id: 3, x: 1, y: 1 }, "click")).status,
          "admitted",
        );
        yield* f.close(f.a);
        yield* f.close(f.b);
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "refuses competing window mutations and desktop mutations in both admission orders",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const window = { pid: 42, window_id: 7, text: "hello" };
        const admitted = yield* f.reserve(f.a, window);
        assert.equal(admitted.status, "admitted");
        assert.deepEqual(yield* f.reserve(f.b, window), {
          status: "refused",
          detail: "target_busy",
          holderThreadId: f.a,
        });
        assert.deepEqual(yield* f.reserve(f.b, { text: "desktop" }), {
          status: "refused",
          detail: "target_busy",
          holderThreadId: f.a,
        });
        if (admitted.status !== "admitted" || admitted.reservationId === null)
          return assert.fail("mutation needs an execution reservation");
        yield* f.release(f.a, admitted.reservationId);
        // A's app lease (D17) outlives its released ticket: B meets the lease, not a ticket,
        // until the lease's idle window passes.
        assert.deepInclude(yield* f.reserve(f.b, { text: "desktop" }), {
          detail: "app_busy",
          holderThreadId: f.a,
        });
        yield* TestClock.adjust(APP_LEASE_IDLE_MS);
        assert.equal((yield* f.reserve(f.b, { text: "desktop" })).status, "admitted");
        assert.deepEqual(yield* f.reserve(f.a, window), {
          status: "refused",
          detail: "target_busy",
          holderThreadId: f.b,
        });
        yield* f.close(f.b);
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "rejects old-turn input when admission arrives after idle and reuse before the stream update",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const h = yield* harness({
          reservation: (request) =>
            request.action !== "reserve"
              ? Effect.succeed({ status: "released" } as const)
              : Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.andThen(
                    f.leases.callReservation(f.a, { ...request, controlId: f.first.controlId }),
                  ),
                  Effect.orDie,
                ),
        });
        yield* h.push(active());
        yield* h.send(call(1, "type_text", { pid: 42, window_id: 7, text: "old turn" }));
        yield* Deferred.await(entered);
        yield* f.leases.turnEnded(f.a);
        const reused = yield* f.leases.control(f.a, Option.none());
        assert.equal(reused.controlId, f.first.controlId);
        yield* Deferred.succeed(gate, undefined);
        // The proxy has not heard the idle epoch. Discovery proves the old input was never sent.
        yield* h.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
        assert.equal((yield* h.nextToDriver).id, 2);
        const refused = (yield* h.nextToProvider).result as {
          structuredContent: { detail: string };
        };
        assert.equal(refused.structuredContent.detail, "replaced");
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );
  it.effect("atomically admits only one of two threads racing for the same window", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const decisions = yield* Effect.all([f.reserve(f.a), f.reserve(f.b)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(decisions.map((decision) => decision.status).sort(), [
        "admitted",
        "refused",
      ]);
    }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "admits a background-scoped batch without foreground approval and holds only its window",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.equal((yield* f.reserve()).status, "admitted");
        const app_scope = { apps: ["org.example.Other"] };
        const batch = (window: object, step: object = {}) => ({
          ...window,
          app_scope,
          steps: [{ tool: "click", args: { element_token: "s:1", ...step } }],
        });
        // The driver keeps it to background delivery in its app, so it needs no foreground grant.
        const own = yield* f.reserve(f.b, batch({ pid: 43, window_id: 8 }), "run_steps");
        assert.equal(own.status, "admitted");
        // It holds its own window, so another thread's window stays a conflict.
        assert.deepInclude(yield* f.reserve(f.b, batch({ pid: 42, window_id: 7 }), "run_steps"), {
          status: "refused",
          detail: "target_busy",
        });
        // A step naming another window may act anywhere in the scoped apps: desktop work.
        assert.deepInclude(
          yield* f.reserve(f.b, batch({ pid: 44, window_id: 9 }, { pid: 45 }), "run_steps"),
          { status: "refused", detail: "target_busy" },
        );
        // A check naming another window moves later steps there, so it is desktop work too.
        for (const check of [
          { wait_for: { pid: 42, window_id: 7, name: "OK" } },
          { expect: [{ app: "Other", window: "Doc" }] },
        ])
          assert.deepInclude(
            yield* f.reserve(
              f.b,
              {
                ...batch({ pid: 44, window_id: 9 }),
                steps: [{ tool: "click", args: {}, ...check }],
              },
              "run_steps",
            ),
            { status: "refused", detail: "target_busy" },
          );
        // A script can launch a scoped app, which needs foreground approval, so its scope grants none.
        assert.deepInclude(
          yield* f.reserve(f.b, { script: "cua.call('launch_app', {})", app_scope }, "run_script"),
          { status: "refused", detail: "foreground_not_approved" },
        );
        // Without a scope, or with foreground delivery, it still needs foreground approval.
        for (const args of [
          { pid: 44, window_id: 9, steps: [] },
          {
            ...batch({ pid: 44, window_id: 9 }),
            app_scope: { ...app_scope, delivery: "foreground" },
          },
        ])
          assert.deepInclude(yield* f.reserve(f.b, args, "run_steps"), {
            status: "refused",
            detail: "foreground_not_approved",
          });
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "allows unrelated window mutations and reads while opaque and app-only mutations conflict",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const focus = yield* foregroundGrant(f.b, "handoff:conflict-focus");
        assert.equal((yield* f.reserve()).status, "admitted");
        // Another app's window: the same app's other windows are one app lease since D17.
        assert.equal((yield* f.reserve(f.b, { pid: 43, window_id: 8 })).status, "admitted");
        assert.equal((yield* f.reserve(f.b, {}, "list_windows")).status, "admitted");
        for (const [name, args] of [
          ["type_text", { pid: 99 }],
          ["run_steps", { steps: [{ type: "type_text", pid: 99, window_id: 8 }] }],
          ["run_script", { pid: 99, window_id: 8, code: "dynamic" }],
          ["bring_to_front", { pid: 99, window_id: 8 }],
          ["type_text", { pid: 99, window_id: 8, dispatch: "foreground" }],
          ["future_tool", { pid: 99, window_id: 8 }],
        ] as const) {
          const decision = yield* f.leases.callReservation(f.b, {
            action: "reserve",
            controlId: f.second.controlId,
            connectionId: "driver:1",
            callId: name,
            interruptions: 0,
            idleEpoch: 0,
            name,
            args,
            foregroundGrantId: focus.handoffId,
          });
          assert.deepEqual(decision, {
            status: "refused",
            detail: "target_busy",
            holderThreadId: f.a,
          });
        }
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect.each([
    ["FOREGROUND", false],
    ["FOREGROUND", true],
    ["fOrEgRoUnD", false],
    ["fOrEgRoUnD", true],
  ] as const)(
    "excludes other windows for delivery_mode %s with foreground first=%s",
    ([mode, foregroundFirst]) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const focus = yield* foregroundGrant(
          foregroundFirst ? f.a : f.b,
          "handoff:mixed-case-focus",
        );
        const foreground = { pid: 42, window_id: 7, delivery_mode: mode };
        const background = { pid: 99, window_id: 8 };
        assert.equal(
          (yield* f.reserve(
            f.a,
            foregroundFirst ? foreground : background,
            "type_text",
            "driver:1",
            0,
            foregroundFirst ? focus.handoffId : undefined,
          )).status,
          "admitted",
        );
        assert.deepEqual(
          yield* f.reserve(
            f.b,
            foregroundFirst ? background : foreground,
            "type_text",
            "driver:1",
            0,
            foregroundFirst ? undefined : focus.handoffId,
          ),
          {
            status: "refused",
            detail: "target_busy",
            holderThreadId: f.a,
          },
        );
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "rejects contradictory or invalid window identities before they acquire authority",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        for (const args of [
          { pid: 42, target: { kind: "window", window_id: 7 } },
          { pid: -1, window_id: 7 },
          { pid: 42, window_id: 0 },
          { pid: 42, window_id: Number.MAX_SAFE_INTEGER + 1 },
          { pid: "42", window_id: 7 },
        ])
          assert.deepEqual(yield* f.reserve(f.a, args), {
            status: "refused",
            detail: "invalid_target",
          });
        assert.equal((yield* f.reserve(f.b)).status, "admitted");
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "retains every outstanding ticket and rejects another thread or generation releasing it",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const first = yield* f.reserve();
        const second = yield* f.reserve();
        if (
          first.status !== "admitted" ||
          first.reservationId === null ||
          second.status !== "admitted" ||
          second.reservationId === null
        )
          return assert.fail("expected reservations");
        yield* f.release(f.a, first.reservationId);
        yield* f.release(f.b, second.reservationId);
        yield* f.release(f.a, second.reservationId, "driver:old");
        assert.equal((yield* f.reserve(f.b)).status, "refused");
        yield* f.release(f.a, second.reservationId);
        // A's app lease (D17) outlives its released ticket: B meets the lease, not a ticket,
        // until the lease's idle window passes.
        assert.deepInclude(yield* f.reserve(f.b), { detail: "app_busy", holderThreadId: f.a });
        yield* TestClock.adjust(APP_LEASE_IDLE_MS);
        assert.equal((yield* f.reserve(f.b)).status, "admitted");
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "fences a closed generation against delayed acquisition without closing a newer driver",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.close();
        assert.deepEqual(yield* f.reserve(), { status: "refused", detail: "replaced" });
        assert.equal(
          (yield* f.reserve(f.a, { pid: 42, window_id: 7 }, "type_text", "driver:2")).status,
          "admitted",
        );
        yield* f.close();
        assert.equal((yield* f.reserve(f.b)).status, "refused");
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect(
    "denies idle, paused, stopped and expired controls while retaining execution until cutoff",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.reserve();
        yield* f.leases.turnEnded(f.a);
        assert.deepEqual(yield* f.reserve(), { status: "refused", detail: "control_idle" });
        assert.equal((yield* f.reserve(f.b)).status, "refused");
        yield* f.close();
        assert.equal((yield* f.reserve(f.b)).status, "admitted");
        yield* f.leases.pause("takeover");
        assert.deepEqual(yield* f.reserve(f.b), { status: "refused", detail: "waiting_for_human" });
        yield* f.leases.resume;
        assert.deepEqual(yield* f.reserve(f.b), { status: "refused", detail: "replaced" });
        yield* f.leases.stop(f.b);
        assert.deepEqual(yield* f.reserve(f.b), { status: "refused", detail: "stopped" });
        const fresh = yield* f.leases.control(f.a, Option.none());
        yield* TestClock.adjust("1 hour");
        const expired: ComputerUseCallReservation = {
          action: "reserve",
          controlId: fresh.controlId,
          connectionId: "driver:3",
          callId: "expired",
          interruptions: 1,
          idleEpoch: 1,
          name: "type_text",
          args: { pid: 42, window_id: 7 },
        };
        assert.deepEqual(yield* f.leases.callReservation(f.a, expired), {
          status: "refused",
          detail: "expired",
        });
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );
});

describe("server computer-use app leases of calls that never ran", () => {
  it.effect("a refused call leaves no app lease, so another thread can use the app at once", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const refused = yield* f.reserve();
      if (refused.status !== "admitted" || refused.reservationId === null)
        return assert.fail("expected ticket");
      yield* f.release(f.a, refused.reservationId, "driver:1", { completed: true, notSent: true });
      assert.equal((yield* f.reserve(f.b)).status, "admitted");
    }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect("a refused call keeps the app lease an earlier call of its thread took", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const acted = yield* f.reserve();
      if (acted.status !== "admitted" || acted.reservationId === null)
        return assert.fail("expected first ticket");
      yield* f.release(f.a, acted.reservationId, "driver:1", { completed: true });
      const refused = yield* f.reserve();
      if (refused.status !== "admitted" || refused.reservationId === null)
        return assert.fail("expected second ticket");
      yield* f.release(f.a, refused.reservationId, "driver:1", { completed: true, notSent: true });
      assert.deepInclude(yield* f.reserve(f.b), { detail: "app_busy", holderThreadId: f.a });
    }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );
});

describe("server computer-use app leases when calls overlap", () => {
  it.effect.each(["first", "second"] as const)(
    "two refused calls of one thread leave no app lease, the %s released first",
    (order) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const one = yield* f.reserve();
        const two = yield* f.reserve();
        if (one.status !== "admitted" || one.reservationId === null) return assert.fail("one");
        if (two.status !== "admitted" || two.reservationId === null) return assert.fail("two");
        const ids =
          order === "first"
            ? [one.reservationId, two.reservationId]
            : [two.reservationId, one.reservationId];
        for (const id of ids)
          yield* f.release(f.a, id, "driver:1", { completed: true, notSent: true });
        assert.equal((yield* f.reserve(f.b)).status, "admitted");
      }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect("a refused call keeps the lease of an overlapping call that ran", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const refused = yield* f.reserve();
      const acted = yield* f.reserve();
      if (refused.status !== "admitted" || refused.reservationId === null)
        return assert.fail("refused");
      if (acted.status !== "admitted" || acted.reservationId === null) return assert.fail("acted");
      yield* f.release(f.a, acted.reservationId, "driver:1", { completed: true });
      yield* f.release(f.a, refused.reservationId, "driver:1", { notSent: true });
      assert.deepInclude(yield* f.reserve(f.b), { detail: "app_busy", holderThreadId: f.a });
    }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect("a refused call confirmed before its refusal leaves no app lease", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const refused = yield* f.reserve();
      if (refused.status !== "admitted" || refused.reservationId === null)
        return assert.fail("expected ticket");
      const confirmed = yield* f.leases.callReservation(f.a, {
        action: "validate",
        controlId: f.first.controlId,
        connectionId: "driver:1",
        reservationId: refused.reservationId,
      });
      assert.equal(confirmed.status, "admitted");
      yield* f.release(f.a, refused.reservationId, "driver:1", { notSent: true });
      assert.equal((yield* f.reserve(f.b)).status, "admitted");
    }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );

  it.effect("a release from another connection cannot take back a call's app lease", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const acted = yield* f.reserve();
      if (acted.status !== "admitted" || acted.reservationId === null)
        return assert.fail("expected ticket");
      yield* f.release(f.a, acted.reservationId, "driver:2", { notSent: true });
      yield* f.release(f.a, acted.reservationId, "driver:1", { completed: true });
      assert.deepInclude(yield* f.reserve(f.b), { detail: "app_busy", holderThreadId: f.a });
    }).pipe(Effect.provide(Layer.merge(serviceLayer, database))),
  );
});
