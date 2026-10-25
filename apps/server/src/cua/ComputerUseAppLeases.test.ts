import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ComputerUseCallReservation, ThreadId } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import { APP_LEASE_IDLE_MS, makeAppLeases } from "./ComputerUseAppLeases.ts";
import { makeCallReservations } from "./ComputerUseCallReservations.ts";
import type { ComputerUseControlState } from "./ComputerUseControl.ts";
import { makeCallReservation, ORPHAN_CALL_GRACE_MS } from "./ComputerUseLeaseAdmission.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { call, harness } from "./ComputerUseLeaseProxy.testkit.ts";
import { leaseUpdates } from "./ComputerUseLeaseRoute.ts";
import { database, grant } from "./ComputerUseLeases.projection.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";

// D17 (#1671): an app belongs to one thread at a time between its mutating calls, whatever kind
// of control each thread holds. These run on the real lease service and its admission.
const layer = ComputerUseLeases.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      database,
      NodeServices.layer,
      ServerSettings.ServerSettingsService.layerTest({ enableCua: true }),
    ),
  ),
);

const TEXTEDIT = "com.apple.TextEdit";
const CALCULATOR = "com.apple.calculator";

const fullAccess = Effect.fn("appLeases.fullAccess")(function* (name: string) {
  const sql = yield* SqlClient.SqlClient;
  const leases = yield* ComputerUseLeases.ComputerUseLeases;
  const threadId = ThreadId.make(`thread-${name}`);
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
       created_at, updated_at, payload_json)
    VALUES (${threadId}, 'project', ${name}, 'codex', 'full-access', 'default',
      '2026-01-01', '2026-01-01', '{}')`;
  const control = Option.getOrThrow(yield* leases.everyAppControl(threadId, false));
  return { threadId, control };
});

const granted = Effect.fn("appLeases.granted")(function* (name: string, apps: Array<string>) {
  const leases = yield* ComputerUseLeases.ComputerUseLeases;
  const threadId = ThreadId.make(`thread-${name}`);
  yield* grant(threadId, `handoff:${name}`, apps);
  const control = yield* leases.control(threadId, yield* leases.active(threadId));
  return { threadId, control };
});

let calls = 0;
/** One call from a thread's proxy, as the proxy sends it after judging its app. */
const reserve = (
  holder: { readonly threadId: ThreadId; readonly control: { readonly controlId: string } },
  name: string,
  args: object,
  app?: string,
) =>
  Effect.gen(function* () {
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const request: ComputerUseCallReservation = {
      action: "reserve",
      controlId: holder.control.controlId,
      connectionId: `proxy:${holder.threadId}`,
      callId: String(calls++),
      interruptions: 0,
      idleEpoch: 0,
      name,
      args,
      ...(app === undefined ? {} : { app }),
    };
    const admission = yield* leases.callReservation(holder.threadId, request);
    // The call finished: its window ticket goes, and only the app lease stays.
    if (admission.status === "admitted" && admission.reservationId !== null)
      yield* leases.callReservation(holder.threadId, {
        action: "release",
        controlId: holder.control.controlId,
        connectionId: `proxy:${holder.threadId}`,
        reservationId: admission.reservationId,
      });
    return admission;
  });

const PIDS: Readonly<Record<string, number>> = { [TEXTEDIT]: 42, [CALCULATOR]: 43 };
const click = (holder: Parameters<typeof reserve>[0], app: string, windowId = 7) =>
  reserve(holder, "click", { pid: PIDS[app], window_id: windowId, x: 1, y: 1 }, app);

const busy = (holderThreadId: ThreadId, app: string) =>
  ({ status: "refused", detail: "app_busy", holderThreadId, app }) as const;

describe("app leases between threads (D17)", () => {
  it.effect.each([
    { label: "two full access threads", a: "full" as const },
    { label: "a granted thread and a full access thread", a: "grant" as const },
  ])("$label: A's click on an app leases it, B's is app_busy naming A, B's read runs", ({ a }) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const holder = a === "full" ? yield* fullAccess("a") : yield* granted("a", [TEXTEDIT]);
      const other = yield* fullAccess("b");
      assert.equal((yield* click(holder, TEXTEDIT)).status, "admitted");
      // Another window of the same app is still the same app.
      assert.deepInclude(yield* click(other, TEXTEDIT, 8), busy(holder.threadId, TEXTEDIT));
      // A desktop call could reach the leased app, so it waits for it too.
      assert.deepInclude(
        yield* reserve(other, "click", { x: 1, y: 1 }),
        busy(holder.threadId, TEXTEDIT),
      );
      // Reads never need a lease.
      assert.deepInclude(
        yield* reserve(other, "get_window_state", { pid: 42, window_id: 7 }, TEXTEDIT),
        { status: "admitted", reservationId: null } as const,
      );
      // The holder keeps going.
      assert.equal((yield* click(holder, TEXTEDIT)).status, "admitted");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("threads on different apps run at the same time", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const a = yield* fullAccess("parallel-a");
      const b = yield* fullAccess("parallel-b");
      assert.equal((yield* click(a, TEXTEDIT)).status, "admitted");
      assert.equal((yield* click(b, CALCULATOR, 9)).status, "admitted");
      assert.equal((yield* click(a, TEXTEDIT)).status, "admitted");
      assert.equal((yield* click(b, CALCULATOR, 9)).status, "admitted");
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each(["Stop", "Stop all", "an idle turn"] as const)(
    "%s on the holder releases its app",
    (release) =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const a = yield* fullAccess("release-a");
        const b = yield* fullAccess("release-b");
        assert.equal((yield* click(a, TEXTEDIT)).status, "admitted");
        assert.deepInclude(yield* click(b, TEXTEDIT, 8), busy(a.threadId, TEXTEDIT));
        if (release === "Stop") yield* leases.stop(a.threadId);
        else if (release === "an idle turn") assert.isTrue(yield* leases.turnEnded(a.threadId));
        else {
          yield* leases.stopAll;
          // Stop all ended B's control too; its next turn takes a new one.
          const again = Option.getOrThrow(yield* leases.everyAppControl(b.threadId, false));
          assert.equal((yield* click({ ...b, control: again }, TEXTEDIT, 8)).status, "admitted");
          return;
        }
        assert.equal((yield* click(b, TEXTEDIT, 8)).status, "admitted");
      }).pipe(Effect.provide(layer)),
  );

  it.effect("an app left alone for the idle window is released", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const a = yield* fullAccess("idle-a");
      const b = yield* fullAccess("idle-b");
      assert.equal((yield* click(a, TEXTEDIT)).status, "admitted");
      yield* TestClock.adjust(APP_LEASE_IDLE_MS - 1);
      assert.deepInclude(yield* click(b, TEXTEDIT, 8), busy(a.threadId, TEXTEDIT));
      yield* TestClock.adjust(1);
      assert.equal((yield* click(b, TEXTEDIT, 8)).status, "admitted");
      // Now B holds it.
      assert.deepInclude(yield* click(a, TEXTEDIT), busy(b.threadId, TEXTEDIT));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("the holder's control expiring releases its app", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const a = yield* fullAccess("expiry-a");
      // A keeps using the app until just before its control expires, so only expiry ends it.
      const step = APP_LEASE_IDLE_MS / 2;
      const until = DateTime.toEpochMillis(a.control.expiresAt) - step;
      while ((yield* Clock.currentTimeMillis) < until) {
        assert.equal((yield* click(a, TEXTEDIT)).status, "admitted");
        yield* TestClock.adjust(step);
      }
      assert.equal((yield* click(a, TEXTEDIT)).status, "admitted");
      const b = yield* fullAccess("expiry-b");
      assert.deepInclude(yield* click(b, TEXTEDIT, 8), busy(a.threadId, TEXTEDIT));
      yield* TestClock.adjust(step);
      assert.equal((yield* click(b, TEXTEDIT, 8)).status, "admitted");
    }).pipe(Effect.provide(layer)),
  );
  it.effect("B's refused call never reaches its driver, so app_busy is always not run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const settings = yield* ServerSettings.ServerSettingsService;
        const a = yield* fullAccess("unsent-a");
        const b = yield* fullAccess("unsent-b");
        assert.equal((yield* click(a, TEXTEDIT)).status, "admitted");
        const updates = leaseUpdates({ threadId: b.threadId, controlId: b.control.controlId }).pipe(
          Stream.provideService(ComputerUseLeases.ComputerUseLeases, leases),
          Stream.provideService(ServerSettings.ServerSettingsService, settings),
        );
        const h = yield* harness({
          controlId: b.control.controlId,
          expiresAt: DateTime.formatIso(b.control.expiresAt),
          leaseUpdates: updates,
          reservation: (request) => leases.callReservation(b.threadId, request).pipe(Effect.orDie),
        });
        yield* h.applied;
        yield* h.send(call(1, "click", { pid: 42, window_id: 8, x: 1, y: 1 }));
        // B's proxy never needed the app's id; the call still meets A's lease on its process.
        // Whichever side hears of the call first: the provider's refusal, or the driver's input.
        const first = yield* Effect.raceFirst(
          h.nextToProvider.pipe(Effect.map((line) => ({ to: "provider", line }) as const)),
          h.nextToDriver.pipe(Effect.map((line) => ({ to: "driver", line }) as const)),
        );
        assert.equal(first.to, "provider");
        const refused = first.line as { readonly result: { readonly structuredContent: object } };
        assert.deepInclude(refused.result.structuredContent, {
          detail: "app_busy",
          holderThreadId: a.threadId,
          app: TEXTEDIT,
        });
        assert.equal(yield* h.driverQueued, 0);
      }),
    ).pipe(Effect.provide(layer)),
  );
  it.effect("a call whose proxy could not name the app still meets the lease on its process", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const a = yield* fullAccess("pid-a");
      const b = yield* granted("pid-b", [TEXTEDIT]);
      // A full access proxy that never listed apps leases by pid alone.
      assert.equal(
        (yield* reserve(a, "click", { pid: 42, window_id: 7, x: 1, y: 1 })).status,
        "admitted",
      );
      assert.deepInclude(yield* click(b, TEXTEDIT, 8), {
        status: "refused",
        detail: "app_busy",
        holderThreadId: a.threadId,
      } as const);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "two threads' first calls on one app at the same moment: one leases it, one is app_busy",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const a = yield* fullAccess("race-a");
        const b = yield* fullAccess("race-b");
        const [first, second] = yield* Effect.all([click(a, TEXTEDIT), click(b, TEXTEDIT, 8)], {
          concurrency: "unbounded",
        });
        const admitted = [first, second].filter((result) => result.status === "admitted");
        assert.lengthOf(admitted, 1);
        const winner = first.status === "admitted" ? a.threadId : b.threadId;
        assert.deepInclude(first.status === "admitted" ? second : first, busy(winner, TEXTEDIT));
      }).pipe(Effect.provide(layer)),
  );

  it.effect.each(["closes its driver", "loses its lease stream"] as const)(
    "the holder's proxy that %s releases its app",
    (gone) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const leases = yield* ComputerUseLeases.ComputerUseLeases;
          const settings = yield* ServerSettings.ServerSettingsService;
          const a = yield* fullAccess(`gone-${gone.length}-a`);
          const b = yield* fullAccess(`gone-${gone.length}-b`);
          const reading = yield* Deferred.make<void>();
          const disconnect = yield* Deferred.make<void>();
          // The proxy reads its first update and stays connected until it goes away.
          const proxy =
            gone === "loses its lease stream"
              ? yield* leaseUpdates({ threadId: a.threadId, controlId: a.control.controlId }).pipe(
                  Stream.take(1),
                  Stream.runForEach(() =>
                    Deferred.succeed(reading, undefined).pipe(
                      Effect.andThen(Deferred.await(disconnect)),
                    ),
                  ),
                  Effect.provideService(ComputerUseLeases.ComputerUseLeases, leases),
                  Effect.provideService(ServerSettings.ServerSettingsService, settings),
                  Effect.forkChild,
                )
              : undefined;
          if (proxy !== undefined) yield* Deferred.await(reading);
          assert.equal((yield* click(a, TEXTEDIT)).status, "admitted");
          assert.deepInclude(yield* click(b, TEXTEDIT, 8), busy(a.threadId, TEXTEDIT));
          if (gone === "closes its driver")
            yield* leases.callReservation(a.threadId, {
              action: "close",
              controlId: a.control.controlId,
              connectionId: `proxy:${a.threadId}`,
            });
          else if (proxy !== undefined) {
            yield* Deferred.succeed(disconnect, undefined);
            yield* Fiber.join(proxy);
          }
          assert.equal((yield* click(b, TEXTEDIT, 8)).status, "admitted");
        }),
      ).pipe(Effect.provide(layer)),
  );

  it.effect("deleting the holder's thread releases its app", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const a = yield* fullAccess("deleted-a");
      const b = yield* fullAccess("deleted-b");
      assert.equal((yield* click(a, TEXTEDIT)).status, "admitted");
      assert.deepInclude(yield* click(b, TEXTEDIT, 8), busy(a.threadId, TEXTEDIT));
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${a.threadId}`;
      assert.equal((yield* click(b, TEXTEDIT, 8)).status, "admitted");
    }).pipe(Effect.provide(layer)),
  );
  it.effect("a granted thread whose proxy sent no app id still holds the app's process", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const a = yield* granted("no-app-a", [TEXTEDIT]);
      const b = yield* fullAccess("no-app-b");
      // An older proxy reserves without the app; its call is still running (ticket held).
      const held = yield* leases.callReservation(a.threadId, {
        action: "reserve",
        controlId: a.control.controlId,
        connectionId: `proxy:${a.threadId}`,
        callId: "held",
        interruptions: 0,
        idleEpoch: 0,
        name: "click",
        args: { pid: 42, window_id: 7, x: 1, y: 1 },
      });
      assert.equal(held.status, "admitted");
      assert.deepInclude(yield* click(b, TEXTEDIT, 8), {
        status: "refused",
        detail: "app_busy",
        holderThreadId: a.threadId,
      } as const);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("a stopped holder's call still running in the app keeps it until that call ends", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const a = yield* fullAccess("inflight-a");
      const b = yield* fullAccess("inflight-b");
      // A's drag is running: its ticket is held until the call answers or the driver is closed.
      const running = yield* leases.callReservation(a.threadId, {
        action: "reserve",
        controlId: a.control.controlId,
        connectionId: `proxy:${a.threadId}`,
        callId: "drag",
        interruptions: 0,
        idleEpoch: 0,
        name: "drag",
        args: { pid: 42, window_id: 7, from: [1, 1], to: [2, 2] },
        app: TEXTEDIT,
      });
      assert.equal(running.status, "admitted");
      // Stop ends A's control before its proxy has killed the driver.
      yield* leases.stop(a.threadId);
      assert.deepInclude(yield* click(b, TEXTEDIT, 8), busy(a.threadId, TEXTEDIT));
      // The proxy closes the driver, which ends the call; the app is free.
      yield* leases.callReservation(a.threadId, {
        action: "close",
        controlId: a.control.controlId,
        connectionId: `proxy:${a.threadId}`,
      });
      assert.equal((yield* click(b, TEXTEDIT, 8)).status, "admitted");
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "a call left behind by a proxy that exited without closing frees its app after the grace",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const leases = yield* ComputerUseLeases.ComputerUseLeases;
          const settings = yield* ServerSettings.ServerSettingsService;
          const a = yield* fullAccess("orphan-a");
          const b = yield* fullAccess("orphan-b");
          const reading = yield* Deferred.make<void>();
          const exit = yield* Deferred.make<void>();
          const proxy = yield* leaseUpdates({
            threadId: a.threadId,
            controlId: a.control.controlId,
          }).pipe(
            Stream.take(1),
            Stream.runForEach(() =>
              Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(exit))),
            ),
            Effect.provideService(ComputerUseLeases.ComputerUseLeases, leases),
            Effect.provideService(ServerSettings.ServerSettingsService, settings),
            Effect.forkChild,
          );
          yield* Deferred.await(reading);
          const running = yield* leases.callReservation(a.threadId, {
            action: "reserve",
            controlId: a.control.controlId,
            connectionId: `proxy:${a.threadId}`,
            callId: "drag",
            interruptions: 0,
            idleEpoch: 0,
            name: "drag",
            args: { pid: 42, window_id: 7, from: [1, 1], to: [2, 2] },
            app: TEXTEDIT,
          });
          assert.equal(running.status, "admitted");
          // A signal kills A's proxy: its driver dies with it, but it never sends close.
          yield* Deferred.succeed(exit, undefined);
          yield* Fiber.join(proxy);
          // The left-behind ticket still covers a driver that may be stopping...
          assert.deepInclude(yield* click(b, TEXTEDIT, 8), busy(a.threadId, TEXTEDIT));
          // ...for no longer than any proxy takes to cut its driver off.
          yield* TestClock.adjust(ORPHAN_CALL_GRACE_MS);
          assert.equal((yield* click(b, TEXTEDIT, 8)).status, "admitted");
        }),
      ).pipe(Effect.provide(layer)),
  );
});

