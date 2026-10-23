import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  FleetGoalId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { HubDown, type HubDownShape, type PausedGoalWork } from "../../hub/HubDown.ts";
import { type HubWork, UNAFFECTED } from "../../hub/hubDownPolicy.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as FleetDefaults from "../defaults.ts";
import { Health, type ThreadHealth } from "../health/Health.ts";
import { Fallback } from "../resources/Fallback.ts";
import { Placement } from "../resources/Placement.ts";
import { GoalController, layer as controllerLayer } from "./GoalController.ts";
import { LAUNCH_GRACE_MS, type PullRequestObservation } from "./goalPlan.ts";
import { GoalStore, layer as goalStoreLayer, NOT_SENT } from "./GoalStore.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";
import {
  GoalWorkerRuntime,
  type LaunchRequest,
  type OwnerAccess,
  type WorkerReading,
} from "./GoalWorkerRuntime.ts";

interface Fake {
  readonly launches: Array<LaunchRequest & { readonly mode: string }>;
  readonly followUps: Array<{ readonly actionId: string; readonly message: string }>;
  readonly interrupts: Array<string>;
  /** Threads that exist, by launch action id. */
  readonly threads: Map<string, ThreadId>;
  /** Threads whose run ended. */
  readonly ended: Set<string>;
  crashAfterStart: boolean;
  failAfterStart: boolean;
  crashFollowUp: boolean;
  lookupFails: boolean;
  /** Owner answers, one per call; the last repeats. */
  owners: Array<OwnerAccess | { readonly unavailable: string }>;
  /** Runs once, inside the next launch, after the thread exists. */
  duringLaunch: Effect.Effect<void> | null;
  reading: (threadId: string) => WorkerReading;
  pullRequest: PullRequestObservation;
}

const access = (runtimeMode: OwnerAccess["runtimeMode"] = "full-access"): OwnerAccess => ({
  scope: {} as OwnerAccess["scope"],
  runtimeMode,
  canReachHosts: runtimeMode === "full-access",
});

const running = (threadId: string, fake: Fake): WorkerReading =>
  fake.ended.has(threadId)
    ? {
        kind: "seen",
        terminal: true,
        runId: RunId.make("run:1"),
        runStatus: "interrupted",
        lastActivityAt: null,
        result: null,
      }
    : {
        kind: "seen",
        terminal: false,
        runId: RunId.make("run:1"),
        runStatus: "running",
        lastActivityAt: null,
        result: null,
      };

const makeFake = (): Fake => {
  const fake: Fake = {
    launches: [],
    followUps: [],
    interrupts: [],
    threads: new Map(),
    ended: new Set(),
    crashAfterStart: false,
    failAfterStart: false,
    crashFollowUp: false,
    lookupFails: false,
    owners: [access()],
    duringLaunch: null,
    reading: (threadId) => running(threadId, fake),
    pullRequest: { kind: "seen", state: "open", checks: "pending" },
  };
  return fake;
};

const runtimeFor = (fake: Fake) =>
  Layer.succeed(GoalWorkerRuntime, {
    owner: () =>
      Effect.sync(() => (fake.owners.length > 1 ? fake.owners.shift()! : fake.owners[0]!)),
    observeWorker: (_access, _goal, worker) => Effect.sync(() => fake.reading(worker.threadId!)),
    observePullRequest: () => Effect.sync(() => fake.pullRequest),
    observeIssue: () => Effect.succeed("open" as const),
    findLaunched: (_access, _goal, actionId) =>
      fake.lookupFails
        ? Effect.fail(new OrchestratorMcpFailure({ code: "orchestration_error", message: "busy" }))
        : Effect.sync(() => {
            const threadId = fake.threads.get(actionId);
            return threadId === undefined ? null : { host: null, threadId, runId: null };
          }),
    launch: (current, request) =>
      Effect.gen(function* () {
        fake.launches.push({ ...request, mode: current.runtimeMode });
        const threadId = ThreadId.make("thread:worker-" + fake.launches.length);
        fake.threads.set(request.actionId, threadId);
        if (fake.duringLaunch !== null) {
          const run = fake.duringLaunch;
          fake.duringLaunch = null;
          yield* run;
        }
        if (fake.crashAfterStart) {
          fake.crashAfterStart = false;
          return yield* Effect.die("server stopped mid-launch");
        }
        if (fake.failAfterStart) {
          fake.failAfterStart = false;
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "lost reply",
          });
        }
        return { host: null, threadId, runId: RunId.make("run:1") };
      }),
    followUp: (_access, _goal, _worker, message, actionId) =>
      Effect.suspend(() => {
        if (fake.crashFollowUp) {
          fake.crashFollowUp = false;
          return Effect.die("server stopped before the send");
        }
        fake.followUps.push({ actionId, message });
        return Effect.void;
      }),
    interrupt: (_access, worker) =>
      Effect.sync(() => {
        fake.interrupts.push(worker.threadId!);
        fake.ended.add(worker.threadId!);
      }),
  });

