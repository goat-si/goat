import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentAuthorizationError, FleetGoalId, RunId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";

import { OWNER_REFUSED } from "./GoalAuthority.ts";
import { LAUNCH_GRACE_MS } from "./goalPlan.ts";
import { GoalStore, NOT_SENT } from "./GoalStore.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";
import { type OwnerAccess } from "./GoalWorkerRuntime.ts";
import {
  access,
  makeFake,
  layerFor,
  withWorkers,
  insert,
  record,
  pass,
  setCount,
} from "./GoalController.testkit.ts";

describe("GoalController acts only with its owner's authority when a command goes out (#493)", () => {
  describe("acts only with the authority its owner holds when the command goes out (#493)", () => {
    const blocked = (id: string) =>
      record(id).pipe(
        Effect.map(({ goal }) => goal.status.conditions.find((c) => c.type === "Blocked")),
      );

    it.effect("stops a worker only if its owner can still act after the interrupt's claim", () => {
      const fake = makeFake();
      return Effect.gen(function* () {
        const store = yield* GoalStore;
        yield* insert(withWorkers("goal_stop", 1));
        yield* pass("goal_stop");
        yield* setCount("goal_stop", 0);
        // Live when the pass looks and plans, gone once the interrupt is claimed.
        fake.owners = [access(), access(), { unavailable: "The session was revoked." }, access()];
        yield* pass("goal_stop");
        expect(fake.interrupts).toEqual([]);
        const actionId = "goal:goal_stop:s0:a1:run:1:interrupt";
        expect(yield* store.claimOf(actionId)).toMatchObject({ outcome: NOT_SENT });
        expect(yield* blocked("goal_stop")).toMatchObject({
          status: "True",
          reason: "OwnerAuthorityLost",
          message: "The session was revoked.",
        });
        // Once the owner can act again, the same interrupt goes out.
        yield* pass("goal_stop");
        expect(fake.interrupts).toEqual(["thread:worker-1"]);
      }).pipe(Effect.provide(layerFor(fake)));
    });

    it.effect(
      "sends nothing when the owner's mode drops below the plan right before the send",
      () => {
        const fake = makeFake();
        return Effect.gen(function* () {
          const store = yield* GoalStore;
          // Full access through the claim; the last confirm finds the owner narrowed.
          fake.owners = [access(), access(), access(), access("auto-accept-edits")];
          yield* insert(withWorkers("goal_narrowed", 1));
          yield* pass("goal_narrowed");
          expect(fake.launches).toEqual([]);
          const [claim] = yield* store.launches(FleetGoalId.make("goal_narrowed"));
          expect(claim).toMatchObject({ outcome: NOT_SENT });
          expect(yield* blocked("goal_narrowed")).toMatchObject({ reason: "OwnerAuthorityLost" });
          // The next pass plans at the owner's mode as it is now and launches at that.
          yield* pass("goal_narrowed");
          expect(fake.launches.map((launch) => launch.mode)).toEqual(["auto-accept-edits"]);
        }).pipe(Effect.provide(layerFor(fake)));
      },
    );

    it.effect("sends nothing when the session is revoked after the owner was read", () => {
      const fake = makeFake();
      return Effect.gen(function* () {
        const store = yield* GoalStore;
        // The owner read succeeds, then its session's live grant is gone by the final check.
        const revokedSince: OwnerAccess = {
          ...access(),
          scope: {
            reauthorize: () =>
              Effect.fail(
                new EnvironmentAuthorizationError({
                  message: "The MCP session is no longer active.",
                  requiredScope: "orchestration:operate",
                }),
              ),
          } as unknown as OwnerAccess["scope"],
        };
        fake.owners = [access(), access(), access(), revokedSince, access()];
        yield* insert(withWorkers("goal_revoked_late", 1));
        yield* pass("goal_revoked_late");
        expect(fake.launches).toEqual([]);
        const [claim] = yield* store.launches(FleetGoalId.make("goal_revoked_late"));
        expect(claim).toMatchObject({ outcome: NOT_SENT });
        expect(yield* blocked("goal_revoked_late")).toMatchObject({ reason: "OwnerAuthorityLost" });
      }).pipe(Effect.provide(layerFor(fake)));
    });

    it.effect("sends nothing when the goal changes right before the send, and replans", () => {
      const fake = makeFake();
      return Effect.gen(function* () {
        const store = yield* GoalStore;
        yield* insert(withWorkers("goal_moved", 1));
        // An apply lowers the ceiling (a new generation) after the claim, before the send.
        fake.beforeConfirm = Effect.gen(function* () {
          const { goal } = yield* record("goal_moved");
          yield* store.updateSpec(
            {
              ...goal,
              owner: { ...goal.owner, runtimeModeCeiling: "auto-accept-edits" },
              generation: goal.generation + 1,
            },
            goal.generation,
          );
        }).pipe(Effect.provideService(GoalStore, store), Effect.orDie);
        yield* pass("goal_moved");
        expect(fake.launches).toEqual([]);
        const [claim] = yield* store.launches(FleetGoalId.make("goal_moved"));
        expect(claim).toMatchObject({ outcome: NOT_SENT });
        // A changed goal is replanned, not blocked.
        expect(yield* blocked("goal_moved")).not.toMatchObject({ status: "True" });

        // A follow-up whose goal is paused right before the send is not sent either.
        yield* pass("goal_moved");
        expect(fake.launches).toHaveLength(1);
        fake.reading = () => ({
          kind: "seen",
          terminal: true,
          runId: RunId.make("run:9"),
          runStatus: "completed",
          lastActivityAt: null,
          result: { reported: false, pullRequest: null },
        });
        fake.beforeConfirm = Effect.gen(function* () {
          const { goal } = yield* record("goal_moved");
          yield* store.updateSpec(
            { ...goal, spec: { ...goal.spec, paused: true }, generation: goal.generation + 1 },
            goal.generation,
          );
        }).pipe(Effect.provideService(GoalStore, store), Effect.orDie);
        yield* pass("goal_moved");
        expect(fake.followUps).toEqual([]);
      }).pipe(Effect.provide(layerFor(fake)));
    });

    it.effect(
      "ends an attempt whose thread was created but whose first message was refused",
      () => {
        const fake = makeFake();
        return Effect.gen(function* () {
          const store = yield* GoalStore;
          yield* insert(withWorkers("goal_half", 1));
          fake.loseAfterCreate = true;
          yield* pass("goal_half");
          const [claim] = yield* store.launches(FleetGoalId.make("goal_half"));
          expect(claim).toMatchObject({ outcome: OWNER_REFUSED });
          expect(yield* blocked("goal_half")).toMatchObject({ reason: "OwnerAuthorityLost" });
          // The next pass moves the slot on rather than adopt the empty thread, and the one after
          // starts attempt 2, never attempt 1 again.
          yield* pass("goal_half");
          expect((yield* record("goal_half")).workers[0]).toMatchObject({
            attempt: 2,
            threadId: null,
          });
          yield* pass("goal_half");
          expect(fake.launches.map((launch) => launch.actionId)).toEqual([
            "goal:goal_half:s0:a1:launch",
            "goal:goal_half:s0:a2:launch",
          ]);
        }).pipe(Effect.provide(layerFor(fake)));
      },
    );

    it.effect.each([false, true])(
      "never adopts that empty thread when the goal moved on and its status was lost (lookup fails: %s)",
      (lookupFails) => {
        const fake = makeFake();
        return Effect.gen(function* () {
          const store = yield* GoalStore;
          yield* insert(withWorkers("goal_half_moved", 1));
          // The thread exists, then an apply moves the goal on, so the first message is refused and
          // this pass's status write is refused too.
          fake.loseAfterCreate = "goalChanged";
          fake.duringLaunch = Effect.gen(function* () {
            const { goal } = yield* record("goal_half_moved");
            yield* store.updateSpec(
              { ...goal, title: "Renamed", generation: goal.generation + 1 },
              goal.generation,
            );
          }).pipe(Effect.provideService(GoalStore, store), Effect.orDie);
          // The thread lookup right after the refusal may fail too.
          fake.lookupFails = lookupFails;
          yield* pass("goal_half_moved");
          fake.lookupFails = false;
          yield* pass("goal_half_moved");
          yield* pass("goal_half_moved");
          const workers = (yield* record("goal_half_moved")).workers;
          expect(workers.find((worker) => worker.threadId === "thread:worker-1")).toBeUndefined();
          expect(fake.launches.map((launch) => launch.actionId)).toEqual([
            "goal:goal_half_moved:s0:a1:launch",
            "goal:goal_half_moved:s0:a2:launch",
          ]);
        }).pipe(Effect.provide(layerFor(fake)));
      },
    );
  });

  it.effect(
    "sends the same attempt again, across a restart, when a launch was refused before its thread existed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = (yield* fs.makeTempDirectoryScoped()) + "/state.sqlite";
        const fake = makeFake();
        // Live through the claim; the last confirm finds the owner gone, and the lookup after fails.
        fake.owners = [access(), access(), access(), { unavailable: "Revoked." }, access()];
        fake.lookupFails = true;
        const onlyAttempt = testGoal("goal_refused", {
          spec: testSpec({ limits: { ...testSpec().limits, maxAttemptsPerWorker: 1 } }),
        });
        yield* Effect.gen(function* () {
          yield* insert(onlyAttempt);
          yield* pass("goal_refused");
          const [claim] = yield* (yield* GoalStore).launches(onlyAttempt.id);
          expect(claim).toMatchObject({ outcome: OWNER_REFUSED });
        }).pipe(Effect.provide(layerFor(fake, { path })));
        fake.lookupFails = false;
        yield* Effect.gen(function* () {
          // Even past the launch grace, a refusal that started nothing spends no attempt.
          yield* TestClock.adjust(LAUNCH_GRACE_MS + 1);
          yield* pass("goal_refused");
          yield* pass("goal_refused");
          expect(fake.launches.map((launch) => launch.actionId)).toEqual([
            "goal:goal_refused:s0:a1:launch",
          ]);
          expect((yield* record("goal_refused")).goal.status.phase).not.toBe("failed");
        }).pipe(Effect.provide(layerFor(fake, { path })));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["deleted", "dropped"] as const)(
    "finishes a slot that is %s after a launch was refused before its thread existed",
    (change) => {
      const fake = makeFake();
      return Effect.gen(function* () {
        const store = yield* GoalStore;
        fake.owners = [access(), access(), access(), { unavailable: "Revoked." }, access()];
        fake.lookupFails = true;
        yield* insert(withWorkers("goal_refused_gone", 1));
        yield* pass("goal_refused_gone");
        fake.lookupFails = false;
        if (change === "deleted")
          yield* store.requestDeletion(
            FleetGoalId.make("goal_refused_gone"),
            "2026-10-20T00:00:00.000Z",
          );
        else yield* setCount("goal_refused_gone", 0);
        const id = FleetGoalId.make("goal_refused_gone");
        for (let i = 0; i < 4 && (yield* store.get(id)) !== null; i++) yield* pass(id);
        expect(fake.launches).toEqual([]);
        if (change === "deleted")
          expect(yield* store.get(FleetGoalId.make("goal_refused_gone"))).toBeNull();
        else
          expect((yield* record("goal_refused_gone")).workers[0]).toMatchObject({
            state: "superseded",
          });
      }).pipe(Effect.provide(layerFor(fake)));
    },
  );
});
