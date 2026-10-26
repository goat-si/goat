import * as Logger from "effect/Logger";
import * as MemorySnapshot from "../memory/MemorySnapshot.ts";
import type { MemoryTaskGrantCeiling } from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CommandId,
  CheckpointScopeId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  ProjectId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { worktreeThreadBusy } from "../mcp/WorktreeInventoryService.ts";
import * as CheckpointRollback from "./CheckpointRollbackService.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as ProviderTurnControl from "./ProviderTurnControlService.ts";
import * as RuntimeRequest from "./RuntimeRequestService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ResourceCleanup from "./ResourceCleanupService.ts";
import * as ServerSettings from "../serverSettings.ts";

import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as WorkspaceLease from "../workspace/workspaceLease.ts";
import {
  layerWorktreeLocation,
  makeLocalCommandHarness,
} from "./ProviderTurnStartService.localCommand.testkit.ts";

const managedWorktreesDir = "/tmp/provider-turn-start-worktrees";
// fs.realpath applies `..` and `.` before following symlinks.
const normalize = (target: string) => {
  const parts: Array<string> = [];
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
};

/** Starts a run on a thread whose worktree folder is missing, with routing reads failing after. */
function makeWorktreeStartHarness(
  branch: string | null,
  worktreePath = `${managedWorktreesDir}/project/feature-restore`,
  realPaths: Record<string, string> = {
    [managedWorktreesDir]: managedWorktreesDir,
    [`${managedWorktreesDir}/project`]: `${managedWorktreesDir}/project`,
  },
) {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project_provider_turn_start_projection_failure"),
      branch,
      worktreePath,
    },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    providerSessions: [],
    messages: [{ id: messageId, text: "Continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const pruneWorktrees = vi.fn(() => Effect.void);
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.succeed(FileSystem.FileSystem, {
          exists: () => Effect.succeed(false),
          // Paths that exist on the fake disk, mapped to where their symlinks lead.
          realPath: (target: string) =>
            normalize(target) in realPaths
              ? Effect.succeed(realPaths[normalize(target)])
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "realPath",
                    pathOrDescriptor: target,
                  }),
                ),
        } as never),
        layerWorktreeLocation(),
        Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees, createWorktree }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => {
            projectionReadCount += 1;
            return Effect.succeed(projection);
          },
          getTurnStartContext: () => {
            projectionReadCount += 1;
            return Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            });
          },
          getRuntimeRecoveryProjection: () => {
            projectionReadCount += 1;
            return Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: "simulated inherited-background projection failure",
              }),
            );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
      ),
    ),
  );

  return {
    layer,
    threadId,
    runId,
    pruneWorktrees,
    createWorktree,
    writeIfRunCurrent,
    startRootRun,
    projectionReadCount: () => projectionReadCount,
  };
}