/** This machine only, like the design's first release; SSH hosts are refused. */
/** This machine only, like the design's first release, unless a test asks it to place remotely. */
const placementFor = (placeRemote: boolean) =>
  Layer.succeed(Placement, {
    place: (request) =>
      Effect.succeed(
        placeRemote
          ? {
              _tag: "Placed" as const,
              host: "mac-studio",
              modelSelection: request.modelSelection,
              reason: undefined,
            }
          : (request.hostSelector.hosts ?? [null]).includes(null)
            ? {
                _tag: "Placed" as const,
                host: null,
                modelSelection: request.modelSelection,
                reason: undefined,
              }
            : {
                _tag: "Refused" as const,
                reasons: (request.hostSelector.hosts ?? []).map((host) => ({
                  host,
                  reason: {
                    code: "placement_unavailable" as const,
                    message: "placement_unavailable",
                  },
                })),
              },
      ),
    status: Effect.die("unused"),
    statusOf: () => Effect.die("unused"),
  });

const noFallback = Layer.succeed(Fallback, {
  next: () => Effect.succeed({ _tag: "Exhausted" as const, reason: "No chain." }),
  reportFailure: () => Effect.void,
  cooldowns: Effect.succeed([]),
  coversThreads: Effect.succeed(false),
  continueThread: () => Effect.succeed(false),
});

let healthOf = (): ThreadHealth => ({ _tag: "healthy" });
const healthy = Layer.succeed(Health, {
  hostCondition: (host) => Effect.succeed({ host, conditions: [], observedAt: "" }),
  threadHealth: () => Effect.sync(() => healthOf()),
});

const persistence = (path: string | undefined) =>
  path === undefined
    ? SqlitePersistence.layerMemory
    : SqlitePersistence.layerFromPath(path).pipe(Layer.provide(NodeServices.layer));

const layerFor = (
  fake: Fake,
  options: {
    readonly enabled?: boolean;
    readonly path?: string;
    readonly placeRemote?: boolean;
    readonly hubDown?: HubDownShape;
  } = {},
) =>
  controllerLayer.pipe(
    Layer.provide(
      options.hubDown === undefined ? Layer.empty : Layer.succeed(HubDown, options.hubDown),
    ),
    Layer.provideMerge(goalStoreLayer),
    Layer.provideMerge(persistence(options.path)),
    Layer.provide(runtimeFor(fake)),
    Layer.provide(
      Layer.mergeAll(
        placementFor(options.placeRemote === true),
        FleetDefaults.layerRescheduler,
        noFallback,
        healthy,
      ),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        fleet: { controllerEnabled: options.enabled ?? true },
      }),
    ),
  );

const withWorkers = (id: string, count: number, overrides: Parameters<typeof testSpec>[0] = {}) =>
  testGoal(id, {
    spec: testSpec({
      ...overrides,
      workers: { ...testSpec().workers, count },
      limits: { ...testSpec().limits, maxWorkers: Math.max(count, 1) },
    }),
  });

const insert = (goal: ReturnType<typeof testGoal>) =>
  GoalStore.pipe(Effect.flatMap((store) => store.create(goal, "thread:thread:owner", null)));

const record = (id: string) =>
  GoalStore.pipe(
    Effect.flatMap((store) => store.get(FleetGoalId.make(id))),
    Effect.map((found) => found!),
  );

