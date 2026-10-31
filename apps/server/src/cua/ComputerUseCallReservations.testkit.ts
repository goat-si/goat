/** The lease service on an in-memory database, for the call reservation tests. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import { batchAppScope } from "./ComputerUseBatchScope.ts";
import { leaseUpdates } from "./ComputerUseLeaseRoute.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";

export const database = NodeSqliteClient.layer({ filename: ":memory:" });
export const serviceLayer = ComputerUseLeases.layer.pipe(
  Layer.provide(Layer.merge(database, NodeServices.layer)),
);
export const fixture = Effect.fn("reservations.fixture")(function* () {
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
  ) => {
    const batch = batchAppScope(name, args);
    return leases.callReservation(owner, {
      action: "reserve",
      controlId: owner === a ? first.controlId : second.controlId,
      connectionId,
      callId: String(sequence++),
      interruptions,
      idleEpoch: 0,
      name,
      args,
      ...(batch === undefined ? {} : { safetyApps: batch.apps }),
      ...(foregroundGrantId === undefined ? {} : { foregroundGrantId }),
    });
  };
  const release = (
    owner: typeof a,
    reservationId: string,
    connectionId = "driver:1",
    outcome: { readonly completed?: true; readonly notSent?: true } = {},
  ) =>
    leases.callReservation(owner, {
      action: "release",
      controlId: owner === a ? first.controlId : second.controlId,
      connectionId,
      reservationId,
      ...outcome,
    });
  const close = (owner = a, connectionId = "driver:1") =>
    leases.callReservation(owner, {
      action: "close",
      controlId: owner === a ? first.controlId : second.controlId,
      connectionId,
    });
  return { leases, a, b, first, second, reserve, release, close };
});

export const openProxy = Effect.fn("reservations.openProxy")(function* (
  threadId: ThreadId,
  controlId: string,
) {
  const reading = yield* Deferred.make<void>();
  const exit = yield* Deferred.make<void>();
  const proxy = yield* leaseUpdates({ threadId, controlId }).pipe(
    Stream.take(1),
    Stream.runForEach(() =>
      Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(exit))),
    ),
    Effect.provide(ServerSettings.ServerSettingsService.layerTest({ enableCua: true })),
    Effect.forkChild,
  );
  yield* Deferred.await(reading);
  return Deferred.succeed(exit, undefined).pipe(Effect.andThen(Fiber.join(proxy)));
});