it.each([
  { label: "with a branch", branch: "feature/restore" },
  { label: "without a branch", branch: null },
])(
  "recreates the checkout when possible and fails safely on a broken projection, $label",
  async ({ branch }) => {
    const harness = makeWorktreeStartHarness(branch);
    const {
      threadId,
      runId,
      layer,
      createWorktree,
      pruneWorktrees,
      writeIfRunCurrent,
      startRootRun,
    } = harness;
    await Effect.gen(function* () {
      const service = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
      const error = yield* service.start({ threadId, runId }).pipe(Effect.flip);
      expect(error._tag).toBe("ProviderTurnStartError");
      expect(harness.projectionReadCount()).toBe(2);
      if (branch === null) {
        expect(createWorktree).not.toHaveBeenCalled();
      } else {
        expect(pruneWorktrees).toHaveBeenCalledWith({ cwd: "/tmp/provider-turn-start-project" });
        expect(createWorktree).toHaveBeenCalledWith({
          cwd: "/tmp/provider-turn-start-project",
          refName: branch,
          path: `${managedWorktreesDir}/project/feature-restore`,
        });
      }
      expect(writeIfRunCurrent).not.toHaveBeenCalled();
      expect(startRootRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer), Effect.runPromise);
  },
);

it("settles the last contended start attempt instead of leaving its run starting", async () => {
  const { layer, threadId, runId, writeIfRunCurrent, createWorktree, startRootRun } =
    makeWorktreeStartHarness(null);
  await Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    yield* WorkspaceLease.withWorkspaceLease(
      `${managedWorktreesDir}/project/feature-restore`,
      Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(held);
    const service = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
    yield* service.start({ threadId, runId, willRetry: false });
    expect(writeIfRunCurrent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId,
        expectedStatus: "starting",
        events: expect.arrayContaining([
          expect.objectContaining({
            type: "run.updated",
            payload: expect.objectContaining({ status: "failed" }),
          }),
          expect.objectContaining({
            type: "run-attempt.updated",
            payload: expect.objectContaining({ status: "failed" }),
          }),
          expect.objectContaining({
            type: "node.updated",
            payload: expect.objectContaining({ status: "failed" }),
          }),
          expect.objectContaining({
            type: "turn-item.updated",
            payload: expect.objectContaining({
              type: "error",
              failure: expect.objectContaining({ message: expect.stringContaining("Retry") }),
            }),
          }),
        ]),
      }),
    );
    expect(createWorktree).not.toHaveBeenCalled();
    expect(startRootRun).not.toHaveBeenCalled();
  }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise);
});

function startWithMissingWorktree(worktreePath: string, realPaths?: Record<string, string>) {
  const harness = makeWorktreeStartHarness("feature/restore", worktreePath, realPaths);
  const {
    layer,
    threadId,
    runId,
    pruneWorktrees,
    createWorktree,
    writeIfRunCurrent,
    startRootRun,
  } = harness;
  const projectionReadCount = harness.projectionReadCount;
  const start = Effect.gen(function* () {
    return yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.flip);
  }).pipe(Effect.provide(layer), Effect.runPromise);
  return {
    start,
    pruneWorktrees,
    createWorktree,
    writeIfRunCurrent,
    startRootRun,
    projectionReads: projectionReadCount,
  };
}

it.each([
  {
    label: "<managed>/<repo>/<branch>",
    worktreePath: `${managedWorktreesDir}/project/feature-restore`,
    recreated: true,
  },
  {
    label: "the real path of a symlinked managed folder",
    worktreePath: "/real-worktrees/project/feature-restore",
    realPaths: { [managedWorktreesDir]: "/real-worktrees", "/real-worktrees": "/real-worktrees" },
    recreated: true,
  },
  {
    label: "a path outside the managed folder",
    worktreePath: "/tmp/provider-turn-start-project/.git/hooks",
    recreated: false,
  },
  {
    label: "a symlink inside the managed folder that leads out",
    worktreePath: `${managedWorktreesDir}/project/hooks`,
    realPaths: {
      [managedWorktreesDir]: managedWorktreesDir,
      [`${managedWorktreesDir}/project`]: "/tmp/provider-turn-start-project/.git",
    },
    recreated: false,
  },
  {
    label: "a folder nested below a worktree",
    worktreePath: `${managedWorktreesDir}/project/feature-restore/link/hooks`,
    recreated: false,
  },
  {
    label: "'..' out of the managed folder",
    worktreePath: `${managedWorktreesDir}/project/../../outside`,
    recreated: false,
  },
  {
    // Left raw on purpose: git follows `link` before applying `..`.
    label: "'..' after a symlink inside the managed folder",
    worktreePath: `${managedWorktreesDir}/project/x/link/../../hooks`,
    realPaths: {
      [managedWorktreesDir]: managedWorktreesDir,
      [`${managedWorktreesDir}/project`]: `${managedWorktreesDir}/project`,
      [`${managedWorktreesDir}/project/x`]: `${managedWorktreesDir}/project/x`,
      [`${managedWorktreesDir}/project/x/link`]: "/tmp/provider-turn-start-project/.git/refs/heads",
    },
    recreated: false,
  },
  { label: "a relative path", worktreePath: "project/feature-restore", recreated: false },
])("recreates a missing worktree only at the managed location: $label", async (input) => {
  const harness = startWithMissingWorktree(input.worktreePath, input.realPaths);
  await harness.start;
  expect(harness.createWorktree).toHaveBeenCalledTimes(input.recreated ? 1 : 0);
});