describe("app lease records (D17)", () => {
  // Leases have no timer or fiber: expiry is judged when a check meets a lease. What could
  // leak is a record, so these pin that none outlives reuse, release or its control.
  const holder = ThreadId.make("thread-holder");
  const other = ThreadId.make("thread-other");
  const textEdit = { _tag: "app", pid: 42, app: TEXTEDIT } as const;

  it.effect("reuse keeps one record, and a released, ended or idle lease leaves none", () =>
    Effect.gen(function* () {
      let live = true;
      const leases = makeAppLeases({ holds: () => Effect.succeed(live) });
      leases.hold(holder, "control:1", textEdit, 0);
      leases.hold(holder, "control:1", textEdit, 1);
      leases.hold(holder, "control:2", { _tag: "app", pid: 42, app: undefined }, 2);
      assert.equal(leases.held(), 1);
      assert.deepEqual(yield* leases.busy(other, textEdit, 3), {
        holderThreadId: holder,
        app: TEXTEDIT,
      });
      leases.release(holder, "control:2");
      assert.equal(leases.held(), 0);

      leases.hold(holder, "control:3", textEdit, 10);
      live = false;
      assert.isUndefined(yield* leases.busy(other, { _tag: "every" }, 11));
      assert.equal(leases.held(), 0);

      live = true;
      leases.hold(holder, "control:4", textEdit, 20);
      assert.isUndefined(yield* leases.busy(other, textEdit, 20 + APP_LEASE_IDLE_MS));
      assert.equal(leases.held(), 0);
    }),
  );
  it.effect("a lease keeps every process its app was used in, so neither stops meeting it", () =>
    Effect.gen(function* () {
      const leases = makeAppLeases({ holds: () => Effect.succeed(true) });
      leases.hold(holder, "control:1", textEdit, 0);
      leases.hold(holder, "control:1", { _tag: "app", pid: 77, app: TEXTEDIT }, 1);
      assert.equal(leases.held(), 1);
      for (const pid of [42, 77])
        assert.deepInclude(yield* leases.busy(other, { _tag: "app", pid, app: undefined }, 2), {
          holderThreadId: holder,
        });
    }),
  );
});

