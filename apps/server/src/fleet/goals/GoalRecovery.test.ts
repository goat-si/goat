// @effect-diagnostics nodeBuiltinImport:off - builds temporary git repositories and worktrees with real git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  FleetGoalId,
  type OrchestrationV2ThreadShell,
  RunId,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { Health } from "../health/Health.ts";
import { Rescheduler } from "../health/Rescheduler.ts";
import { Fallback } from "../resources/Fallback.ts";
import { Placement } from "../resources/Placement.ts";
import { GoalController, layer as controllerLayer } from "./GoalController.ts";
import { launchActionId } from "./goalPlan.ts";
import { GoalRecovery, layer as recoveryLayer } from "./GoalRecovery.ts";
import { GoalStore, layer as goalStoreLayer } from "./GoalStore.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";
import {
  GoalWorkerRuntime,
  type LaunchRequest,
  type OwnerAccess,
  workerThreadId,
} from "./GoalWorkerRuntime.ts";

interface World {
  readonly root: string;
  readonly repo: string;
  readonly git: (cwd: string, ...args: ReadonlyArray<string>) => string;
  /** Worker threads on this machine by id; a test edits them to end or restart a run. */
  readonly shells: Map<string, OrchestrationV2ThreadShell>;
  readonly launches: Array<LaunchRequest & { readonly worktree: string }>;
  readonly interrupts: Array<string>;
  readonly rescheduled: Array<unknown>;
  /** Whether an interrupt ends the run, or the run keeps going. */
  stopOnInterrupt: boolean;
}

const makeWorld = (): World => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-goal-recovery-")),
  );
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NodePath.join(root, "no-config"),
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_AUTHOR_NAME: "Goal Test",
    GIT_AUTHOR_EMAIL: "goal-test@example.invalid",
    GIT_COMMITTER_NAME: "Goal Test",
    GIT_COMMITTER_EMAIL: "goal-test@example.invalid",
  };
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd, env, encoding: "utf8" });
  const origin = NodePath.join(root, "origin.git");
  const repo = NodePath.join(root, "repo");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(root, "init", "--quiet", "--initial-branch=main", repo);
  NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "--quiet", "-u", "origin", "main");
  return {
    root,
    repo,
    git,
    shells: new Map(),
    launches: [],
    interrupts: [],
    rescheduled: [],
    stopOnInterrupt: true,
  };
};

const acquireWorld = Effect.acquireRelease(Effect.sync(makeWorld), (world) =>
  Effect.sync(() => NodeFS.rmSync(world.root, { recursive: true, force: true })),
);

/** A worker thread whose latest run has the given status; only "running" keeps it active. */
const setRun = (
  world: World,
  threadId: ThreadId,
  runId: string,
  status: "running" | "failed" | "interrupted",
) => {
  const shell = world.shells.get(threadId);
  if (shell === undefined) throw new Error("no thread " + threadId);
  world.shells.set(threadId, {
    ...shell,
    latestRunId: RunId.make(runId),
    activeRunId: status === "running" ? RunId.make(runId) : null,
    status,
  });
};

const ownerAccess = { scope: {}, runtimeMode: "full-access", canReachHosts: true } as OwnerAccess;