effectIt.effect("recovers an abandoned failed turn before continuing its native conversation", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running" },
    });

    yield* harness.start;

    expect(harness.interruptTurn).toHaveBeenCalledOnce();
    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    expect(harness.projection().providerTurns[0]).toMatchObject({
      status: "interrupted",
      completedAt: expect.anything(),
    });
    expect(harness.startRootRun).toHaveBeenCalledOnce();
    expect(harness.startRootRun.mock.calls[0]?.[0].providerThread.nativeThreadRef?.nativeId).toBe(
      "existing-native-conversation",
    );
  }),
);

effectIt.effect("hands the run worker the reason its Stop recorded, read for that run only", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running" },
    });
    yield* harness.start;
    const started = harness.startRootRun.mock.calls[0]![0];
    harness.setProjection({
      ...harness.projection(),
      turnItems: [
        {
          type: "run_interrupt_request",
          runId: harness.runId,
          message: "Stopped by an agent: done",
        },
      ],
    } as never);

    // Without it a late interrupted terminal records the Stop as the user's.
    expect(yield* started.loadRunInterruptReason!()).toBe("Stopped by an agent: done");
    expect(harness.getThreadRecords).toHaveBeenLastCalledWith(harness.threadId, ["turnItems"], {
      turnItemTypes: ["run_interrupt_request"],
      turnItemRunIds: [harness.runId],
    });
  }),
);

effectIt.effect.each([
  { runStatus: "failed", turnStatus: "completed" },
  { runStatus: "completed", turnStatus: "completed" },
  { runStatus: "failed", turnStatus: "running", differentThread: true },
  { runStatus: "failed", turnStatus: "running", liveSession: false },
  { runStatus: "failed", turnStatus: "interrupted", interruptFailure: true },
] as const)("continues without interrupting when recovery does not apply: %j", (previousTurn) =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", previousTurn });

    yield* harness.start;

    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("running");
  }),
);

effectIt.effect("does not start another turn when abandoned-turn cleanup fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running", interruptFailure: true },
    });

    yield* harness.start;

    expect(harness.interruptTurn).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
  }),
);

effectIt.effect("retries abandoned-turn cleanup without failing the continuation early", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running", interruptFailure: true },
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.open).not.toHaveBeenCalled();
  }),
);

effectIt.effect("does not start the continuation if recording recovery fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running" },
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.projection().providerTurns[0]?.status).toBe("running");
    expect(harness.open).not.toHaveBeenCalled();
  }),
);

effectIt.effect("does not resume a continuation stopped while recovery was in flight", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running", interruptCurrentRun: true },
    });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.open).not.toHaveBeenCalled();
  }),
);

