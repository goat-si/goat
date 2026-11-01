/**
 * Moves of a goal's worker to another host across the controller, its store and the Rescheduler,
 * over one database file that a "restart" reopens (#1451). The worker runtime is scripted; the
 * hosts answer through a fake SshRemoteDispatch the Rescheduler calls.
 */
import { describe, expect, it } from "@effect/vitest";
import { FleetGoalId, RunId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import {
  access,
  failedRun,
  insert,
  makeFake,
  pass,
  record,
  setCount,
} from "./GoalController.testkit.ts";
import {
  databaseFile,
  goalWith,
  moveOutcome,
  newWorld,
  server,
  stall,
  stallThenStop,
  startThenFail,
  turnsOf,
} from "./GoalController.moves.testkit.ts";
import { LAUNCH_GRACE_MS } from "./goalPlan.ts";
import { GoalStore } from "./GoalStore.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";

describe("goal moves across a restart (#1451)", () => {
  it.effect(
    "adopts a move that took the last turn and lost its answer, after a restart, without another turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_last_turn";
          yield* Effect.gen(function* () {
            yield* insert(goalWith(id, { maxTurns: 2 }));
            yield* startThenFail(world, fake, id);
            world.loseNextLaunchAnswer = true;
            yield* pass(id);
            expect(world.launches.map((launch) => launch.host)).toEqual(["B"]);
            expect(yield* moveOutcome(id)).toBe("none");
            expect(yield* turnsOf(id)).toBe(2);
            const held = (yield* record(id)).goal.status;
            expect(held.conditions.find((c) => c.type === "Degraded")).toMatchObject({
              reason: "MoveUnconfirmed",
            });
          }).pipe(Effect.provide(server(fake, world, path)));
          // A new process: the budget is spent, but finding the started move is not new work.
          yield* Effect.gen(function* () {
            yield* pass(id);
            expect(yield* moveOutcome(id)).toBe("rescheduled");
            expect((yield* record(id)).workers[0]).toMatchObject({
              attempt: 2,
              host: "B",
              threadId: "thread:B-1",
              state: "running",
            });
            expect(yield* turnsOf(id)).toBe(2);
            expect(world.launches).toHaveLength(1);
          }).pipe(Effect.provide(server(fake, world, path)));
        }),
      ),
  );

  it.effect(
    "keeps the slot while the destination cannot be checked, past the launch grace, then adopts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_dark";
          yield* Effect.gen(function* () {
            yield* insert(goalWith(id));
            yield* startThenFail(world, fake, id);
            world.loseNextLaunchAnswer = true;
            yield* pass(id);
            world.reachable.B = false;
            for (let round = 0; round < 3; round += 1) {
              yield* TestClock.adjust(LAUNCH_GRACE_MS + 60_000);
              yield* pass(id);
            }
            // Nothing else started for the slot, and the wait is visible.
            expect(world.launches).toHaveLength(1);
            expect(fake.launches).toHaveLength(1);
            const waiting = yield* record(id);
            expect(waiting.workers[0]).toMatchObject({ attempt: 1 });
            expect(waiting.goal.status.conditions.find((c) => c.type === "Degraded")).toMatchObject(
              {
                status: "True",
                reason: "MoveUnconfirmed",
              },
            );
          }).pipe(Effect.provide(server(fake, world, path)));
          world.reachable.B = true;
          yield* Effect.gen(function* () {
            yield* pass(id);
            expect((yield* record(id)).workers[0]).toMatchObject({ attempt: 2, host: "B" });
            expect(world.launches).toHaveLength(1);
          }).pipe(Effect.provide(server(fake, world, path)));
        }),
      ),
  );

  it.effect(
    "adopts a launched successor as the next attempt after the attempt cap was lowered",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_cap_lowered";
          yield* Effect.gen(function* () {
            yield* insert(goalWith(id));
            yield* startThenFail(world, fake, id);
            world.loseNextLaunchAnswer = true;
            yield* pass(id);
            const store = yield* GoalStore;
            const { goal } = yield* record(id);
            yield* store.updateSpec(
              {
                ...goal,
                spec: {
                  ...goal.spec,
                  limits: { ...goal.spec.limits, maxAttemptsPerWorker: 1 },
                },
                generation: goal.generation + 1,
              },
              goal.generation,
            );
            yield* pass(id);
            expect((yield* record(id)).workers[0]).toMatchObject({
              attempt: 2,
              host: "B",
              threadId: "thread:B-1",
              launchClientRequestId: "goal:" + id + ":s0:a2:launch",
            });
            expect(world.launches).toHaveLength(1);
          }).pipe(Effect.provide(server(fake, world, path)));
        }),
      ),
  );

  it.effect(
    "keeps a confirmed successor through more restarts, passes and a lost status write, launching nothing again",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_settled";
          yield* Effect.gen(function* () {
            yield* insert(goalWith(id));
            yield* startThenFail(world, fake, id);
            yield* pass(id);
            expect((yield* record(id)).workers[0]).toMatchObject({ attempt: 2, host: "B" });
            // The status write after the move is lost: the slot row still names attempt 1.
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE fleet_goal_workers SET attempt = 1, host = 'A', thread_id = 'thread:worker-1', launch_client_request_id = ${"goal:" + id + ":s0:a1:launch"} WHERE goal_id = ${id}`;
          }).pipe(Effect.provide(server(fake, world, path)));
          for (let restart = 0; restart < 2; restart += 1)
            yield* Effect.gen(function* () {
              for (let round = 0; round < 3; round += 1) yield* pass(id);
              const slot = (yield* record(id)).workers.find((worker) => worker.slot === 0);
              expect(slot).toMatchObject({ attempt: 2, host: "B", threadId: "thread:B-1" });
            }).pipe(Effect.provide(server(fake, world, path)));
          expect(world.launches).toHaveLength(1);
          expect(fake.launches).toHaveLength(1);
        }),
      ),
  );

  it.effect(
    "frees the slot after a refusal that proves nothing started, and moves on the next pass",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_refused";
          yield* Effect.gen(function* () {
            yield* insert(goalWith(id));
            yield* startThenFail(world, fake, id);
            world.refuseNextLaunch = true;
            yield* pass(id);
            expect(world.launches).toEqual([]);
            expect(yield* moveOutcome(id)).toBe("not_sent");
            yield* TestClock.adjust(60 * 60_000);
            yield* pass(id);
            expect(world.launches.map((launch) => launch.host)).toEqual(["B"]);
            expect((yield* record(id)).workers[0]).toMatchObject({ attempt: 2, host: "B" });
          }).pipe(Effect.provide(server(fake, world, path)));
        }),
      ),
  );

  it.effect(
    "adopts the last legal attempt's move after a restart, while new work stays blocked",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_boundary";
          yield* Effect.gen(function* () {
            yield* insert(goalWith(id, { maxAttemptsPerWorker: 2, maxTurns: 2 }));
            yield* startThenFail(world, fake, id);
            world.loseNextLaunchAnswer = true;
            yield* pass(id);
          }).pipe(Effect.provide(server(fake, world, path)));
          yield* Effect.gen(function* () {
            yield* pass(id);
            expect((yield* record(id)).workers[0]).toMatchObject({ attempt: 2, host: "B" });
            // The successor fails too: no attempt and no turn is left, so nothing more starts.
            fake.reading = () => failedRun("run:9");
            world.health = () => ({
              _tag: "failed",
              failureClass: "unknown",
              runId: "run:9" as never,
            });
            for (let round = 0; round < 3; round += 1) {
              yield* TestClock.adjust(60 * 60_000);
              yield* pass(id);
            }
            expect(world.launches).toHaveLength(1);
            expect(fake.launches).toHaveLength(1);
            expect(yield* turnsOf(id)).toBe(2);
          }).pipe(Effect.provide(server(fake, world, path)));
        }),
      ),
  );

  it.effect(
    "continues a move that had to interrupt a stalled worker, instead of asking a person",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_stalled";
          yield* Effect.gen(function* () {
            yield* insert(goalWith(id));
            yield* stallThenStop(world, fake, id);
            yield* pass(id);
            expect(world.launches.map((launch) => launch.host)).toEqual(["B"]);
            expect((yield* record(id)).workers[0]).toMatchObject({
              attempt: 2,
              host: "B",
              state: "running",
            });
          }).pipe(Effect.provide(server(fake, world, path)));
        }),
      ),
  );

  it.effect(
    "still starts a stopped worker's successor when the move took the goal's last turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_stalled_budget";
          yield* Effect.gen(function* () {
            // The launch, the steer and the move take all three turns.
            yield* insert(goalWith(id, { maxTurns: 3 }));
            yield* stallThenStop(world, fake, id);
            expect(yield* turnsOf(id)).toBe(3);
            yield* pass(id);
            expect(world.launches.map((launch) => launch.host)).toEqual(["B"]);
            expect((yield* record(id)).workers[0]).toMatchObject({ attempt: 2, host: "B" });
            expect(yield* turnsOf(id)).toBe(3);
          }).pipe(Effect.provide(server(fake, world, path)));
        }),
      ),
  );

  it.effect(
    "keeps a stopped worker's move after a capacity refusal and a restart, without asking a person",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_stalled_capacity";
          yield* Effect.gen(function* () {
            yield* insert(goalWith(id));
            yield* stallThenStop(world, fake, id);
            world.reachable.B = false;
            for (let round = 0; round < 2; round += 1) {
              yield* TestClock.adjust(60 * 60_000);
              yield* pass(id);
            }
            expect(world.launches).toEqual([]);
            expect((yield* record(id)).workers[0]?.state).not.toBe("needs_human");
          }).pipe(Effect.provide(server(fake, world, path)));
          world.reachable.B = true;
          yield* Effect.gen(function* () {
            yield* pass(id);
            expect(world.launches.map((launch) => launch.host)).toEqual(["B"]);
            expect((yield* record(id)).workers[0]).toMatchObject({
              attempt: 2,
              host: "B",
              state: "running",
            });
          }).pipe(Effect.provide(server(fake, world, path)));
        }),
      ),
  );

  it.effect(
    "does not delete a goal while its stopped worker's successor may be running, then stops it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_stalled_delete";
          yield* Effect.gen(function* () {
            yield* insert(goalWith(id));
            yield* stallThenStop(world, fake, id);
            // The successor starts on B, but its answer is lost and B then goes dark.
            world.loseNextLaunchAnswer = true;
            yield* pass(id);
            expect(world.launches.map((launch) => launch.host)).toEqual(["B"]);
            world.reachable.B = false;
            const store = yield* GoalStore;
            yield* store.requestDeletion(FleetGoalId.make(id), "2026-10-25T00:00:00.000Z");
            for (let round = 0; round < 3; round += 1) {
              yield* TestClock.adjust(LAUNCH_GRACE_MS + 60_000);
              yield* pass(id);
            }
            expect(yield* store.get(FleetGoalId.make(id))).not.toBeNull();
            expect(world.launches).toHaveLength(1);
          }).pipe(Effect.provide(server(fake, world, path)));
          world.reachable.B = true;
          yield* Effect.gen(function* () {
            yield* pass(id);
            yield* pass(id);
            expect(fake.interrupts).toContain("thread:B-1");
            expect(world.launches).toHaveLength(1);
          }).pipe(Effect.provide(server(fake, world, path)));
        }),
      ),
  );

  it.effect(
    "calls off a stopped worker's move once a person resumes its run, and leaves that run alone",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_stalled_resumed";
          yield* Effect.gen(function* () {
            yield* insert(goalWith(id));
            yield* stallThenStop(world, fake, id);
            world.sourceRunId = "run:6";
            world.sourceRun = "running";
            world.health = () => ({ _tag: "healthy" });
            for (let round = 0; round < 3; round += 1) yield* pass(id);
            expect(world.sourceRun).toBe("running");
            expect(world.launches).toEqual([]);
            expect(yield* moveOutcome(id)).toBe("not_sent");
            expect((yield* record(id)).workers[0]).toMatchObject({
              attempt: 1,
              host: "A",
              state: "running",
            });
          }).pipe(Effect.provide(server(fake, world, path)));
        }),
      ),
  );

  it.effect(
    "goes on with a move whose interrupt lost its answer, after a restart, without asking a person",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_stalled_lost_stop";
          yield* Effect.gen(function* () {
            yield* insert(goalWith(id));
            world.loseNextInterruptAnswer = true;
            yield* stallThenStop(world, fake, id);
          }).pipe(Effect.provide(server(fake, world, path)));
          yield* Effect.gen(function* () {
            yield* pass(id);
            expect(world.launches.map((launch) => launch.host)).toEqual(["B"]);
            expect((yield* record(id)).workers[0]).toMatchObject({
              attempt: 2,
              host: "B",
              state: "running",
            });
          }).pipe(Effect.provide(server(fake, world, path)));
        }),
      ),
  );

  it.effect("calls off a stopped worker's move when the goal no longer wants its slot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = newWorld();
        const fake = makeFake();
        const path = yield* databaseFile;
        const id = "goal_stalled_shrunk";
        yield* Effect.gen(function* () {
          yield* insert(goalWith(id));
          yield* stallThenStop(world, fake, id);
          world.reachable.B = false;
          yield* pass(id);
          yield* setCount(id, 0);
          world.reachable.B = true;
          for (let round = 0; round < 3; round += 1) yield* pass(id);
          expect(world.launches).toEqual([]);
          expect(yield* moveOutcome(id)).toBe("not_sent");
        }).pipe(Effect.provide(server(fake, world, path)));
      }),
    ),
  );

  it.effect(
    "never sends a remote follow-up again after a restart, when the earlier process may have sent it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_remote_follow";
          const followUpId = "goal:" + id + ":s0:a1:run:9:followup";
          yield* Effect.gen(function* () {
            yield* insert(goalWith(id));
            yield* pass(id);
            expect((yield* record(id)).workers[0]).toMatchObject({ host: "A" });
            fake.reading = () => ({
              kind: "seen",
              terminal: true,
              runId: RunId.make("run:9"),
              runStatus: "completed",
              lastActivityAt: null,
              result: { reported: false, pullRequest: null },
            });
            // The process stops between the claim and the follow-up's settlement.
            fake.crashFollowUp = true;
            yield* pass(id).pipe(Effect.exit);
          }).pipe(Effect.provide(server(fake, world, path)));
          // A new process reaches A under a new session, which cannot dedupe a resend. Its owner
          // drops out between the action's own check and the check after its claim, then
          // returns: still nothing is resent.
          fake.owners = [access(), access(), { unavailable: "plan mode" }, access()];
          yield* Effect.gen(function* () {
            yield* pass(id);
            yield* pass(id);
            yield* pass(id);
            expect(fake.followUps).toEqual([]);
            const store = yield* GoalStore;
            expect((yield* store.claimOf(followUpId))?.outcome).toBe("uncertain");
            expect((yield* record(id)).workers[0]).toMatchObject({
              followedUpRunId: "run:9",
            });
          }).pipe(Effect.provide(server(fake, world, path)));
        }),
      ),
  );

  it.effect(
    "restores a sent steer whose slot write was lost, then moves the stalled worker without steering again",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_steer_lost";
          yield* Effect.gen(function* () {
            yield* insert(goalWith(id));
            yield* pass(id);
            stall(world, fake);
            yield* pass(id);
            expect(fake.followUps).toHaveLength(1);
            // The steer's receipt settled, but the slot's status write after it was lost.
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE fleet_goal_workers SET detail_json = json_set(detail_json, '$.steeredRunId', NULL, '$.followedUpRunId', NULL, '$.followUps', 0) WHERE goal_id = ${id}`;
            expect((yield* record(id)).workers[0]).toMatchObject({ steeredRunId: null });
            yield* pass(id);
            yield* pass(id);
            expect(fake.followUps).toHaveLength(1);
            expect(world.sourceRun).toBe("interrupted");
          }).pipe(Effect.provide(server(fake, world, path)));
        }),
      ),
  );

  it.effect("moves a projectId-only goal's worker to its project's folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = newWorld();
        const fake = makeFake();
        fake.project = { cwd: "/projects/goat", canonicalKey: null };
        const path = yield* databaseFile;
        const id = "goal_project";
        yield* Effect.gen(function* () {
          yield* insert(
            testGoal(id, {
              spec: testSpec({
                workers: { ...testSpec().workers, hostSelector: { hosts: ["A", "B"] } },
              }),
            }),
          );
          yield* startThenFail(world, fake, id);
          yield* pass(id);
          expect(world.launches.map((launch) => launch.cwd)).toEqual(["/projects/goat"]);
        }).pipe(Effect.provide(server(fake, world, path)));
      }),
    ),
  );

  it.effect(
    "leaves a worker whose host stopped answering observable, and moves it once that host is Lost",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const fake = makeFake();
          const path = yield* databaseFile;
          const id = "goal_lost_host";
          yield* Effect.gen(function* () {
            yield* insert(goalWith(id));
            yield* pass(id);
            world.reachable.A = false;
            fake.reading = () => ({ kind: "unknown", message: "A did not answer" });
            world.health = () => ({ _tag: "host_lost", host: "A" }) as never;
            // Not Lost yet: the move waits, launching nothing, and the slot says why.
            for (let round = 0; round < 2; round += 1) {
              yield* TestClock.adjust(60 * 60_000);
              yield* pass(id);
            }
            expect(world.launches).toEqual([]);
            expect((yield* record(id)).workers[0]).toMatchObject({ attempt: 1, host: "A" });
            world.lost.add("A");
            yield* TestClock.adjust(60 * 60_000);
            yield* pass(id);
            yield* TestClock.adjust(60 * 60_000);
            yield* pass(id);
            expect(world.launches.map((launch) => launch.host)).toEqual(["B"]);
            expect((yield* record(id)).workers[0]).toMatchObject({ attempt: 2, host: "B" });
          }).pipe(Effect.provide(server(fake, world, path)));
        }),
      ),
  );
});
