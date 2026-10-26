/**
 * Draining a host moves its goal attempts that are idle between runs to another host (#1130),
 * across the controller, its store and the real Rescheduler, over one database file that a
 * "restart" reopens. The worker runtime is scripted; the hosts answer through a fake dispatch.
 */
import { describe, expect, it } from "@effect/vitest";
import { BUILTIN_PERMISSION_PROFILES, FleetGoalId, RunId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { GoalController } from "./GoalController.ts";
import {
  access,
  type Fake,
  failedRun,
  insert,
  layerFor,
  makeFake,
  pass,
  record,
  running,
  withWorkers,
} from "./GoalController.testkit.ts";
import {
  databaseFile,
  goalWith,
  moveOutcome,
  newWorld,
  server,
  turnsOf,
  type World,
} from "./GoalController.moves.testkit.ts";
import { LAUNCH_GRACE_MS } from "./goalPlan.ts";
import { GoalStore } from "./GoalStore.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";
import type { WorkerReading } from "./GoalWorkerRuntime.ts";

const CEILING = BUILTIN_PERMISSION_PROFILES["worker"]!;

const finished = (runId: string): WorkerReading => ({
  kind: "seen",
  terminal: true,
  runId: RunId.make(runId),
  runStatus: "completed",
  lastActivityAt: null,
  result: { reported: false, pullRequest: null },
});

/** The goal's workers started, and each finished its run on run:5 without reporting yet. */
const startIdle = (world: World, fake: Fake, id: string) =>
  Effect.gen(function* () {
    yield* pass(id);
    const ours = (threadId: string) => threadId.startsWith("thread:worker-");
    fake.reading = (threadId) => (ours(threadId) ? finished("run:5") : running(threadId, fake));
    world.health = (threadId) =>
      ours(threadId) ? { _tag: "healthy", idle: true } : { _tag: "healthy" };
    world.sourceRun = "completed";
    world.localRun = "completed";
  });

const pairWith = (id: string) =>
  testGoal(id, {
    spec: testSpec({
      project: { host: null, projectId: null, cwd: "/repo" },
      workers: { ...testSpec().workers, count: 2, hostSelector: { hosts: ["A", "B"] } },
      limits: { ...testSpec().limits, maxWorkers: 2 },
    }),
  });

const condition = (id: string, type: string) =>
  record(id).pipe(
    Effect.map((found) => found.goal.status.conditions.find((entry) => entry.type === type)),
  );

const rescheduleClaims = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM fleet_reschedule_claims`,
  ),
  Effect.map((rows) => rows[0]?.n ?? 0),
);

type Server = ReturnType<typeof server>;
type Provided = Server extends import("effect/Layer").Layer<infer A, infer _E, infer _R>
  ? A
  : never;

/** One test over a fresh database file; each run is a server process over that file. */
const scenario = (
  body: (input: {
    readonly world: World;
    readonly fake: Fake;
    readonly run: <A, E>(effect: Effect.Effect<A, E, Provided>) => Effect.Effect<A>;
  }) => Effect.Effect<void>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = newWorld();
      const fake = makeFake();
      const path = yield* databaseFile;
      yield* body({
        world,
        fake,
        run: (effect) => effect.pipe(Effect.provide(server(fake, world, path)), Effect.orDie),
      });
    }),
  );

describe("draining a host moves its idle goal attempts (#1130)", () => {
  it.effect("moves an idle attempt off a drained SSH host under the goal's ceiling, once", () =>
    scenario(({ world, fake, run }) =>
      run(
        Effect.gen(function* () {
          const id = "goal_drain_ssh";
          yield* insert(goalWith(id));
          yield* startIdle(world, fake, id);
          fake.owners = [access("auto-accept-edits")];
          fake.moveCeiling = CEILING;
          world.draining.add("A");
          yield* pass(id);
          expect(world.launches).toHaveLength(1);
          expect(world.launches[0]).toMatchObject({
            host: "B",
            runtimeMode: "auto-accept-edits",
            permissionProfileCeiling: CEILING,
            workspace: { type: "worktree", branch: "goal/test/s0-a2", baseRef: "goal/test/s0-a1" },
          });
          expect((yield* record(id)).workers[0]).toMatchObject({
            attempt: 2,
            host: "B",
            state: "running",
          });
          yield* pass(id);
          yield* pass(id);
          expect(world.launches).toHaveLength(1);
          expect(fake.interrupts).toEqual([]);
          expect(fake.followUps).toEqual([]);
        }),
      ),
    ),
  );

  it.effect(
    "moves an idle attempt off this machine when it drains, and leaves the earlier one alone after a restart",
    () =>
      scenario(({ world, fake, run }) =>
        Effect.gen(function* () {
          const id = "goal_drain_local";
          fake.project = { cwd: "/srv/goat", canonicalKey: null };
          yield* run(
            Effect.gen(function* () {
              yield* insert(
                testGoal(id, {
                  spec: testSpec({
                    workers: { ...testSpec().workers, hostSelector: { hosts: [null, "A", "B"] } },
                  }),
                }),
              );
              yield* startIdle(world, fake, id);
              expect(fake.launches.map((launch) => launch.host)).toEqual([null]);
              world.draining.add(null);
              // The attempt's branch was never pushed, so the destination starts from the base.
              world.unpublished.add("goal/test/s0-a1");
              yield* pass(id);
              expect(world.launches).toHaveLength(1);
              expect(world.launches[0]).toMatchObject({
                host: "A",
                cwd: "/srv/goat",
                workspace: { type: "worktree", branch: "goal/test/s0-a2", baseRef: "dev" },
              });
              expect(world.launches[0]?.message).toContain("this machine");
              expect((yield* record(id)).workers[0]).toMatchObject({ attempt: 2, host: "A" });
            }),
          );
          yield* run(
            Effect.gen(function* () {
              yield* pass(id);
              yield* pass(id);
              expect(fake.launches).toHaveLength(1);
              expect(world.launches).toHaveLength(1);
              expect(fake.interrupts).toEqual([]);
              expect((yield* record(id)).workers[0]).toMatchObject({ attempt: 2, host: "A" });
            }),
          );
        }),
      ),
  );

  it.effect(
    "leaves an attempt that started running before its move was sent, without interrupting it",
    () =>
      scenario(({ world, fake, run }) =>
        run(
          Effect.gen(function* () {
            const id = "goal_drain_active";
            yield* insert(goalWith(id));
            yield* startIdle(world, fake, id);
            // Observed idle, but its host already reports a new run.
            world.sourceRun = "running";
            world.draining.add("A");
            yield* pass(id);
            expect(world.launchCalls).toBe(0);
            expect(world.sourceRun).toBe("running");
            expect(yield* moveOutcome(id)).toBe("not_sent");
            expect((yield* record(id)).workers[0]).toMatchObject({ attempt: 1, host: "A" });
            expect((yield* condition(id, "Degraded"))?.status).toBe("False");
          }),
        ),
      ),
  );

  it.effect(
    "starts nothing once the host is uncordoned before the launch, and goes back to work there",
    () =>
      scenario(({ world, fake, run }) =>
        run(
          Effect.gen(function* () {
            const id = "goal_drain_uncordon";
            yield* insert(goalWith(id));
            yield* startIdle(world, fake, id);
            world.draining.add("A");
            // Uncordoned after the pass observed the drain and the move passed its first check.
            world.onStatus = () => void world.draining.delete("A");
            yield* pass(id);
            expect(world.launchCalls).toBe(0);
            expect(yield* moveOutcome(id)).toBe("not_sent");
            expect(yield* rescheduleClaims).toBe(0);
            world.onStatus = null;
            yield* pass(id);
            expect(world.launchCalls).toBe(0);
            expect(fake.followUps).toHaveLength(1);
          }),
        ),
      ),
  );

  it.effect("starts nothing when the host is uncordoned while the source is read last", () =>
    scenario(({ world, fake, run }) =>
      run(
        Effect.gen(function* () {
          const id = "goal_drain_uncordon_probe";
          yield* insert(goalWith(id));
          yield* startIdle(world, fake, id);
          world.draining.add("A");
          let reads = 0;
          // The second status read is the one right before the launch.
          world.onStatus = () => {
            reads += 1;
            if (reads === 2) world.draining.delete("A");
          };
          yield* pass(id);
          expect(reads).toBe(2);
          expect(world.launchCalls).toBe(0);
          expect(yield* rescheduleClaims).toBe(0);
          expect(yield* moveOutcome(id)).toBe("not_sent");
        }),
      ),
    ),
  );

  it.effect("writes nothing when the owner's authority is lost while the source is read last", () =>
    scenario(({ world, fake, run }) =>
      run(
        Effect.gen(function* () {
          const id = "goal_drain_revoked_probe";
          yield* insert(goalWith(id));
          yield* startIdle(world, fake, id);
          world.draining.add("A");
          let reads = 0;
          // The second status read is the one right before the launch.
          world.onStatus = () => {
            reads += 1;
            if (reads === 2) fake.owners = [{ unavailable: "The session was revoked." }];
          };
          yield* pass(id);
          expect(reads).toBe(2);
          expect(world.launchCalls).toBe(0);
          expect(yield* rescheduleClaims).toBe(0);
          expect(yield* moveOutcome(id)).toBe("not_sent");
        }),
      ),
    ),
  );

  it.effect(
    "keeps a move that may have started after an uncordon, and adopts it without another launch",
    () =>
      scenario(({ world, fake, run }) =>
        run(
          Effect.gen(function* () {
            const id = "goal_drain_uncordon_started";
            yield* insert(goalWith(id));
            yield* startIdle(world, fake, id);
            world.draining.add("A");
            world.loseNextLaunchAnswer = true;
            yield* pass(id);
            expect(world.launches).toHaveLength(1);
            world.draining.delete("A");
            world.reachable.B = false;
            for (let round = 0; round < 2; round += 1) {
              yield* TestClock.adjust(LAUNCH_GRACE_MS + 60_000);
              yield* pass(id);
            }
            expect((yield* record(id)).workers[0]).toMatchObject({ attempt: 1, host: "A" });
            world.reachable.B = true;
            yield* pass(id);
            expect((yield* record(id)).workers[0]).toMatchObject({ attempt: 2, host: "B" });
            expect(world.launches).toHaveLength(1);
            expect(fake.followUps).toEqual([]);
          }),
        ),
      ),
  );

  it.effect(
    "moves one slot at a time: an unconfirmed move holds the other slot across passes, a restart and the launch grace",
    () =>
      scenario(({ world, fake, run }) =>
        Effect.gen(function* () {
          const id = "goal_drain_pair";
          yield* run(
            Effect.gen(function* () {
              yield* insert(pairWith(id));
              yield* startIdle(world, fake, id);
              expect(fake.launches.map((launch) => launch.host)).toEqual(["A", "A"]);
              world.draining.add("A");
              world.loseNextLaunchAnswer = true;
              yield* pass(id);
              expect(world.launches).toHaveLength(1);
              world.reachable.B = false;
              for (let round = 0; round < 3; round += 1) {
                yield* TestClock.adjust(LAUNCH_GRACE_MS + 60_000);
                yield* pass(id);
              }
              expect(world.launchCalls).toBe(1);
              expect((yield* record(id)).workers[1]).toMatchObject({
                attempt: 1,
                host: "A",
                note: expect.stringMatching(/move/),
              });
            }),
          );
          yield* run(
            Effect.gen(function* () {
              yield* pass(id);
              expect(world.launchCalls).toBe(1);
              // Slot 1's run fails meanwhile: its move waits too, without a claim.
              fake.reading = (threadId: string) =>
                threadId === "thread:worker-2" ? failedRun("run:7") : finished("run:5");
              world.health = (threadId: string) =>
                threadId === "thread:worker-2"
                  ? { _tag: "failed", failureClass: "unknown", runId: RunId.make("run:7") }
                  : { _tag: "healthy", idle: true };
              // Its host reports that run too (slot 0's move only looks its successor up).
              world.sourceRun = "failed";
              world.sourceRunId = "run:7";
              yield* pass(id);
              const store = yield* GoalStore;
              expect(yield* store.claimOf("goal:" + id + ":s1:a1:run:7:reschedule")).toBeNull();
              expect(world.launchCalls).toBe(1);
              world.reachable.B = true;
              yield* pass(id);
              yield* pass(id);
              const workers = (yield* record(id)).workers;
              expect(workers.slice(0, 2)).toMatchObject([
                { attempt: 2, host: "B" },
                { attempt: 2, host: "B" },
              ]);
              expect(world.launches).toHaveLength(2);
            }),
          );
        }),
      ),
  );

  it.effect(
    "adopts a drain move that took the last turn and lost its answer, after a restart",
    () =>
      scenario(({ world, fake, run }) =>
        Effect.gen(function* () {
          const id = "goal_drain_last_turn";
          yield* run(
            Effect.gen(function* () {
              yield* insert(goalWith(id, { maxTurns: 2 }));
              yield* startIdle(world, fake, id);
              world.draining.add("A");
              world.loseNextLaunchAnswer = true;
              yield* pass(id);
              expect(yield* turnsOf(id)).toBe(2);
            }),
          );
          yield* run(
            Effect.gen(function* () {
              yield* pass(id);
              expect((yield* record(id)).workers[0]).toMatchObject({ attempt: 2, host: "B" });
              expect(yield* turnsOf(id)).toBe(2);
              expect(world.launches).toHaveLength(1);
            }),
          );
        }),
      ),
  );

  it.effect(
    "stays with a visible reason and backs off while no host can take it, then moves exactly once",
    () =>
      scenario(({ world, fake, run }) =>
        run(
          Effect.gen(function* () {
            const id = "goal_drain_capacity";
            yield* insert(goalWith(id));
            yield* startIdle(world, fake, id);
            world.draining.add("A");
            world.reachable.B = false;
            const gaps: Array<number> = [];
            for (let round = 0; round < 3; round += 1) {
              yield* pass(id);
              const status = (yield* record(id)).goal.status;
              gaps.push(
                Date.parse(status.nextReconcileAt ?? "") - Date.parse(status.lastReconcileAt ?? ""),
              );
              yield* TestClock.adjust(60 * 60_000);
            }
            expect(gaps[0]! < gaps[1]! && gaps[1]! < gaps[2]!).toBe(true);
            expect(yield* condition(id, "Degraded")).toMatchObject({
              status: "True",
              reason: "RescheduleRefused",
              message: expect.stringMatching(/No host can take the work/),
            });
            expect(world.launchCalls).toBe(0);
            expect(yield* turnsOf(id)).toBe(2);
            expect(fake.followUps).toEqual([]);
            world.reachable.B = true;
            yield* pass(id);
            yield* pass(id);
            expect(world.launches.map((launch) => launch.host)).toEqual(["B"]);
            expect(yield* turnsOf(id)).toBe(2);
          }),
        ),
      ),
  );

  it.effect("writes nothing for a goal changed or deleted after the pass read it", () =>
    scenario(({ world, fake, run }) =>
      run(
        Effect.gen(function* () {
          const id = "goal_drain_changed";
          yield* insert(goalWith(id));
          yield* startIdle(world, fake, id);
          world.draining.add("A");
          const store = yield* GoalStore;
          const controller = yield* GoalController;
          const stale = yield* record(id);
          yield* store.updateSpec(
            { ...stale.goal, generation: stale.goal.generation + 1 },
            stale.goal.generation,
          );
          yield* controller.reconcile(stale, 10);
          const fresh = yield* record(id);
          yield* store.requestDeletion(FleetGoalId.make(id), "2026-10-25T00:00:00.000Z");
          yield* controller.reconcile(fresh, 10);
          expect(world.launchCalls).toBe(0);
          expect(yield* rescheduleClaims).toBe(0);
        }),
      ),
    ),
  );

  it.effect("writes nothing when the owner's authority is gone once the move is claimed", () =>
    scenario(({ world, fake, run }) =>
      run(
        Effect.gen(function* () {
          const id = "goal_drain_owner";
          yield* insert(goalWith(id));
          yield* startIdle(world, fake, id);
          world.draining.add("A");
          fake.owners = [access(), access(), { unavailable: "The session was revoked." }];
          yield* pass(id);
          expect(world.launchCalls).toBe(0);
          expect(yield* moveOutcome(id)).toBe("not_sent");
          expect(yield* condition(id, "Blocked")).toMatchObject({ reason: "OwnerAuthorityLost" });
        }),
      ),
    ),
  );

  it.effect(
    "asks a person, and never asks the destination again, when it cannot hold the goal's ceiling",
    () =>
      scenario(({ world, fake, run }) =>
        run(
          Effect.gen(function* () {
            const id = "goal_drain_ceiling";
            yield* insert(goalWith(id));
            yield* startIdle(world, fake, id);
            fake.moveCeiling = CEILING;
            world.draining.add("A");
            world.refuseNextLaunchCode = "permission_profile_unsupported";
            yield* pass(id);
            expect(yield* moveOutcome(id)).toBe("refused");
            for (let round = 0; round < 3; round += 1) {
              yield* TestClock.adjust(60 * 60_000);
              yield* pass(id);
            }
            expect(world.launchCalls).toBe(1);
            expect(world.launches).toEqual([]);
            expect(fake.followUps).toEqual([]);
            expect((yield* record(id)).workers[0]).toMatchObject({
              attempt: 1,
              state: "needs_human",
              note: expect.stringMatching(/cannot move/),
            });
          }),
        ),
      ),
  );

  it.effect("leaves work on a host that is only cordoned", () =>
    scenario(({ world, fake, run }) =>
      run(
        Effect.gen(function* () {
          const id = "goal_drain_cordon";
          yield* insert(goalWith(id));
          yield* startIdle(world, fake, id);
          world.cordoned.add("A");
          yield* pass(id);
          expect(world.launchCalls).toBe(0);
          expect(fake.followUps).toHaveLength(1);
        }),
      ),
    ),
  );
});

describe("one move in flight per goal (#1130)", () => {
  it.effect(
    "refuses another slot's fresh, unsent or refused move while one is unsettled, and admits it after",
    () =>
      Effect.gen(function* () {
        const store = yield* GoalStore;
        const id = "goal_admit";
        yield* insert(withWorkers(id, 2));
        const goalId = FleetGoalId.make(id);
        const at = "2026-10-20T01:00:00.000Z";
        const claim = (actionId: string, slot = 1) =>
          store.claim({
            goalId,
            generation: 1,
            actionId,
            kind: "launch",
            host: "A",
            slot,
            nowIso: at,
          });
        const move = (slot: number, run: string) =>
          "goal:" + id + ":s" + slot + ":a1:" + run + ":reschedule";
        // Slot 1 had a move refused and another never sent, before slot 0's move started.
        expect(yield* claim(move(1, "run:7"))).toBeNull();
        yield* store.settle(move(1, "run:7"), "refused", at);
        expect(yield* claim(move(1, "run:8"))).toBeNull();
        yield* store.settle(move(1, "run:8"), "not_sent", at);
        expect(yield* claim(move(0, "run:5"), 0)).toBeNull();
        expect(yield* claim(move(1, "run:7"))).toBe("move_in_flight");
        expect(yield* claim(move(1, "run:8"))).toBe("move_in_flight");
        expect(yield* claim(move(1, "run:9"))).toBe("move_in_flight");
        // The move's own receipt and other actions are unaffected.
        expect(yield* claim(move(0, "run:5"), 0)).toBe("already_claimed");
        expect(yield* claim("goal:" + id + ":s1:a1:run:9:followup")).toBeNull();
        yield* store.settle(move(0, "run:5"), "rescheduled", at);
        expect(yield* claim(move(1, "run:9"))).toBeNull();
      }).pipe(Effect.provide(layerFor(makeFake()))),
  );
});