/** Real SQL scheduling and executor; only provider I/O and the projection fixture are substituted. */
const leaseWorker = (
  type: "provider-turn.start" | "provider-turn.restart" = "provider-turn.start",
) =>
  Effect.gen(function* () {
    const worktreePath = "/tmp/contended-provider-turn-start";
    const harness = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* WorkspaceLease.withWorkspaceLease(
      worktreePath,
      Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(held);
    const outboxLayer = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
    const cleanupTerminals = vi.fn(() => Effect.void);
    const interruptAndAwaitTerminal = vi.fn(() => Effect.void);
    const detach = vi.fn(() => Effect.void);
    const executorLayer = EffectWorker.layerExecutor.pipe(
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          Layer.succeed(ResourceCleanup.ResourceCleanupService, {
            cleanupScheduledTasks: () => Effect.void,
            cleanupTerminals,
            cleanupPreviews: () => Effect.void,
            cleanupAttachments: () => Effect.void,
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ detach }),
          Layer.mock(CheckpointRollback.CheckpointRollbackServiceV2)({}),
          Layer.mock(RunFinalization.RunFinalizationService)({}),
          Layer.mock(ProviderTurnControl.ProviderTurnControlServiceV2)({
            interruptAndAwaitTerminal,
          }),
          Layer.mock(RuntimeRequest.RuntimeRequestServiceV2)({}),
          Layer.mock(ThreadTitleRegeneration.ThreadTitleRegenerationService)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          ServerSettings.layerTest(),
        ),
      ),
    );
    const workerLayer = EffectWorker.layerWithOptions({ workerId: "lease-test" }).pipe(
      Layer.provide(executorLayer),
      Layer.provideMerge(outboxLayer),
    );
    const services = yield* Layer.build(workerLayer);
    const outbox = Context.get(services, EffectOutbox.EffectOutboxV2);
    const worker = Context.get(services, EffectWorker.OrchestrationEffectWorkerV2);
    const effectId = "effect:contended-start";
    yield* outbox.enqueue([
      {
        id: effectId,
        commandId: CommandId.make("command:contended-start"),
        threadId: harness.threadId,
        request:
          type === "provider-turn.start"
            ? { type, runId: harness.runId }
            : {
                type,
                runId: harness.runId,
                providerSessionId: ProviderSessionId.make("old-provider-session"),
                providerThreadId: ProviderThreadId.make("old-provider-thread"),
                providerTurnId: ProviderTurnId.make("old-provider-turn"),
                interruptedAttemptId: RunAttemptId.make("old-attempt"),
                sessionTransition: { type: "detach" },
              },
      },
    ]);
    const row = outbox.get(effectId).pipe(Effect.map(Option.getOrThrow));
    return {
      ...harness,
      outbox,
      worker,
      effectId,
      row,
      cleanupTerminals,
      interruptAndAwaitTerminal,
      detach,
      release: Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(holder))),
    };
  });

for (const type of ["provider-turn.start", "provider-turn.restart"] as const) {
  effectIt.effect(
    `reclaims a contended ${type} after five minutes while freeing the only worker slot`,
    () =>
      Effect.gen(function* () {
        const h = yield* leaseWorker(type);
        expect(yield* h.worker.runOnce).toBe(true);
        expect(yield* h.row).toMatchObject({ status: "pending", attemptCount: 0 });
        expect(yield* h.worker.runOnce).toBe(false);
        yield* h.outbox.enqueue([
          {
            id: "effect:unrelated",
            commandId: CommandId.make("command:unrelated"),
            threadId: ThreadId.make("thread:unrelated"),
            request: { type: "terminal.cleanup" },
          },
        ]);
        expect(yield* h.worker.runOnce).toBe(true);
        expect(Option.getOrThrow(yield* h.outbox.get("effect:unrelated")).status).toBe("succeeded");
        expect(h.cleanupTerminals).toHaveBeenCalledExactlyOnceWith(
          ThreadId.make("thread:unrelated"),
        );
        // Explicit worker reclaims, no sleeps or manual start calls. Each one is
        // beyond the old 1.5-second failure budget, including the 5-minute git limit.
        for (let n = 0; n < 6; n++) {
          yield* TestClock.adjust("1 minute");
          expect(yield* h.worker.runOnce).toBe(true);
          expect(yield* h.row).toMatchObject({ status: "pending", attemptCount: 0 });
          const shell = ProjectionStore.threadShellFromProjection(h.projection());
          expect(shell.activeRunId).toBe(h.runId);
          expect(shell.status).toBe("starting");
          expect(worktreeThreadBusy(shell, DateTime.toEpochMillis(yield* DateTime.now))).toBe(true);
        }
        expect(h.open).not.toHaveBeenCalled();
        expect(h.writeIfRunCurrent).not.toHaveBeenCalled();
        yield* h.release;
        yield* TestClock.adjust("1 second");
        expect(yield* h.worker.runOnce).toBe(true);
        expect(yield* h.row).toMatchObject({ status: "succeeded", attemptCount: 1 });
        expect(h.projection().runs.at(-1)?.status).toBe("running");
        expect(h.startRootRun).toHaveBeenCalledOnce();
        if (type === "provider-turn.restart") {
          expect(h.interruptAndAwaitTerminal).toHaveBeenCalledTimes(8);
          expect(h.detach).toHaveBeenCalledTimes(8);
        }
      }).pipe(Effect.scoped),
  );
}

