/**
 * The goal controller over a scripted worker runtime and fixed placement, health, fallback and
 * recovery, shared by the controller's test files.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FleetGoalId, OrchestratorMcpFailure, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HubDown, type HubDownShape } from "../../hub/HubDown.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as FleetDefaults from "../defaults.ts";
import { Health, type ThreadHealth } from "../health/Health.ts";
import { Fallback } from "../resources/Fallback.ts";
import { Placement } from "../resources/Placement.ts";
import { GoalController, layer as controllerLayer } from "./GoalController.ts";
import { type PullRequestObservation } from "./goalPlan.ts";
import { GoalRecovery } from "./GoalRecovery.ts";
import { GoalStore, layer as goalStoreLayer } from "./GoalStore.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";
import {
  GoalOwnerAuthorityLost,
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
  /** Runs once, inside the next launch, follow-up or interrupt, right before its confirm. */
  beforeConfirm: Effect.Effect<void> | null;
  /** Makes the next launch create its thread and then lose its owner, as a refused first message does. */
  loseAfterCreate: boolean | "goalChanged";
  reading: (threadId: string) => WorkerReading;
  pullRequest: PullRequestObservation;
}

export const access = (runtimeMode: OwnerAccess["runtimeMode"] = "full-access"): OwnerAccess => ({
  scope: {} as OwnerAccess["scope"],
  runtimeMode,
  canReachHosts: runtimeMode === "full-access",
});

export const running = (threadId: string, fake: Fake): WorkerReading =>
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

export const failedRun = (runId: string): WorkerReading => ({
  kind: "seen",
  terminal: true,
  runId: RunId.make(runId),
  runStatus: "failed",
  lastActivityAt: null,
  result: null,
});

export const makeFake = (): Fake => {
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
    beforeConfirm: null,
    loseAfterCreate: false,
    reading: (threadId) => running(threadId, fake),
    pullRequest: { kind: "seen", state: "open", checks: "pending" },
  };
  return fake;
};

/** What the runtime does last before it hands a command over: the controller's confirm. */
const confirmLast = <E>(fake: Fake, confirm: Effect.Effect<void, E>) =>
  Effect.suspend(() => {
    const before = fake.beforeConfirm ?? Effect.void;
    fake.beforeConfirm = null;
    return Effect.andThen(before, confirm);
  });

const runtimeFor = (fake: Fake) =>
  Layer.succeed(GoalWorkerRuntime, {
    owner: () =>
      Effect.sync(
        () =>
          (fake.owners.length > 1 ? fake.owners.shift() : fake.owners[0]) ?? {
            unavailable: "No owner was scripted.",
          },
      ),
    observeWorker: (_access, _goal, worker) =>
      Effect.sync(() => fake.reading(worker.threadId ?? "")),
    observePullRequest: () => Effect.sync(() => fake.pullRequest),
    observeIssue: () => Effect.succeed("open" as const),
    findLaunched: (_access, _goal, actionId) =>
      fake.lookupFails
        ? Effect.fail(new OrchestratorMcpFailure({ code: "orchestration_error", message: "busy" }))
        : Effect.sync(() => {
            const threadId = fake.threads.get(actionId);
            return threadId === undefined ? null : { host: null, threadId, runId: null };
          }),
    launch: (current, request, confirm) =>
      Effect.gen(function* () {
        yield* confirmLast(fake, confirm);
        fake.launches.push({ ...request, mode: current.runtimeMode });
        const threadId = ThreadId.make("thread:worker-" + fake.launches.length);
        fake.threads.set(request.actionId, threadId);
        if (fake.loseAfterCreate !== false) {
          const goalChanged = fake.loseAfterCreate === "goalChanged";
          fake.loseAfterCreate = false;
          if (goalChanged && fake.duringLaunch !== null) {
            const run = fake.duringLaunch;
            fake.duringLaunch = null;
            yield* run;
          }
          return yield* new GoalOwnerAuthorityLost({ message: "revoked", goalChanged });
        }
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
    followUp: (_access, _goal, _worker, message, actionId, confirm) =>
      Effect.suspend(() => {
        if (fake.crashFollowUp) {
          fake.crashFollowUp = false;
          return Effect.die("server stopped before the send");
        }
        return confirmLast(fake, confirm).pipe(
          Effect.andThen(Effect.sync(() => void fake.followUps.push({ actionId, message }))),
        );
      }),
    interrupt: (_access, worker, _actionId, confirm) =>
      confirmLast(fake, confirm).pipe(
        Effect.andThen(
          Effect.sync(() => {
            fake.interrupts.push(worker.threadId ?? "");
            fake.ended.add(worker.threadId ?? "");
          }),
        ),
      ),
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

/** Later attempts start like first ones; GoalRecovery.test.ts covers resuming earlier work. */
const freshStarts = Layer.succeed(GoalRecovery, {
  capture: () => Effect.void,
  resume: () => Effect.succeed({ _tag: "Start" as const, workspace: null, note: null }),
  forget: () => Effect.void,
});

const persistence = (path: string | undefined) =>
  path === undefined
    ? SqlitePersistence.layerMemory
    : SqlitePersistence.layerFromPath(path).pipe(Layer.provide(NodeServices.layer));

export const layerFor = (
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
        freshStarts,
      ),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        fleet: { controllerEnabled: options.enabled ?? true },
      }),
    ),
  );

export const withWorkers = (
  id: string,
  count: number,
  overrides: Parameters<typeof testSpec>[0] = {},
) =>
  testGoal(id, {
    spec: testSpec({
      ...overrides,
      workers: { ...testSpec().workers, count },
      limits: { ...testSpec().limits, maxWorkers: Math.max(count, 1) },
    }),
  });

export const insert = (goal: ReturnType<typeof testGoal>) =>
  GoalStore.pipe(Effect.flatMap((store) => store.create(goal, "thread:thread:owner", null)));

export const record = (id: string) =>
  GoalStore.pipe(
    Effect.flatMap((store) => store.get(FleetGoalId.make(id))),
    Effect.flatMap((found) =>
      found === null ? Effect.die("No goal " + id + ".") : Effect.succeed(found),
    ),
  );

export const pass = (id: string) =>
  Effect.gen(function* () {
    const controller = yield* GoalController;
    return yield* controller.reconcile(yield* record(id), 10);
  });

export const setCount = (id: string, count: number) =>
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

/** Sets what every worker's health reads until the next call. */
export const setHealth = (next: () => ThreadHealth) => {
  healthOf = next;
};