describe("call admission after an app lease check (D17)", () => {
  const first = ThreadId.make("thread-first");
  const second = ThreadId.make("thread-second");
  const expiresAt = DateTime.makeUnsafe(3_600_000);
  const control = (threadId: ThreadId, controlId: string) => ({
    controlId,
    threadId,
    expiresAt,
    uses: 0,
  });
  const active = (apps?: ReadonlyArray<string>, idle?: true) =>
    ({
      _tag: "active",
      expiresAt,
      interruptions: { count: 0, last: "human_input" },
      apps,
      wakeAt: DateTime.toEpochMillis(expiresAt),
      ...(idle === undefined ? {} : { idle }),
    }) satisfies ComputerUseControlState;

  it.effect("judges the caller's authority as it is after another holder's lease was checked", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      let firstState: ComputerUseControlState = active();
      let secondState: ComputerUseControlState = active([TEXTEDIT, CALCULATOR]);
      let gated = false;
      const controls = new Map([
        [first, control(first, "control:first")],
        [second, control(second, "control:second")],
      ]);
      const reserve = makeCallReservation({
        admission: yield* Semaphore.make(1),
        controls,
        reservations: makeCallReservations(),
        changed: Effect.void,
        controlState: (threadId) =>
          threadId === first
            ? gated
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.as(firstState),
                )
              : Effect.succeed(firstState)
            : Effect.sync(() => secondState),
        blocked: () => false,
        interruptions: () => 0,
        bound: () => false,
      }).reserve;
      const call = (
        threadId: ThreadId,
        controlId: string,
        callId: string,
        pid: number,
        app: string,
      ) =>
        reserve(threadId, {
          action: "reserve",
          controlId,
          connectionId: `proxy:${threadId}`,
          callId,
          interruptions: 0,
          idleEpoch: 0,
          name: "invoke_menu",
          args: { pid, window_id: Number(callId) },
          app,
        });
      assert.equal((yield* call(first, "control:first", "1", 42, TEXTEDIT)).status, "admitted");
      // The first thread's turn went idle, so its lease no longer holds once checked.
      firstState = active(undefined, true);
      gated = true;
      const pending = yield* call(second, "control:second", "2", 42, TEXTEDIT).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      // While that check waits, a person ends the second thread's computer use.
      secondState = { _tag: "ended", reason: "revoked" };
      yield* Deferred.succeed(gate, undefined);
      assert.deepEqual(yield* Fiber.join(pending), { status: "refused", detail: "revoked" });
    }),
  );
});
