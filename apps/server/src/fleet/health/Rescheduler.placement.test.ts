import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

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

it.effect(
  "with placement, a launch delivered but not recorded keeps its claim: it reads unknown, never not launched, and the resend settles it",
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
            const sql = yield* SqlClient.SqlClient;
            yield* sql`
            CREATE TRIGGER fail_started BEFORE UPDATE ON placement_attempts
            WHEN NEW.state = 'started' BEGIN SELECT RAISE(ABORT, 'injected record failure'); END
          `;
            expect((yield* reschedule({ targetHost: "B" }))._tag).toBe("Unconfirmed");
            expect(world.launches.length).toBe(1);
            const move = yield* Effect.flatMap(Rescheduler.Rescheduler, (service) =>
              service.findMove({
                clientRequestId: request().clientRequestId,
                owner: request().owner,
              }),
            );
            expect(move._tag).toBe("Unknown");
            yield* sql`DROP TRIGGER fail_started`;
            expect((yield* reschedule({ targetHost: "B" }))._tag).toBe("Rescheduled");
            expect(world.launches.length).toBe(1);
          }),
        );
      }),
    ),
);

it.effect(
  "with placement, a move whose attempt history is gone reads unknown, never a thread found by its title",
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
            // B now lists a thread with the move's title; the attempt that would identify it is gone.
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DELETE FROM placement_attempts`;
            const move = yield* Effect.flatMap(Rescheduler.Rescheduler, (service) =>
              service.findMove({
                clientRequestId: request().clientRequestId,
                owner: request().owner,
              }),
            );
            expect(move._tag).toBe("Unknown");
            expect(world.calls.some((call) => call.tool === "goat_thread_list")).toBe(false);
            expect((yield* reschedule({ targetHost: "B" }))._tag).not.toBe("Rescheduled");
            expect(world.launches.length).toBe(1);
          }),
        );
      }),
    ),
);

it.effect(
  "with placement, a pinned retry obeys the current allowlist: a removed target receives nothing and the attempt stays unknown",
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
            const sent = world.launches.length;
            const calls = world.calls.length;
            // The owner's profile no longer allows B.
            const refused = yield* reschedule({ targetHost: null, allowedHosts: ["C"] });
            expect(refused._tag).toBe("Refused");
            expect(world.launches.length).toBe(sent);
            expect(world.calls.length).toBe(calls);
            // B allowed again: the same key goes back and its outcome is read, nothing new starts.
            expect((yield* reschedule({ targetHost: null, allowedHosts: ["B"] }))._tag).toBe(
              "Rescheduled",
            );
            expect(world.launches.length).toBe(sent);
          }),
        );
      }),
    ),
);