const runtimeFor = (world: World) =>
  Layer.succeed(GoalWorkerRuntime, {
    owner: () => Effect.succeed(ownerAccess),
    observeWorker: (_access, _goal, worker) =>
      Effect.sync(() => {
        const shell = worker.threadId === null ? undefined : world.shells.get(worker.threadId);
        if (shell === undefined) return { kind: "missing" as const };
        return {
          kind: "seen" as const,
          terminal: shell.activeRunId === null,
          runId: shell.latestRunId,
          runStatus: shell.status,
          lastActivityAt: null,
          result: null,
        };
      }),
    observePullRequest: () => Effect.die("unused"),
    observeIssue: () => Effect.succeed("open" as const),
    findLaunched: (_access, _goal, actionId) =>
      Effect.sync(() =>
        world.shells.has(workerThreadId(actionId))
          ? { host: null, threadId: workerThreadId(actionId), runId: null }
          : null,
      ),
    // Like the real local launch: a fresh worktree on the attempt's branch from the requested base.
    launch: (_access, request) =>
      Effect.sync(() => {
        const worktree = NodePath.join(world.root, "worktrees", "a" + (world.launches.length + 1));
        world.git(
          world.repo,
          "worktree",
          "add",
          "--quiet",
          "-b",
          request.branch,
          worktree,
          request.workspace?.baseRef ?? request.goal.spec.workers.workspace.baseRef,
        );
        world.launches.push({ ...request, worktree });
        const threadId = workerThreadId(request.actionId);
        world.shells.set(threadId, {
          ...liveThreadShell(threadId, { activeRunId: RunId.make("run:1") }),
          worktreePath: worktree,
          latestRunId: RunId.make("run:1"),
        });
        return { host: null, threadId, runId: RunId.make("run:1") };
      }),
    followUp: () => Effect.void,
    interrupt: (_access, worker) =>
      Effect.sync(() => {
        const threadId = worker.threadId!;
        world.interrupts.push(threadId);
        if (world.stopOnInterrupt)
          setRun(world, threadId, world.shells.get(threadId)!.latestRunId!, "interrupted");
      }),
  });

const project = (world: World) =>
  Layer.mock(ProjectStoreV2)({
    get: (projectId) =>
      Effect.succeedSome({
        projectId,
        title: "repo",
        workspaceRoot: world.repo,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        createdAt: "2026-10-20T00:00:00.000Z",
        updatedAt: "2026-10-20T00:00:00.000Z",
        deletedAt: null,
      }),
  });

const recoveryFor = (world: World) =>
  recoveryLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.sync(() => world.shells.get(threadId) ?? null),
        }),
        project(world),
        ProcessRunner.layer,
        ServerConfig.layerTest(world.repo, NodePath.join(world.root, "state")),
      ),
    ),
  );

const layerFor = (world: World) =>
  controllerLayer.pipe(
    Layer.provideMerge(recoveryFor(world)),
    Layer.provideMerge(goalStoreLayer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(runtimeFor(world)),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Placement, {
          place: (request) =>
            Effect.succeed({
              _tag: "Placed" as const,
              host: null,
              modelSelection: request.modelSelection,
              reason: undefined,
            }),
          status: Effect.die("unused"),
          statusOf: () => Effect.die("unused"),
        }),
        Layer.succeed(Rescheduler, {
          reschedule: (request) =>
            Effect.sync(() => {
              world.rescheduled.push(request);
              return { _tag: "Refused" as const, reason: "no_capacity" as const, message: "no" };
            }),
        }),
        Layer.succeed(Fallback, {
          next: () => Effect.succeed({ _tag: "Exhausted" as const, reason: "No chain." }),
          reportFailure: () => Effect.void,
          cooldowns: Effect.succeed([]),
          coversThreads: Effect.succeed(false),
          continueThread: () => Effect.succeed(false),
        }),
        Layer.succeed(Health, {
          hostCondition: (host) => Effect.succeed({ host, conditions: [], observedAt: "" }),
          threadHealth: () => Effect.succeed({ _tag: "healthy" as const }),
        }),
      ),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({ fleet: { controllerEnabled: true } }),
    ),
    Layer.provide(NodeServices.layer),
  );

const GOAL = testGoal("goal_rec", {
  spec: testSpec({
    workers: {
      ...testSpec().workers,
      workspace: { baseRef: "main", branchPrefix: "goal/test", startFromOrigin: false },
    },
  }),
});
const firstThread = workerThreadId(launchActionId(GOAL, 0, 1));

const pass = Effect.gen(function* () {
  const store = yield* GoalStore;
  const record = yield* store.get(FleetGoalId.make("goal_rec"));
  return yield* (yield* GoalController).reconcile(record!, 10);
});

/**
 * Attempt 1 launches, commits work it never pushes, leaves a file uncommitted and fails. The second
 * pass captures its replica and moves the slot to attempt 2; the next pass launches that.
 */
