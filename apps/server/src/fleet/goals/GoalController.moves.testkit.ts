/**
 * The #1451 restart harness: the goal controller, its store and the real Rescheduler over one
 * database file that a "restart" reopens. The worker runtime is scripted; the hosts answer
 * through a fake SshRemoteDispatch the Rescheduler calls. Shared by the move and drain tests.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect } from "@effect/vitest";
import { FleetGoalId, RunId, type RuntimeMode, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import * as FleetHostStates from "../health/FleetHostStates.ts";
import { Health, type ThreadHealth } from "../health/Health.ts";
import { HostHealthMonitor } from "../health/HostHealthMonitor.ts";
import * as Rescheduler from "../health/Rescheduler.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { Placement } from "../resources/Placement.ts";
import { layer as controllerLayer } from "./GoalController.ts";
import {
  failedRun,
  type Fake,
  freshStarts,
  noFallback,
  pass,
  running,
  runtimeFor,
} from "./GoalController.testkit.ts";
import { GoalStore, layer as goalStoreLayer } from "./GoalStore.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";

export interface World {
  readonly reachable: Record<string, boolean>;
  /** Hosts the monitor counts as Lost. */
  readonly lost: Set<string>;
  readonly threads: Array<{
    readonly host: string;
    readonly threadId: ThreadId;
    readonly title: string;
    phase: string;
  }>;
  readonly launches: Array<SshRemoteDispatch.SshLaunchInput>;
  /** The next launch creates its thread and then loses its answer. */
  loseNextLaunchAnswer: boolean;
  /** The next launch is refused before anything is created. */
  refuseNextLaunch: boolean;
  /** How the worker's own run reads, by thread. */
  health: (threadId: string) => ThreadHealth;
  /** The first worker's run on A, as its host reports it; an interrupt stops it. */
  sourceRun: "running" | "failed" | "interrupted" | "completed";
  /** The run the first worker is on; a person resuming it starts a new one. */
  sourceRunId: string;
  /** The next interrupt stops the run, then its answer is lost. */
  loseNextInterruptAnswer: boolean;
  /** Hosts marked Draining (null is this machine), as fleet_host_states reads them. */
  readonly draining: Set<string | null>;
  /** Hosts cordoned without a drain. */
  readonly cordoned: Set<string | null>;
  /** How this machine's own worker threads read: their latest run ended or is running. */
  localRun: "completed" | "running";
  /** Runs inside every goat_thread_status call, before it answers. */
  onStatus: (() => void) | null;
  /** The next launch is refused with this remote code before anything is created. */
  refuseNextLaunchCode: string | null;
  /** Branches the destination cannot start a worktree from: they were never pushed. */
  readonly unpublished: Set<string>;
  /** Every launch the destination was asked for, created or not. */
  launchCalls: number;
}

export const newWorld = (): World => ({
  reachable: { A: true, B: true },
  lost: new Set(),
  threads: [],
  launches: [],
  loseNextLaunchAnswer: false,
  refuseNextLaunch: false,
  health: () => ({ _tag: "healthy" }),
  sourceRun: "failed",
  sourceRunId: "run:5",
  loseNextInterruptAnswer: false,
  draining: new Set(),
  cordoned: new Set(),
  localRun: "completed",
  onStatus: null,
  refuseNextLaunchCode: null,
  unpublished: new Set(),
  launchCalls: 0,
});

const unavailable = (host: string) =>
  new SshRemoteDispatch.SshRemoteDispatchError({
    reason: "host_unavailable",
    message: host + " did not answer",
  });

