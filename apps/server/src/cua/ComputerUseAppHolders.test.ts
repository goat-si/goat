import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ComputerUseCallReservation, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import { APP_LEASE_IDLE_MS } from "./ComputerUseAppLeases.ts";
import { makeCallReservations, ORPHAN_CALL_GRACE_MS } from "./ComputerUseCallReservations.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { database } from "./ComputerUseLeases.projection.testkit.ts";

const TEXTEDIT = "com.apple.TextEdit";
const CALCULATOR = "com.apple.calculator";
type Reserve = Extract<ComputerUseCallReservation, { action: "reserve" }>;

describe("ticket holders", () => {
  it("lists each other thread's window ticket, skips desktop-wide ones, and starts no grace", () => {
    const reservations = makeCallReservations();
    const a = ThreadId.make("thread-a");
    const b = ThreadId.make("thread-b");
    let calls = 0;
    const request = (owner: ThreadId, args: object, app?: string): Reserve => ({
      action: "reserve",
      controlId: `control:${owner}`,
      connectionId: `driver:${owner}`,
      callId: String(calls++),
      interruptions: 0,
      idleEpoch: 0,
      name: "click",
      args,
      ...(app === undefined ? {} : { app }),
    });
    reservations.reserve(a, request(a, { pid: 42, window_id: 7 }, TEXTEDIT));
    reservations.reserve(a, request(a, { pid: 43, window_id: 9 }));
    reservations.reserve(a, request(a, { x: 1, y: 1 }));
    expect(reservations.ticketHolders(b, 0)).toEqual([
      { holderThreadId: a, pids: [42], app: TEXTEDIT },
      { holderThreadId: a, pids: [43] },
    ]);
    expect(reservations.ticketHolders(a, 0)).toEqual([]);
    // Admission starts the grace of a ticket whose control cannot act; the lookup never does.
    const probe = request(b, { pid: 42, window_id: 8 }, TEXTEDIT);
    expect(reservations.appTicket(b, probe, () => false, 5_000)?.holderThreadId).toBe(a);
    const pids = (now: number) => reservations.ticketHolders(b, now).map((each) => each.pids[0]);
    expect(pids(5_000 + ORPHAN_CALL_GRACE_MS - 1)).toEqual([42, 43]);
    expect(pids(5_000 + ORPHAN_CALL_GRACE_MS)).toEqual([43]);
  });
});

const layer = ComputerUseLeases.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      database,
      NodeServices.layer,
      ServerSettings.ServerSettingsService.layerTest({ enableCua: true }),
    ),
  ),
);

const fullAccess = Effect.fn("appHolders.fullAccess")(function* (name: string) {
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

let calls = 0;
const PIDS: Readonly<Record<string, number>> = { [TEXTEDIT]: 42, [CALCULATOR]: 43 };
/** A click from the thread's proxy; done releases its ticket, as an answered call does. */
const click = (
  holder: { readonly threadId: ThreadId; readonly control: { readonly controlId: string } },
  app: string,
  windowId = 7,
  done = true,
) =>
  Effect.gen(function* () {
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const connection = {
      controlId: holder.control.controlId,
      connectionId: `proxy:${holder.threadId}`,
    };
    const admission = yield* leases.callReservation(holder.threadId, {
      action: "reserve",
      ...connection,
      callId: String(calls++),
      interruptions: 0,
      idleEpoch: 0,
      name: "click",
      args: { pid: PIDS[app], window_id: windowId, x: 1, y: 1 },
      app,
    });
    if (done && admission.status === "admitted" && admission.reservationId !== null)
      yield* leases.callReservation(holder.threadId, {
        action: "release",
        ...connection,
        reservationId: admission.reservationId,
      });
    return admission;
  });
const holders = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    assert.isDefined(leases.appHolders);
    return yield* leases.appHolders!(threadId);
  });

describe("app holders on the lease service", () => {
  it.effect(
    "another thread's leases are listed per app, the caller's own never, until they idle out",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const a = yield* fullAccess("holders-a");
        const b = yield* fullAccess("holders-b");
        assert.equal((yield* click(a, TEXTEDIT)).status, "admitted");
        assert.equal((yield* click(a, CALCULATOR, 9)).status, "admitted");
        expect(yield* holders(b.threadId)).toEqual(
          expect.arrayContaining([
            { holderThreadId: a.threadId, pids: [42], app: TEXTEDIT },
            { holderThreadId: a.threadId, pids: [43], app: CALCULATOR },
          ]),
        );
        expect(yield* holders(a.threadId)).toEqual([]);
        yield* TestClock.adjust(APP_LEASE_IDLE_MS);
        expect(yield* holders(b.threadId)).toEqual([]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("a stopped holder's running call is listed until it ends", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const a = yield* fullAccess("running-a");
      const b = yield* fullAccess("running-b");
      assert.equal((yield* click(a, TEXTEDIT, 7, false)).status, "admitted");
      yield* leases.stop(a.threadId);
      expect(yield* holders(b.threadId)).toEqual([
        { holderThreadId: a.threadId, pids: [42], app: TEXTEDIT },
      ]);
      yield* leases.callReservation(a.threadId, {
        action: "close",
        controlId: a.control.controlId,
        connectionId: `proxy:${a.threadId}`,
      });
      expect(yield* holders(b.threadId)).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "an idle holder held for a person is still listed while admission refuses its app",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const a = yield* fullAccess("person-a");
        const b = yield* fullAccess("person-b");
        assert.equal((yield* click(a, TEXTEDIT)).status, "admitted");
        yield* leases.hold(a.control.controlId, true);
        yield* leases.turnEnded(a.threadId);
        assert.deepInclude(yield* click(b, TEXTEDIT, 8), {
          status: "refused",
          detail: "app_busy",
          holderThreadId: a.threadId,
        });
        expect((yield* holders(b.threadId)).map((each) => each.holderThreadId)).toContain(
          a.threadId,
        );
      }).pipe(Effect.provide(layer)),
  );
});