const failFirstAttempt = (world: World) =>
  Effect.gen(function* () {
    yield* (yield* GoalStore).create(GOAL, "thread:thread:owner", null);
    yield* pass;
    const first = world.launches[0]!.worktree;
    NodeFS.writeFileSync(NodePath.join(first, "committed.txt"), "kept\n");
    world.git(first, "add", "committed.txt");
    world.git(first, "commit", "--quiet", "-m", "unpushed work");
    NodeFS.writeFileSync(NodePath.join(first, "notes.txt"), "not committed\n");
    setRun(world, firstThread, "run:1", "failed");
    yield* pass;
    return world.git(first, "rev-parse", "HEAD").trim();
  });

const goalStatus = Effect.gen(function* () {
  const record = yield* (yield* GoalStore).get(FleetGoalId.make("goal_rec"));
  return record!;
});

describe("GoalRecovery", () => {
  it.live(
    "restarts a failed attempt on this machine from its replica, with its unpushed commit and uncommitted file",
    () =>
      Effect.gen(function* () {
        const world = yield* acquireWorld;
        yield* Effect.gen(function* () {
          const unpushed = yield* failFirstAttempt(world);
          expect(world.git(world.repo, "branch", "-r", "--contains", unpushed).trim()).toBe("");
          yield* pass;

          expect(world.launches.map((launch) => launch.actionId)).toEqual([
            launchActionId(GOAL, 0, 1),
            launchActionId(GOAL, 0, 2),
          ]);
          const second = world.launches[1]!;
          expect(second.branch).toBe("goal/test/s0-a2");
          expect(second.workspace).toEqual({
            baseRef: expect.stringMatching(/^goat\/replica\/goal-goal_rec-s0-[0-9a-f]{12}-1$/),
            startFromOrigin: false,
          });
          expect(second.message).toContain("after attempt 1 stopped");
          expect(NodeFS.readFileSync(NodePath.join(second.worktree, "committed.txt"), "utf8")).toBe(
            "kept\n",
          );
          expect(NodeFS.readFileSync(NodePath.join(second.worktree, "notes.txt"), "utf8")).toBe(
            "not committed\n",
          );
          // Throws unless attempt 2 is built on attempt 1's last commit.
          world.git(second.worktree, "merge-base", "--is-ancestor", unpushed, "HEAD");
          expect(world.rescheduled).toEqual([]);
          const record = yield* goalStatus;
          expect(record.workers.find((worker) => worker.slot === 0)).toMatchObject({
            attempt: 2,
            state: "running",
            threadId: workerThreadId(launchActionId(GOAL, 0, 2)),
          });
        }).pipe(Effect.provide(layerFor(world)));
      }).pipe(Effect.scoped),
  );

  it.live(
    "refuses a replica whose commit cannot be verified, launches nothing, and launches once it verifies",
    () =>
      Effect.gen(function* () {
        const world = yield* acquireWorld;
        yield* Effect.gen(function* () {
          yield* failFirstAttempt(world);
          const sql = yield* SqlClient.SqlClient;
          const [row] = yield* sql<{ readonly commit_oid: string }>`
            SELECT commit_oid FROM fleet_replicas WHERE owner_key = 'goal:goal_rec:s0'
          `;
          const base = world.git(world.repo, "rev-parse", "main").trim();
          yield* sql`UPDATE fleet_replicas SET commit_oid = ${base}`;
          yield* pass;

          expect(world.launches).toHaveLength(1);
          const record = yield* goalStatus;
          expect(record.goal.status.conditions).toContainEqual(
            expect.objectContaining({ type: "Blocked", reason: "ResumeRefused" }),
          );
          expect(record.workers.find((worker) => worker.slot === 0)?.note).toContain(
            "could not be verified",
          );
          expect(world.git(world.repo, "for-each-ref", "refs/heads/goat/replica").trim()).toBe("");

          yield* sql`UPDATE fleet_replicas SET commit_oid = ${row!.commit_oid}`;
          yield* pass;
          expect(world.launches).toHaveLength(2);
        }).pipe(Effect.provide(layerFor(world)));
      }).pipe(Effect.scoped),
  );

  it.live(
    "waits while the previous attempt runs again, stops it first, and restarts once it stopped",
    () =>
      Effect.gen(function* () {
        const world = yield* acquireWorld;
        yield* Effect.gen(function* () {
          yield* failFirstAttempt(world);
          // A person messaged attempt 1 after it failed, and the interrupt does not land at once.
          setRun(world, firstThread, "run:2", "running");
          world.stopOnInterrupt = false;
          yield* pass;
          expect(world.interrupts).toEqual([firstThread]);
          expect(world.launches).toHaveLength(1);
          expect((yield* goalStatus).workers.find((worker) => worker.slot === 0)?.note).toContain(
            "still active",
          );

          setRun(world, firstThread, "run:2", "interrupted");
          yield* pass;
          expect(world.launches).toHaveLength(2);
          expect(world.launches[1]!.workspace?.baseRef).toMatch(/^goat\/replica\//);
        }).pipe(Effect.provide(layerFor(world)));
      }).pipe(Effect.scoped),
  );

  /** GoalRecovery alone, over one stopped attempt-1 worktree whose shell the test controls. */
  const recoveryAlone = (world: World, shellOf: () => OrchestrationV2ThreadShell) =>
    recoveryLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.sync(shellOf),
          }),
          project(world),
          ProcessRunner.layer,
          ServerConfig.layerTest(world.repo, NodePath.join(world.root, "state")),
          SqlitePersistence.layerMemory,
        ),
      ),
      Layer.provide(NodeServices.layer),
    );

  const stoppedShell = (worktree: string, runId: string): OrchestrationV2ThreadShell => ({
    ...liveThreadShell(firstThread, { activeRunId: null }),
    worktreePath: worktree,
    latestRunId: RunId.make(runId),
    status: "failed",
  });

  // The attempt reads as having run again once the step under test wrote its ref.
  it.live.each([
    { during: "the capture", writes: "refs/goat/replicas" },
    { during: "the import", writes: "refs/heads/goat/replica" },
  ])("waits when the previous attempt ran again during $during", ({ writes }) =>
    Effect.gen(function* () {
      const world = yield* acquireWorld;
      const worktree = NodePath.join(world.root, "a1");
      world.git(world.repo, "worktree", "add", "--quiet", "-b", "goal/test/s0-a1", worktree);
      NodeFS.writeFileSync(NodePath.join(worktree, "notes.txt"), "not committed\n");
      const ranAgain = () => world.git(world.repo, "for-each-ref", writes).trim() !== "";
      const resume = yield* Effect.gen(function* () {
        return yield* (yield* GoalRecovery).resume(GOAL, 0, 2);
      }).pipe(
        Effect.provide(
          recoveryAlone(world, () => stoppedShell(worktree, ranAgain() ? "run:2" : "run:1")),
        ),
      );
      expect(resume).toMatchObject({ _tag: "Wait", message: expect.stringContaining("ran again") });
    }).pipe(Effect.scoped),
  );

  it.live("waits when the last turn cannot be captured, and captures it on the next try", () =>
    Effect.gen(function* () {
      const world = yield* acquireWorld;
      const worktree = NodePath.join(world.root, "a1");
      world.git(world.repo, "worktree", "add", "--quiet", "-b", "goal/test/s0-a1", worktree);
      NodeFS.writeFileSync(NodePath.join(worktree, "notes.txt"), "not committed\n");
      // First the shell names a folder that is not a checkout, so the capture fails.
      let worktreePath = NodePath.join(world.root, "not-a-checkout");
      NodeFS.mkdirSync(worktreePath);
      yield* Effect.gen(function* () {
        const recovery = yield* GoalRecovery;
        expect(yield* recovery.resume(GOAL, 0, 2)).toMatchObject({
          _tag: "Wait",
          message: expect.stringContaining("could not be captured"),
        });
        worktreePath = worktree;
        expect(yield* recovery.resume(GOAL, 0, 2)).toMatchObject({
          _tag: "Start",
          workspace: { baseRef: expect.stringMatching(/^goat\/replica\//), startFromOrigin: false },
        });
      }).pipe(Effect.provide(recoveryAlone(world, () => stoppedShell(worktreePath, "run:1"))));
    }).pipe(Effect.scoped),
  );
});