effectIt.effect("preserves earlier failures and defers even the final normal attempt", () =>
  Effect.gen(function* () {
    const h = yield* leaseWorker();
    // Seed four normal failures through the real claim/retry API. Deferral
    // must refund its own claim, never reset these previous attempts.
    for (let n = 0; n < 4; n++) {
      yield* h.outbox.claimNext({ workerId: "earlier-worker", leaseDurationMs: 30_000 });
      yield* h.outbox.retry({
        effectId: h.effectId,
        workerId: "earlier-worker",
        error: "earlier failure",
        delayMs: 0,
      });
    }
    expect(yield* h.worker.runOnce).toBe(true);
    expect(yield* h.row).toMatchObject({ status: "pending", attemptCount: 4 });
    expect(h.projection().runs.at(-1)?.status).toBe("starting");
    yield* h.release;
    yield* TestClock.adjust("1 second");
    expect(yield* h.worker.runOnce).toBe(true);
    expect(yield* h.row).toMatchObject({ status: "succeeded", attemptCount: 5 });
    expect(h.startRootRun).toHaveBeenCalledOnce();
  }).pipe(Effect.scoped),
);

for (const type of ["provider-turn.start", "provider-turn.restart"] as const) {
  effectIt.effect(`settles a still-contended ${type} only at its ten-minute deadline`, () =>
    Effect.gen(function* () {
      const h = yield* leaseWorker(type);
      yield* h.worker.runOnce;
      yield* TestClock.adjust("599 seconds");
      yield* h.worker.runOnce;
      expect(yield* h.row).toMatchObject({ status: "pending", attemptCount: 0 });
      expect(h.projection().runs.at(-1)?.status).toBe("starting");
      yield* TestClock.adjust("1 second");
      yield* h.worker.runOnce;
      expect(yield* h.row).toMatchObject({
        status: "succeeded",
        attemptCount: 1,
        lastError: null,
      });
      expect(h.projection().runs.at(-1)?.terminationCause).toEqual({ kind: "validation_error" });
      expect(h.projection().turnItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "error",
            title: "Workspace is busy",
            failure: expect.objectContaining({
              message: expect.stringContaining("workspace is busy"),
            }),
          }),
        ]),
      );
      expect(h.open).not.toHaveBeenCalled();
      expect(h.startRootRun).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );
}

// GOAT holds the workspace lease only while it prepares the checkout, and
// never waits for it: a start that finds cleanup holding the lease defers to
// the outbox retry, then recreates the removed checkout.
effectIt.effect("defers provider startup to a running cleanup and recreates its checkout", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-start-" });
    const worktreePath = path.join(workspaceRoot, "project", "worktree");
    yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
    const release = yield* Deferred.make<void>();
    const harness = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      worktreesDir: workspaceRoot,
      fileSystem,
      failReadsAfterRunning: true,
    });
    harness.createWorktree.mockImplementation(() =>
      fileSystem.makeDirectory(worktreePath).pipe(Effect.as({} as never), Effect.orDie),
    );
    const open = harness.open.getMockImplementation()!;
    harness.open.mockImplementation(() =>
      Effect.gen(function* () {
        expect(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie)).toBe(true);
        return yield* open();
      }),
    );
    const cleanup = yield* withWorkspaceLease(
      worktreePath,
      Deferred.await(release).pipe(
        Effect.andThen(fileSystem.remove(worktreePath, { recursive: true, force: true })),
      ),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    const deferred = yield* harness.startWithRetry.pipe(Effect.flip);
    expect(deferred._tag).toBe("ProviderTurnStartError");
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(cleanup);
    yield* harness.startWithRetry;
    expect(harness.createWorktree).toHaveBeenCalledWith({
      cwd: "/tmp/native-account-project",
      refName: "feature/restore",
      path: worktreePath,
    });
    expect(harness.resolveRuntimePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({ worktreePath }),
      }),
    );
    expect(harness.open).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
      }),
    );
    expect(harness.startRootRun).toHaveBeenCalledWith(
      expect.objectContaining({
        appThread: expect.objectContaining({ worktreePath }),
        runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

effectIt.effect("reads the turn-start context once and no full thread records", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });
    yield* harness.start;
    expect(harness.getThreadRecords).not.toHaveBeenCalled();
    expect(harness.getTurnStartContext).toHaveBeenCalledOnce();
    expect(harness.projection().runs.at(-1)?.status).toBe("completed");
  }),
);

