/**
 * Moves of a goal's worker to another host across the controller, its store and the Rescheduler,
 * over one database file that a "restart" reopens (#1451). The worker runtime is scripted; the
 * hosts answer through a fake SshRemoteDispatch the Rescheduler calls.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { FleetGoalId, RunId, type RuntimeMode, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import * as FleetHostStates from "../health/FleetHostStates.ts";
import { Health, type ThreadHealth } from "../health/Health.ts";
import { HostHealthMonitor } from "../health/HostHealthMonitor.ts";
import * as Rescheduler from "../health/Rescheduler.ts";
import { Placement } from "../resources/Placement.ts";
import { layer as controllerLayer } from "./GoalController.ts";
import {
  failedRun,
  type Fake,
  freshStarts,
  insert,
  makeFake,
  noFallback,
  pass,
  record,
  running,
  setCount,
  runtimeFor,
} from "./GoalController.testkit.ts";
import { LAUNCH_GRACE_MS } from "./goalPlan.ts";
import { GoalStore, layer as goalStoreLayer } from "./GoalStore.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";

interface World {
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
  sourceRun: "running" | "failed" | "interrupted";
  /** The run the first worker is on; a person resuming it starts a new one. */
  sourceRunId: string;
  /** The next interrupt stops the run, then its answer is lost. */
  loseNextInterruptAnswer: boolean;
}

const newWorld = (): World => ({
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

/** A goal's first worker goes to A; a move goes to a reachable host it was not on. */
const placementOf = (world: World) =>
  Layer.succeed(Placement, {
    place: (request) =>
      Effect.sync(() => {
        const host = (request.hostSelector.hosts ?? ["A", "B"]).find(
          (host): host is string =>
            host !== null &&
            world.reachable[host] === true &&
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
const server = (fake: Fake, world: World, path: string) => {
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
              conditions:
                host !== null && world.lost.has(host) ? ([{ type: "Lost" }] as never) : [],
              observedAt: "",
            }),
          recordContact: () => Effect.void,
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
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
          hostCondition: (host) => Effect.succeed({ host, conditions: [], observedAt: "" }),
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

const databaseFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "goat-goal-moves-" }),
    "state.sqlite",
  );
}).pipe(Effect.provide(NodeServices.layer));

/** A goal on a folder, its workers on A or B, with the given limits. */
const goalWith = (id: string, limits: Partial<ReturnType<typeof testSpec>["limits"]> = {}) =>
  testGoal(id, {
    spec: testSpec({
      project: { host: null, projectId: null, cwd: "/repo" },
      workers: { ...testSpec().workers, hostSelector: { hosts: ["A", "B"] } },
      limits: { ...testSpec().limits, ...limits },
    }),
  });

/** The first worker launched on A, then its run failed: the next pass moves it. */
const startThenFail = (world: World, fake: Fake, id: string) =>
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

const turnsOf = (id: string) =>
  GoalStore.pipe(Effect.flatMap((store) => store.turns(FleetGoalId.make(id))));

/** The first worker's run on A stalls; after a steer, the goal's move stops that run itself. */
const stallThenStop = (world: World, fake: Fake, id: string) =>
  Effect.gen(function* () {
    yield* pass(id);
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
    yield* pass(id);
    yield* pass(id);
    expect(world.sourceRun).toBe("interrupted");
    expect(world.launches).toEqual([]);
  });

const moveOutcome = (id: string) =>
  GoalStore.pipe(
    Effect.flatMap((store) => store.claimOf("goal:" + id + ":s0:a1:run:5:reschedule")),
    Effect.map((claim) => claim?.outcome ?? "none"),
  );

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