const pass = (id: string) =>
  Effect.gen(function* () {
    const controller = yield* GoalController;
    return yield* controller.reconcile(yield* record(id), 10);
  });

const setCount = (id: string, count: number) =>
  Effect.gen(function* () {
    const store = yield* GoalStore;
    const { goal } = yield* record(id);
    yield* store.updateSpec(
      {
        ...goal,
        spec: { ...goal.spec, workers: { ...goal.spec.workers, count } },
        generation: goal.generation + 1,
      },
      goal.generation,
    );
  });

describe("GoalController", () => {
  it.effect("does nothing while fleet.controllerEnabled is off", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      yield* insert(withWorkers("goal_off", 2));
      yield* (yield* GoalController).runDue;
      expect(fake.launches).toEqual([]);
    }).pipe(Effect.provide(layerFor(fake, { enabled: false })));
  });

  it.effect(
    "launches each slot once, claimed first, and a second tick launches nothing new",
    () => {
      const fake = makeFake();
      return Effect.gen(function* () {
        const store = yield* GoalStore;
        yield* insert(withWorkers("goal_two", 2));
        yield* (yield* GoalController).runDue;
        yield* pass("goal_two");
        expect(fake.launches.map((launch) => launch.actionId)).toEqual([
          "goal:goal_two:s0:a1:launch",
          "goal:goal_two:s1:a1:launch",
        ]);
        expect(fake.launches[0]).toMatchObject({
          branch: "goal/test/s0-a1",
          host: null,
          title: "Test goal · s0 a1",
        });
        expect((yield* store.launches(FleetGoalId.make("goal_two")))[0]).toMatchObject({
          outcome: "launched",
          threadId: "thread:worker-1",
        });
        expect((yield* record("goal_two")).workers.map((worker) => worker.threadId)).toEqual([
          "thread:worker-1",
          "thread:worker-2",
        ]);
      }).pipe(Effect.provide(layerFor(fake)));
    },
  );

  it.effect("launches with the owner's authority as it is after the claim (P1-1)", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const store = yield* GoalStore;
      // Full access when the pass starts, lowered by the time the launch is claimed.
      fake.owners = [access(), access(), access("auto-accept-edits")];
      yield* insert(withWorkers("goal_lowered", 1));
      yield* pass("goal_lowered");
      expect(fake.launches.map((launch) => launch.mode)).toEqual(["auto-accept-edits"]);
      // Gone after the claim: nothing is sent, the claim stays retakable, the goal is blocked.
      fake.owners = [
        access(),
        access(),
        { unavailable: "The owner thread is in plan mode." },
        access(),
      ];
      yield* insert(withWorkers("goal_planmode", 1));
      yield* pass("goal_planmode");
      expect(fake.launches).toHaveLength(1);
      const [claim] = yield* store.launches(FleetGoalId.make("goal_planmode"));
      expect(claim).toMatchObject({ outcome: NOT_SENT });
      expect(
        (yield* record("goal_planmode")).goal.status.conditions.find((c) => c.type === "Blocked"),
      ).toMatchObject({
        status: "True",
        reason: "OwnerAuthorityLost",
      });
      yield* pass("goal_planmode");
      expect(fake.launches.map((launch) => launch.actionId)).toContain(
        "goal:goal_planmode:s0:a1:launch",
      );
    }).pipe(Effect.provide(layerFor(fake)));
  });

  it.effect(
    "keeps a launched worker when a spec change drops the pass's status, and stops it (P1-3)",
    () => {
      const fake = makeFake();
      return Effect.gen(function* () {
        yield* insert(withWorkers("goal_race", 1));
        const store = yield* GoalStore;
        fake.duringLaunch = setCount("goal_race", 0).pipe(
          Effect.provideService(GoalStore, store),
          Effect.orDie,
        );
        yield* pass("goal_race");
        const lost = yield* record("goal_race");
        // The pass's status was refused by the generation check...
        expect(lost.goal.generation).toBe(2);
        expect(lost.workers).toEqual([]);
        // ...but the launch record keeps the thread, so the next pass stops it.
        yield* pass("goal_race");
        expect(fake.interrupts).toEqual(["thread:worker-1"]);
        yield* pass("goal_race");
        expect((yield* record("goal_race")).workers[0]).toMatchObject({
          threadId: "thread:worker-1",
          state: "superseded",
        });
      }).pipe(Effect.provide(layerFor(fake)));
    },
  );

  it.effect("does not delete a goal while a thread it launched may still run (P1-3)", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const store = yield* GoalStore;
      yield* insert(withWorkers("goal_delete", 1));
      fake.duringLaunch = store
        .requestDeletion(FleetGoalId.make("goal_delete"), "2026-10-20T00:00:00.000Z")
        .pipe(Effect.orDie, Effect.asVoid);
      yield* pass("goal_delete");
      yield* pass("goal_delete");
      expect(fake.interrupts).toEqual(["thread:worker-1"]);
      expect(yield* store.get(FleetGoalId.make("goal_delete"))).not.toBeNull();
      yield* pass("goal_delete");
      expect(yield* store.get(FleetGoalId.make("goal_delete"))).toBeNull();
    }).pipe(Effect.provide(layerFor(fake)));
  });

  it.effect(
    "after a crash mid-launch, adopts the thread by its action id across a restart (P1-4)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = (yield* fs.makeTempDirectoryScoped()) + "/state.sqlite";
        const fake = makeFake();
        fake.crashAfterStart = true;
        yield* Effect.gen(function* () {
          yield* insert(testGoal("goal_crash"));
          yield* (yield* GoalController).runDue.pipe(Effect.exit);
        }).pipe(Effect.provide(layerFor(fake, { path })));
        const recovered = yield* Effect.gen(function* () {
          yield* (yield* GoalController).runDue;
          return yield* record("goal_crash");
        }).pipe(Effect.provide(layerFor(fake, { path })));
        expect(fake.launches).toHaveLength(1);
        expect(recovered.workers[0]).toMatchObject({
          threadId: "thread:worker-1",
          state: "running",
          attempt: 1,
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "waits on a launch it cannot look up, and only moves on once it knows it is absent (P1-4)",
    () => {
      const fake = makeFake();
      return Effect.gen(function* () {
        yield* insert(testGoal("goal_unclear"));
        fake.failAfterStart = true;
        fake.lookupFails = true;
        // Pretend the thread was never created: the launch call errored before creating it.
        fake.duringLaunch = Effect.sync(() => fake.threads.clear());
        yield* pass("goal_unclear");
        yield* TestClock.adjust(LAUNCH_GRACE_MS + 60_000);
        yield* pass("goal_unclear");
        expect(fake.launches).toHaveLength(1);
        expect((yield* record("goal_unclear")).workers[0]).toMatchObject({
          state: "launch_unknown",
          attempt: 1,
        });
        fake.lookupFails = false;
        yield* pass("goal_unclear");
        yield* pass("goal_unclear");
        expect(fake.launches.map((launch) => launch.actionId)).toEqual([
          "goal:goal_unclear:s0:a1:launch",
          "goal:goal_unclear:s0:a2:launch",
        ]);
      }).pipe(Effect.provide(layerFor(fake)));
    },
  );

  it.effect("resends a follow-up whose claim outlived a crash, under the same id (P2-5)", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      yield* insert(testGoal("goal_follow"));
      yield* pass("goal_follow");
      fake.reading = () => ({
        kind: "seen",
        terminal: true,
        runId: RunId.make("run:9"),
        runStatus: "completed",
        lastActivityAt: null,
        result: { reported: false, pullRequest: null },
      });
      fake.crashFollowUp = true;
      yield* pass("goal_follow").pipe(Effect.exit);
      yield* pass("goal_follow");
      yield* pass("goal_follow");
      expect(fake.followUps).toEqual([
        {
          actionId: "goal:goal_follow:s0:a1:run:9:followup",
          message:
            'Report your result with goat_call {path:"thread.report_result"}: outcome, summary, and any pull request.',
        },
      ]);
    }).pipe(Effect.provide(layerFor(fake)));
  });

  it.effect("keeps a finished goal scheduled until every dropped slot is stopped (P2-7)", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const id = "goal_cleanup";
      yield* insert(
        withWorkers(id, 4, {
          targets: [{ type: "pull_request", number: 7 }],
          doneWhen: [{ type: "pull_requests_merged" }],
        }),
      );
      yield* pass(id);
      yield* pass(id);
      expect(fake.launches).toHaveLength(4);
      fake.pullRequest = { kind: "seen", state: "merged", checks: "passing" };
      yield* setCount(id, 0);
      yield* pass(id);
      const first = yield* record(id);
      expect(first.goal.status.phase).toBe("succeeded");
      expect(fake.interrupts).toHaveLength(3);
      expect(first.goal.status.nextReconcileAt).not.toBeNull();
      yield* TestClock.adjust(120_000);
      yield* (yield* GoalController).runDue;
      expect(fake.interrupts).toHaveLength(4);
    }).pipe(Effect.provide(layerFor(fake)));
  });

  it.effect("refuses SSH hosts with the default placement and reports why", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      yield* insert(
        testGoal("goal_remote", {
          spec: testSpec({
            workers: { ...testSpec().workers, hostSelector: { hosts: ["mac-studio"] } },
          }),
        }),
      );
      yield* pass("goal_remote");
      const { goal } = yield* record("goal_remote");
      expect(fake.launches).toEqual([]);
      expect(
        goal.status.conditions.find((condition) => condition.type === "Blocked"),
      ).toMatchObject({
        status: "True",
        reason: "PlacementRefused",
        message: "mac-studio: placement_unavailable",
      });
    }).pipe(Effect.provide(layerFor(fake)));
  });

  it.effect("stops acting when the turn budget is spent", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      yield* insert(
        testGoal("goal_budget", {
          spec: testSpec({
            limits: { ...testSpec().limits, maxTurns: 1 },
            workers: { ...testSpec().workers, count: 2 },
          }),
        }),
      );
      yield* pass("goal_budget");
      expect(fake.launches.map((launch) => launch.actionId)).toEqual([
        "goal:goal_budget:s0:a1:launch",
      ]);
      expect(
        (yield* record("goal_budget")).goal.status.conditions.find((c) => c.type === "Blocked"),
      ).toMatchObject({ reason: "BudgetExhausted" });
    }).pipe(Effect.provide(layerFor(fake)));
  });
  it.effect(
    "never launches on another machine, even when placement offers one (P1-1, P1-2)",
    () => {
      const fake = makeFake();
      return Effect.gen(function* () {
        const store = yield* GoalStore;
        yield* insert(testGoal("goal_far"));
        yield* pass("goal_far");
        expect(fake.launches).toEqual([]);
        expect(yield* store.launches(FleetGoalId.make("goal_far"))).toEqual([]);
        expect(
          (yield* record("goal_far")).goal.status.conditions.find((c) => c.type === "Blocked"),
        ).toMatchObject({ status: "True", reason: "RemoteWorkersDisabled" });
      }).pipe(Effect.provide(layerFor(fake, { placeRemote: true })));
    },
  );

  it.effect("keeps an unconfirmed launch's host from its claim (P1-2)", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const store = yield* GoalStore;
      yield* insert(testGoal("goal_host"));
      yield* store.claim({
        goalId: FleetGoalId.make("goal_host"),
        generation: 1,
        actionId: "goal:goal_host:s0:a1:launch",
        kind: "launch",
        host: "mac-studio",
        slot: 0,
        nowIso: "2026-10-20T00:00:00.000Z",
      });
      expect(yield* store.launches(FleetGoalId.make("goal_host"))).toMatchObject([
        {
          actionId: "goal:goal_host:s0:a1:launch",
          host: "mac-studio",
          threadId: null,
          settledAt: null,
        },
      ]);
    }).pipe(Effect.provide(layerFor(fake)));
  });

  it.effect("continues a usage-limited worker after its reset, once (P2-4)", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      yield* insert(testGoal("goal_limit"));
      yield* pass("goal_limit");
      fake.reading = () => ({
        kind: "seen",
        terminal: true,
        runId: RunId.make("run:5"),
        runStatus: "failed",
        lastActivityAt: null,
        result: null,
        usageLimitResetAt: "1970-01-01T00:10:00.000Z",
      });
      healthOf = () => ({
        _tag: "failed",
        failureClass: "usage_limit",
        runId: RunId.make("run:5"),
      });
      // First the fallback gets the run (none configured), then it waits for the reset.
      yield* pass("goal_limit");
      yield* pass("goal_limit");
      expect(fake.followUps).toEqual([]);
      yield* TestClock.adjust(11 * 60_000);
      yield* pass("goal_limit");
      yield* pass("goal_limit");
      healthOf = () => ({ _tag: "healthy" });
      expect(fake.followUps).toEqual([
        {
          actionId: "goal:goal_limit:s0:a1:run:5:resume",
          message: "Your usage limit has reset. Continue where you left off.",
        },
      ]);
    }).pipe(Effect.provide(layerFor(fake)));
  });

  describe("while the hub is unreachable", () => {
    const scriptedHub = (initial: HubWork) => {
      const hub = {
        work: initial,
        settled: [] as Array<ReadonlyArray<PausedGoalWork>>,
        notices: [] as Array<{ readonly threadId: string; readonly message: string }>,
      };
      const shape: HubDownShape = {
        forWork: () => Effect.sync(() => hub.work),
        notice: (threadId, _key, message) =>
          Effect.sync(() => {
            hub.notices.push({ threadId, message });
          }),
        settle: (paused) =>
          Effect.sync(() => {
            hub.settled.push(paused);
          }),
      };
      return { hub, shape };
    };

    it.effect("pauses a launch without claiming it and launches once the hub answers", () => {
      const fake = makeFake();
      const { hub, shape } = scriptedHub({
        _tag: "Paused",
        message:
          "The hub is unreachable and local fallback is off for this device in hub settings.",
      });
      return Effect.gen(function* () {
        const store = yield* GoalStore;
        yield* insert(withWorkers("goal_hub", 1));
        yield* (yield* GoalController).runDue;
        expect(fake.launches).toEqual([]);
        // Unclaimed, so the same launch is taken later instead of spending an attempt.
        expect(yield* store.launches(FleetGoalId.make("goal_hub"))).toEqual([]);
        const paused = (yield* record("goal_hub")).goal.status;
        expect(paused.phase).toBe("blocked");
        expect(paused.conditions.find((c) => c.type === "Blocked")).toMatchObject({
          status: "True",
          reason: "HubUnreachable",
        });
        expect(hub.settled.map((batch) => batch.map((work) => work.goalId))).toEqual([
          ["goal_hub"],
        ]);

        hub.work = UNAFFECTED;
        yield* TestClock.adjust("10 minutes");
        yield* (yield* GoalController).runDue;
        expect(fake.launches.map((launch) => launch.actionId)).toEqual([
          "goal:goal_hub:s0:a1:launch",
        ]);
        expect(
          (yield* record("goal_hub")).goal.status.conditions.find((c) => c.type === "Blocked"),
        ).toMatchObject({ status: "False" });
        expect(hub.settled.at(-1)).toEqual([]);
      }).pipe(Effect.provide(layerFor(fake, { hubDown: shape })));
    });

    it.effect(
      "hops a launch to this device's own sign-in with a notice and keeps the goal's model",
      () => {
        const fake = makeFake();
        const own = { instanceId: ProviderInstanceId.make("codex-own"), model: "gpt-6.1-sol" };
        const { hub, shape } = scriptedHub({ _tag: "Hop", selection: own, notice: "moved" });
        return Effect.gen(function* () {
          yield* insert(withWorkers("goal_hop", 1));
          yield* pass("goal_hop");
          expect(fake.launches.map((launch) => launch.modelSelection)).toEqual([own]);
          expect(hub.notices).toEqual([{ threadId: "thread:worker-1", message: "moved" }]);
          // The next attempt starts from the goal's selection, back through the hub.
          expect((yield* record("goal_hop")).workers[0]!.modelSelection.instanceId).toBe("codex");
        }).pipe(Effect.provide(layerFor(fake, { hubDown: shape })));
      },
    );
  });
});
