import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ComputerUseCallReservation } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { active, call, harness } from "./ComputerUseLeaseProxy.testkit.ts";
import { foregroundGrant } from "./ComputerUseForeground.testkit.ts";
import { grant } from "./ComputerUseLeases.projection.testkit.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const serviceLayer = ComputerUseLeases.layer.pipe(
  Layer.provide(Layer.merge(database, NodeServices.layer)),
);
const fixture = Effect.fn("reservations.fixture")(function* () {
  yield* runMigrations();
  const leases = yield* ComputerUseLeases.ComputerUseLeases;
  const a = ThreadId.make("thread:a");
  const b = ThreadId.make("thread:b");
  const first = yield* leases.control(a, Option.none());
  const second = yield* leases.control(b, Option.none());
  let sequence = 0;
  const reserve = (
    owner = a,
    args: unknown = { pid: 42, window_id: 7 },
    name = "type_text",
    connectionId = "driver:1",
    interruptions = 0,
    foregroundGrantId?: import("@goat/contracts").TurnItemId,
  ) =>
    leases.callReservation(owner, {
      action: "reserve",
      controlId: owner === a ? first.controlId : second.controlId,
      connectionId,
      callId: String(sequence++),
      interruptions,
      idleEpoch: 0,
      name,
      args,
      ...(foregroundGrantId === undefined ? {} : { foregroundGrantId }),
    });
  const release = (owner: typeof a, reservationId: string, connectionId = "driver:1") =>
    leases.callReservation(owner, {
      action: "release",
      controlId: owner === a ? first.controlId : second.controlId,
      connectionId,
      reservationId,
    });
  const close = (owner = a, connectionId = "driver:1") =>
    leases.callReservation(owner, {
      action: "close",
      controlId: owner === a ? first.controlId : second.controlId,
      connectionId,
    });
  return { leases, a, b, first, second, reserve, release, close };
});

describe("server computer-use call reservations", () => {
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
    "allows unrelated window mutations and reads while opaque and app-only mutations conflict",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const focus = yield* foregroundGrant(f.b, "handoff:conflict-focus");
        assert.equal((yield* f.reserve()).status, "admitted");
        assert.equal((yield* f.reserve(f.b, { pid: 42, window_id: 8 })).status, "admitted");
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