// GOAT reads the context before trying the lease, so a deferred start reads it
// again on retry and sees a run that moved on meanwhile.
effectIt.effect("rereads startup state after deferring on the workspace lease", () =>
  Effect.gen(function* () {
    const worktreePath = "/tmp/provider-start-fresh-state";
    const release = yield* Deferred.make<void>();
    const harness = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    const holder = yield* withWorkspaceLease(worktreePath, Deferred.await(release)).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const error = yield* harness.startWithRetry.pipe(Effect.flip);
    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.getTurnStartContext).toHaveBeenCalledOnce();
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      runs: projection.runs.map((run) => ({ ...run, status: "running" })),
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* harness.startWithRetry;
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
  }),
);

effectIt.effect("starts another provider in the same checkout while a turn is pending", () =>
  Effect.gen(function* () {
    const worktreePath = "/tmp/provider-start-shared-checkout";
    const turnEntered = yield* Deferred.make<void>();
    const releaseTurn = yield* Deferred.make<void>();
    const first = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    const second = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    first.startRootRun.mockImplementation(() =>
      Deferred.succeed(turnEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseTurn))),
    );
    const pending = yield* first.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(turnEntered);
    yield* second.start;
    expect(second.startRootRun).toHaveBeenCalledOnce();
    expect(second.projection().runs.at(-1)?.status).toBe("running");
    yield* Deferred.succeed(releaseTurn, undefined);
    yield* Fiber.join(pending);
  }),
);

effectIt.effect("terminalizes a starting run when its provider session cannot open", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("DESCRIPTION is not valid ACP JSON"),
    });

    yield* harness.start;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        activeAttemptId: harness.attemptId,
        expectedStatus: "starting",
      }),
    );
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "DESCRIPTION is not valid ACP JSON",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a session-open failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a session-open failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not terminalize a provider-session open interruption", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", interruptOpen: true });

    const exit = yield* Effect.exit(harness.start);

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not overwrite a run interrupted while its provider session opens", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)?.status).toBe("interrupted");
    expect(projection.attempts[0]?.status).toBe("pending");
    expect(projection.nodes[0]?.status).toBe("pending");
    expect(projection.turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("fails a starting run when its last start attempt cannot load the thread", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("Pi RPC read failed: pi process exited with code 1."),
    });

    yield* harness.start;

    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider turn failed to start",
        failure: {
          class: "provider_error",
          message: "Pi RPC read failed: pi process exited with code 1.",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a thread-load failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a thread-load failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "keeps a store failure after the provider loaded the thread typed and retryable",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        historyReadFailureAfterFallback: new Error("database unavailable"),
      });

      const error = yield* harness.start.pipe(Effect.flip);

      expect(error._tag).toBe("ProviderTurnStartError");
      expect((error.cause as { _tag?: string } | undefined)?._tag).toBe("ProjectionStoreReadError");
      expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
      expect(harness.projection().runs.at(-1)?.status).toBe("starting");
      expect(harness.events).toEqual([]);
    }),
);