const dispatchOf = (world: World) =>
  ({
    callHostTool: (
      call: SshRemoteDispatch.SshHostToolCall,
      authorize: Effect.Effect<RuntimeMode, Rescheduler.RescheduleNotAllowed>,
    ) =>
      Effect.gen(function* () {
        yield* authorize;
        if (world.reachable[call.host] !== true) return yield* unavailable(call.host);
        const now = DateTime.formatIso(yield* DateTime.now);
        switch (call.tool) {
          case "goat_thread_status": {
            world.onStatus?.();
            // The goal's first worker lives on A as thread:worker-1, on run 5.
            return {
              host: call.host,
              threadId: call.arguments.threadId,
              title: "Worker",
              phase: world.sourceRun,
              terminal: world.sourceRun !== "running",
              run: {
                runId: world.sourceRunId,
                status: world.sourceRun,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
              },
              queuedRunId: null,
              pendingRequest: null,
              lastActivityAt: now,
              lastMessage: null,
              lastError: null,
              watch: null,
            };
          }
          case "goat_thread_interrupt":
            // The destination stops only the run it is told to.
            if (call.arguments.runId !== undefined && call.arguments.runId !== world.sourceRunId)
              return { threadId: call.arguments.threadId, runId: null, status: "not_running" };
            world.sourceRun = "interrupted";
            if (world.loseNextInterruptAnswer) {
              world.loseNextInterruptAnswer = false;
              return yield* unavailable(call.host);
            }
            return {
              threadId: call.arguments.threadId,
              runId: world.sourceRunId,
              status: "interrupt_requested",
            };
          case "goat_thread_list":
            return {
              threads: world.threads
                .filter(
                  (thread) =>
                    thread.host === call.host &&
                    thread.title.includes(String(call.arguments.titleContains)),
                )
                .map((thread) => ({ threadId: thread.threadId, title: thread.title })),
            };
          default:
            return {};
        }
      }),
    launchThread: (
      input: SshRemoteDispatch.SshLaunchInput,
      beforeLaunch: Effect.Effect<void, Rescheduler.RescheduleNotAllowed>,
    ) =>
      Effect.gen(function* () {
        yield* beforeLaunch;
        const host = input.host ?? "";
        if (world.reachable[host] !== true) return yield* unavailable(host);
        world.launchCalls += 1;
        if (world.refuseNextLaunchCode !== null) {
          const remoteCode = world.refuseNextLaunchCode;
          world.refuseNextLaunchCode = null;
          return yield* new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "remote_refused",
            message: "Refused: " + remoteCode,
            remoteCode,
          });
        }
        const base = input.workspace?.type === "worktree" ? input.workspace.baseRef : undefined;
        if (base !== undefined && world.unpublished.has(base))
          return yield* new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "remote_refused",
            message: 'Base ref "' + base + '" was not found.',
            remoteCode: "invalid_request",
            launchMayHaveStarted: false,
          });
        if (world.refuseNextLaunch) {
          world.refuseNextLaunch = false;
          return yield* new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "remote_refused",
            message: "The folder is not a Git repository there.",
          });
        }
        world.launches.push(input);
        const threadId = ThreadId.make("thread:" + host + "-" + world.launches.length);
        world.threads.push({ host, threadId, title: input.title, phase: "running" });
        if (world.loseNextLaunchAnswer) {
          world.loseNextLaunchAnswer = false;
          return yield* new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "host_unavailable",
            message: "the connection dropped before the answer",
            launchMayHaveStarted: true,
          });
        }
        return {
          host,
          cwd: input.cwd,
          projectId: "project",
          projectCreated: false,
          threadId,
          reportsSupported: false,
          runId: null,
          workspaceStrategy: { type: "worktree" },
          runtimeMode: input.runtimeMode,
          remoteServerKind: null,
          notes: [],
        };
      }),
  }) as unknown as SshRemoteDispatch.SshRemoteDispatch["Service"];

/**
 * A goal's first worker goes to the first host it lists (A by default, this machine when listed
 * first); a move goes to a reachable host it was not on.
 */
const placementOf = (world: World) =>
  Layer.succeed(Placement, {
    place: (request) =>
      Effect.sync(() => {
        const host = (request.hostSelector.hosts ?? ["A", "B"]).find(
          (host) =>
            (host === null || world.reachable[host] === true) &&
            !request.avoidHosts.includes(host) &&
            !(request.hostSelector.exclude ?? []).includes(host),
        );
        return host === undefined
          ? { _tag: "Refused" as const, reasons: [] }
          : {
              _tag: "Placed" as const,
              host,
              modelSelection: request.modelSelection,
              reason: undefined,
            };
      }),
    status: Effect.die("unused"),
    statusOf: () => Effect.die("unused"),
  });

/** One server process over the database at path: everything but the file starts fresh. */
/** A host's conditions as the monitor derives them from the world. */
const conditionsOf = (world: World, host: string | null) =>
  [
    ...(host !== null && world.lost.has(host) ? [{ type: "Lost" }] : []),
    ...(world.cordoned.has(host) || world.draining.has(host) ? [{ type: "Cordoned" }] : []),
    ...(world.draining.has(host) ? [{ type: "Draining" }] : []),
  ] as never;

