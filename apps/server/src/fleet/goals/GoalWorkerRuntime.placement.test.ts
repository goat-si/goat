import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { launchActionId } from "./goalPlan.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";
import { GoalWorkerRuntime } from "./GoalWorkerRuntime.ts";
import {
  confirmed,
  layerFor,
  makeSeen,
  ownerAccess,
  type Seen,
} from "./GoalWorkerRuntime.testkit.ts";

const far = testGoal("goal_far", {
  spec: testSpec({
    project: { host: null, projectId: null, cwd: "/repo" },
    workers: {
      ...testSpec().workers,
      runtimeMode: "full-access",
      hostSelector: { hosts: ["mac-studio"] },
    },
  }),
});
const actionId = launchActionId(far, 0, 1);

const fullOwner = () => {
  const seen = makeSeen();
  seen.workerMode = "full-access";
  return seen;
};

const launchOn = (runtime: GoalWorkerRuntime["Service"], seen: Seen) =>
  runtime.launch(
    ownerAccess("full-access"),
    {
      goal: far,
      slot: 0,
      actionId,
      host: "mac-studio",
      title: "Worker",
      message: "m",
      branch: "goal/test/s0-a1",
      modelSelection: far.spec.workers.modelSelection,
    },
    confirmed(seen),
  );

describe("goal workers under placement admission", () => {
  it.effect(
    "a remote worker launch carries its action's placement key; after a lost answer the lookup resends that key, never a title search",
    () => {
      const seen = fullOwner();
      return Effect.gen(function* () {
        const runtime = yield* GoalWorkerRuntime;
        seen.loseLaunchAnswer = true;
        const lost = yield* launchOn(runtime, seen).pipe(Effect.flip);
        expect(lost._tag).toBe("RemoteLaunchUnconfirmed");
        expect(seen.remoteLaunches[0]?.placement).toMatchObject({
          ownerKey: "goal:goal_far:" + actionId,
          attempt: 0,
        });
        // A thread whose title carries the marker would satisfy a title search; it must not decide.
        seen.remoteThreads.unshift({ threadId: "thread:impostor", title: "Worker " + actionId });
        const found = yield* runtime.findLaunched(
          ownerAccess("full-access"),
          far,
          actionId,
          "mac-studio",
        );
        expect(found).toMatchObject({ host: "mac-studio", threadId: "thread:remote-1" });
        expect(seen.remoteLaunches).toHaveLength(1);
      }).pipe(Effect.provide(layerFor(seen, { placement: true })));
    },
  );

  it.effect(
    "a fenced remote launch is a definite failure, and its idle thread is archived on that host",
    () => {
      const seen = fullOwner();
      return Effect.gen(function* () {
        const runtime = yield* GoalWorkerRuntime;
        seen.fenceNextPlacement = true;
        const failure = yield* launchOn(runtime, seen).pipe(Effect.flip);
        expect(failure).toMatchObject({ code: "capacity_exceeded", mayHaveStarted: false });
        expect(
          seen.remote.map((call) => [call.tool, call.args.threadId, call.args.action]),
        ).toEqual([["goat_thread_organize", "thread:idle", "archive"]]);
        // Nothing was ever sent for this lookup's key beyond the fenced one: it reads as absent.
        expect(
          yield* runtime.findLaunched(ownerAccess("full-access"), far, actionId, "mac-studio"),
        ).toBeNull();
      }).pipe(Effect.provide(layerFor(seen, { placement: true })));
    },
  );

  it.effect("with admission off, a remote worker launch sends no placement", () => {
    const seen = fullOwner();
    return Effect.gen(function* () {
      yield* launchOn(yield* GoalWorkerRuntime, seen);
      expect(seen.remoteLaunches[0]).not.toHaveProperty("placement");
    }).pipe(Effect.provide(layerFor(seen)));
  });
});
