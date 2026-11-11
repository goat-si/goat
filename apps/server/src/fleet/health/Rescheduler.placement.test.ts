import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as FleetHostStates from "./FleetHostStates.ts";
import * as Rescheduler from "./Rescheduler.ts";
import { databaseFile, loseA, newWorld, request, withServer } from "./Rescheduler.testkit.ts";

const placed = <A, E>(
  world: ReturnType<typeof newWorld>,
  filename: string,
  body: Parameters<typeof withServer<A, E>>[2],
) => withServer(world, filename, body, undefined, true);

const reschedule = (overrides: Partial<Rescheduler.RescheduleRequest> = {}) =>
  Effect.flatMap(Rescheduler.Rescheduler, (service) => service.reschedule(request(overrides)));

it.effect(
  "with placement, a lost launch answer is resolved by resending its key to the same target, never by a title lookup",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = newWorld();
        world.reachable.B = true;
        const filename = yield* databaseFile;
        yield* placed(
          world,
          filename,
          Effect.gen(function* () {
            yield* loseA(world);
            world.loseNextLaunchResponse = true;
            const first = yield* reschedule({ targetHost: "B" });
            expect(first._tag).toBe("Unconfirmed");
            const second = yield* reschedule({ targetHost: "B" });
            expect(second._tag).toBe("Rescheduled");
            expect(world.launches.length).toBe(1);
            expect(world.calls.some((call) => call.tool === "goat_thread_list")).toBe(false);
          }),
        );
      }),
    ),
);

it.effect(
  "with placement, an unknown outcome stays pinned across a restart and a target change; no other host receives the work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = newWorld();
        world.reachable.B = true;
        world.reachable.C = true;
        const filename = yield* databaseFile;
        yield* placed(
          world,
          filename,
          Effect.gen(function* () {
            yield* loseA(world);
            world.loseNextLaunchResponse = true;
            expect((yield* reschedule({ targetHost: "B" }))._tag).toBe("Unconfirmed");
            world.reachable.B = false;
          }),
        );
        // A restart over the same database, now asked to move the work to C.
        yield* placed(
          world,
          filename,
          Effect.gen(function* () {
            const moved = yield* reschedule({ targetHost: "C" });
            expect(moved._tag).not.toBe("Rescheduled");
            expect(world.launches.map((launch) => launch.host)).toEqual(["B"]);
          }),
        );
      }),
    ),
);

it.effect(
  "with placement, a fenced launch frees the request: the next one may place elsewhere under a new key",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = newWorld();
        world.reachable.B = true;
        world.reachable.C = true;
        const filename = yield* databaseFile;
        yield* placed(
          world,
          filename,
          Effect.gen(function* () {
            yield* loseA(world);
            world.fenceNextPlacement = true;
            const fenced = yield* reschedule({ targetHost: "B" });
            expect(fenced._tag).toBe("Refused");
            expect(
              world.calls
                .filter((call) => call.tool === "goat_thread_organize")
                .map((call) => call.args.threadId),
            ).toEqual(["idle:B"]);
            const next = yield* reschedule({ targetHost: "C" });
            expect(next._tag).toBe("Rescheduled");
            expect(world.launches.map((launch) => launch.host)).toEqual(["C"]);
          }),
        );
      }),
    ),
);

it.effect(
  "with placement, a retry of a pinned key reaches its target even when this machine's own view would refuse that host",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = newWorld();
        world.reachable.B = true;
        const filename = yield* databaseFile;
        yield* placed(
          world,
          filename,
          Effect.gen(function* () {
            yield* loseA(world);
            world.loseNextLaunchResponse = true;
            expect((yield* reschedule({ targetHost: "B" }))._tag).toBe("Unconfirmed");
            // This machine now sees B as taking no new work; the earlier key still has to learn its outcome.
            const states = yield* FleetHostStates.FleetHostStates;
            yield* states.cordon({ host: "B", draining: false, reason: null, changedBy: null });
            const move = yield* Effect.flatMap(Rescheduler.Rescheduler, (service) =>
              service.findMove({
                clientRequestId: request().clientRequestId,
                owner: request().owner,
              }),
            );
            expect(move._tag).toBe("Unknown");
            expect((yield* reschedule({ targetHost: "B" }))._tag).toBe("Rescheduled");
            expect(world.launches.length).toBe(1);
            const found = yield* Effect.flatMap(Rescheduler.Rescheduler, (service) =>
              service.findMove({
                clientRequestId: request().clientRequestId,
                owner: request().owner,
              }),
            );
            expect(found._tag).toBe("Launched");
          }),
        );
      }),
    ),
);