/** This machine's worker threads: their latest run, as world.localRun says. */
const localShell = (world: World, threadId: ThreadId) => ({
  ...liveThreadShell(threadId, {
    activeRunId: world.localRun === "running" ? RunId.make("run:5") : null,
  }),
  latestRunId: RunId.make("run:5"),
  status: world.localRun,
});

export const server = (fake: Fake, world: World, path: string) => {
  const placement = placementOf(world);
  const rescheduler = Rescheduler.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        placement,
        FleetHostStates.layerClaims,
        Layer.succeed(SshRemoteDispatch.SshRemoteDispatch, dispatchOf(world)),
        Layer.mock(HostHealthMonitor)({
          conditions: (host) =>
            Effect.succeed({
              host,
              conditions: conditionsOf(world, host),
              observedAt: "",
            }),
          recordContact: () => Effect.void,
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.sync(() => localShell(world, threadId)),
        }),
      ),
    ),
  );
  return controllerLayer.pipe(
    Layer.provideMerge(goalStoreLayer),
    Layer.provide(runtimeFor(fake)),
    Layer.provide(
      Layer.mergeAll(
        placement,
        noFallback,
        freshStarts,
        rescheduler,
        Layer.succeed(Health, {
          hostCondition: (host) =>
            Effect.sync(() => ({ host, conditions: conditionsOf(world, host), observedAt: "" })),
          threadHealth: (ref) => Effect.sync(() => world.health(ref.threadId)),
        }),
      ),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({ fleet: { controllerEnabled: true } }),
    ),
    Layer.provideMerge(
      SqlitePersistence.layerFromPath(path).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
};

export const databaseFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "goat-goal-moves-" }),
    "state.sqlite",
  );
}).pipe(Effect.provide(NodeServices.layer));

/** A goal on a folder, its workers on A or B, with the given limits. */
export const goalWith = (id: string, limits: Partial<ReturnType<typeof testSpec>["limits"]> = {}) =>
  testGoal(id, {
    spec: testSpec({
      project: { host: null, projectId: null, cwd: "/repo" },
      workers: { ...testSpec().workers, hostSelector: { hosts: ["A", "B"] } },
      limits: { ...testSpec().limits, ...limits },
    }),
  });

/** The first worker launched on A, then its run failed: the next pass moves it. */
export const startThenFail = (world: World, fake: Fake, id: string) =>
  Effect.gen(function* () {
    yield* pass(id);
    expect(fake.launches.map((launch) => launch.host)).toEqual(["A"]);
    fake.reading = (threadId) =>
      threadId === "thread:worker-1" ? failedRun("run:5") : running(threadId, fake);
    world.health = (threadId) =>
      threadId === "thread:worker-1"
        ? { _tag: "failed", failureClass: "unknown", runId: "run:5" as never }
        : { _tag: "healthy" };
  });

export const turnsOf = (id: string) =>
  GoalStore.pipe(Effect.flatMap((store) => store.turns(FleetGoalId.make(id))));

/** The first worker's run on A reads as running but stalled. */
export const stall = (world: World, fake: Fake) => {
  world.sourceRun = "running";
  fake.reading = (threadId) =>
    threadId === "thread:worker-1"
      ? {
          kind: "seen",
          terminal: world.sourceRun !== "running",
          runId: RunId.make(world.sourceRunId),
          runStatus: world.sourceRun,
          lastActivityAt: null,
          result: null,
        }
      : running(threadId, fake);
  world.health = (threadId) =>
    threadId === "thread:worker-1" && world.sourceRun === "running"
      ? { _tag: "stalled", idleMs: 30 * 60_000 }
      : { _tag: "healthy" };
};

/** The first worker's run on A stalls; after a steer, the goal's move stops that run itself. */
export const stallThenStop = (world: World, fake: Fake, id: string) =>
  Effect.gen(function* () {
    yield* pass(id);
    stall(world, fake);
    yield* pass(id);
    yield* pass(id);
    expect(world.sourceRun).toBe("interrupted");
    expect(world.launches).toEqual([]);
  });

export const moveOutcome = (id: string) =>
  GoalStore.pipe(
    Effect.flatMap((store) => store.claimOf("goal:" + id + ":s0:a1:run:5:reschedule")),
    Effect.map((claim) => claim?.outcome ?? "none"),
  );