effectIt.effect("does not mistake a failed state read for a superseded run", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    const controls = harness.startRootRun.mock.calls[0]?.[0];
    expect(controls).toBeDefined();
    if (controls === undefined) return;
    const startCheck = yield* Effect.flip(controls.shouldStartProviderTurn!());
    const finalizeCheck = yield* Effect.flip(controls.shouldFinalizeRun!());
    expect(startCheck._tag).toBe("ProjectionStoreReadError");
    expect(finalizeCheck._tag).toBe("ProjectionStoreReadError");
  }),
);

effectIt.effect("does not overwrite a run interrupted while its thread loads", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.projection().turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "signs out the existing native provider before opening the newly selected provider",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });

      yield* harness.start;
      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
      });
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("completed");
      expect(projection.attempts[0]?.status).toBe("completed");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "command_execution",
          title: "Provider signed out",
          output: "Provider signed out",
          status: "completed",
        },
      ]);
      expect(projection.providerTurns).toEqual([]);
      expect(projection.checkpoints).toEqual([]);
    }),
);

effectIt.effect(
  "signs out the existing native provider before opening the newly selected provider",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });

      yield* harness.start;
      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
      });
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("completed");
      expect(projection.attempts[0]?.status).toBe("completed");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "command_execution",
          title: "Provider signed out",
          output: "Provider signed out",
          status: "completed",
        },
      ]);
      expect(projection.providerTurns).toEqual([]);
      expect(projection.checkpoints).toEqual([]);
    }),
);

for (const previousMessages of [[], ["/compact", " /COMPACT "]]) {
  effectIt.effect(
    `rejects compaction without conversation context after ${previousMessages.length} prior compactions`,
    () =>
      Effect.gen(function* () {
        const harness = makeLocalCommandHarness({ text: "/compact", previousMessages });

        yield* harness.start;

        expect(harness.open).not.toHaveBeenCalled();
        expect(harness.tryHandlePromptCommand).not.toHaveBeenCalled();
        expect(harness.startRootRun).not.toHaveBeenCalled();
        expect(harness.projection().runs.at(-1)?.status).toBe("failed");
        expect(harness.projection().turnItems).toMatchObject([
          {
            type: "error",
            failure: {
              class: "validation_error",
              message: "Start a conversation before compacting this thread.",
            },
          },
        ]);
      }),
  );
}

// Observe the closure installed by the real start service; authority is reread per send.
effectIt.effect("refreshes each send, omits none and failures, and fences a moved run", () =>
  Effect.gen(function* () {
    let grant: MemoryTaskGrantCeiling = "read_write";
    let fail = false;
    let interrupt = false;
    let threadReads = 0;
    let policyReads = 0;
    let moved = false;
    let selections = 0;
    let moveDuringRead = false;
    const diagnostics: Array<unknown> = [];
    const logger = Logger.make(({ message }) => diagnostics.push(message));
    const snapshot = { protocolVersion: 1, items: [], renderedText: "fixture frame" } as never;
    const harness = makeLocalCommandHarness({
      text: "Continue",
      failReadsAfterRunning: true,
      memory: {
        policy: () =>
          Effect.sync(() => {
            policyReads++;
            return { grant, policyEpoch: 7 };
          }),
        currentRun: () => {
          threadReads++;
          return moved ? undefined : RunId.make("run-native-account-command");
        },
        select: (_threadId, policy, currentPolicy) =>
          Effect.gen(function* () {
            selections++;
            if (interrupt) return yield* Effect.interrupt;
            expect(policy).toEqual(yield* currentPolicy);
            if (fail)
              return yield* new MemorySnapshot.MemorySnapshotError({
                cause: "fixture read failure",
              });
            if (moveDuringRead) moved = true;
            return snapshot;
          }),
      },
    });
    yield* harness.start;
    const refresh = harness.startRootRun.mock.calls[0]![0].refreshMemoryContext;
    expect(refresh).toBeDefined();
    expect(selections).toBe(0);
    expect(yield* refresh!()).toBe(snapshot);
    expect(yield* refresh!()).toBe(snapshot);
    expect(selections).toBe(2);
    grant = "none";
    const readsBeforeNone = threadReads;
    const policiesBeforeNone = policyReads;
    expect(yield* refresh!()).toBeUndefined();
    expect(selections).toBe(2);
    expect(threadReads).toBe(readsBeforeNone);
    expect(policyReads).toBe(policiesBeforeNone + 1);
    grant = "read";
    expect(yield* refresh!()).toBe(snapshot);
    fail = true;
    expect(yield* refresh!().pipe(Effect.provide(Logger.layer([logger])))).toBeUndefined();
    expect(diagnostics).toEqual([
      [
        "Memory refresh unavailable",
        { threadId: "thread-native-account-command", runId: "run-native-account-command" },
      ],
    ]);
    expect(selections).toBe(4);
    fail = false;
    moveDuringRead = true;
    expect(yield* refresh!()).toBeUndefined();
    expect(selections).toBe(5);
    moved = true;
    expect(yield* refresh!()).toBeUndefined();
    expect(selections).toBe(5);
    moved = false;
    moveDuringRead = false;
    interrupt = true;
    const exit = yield* Effect.exit(refresh!().pipe(Effect.provide(Logger.layer([logger]))));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(diagnostics).toHaveLength(1);
  }),
);
effectIt.effect.each([
  { boundary: "policy resolution", loss: "replaced" },
  { boundary: "session opening", loss: "interrupted" },
])("does not continue startup when $loss during $boundary", ({ boundary, loss }) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const gate = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
    const harness = makeLocalCommandHarness({ text: "Continue" });
    const projection = harness.projection();
    const providerThread = projection.providerThreads[0]!;
    const ensureThread = vi.fn(() => Effect.succeed(providerThread));
    const resumeThread = vi.fn(() => Effect.succeed(providerThread));
    const forkThread = vi.fn(() => Effect.succeed(providerThread));
    harness.open.mockReturnValue(
      (boundary === "session opening" ? gate : Effect.void).pipe(
        Effect.as({
          driver: providerThread.driver,
          ensureThread,
          resumeThread,
          forkThread,
        } as never),
      ),
    );
    if (boundary === "policy resolution") {
      harness.resolveRuntimePolicy.mockReturnValue(
        gate.pipe(Effect.as({ cwd: "/tmp/native-account-command" } as never)),
      );
    }

    const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const current = harness.projection();
    const replacementId = RunAttemptId.make("replacement-attempt");
    const updated = {
      ...current,
      runs: current.runs.map((candidate) =>
        loss === "replaced"
          ? { ...candidate, activeAttemptId: replacementId }
          : { ...candidate, status: "interrupted" as const, completedAt: current.updatedAt },
      ),
      attempts:
        loss === "replaced"
          ? [...current.attempts, { ...current.attempts[0]!, id: replacementId, attemptOrdinal: 2 }]
          : current.attempts,
    };
    harness.setProjection(updated);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(startup);

    expect(harness.open).toHaveBeenCalledTimes(boundary === "session opening" ? 1 : 0);
    expect(ensureThread).not.toHaveBeenCalled();
    expect(resumeThread).not.toHaveBeenCalled();
    expect(forkThread).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
    expect(harness.projection()).toEqual(updated);
  }),
);

effectIt.effect("sends the goat-discipline guidance with the message that names it", () =>
  Effect.gen(function* () {
    const sent = [];
    for (const text of ["Continue $goat-discipline", "Continue"]) {
      const harness = makeLocalCommandHarness({
        text,
        previousTurn: { runStatus: "completed", turnStatus: "completed" },
      });
      yield* harness.start;
      sent.push(harness.startRootRun.mock.calls[0]?.[0].message.text ?? "");
    }
    expect(sent[0]).toMatch(
      /^<goat_skill name="goat-discipline">[\s\S]*Continue \$goat-discipline$/,
    );
    expect(sent[1]).toBe("Continue");
  }),
);
