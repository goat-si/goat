import {
  layerCheckpointRollbackService,
  unrelatedProject,
} from "./CheckpointRollbackService.test-support.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import { symlinksSupported } from "@goat/shared/testing/symlinks";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import { isCheckpointRestoreIsolated } from "./CheckpointRestoreSafety.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

it.effect.each(["initial", "waiting"])(
  "rejects a non-ready checkpoint from %s before opening a session or restoring files",
  (state) => {
    const threadId = ThreadId.make("thread:rollback-non-ready");
    const providerThreadId = ProviderThreadId.make("provider-thread:rollback-non-ready");
    const providerSessionId = ProviderSessionId.make("provider-session:rollback-non-ready");
    const checkpointId = CheckpointId.make("checkpoint:rollback-non-ready");
    const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-non-ready");
    const providerInstanceId = ProviderInstanceId.make("provider_rollback_non_ready");
    const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
    const open = vi.fn(() => Effect.die("provider session open must not run"));
    const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
    const readEntered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let projection = {
      thread: {
        worktreePath: process.cwd(),
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
        deletedAt: null,
      },
      providerThread: { id: providerThreadId, providerSessionId, providerInstanceId },
      checkpoint: {
        id: checkpointId,
        scopeId,
        status: state === "waiting" ? "ready" : "stale",
        appRunOrdinal: 0,
      },
      scope: { id: scopeId, cwd: process.cwd() },
    } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
    const getThread = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThread"]>(() =>
      Deferred.succeed(readEntered, undefined).pipe(Effect.as(projection.thread)),
    );
    const getCheckpointRollbackContext = vi.fn(() => Effect.succeed(projection));
    const testLayer = layerCheckpointRollbackService.pipe(
      Layer.provide(
        Layer.mergeAll(
          ThreadCommandExecutor.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ restore }),
          Layer.mock(EventSink.EventSinkV2)({}),
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread,
            getCheckpointRollbackContext,
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      const holder =
        state === "waiting"
          ? yield* withWorkspaceLease(process.cwd(), Deferred.await(release)).pipe(
              Effect.forkChild({ startImmediately: true }),
            )
          : undefined;
      const rollback = yield* service
        .execute({
          threadId,
          providerThreadId,
          checkpointId,
          scopeId,
        })
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      if (state === "waiting") {
        yield* Deferred.await(readEntered);
        projection = {
          ...projection,
          checkpoint: { ...projection.checkpoint!, status: "stale" },
        };
        yield* Deferred.succeed(release, undefined);
        if (holder !== undefined) yield* Fiber.join(holder);
      }
      const error = yield* Fiber.join(rollback);

      assert.deepEqual(getThread.mock.calls, [[threadId]]);
      assert.deepEqual(getCheckpointRollbackContext.mock.calls, [
        [
          threadId,
          {
            threadId,
            providerThreadId,
            checkpointId,
            scopeId,
          },
        ],
      ]);
      assert.equal(error.reason, "rollback-target-invalid");
      assert.equal(
        error.message,
        `Rollback target ${checkpointId} for provider thread ${providerThreadId} on thread ${threadId} is incomplete or invalid.`,
      );
      assert.equal(error.cause, undefined);
      assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
      assert.equal(open.mock.calls.length, 0);
      assert.equal(restore.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  },
);
it.effect.each([
  { order: "cleanup-first", restoreFiles: true },
  { order: "rollback-first", restoreFiles: true },
  { order: "cleanup-first", restoreFiles: false, unmanaged: true },
])("locks rollback with %s", ({ order, restoreFiles, unmanaged = false }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-rollback-" }),
    );
    yield* fileSystem.makeDirectory(path.join(workspaceRoot, ".git"), { recursive: true });
    const worktreesDir = path.join(workspaceRoot, "worktrees");
    const worktreePath = unmanaged
      ? path.join(workspaceRoot, "elsewhere", "feature")
      : path.join(worktreesDir, "repo", "feature");
    yield* fileSystem.makeDirectory(path.join(worktreePath, ".git"), { recursive: true });
    const threadId = ThreadId.make("rollback-worktree");
    const projectId = ProjectId.make("rollback-worktree-project");
    const providerThreadId = ProviderThreadId.make("rollback-worktree-provider-thread");
    const providerSessionId = ProviderSessionId.make("rollback-worktree-provider-session");
    const providerInstanceId = ProviderInstanceId.make("rollback-worktree-provider-instance");
    const checkpointId = CheckpointId.make("rollback-worktree-checkpoint");
    const scopeId = CheckpointScopeId.make("rollback-worktree-scope");
    const branch = "feature/rollback";
    const release = Deferred.makeUnsafe<void>();
    const openEntered = Deferred.makeUnsafe<void>();
    const calls: string[] = [];
    let cleanupEntered = false;
    const providerThread = { id: providerThreadId, providerSessionId, providerInstanceId };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        worktreePath,
        branch,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
        deletedAt: null,
      },
      providerThread,
      providerSession: undefined,
      checkpoint: { id: checkpointId, scopeId, status: "ready", appRunOrdinal: 0 },
      scope: { id: scopeId, cwd: worktreePath },
      runsToRollback: [],
      targetAttempt: undefined,
      rolledBackAttemptIds: [],
      staleCheckpoints: [],
      rootNodes: [],
      providerTurns: [],
    } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
    const testLayer = CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ThreadCommandExecutor.layer,
          NodeServices.layer,
          Layer.mock(ServerConfig.ServerConfig)({ worktreesDir, stateDir: workspaceRoot } as never),
          ServerSettings.layerTest(),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (id) => {
              assert.equal(id, projectId);
              return Effect.succeedSome({ workspaceRoot } as never);
            },
          }),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            pruneWorktrees: (input) =>
              Effect.sync(() => {
                assert.deepEqual(input, { cwd: workspaceRoot });
                calls.push("prune");
              }),
            resolveCommit: () => Effect.succeed({ commitSha: "fixture-head" }),
            verifyManagedCheckout: () => Effect.void,
            createWorktree: (input) =>
              Effect.gen(function* () {
                assert.deepEqual(input, {
                  cwd: workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                });
                calls.push("create");
                yield* fileSystem.makeDirectory(worktreePath).pipe(Effect.orDie);
                return {} as never;
              }),
          }),
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            restore: () =>
              Effect.gen(function* () {
                assert.isTrue(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie));
                calls.push("files");
              }),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: () =>
              Effect.sync(() => {
                calls.push("projection");
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread: () => Effect.succeed(projection.thread),
            getCheckpointRollbackContext: () => Effect.succeed(projection),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            open: (input) =>
              Effect.gen(function* () {
                assert.equal(input.runtimePolicy.cwd, worktreePath);
                if (!(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie))) {
                  return yield* new ProviderWorkspaceMissingError({ threadId, cwd: worktreePath });
                }
                calls.push("session");
                yield* Deferred.succeed(openEntered, undefined);
                if (order === "rollback-first") yield* Deferred.await(release);
                return {} as never;
              }),
          }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({
            resolve: ({ thread }) => {
              assert.equal(thread.worktreePath, worktreePath);
              return Effect.succeed({ cwd: thread.worktreePath } as never);
            },
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      const cleanupEffect = withWorkspaceLease(
        worktreePath,
        Effect.gen(function* () {
          cleanupEntered = true;
          if (order === "cleanup-first") yield* Deferred.await(release);
          yield* fileSystem.remove(worktreePath, { recursive: true, force: true });
          calls.push("cleanup");
        }),
      );
      const cleanup =
        order === "cleanup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      const rollback = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.forkChild({ startImmediately: true }));
      if (order === "cleanup-first") assert.deepEqual(calls, []);
      if (order === "rollback-first") yield* Deferred.await(openEntered);
      const laterCleanup =
        order === "rollback-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      if (order === "rollback-first") assert.isFalse(cleanupEntered);
      yield* Deferred.succeed(release, undefined);
      if (cleanup !== undefined) yield* Fiber.join(cleanup);
      if (unmanaged) {
        const error = yield* Fiber.join(rollback).pipe(Effect.flip);
        assert.equal(error._tag, "CheckpointRollbackExecutionError");
        assert.deepEqual(calls, ["cleanup"]);
        return;
      }
      yield* Fiber.join(rollback);
      if (laterCleanup !== undefined) yield* Fiber.join(laterCleanup);
      const rollbackCalls = restoreFiles
        ? ["session", "files", "projection"]
        : ["session", "projection"];
      assert.deepEqual(
        calls,
        order === "cleanup-first"
          ? ["cleanup", "prune", "create", ...rollbackCalls]
          : [...rollbackCalls, "cleanup"],
      );
    }).pipe(Effect.provide(testLayer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { order: "normal", restoreFiles: true },
  { order: "cleanup-first", restoreFiles: true },
  { order: "cleanup-first", restoreFiles: false },
  { order: "rollback-first", restoreFiles: true },
  // A path the server would not have made is left missing, not recreated.
  { order: "cleanup-first", restoreFiles: false, unmanaged: true },
])("locks rollback with %s", ({ order, restoreFiles, unmanaged = false }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-rollback-" }),
    );
    yield* fileSystem.makeDirectory(path.join(workspaceRoot, ".git"), { recursive: true });
    const worktreesDir = path.join(workspaceRoot, "worktrees");
    const worktreePath = unmanaged
      ? path.join(workspaceRoot, "elsewhere", "feature")
      : path.join(worktreesDir, "repo", "feature");
    yield* fileSystem.makeDirectory(path.join(worktreePath, ".git"), { recursive: true });
    const threadId = ThreadId.make("rollback-worktree");
    const projectId = ProjectId.make("rollback-worktree-project");
    const providerThreadId = ProviderThreadId.make("rollback-worktree-provider-thread");
    const providerSessionId = ProviderSessionId.make("rollback-worktree-provider-session");
    const providerInstanceId = ProviderInstanceId.make("rollback-worktree-provider-instance");
    const checkpointId = CheckpointId.make("rollback-worktree-checkpoint");
    const scopeId = CheckpointScopeId.make("rollback-worktree-scope");
    const branch = "feature/rollback";
    const release = Deferred.makeUnsafe<void>();
    const openEntered = Deferred.makeUnsafe<void>();
    const calls: string[] = [];
    let cleanupEntered = false;
    const providerThread = { id: providerThreadId, providerSessionId, providerInstanceId };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        deletedAt: null,
        worktreePath,
        branch,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      },
      providerThreads: [providerThread],
      providerSessions: [],
      checkpoints: [{ id: checkpointId, scopeId, status: "ready", appRunOrdinal: 0 }],
      checkpointScopes: [{ id: scopeId, cwd: worktreePath }],
      runs: [],
      attempts: [],
      nodes: [],
      providerTurns: [],
    } as unknown as OrchestrationV2ThreadProjection;
    const testLayer = CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ThreadCommandExecutor.layer,
          NodeServices.layer,
          Layer.mock(ServerConfig.ServerConfig)({ worktreesDir, stateDir: workspaceRoot } as never),
          ServerSettings.layerTest(),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (id) => {
              assert.equal(id, projectId);
              return Effect.succeed(Option.some({ workspaceRoot } as never));
            },
          }),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            pruneWorktrees: (input) =>
              Effect.sync(() => {
                assert.deepEqual(input, { cwd: workspaceRoot });
                calls.push("prune");
              }),
            resolveCommit: () => Effect.succeed({ commitSha: "fixture-head" }),
            verifyManagedCheckout: () => Effect.void,
            createWorktree: (input) =>
              Effect.gen(function* () {
                assert.deepEqual(input, {
                  cwd: workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                });
                calls.push("create");
                yield* fileSystem.makeDirectory(worktreePath).pipe(Effect.orDie);
                return {} as never;
              }),
          }),
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            restore: () =>
              Effect.gen(function* () {
                assert.isTrue(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie));
                calls.push("files");
              }),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: () =>
              Effect.sync(() => {
                calls.push("projection");
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread: () => Effect.succeed(projection.thread),
            getCheckpointRollbackContext: () =>
              Effect.succeed({
                thread: projection.thread,
                providerThread: projection.providerThreads[0],
                providerSession: undefined,
                checkpoint: projection.checkpoints[0],
                scope: projection.checkpointScopes[0],
                targetAttempt: undefined,
                runsToRollback: [],
                staleCheckpoints: [],
                rolledBackAttemptIds: [],
                providerTurns: [],
                rootNodes: [],
              }),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            open: (input) =>
              Effect.gen(function* () {
                assert.equal(input.runtimePolicy.cwd, worktreePath);
                if (!(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie))) {
                  return yield* new ProviderWorkspaceMissingError({ threadId, cwd: worktreePath });
                }
                calls.push("session");
                yield* Deferred.succeed(openEntered, undefined);
                if (order === "rollback-first") yield* Deferred.await(release);
                return {} as never;
              }),
          }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({
            resolve: ({ thread }) => {
              assert.equal(thread.worktreePath, worktreePath);
              return Effect.succeed({ cwd: thread.worktreePath } as never);
            },
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      const cleanupEffect = withWorkspaceLease(
        worktreePath,
        Effect.gen(function* () {
          cleanupEntered = true;
          if (order === "cleanup-first") yield* Deferred.await(release);
          yield* fileSystem.remove(worktreePath, { recursive: true, force: true });
          calls.push("cleanup");
        }),
      );
      const cleanup =
        order === "cleanup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      const rollback = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.forkChild({ startImmediately: true }));
      if (order === "cleanup-first") assert.deepEqual(calls, []);
      if (order === "rollback-first") yield* Deferred.await(openEntered);
      const laterCleanup =
        order === "rollback-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      if (order === "rollback-first") assert.isFalse(cleanupEntered);
      yield* Deferred.succeed(release, undefined);
      if (cleanup !== undefined) yield* Fiber.join(cleanup);
      if (unmanaged) {
        const error = yield* Fiber.join(rollback).pipe(Effect.flip);
        assert.equal(error._tag, "CheckpointRollbackExecutionError");
        assert.deepEqual(calls, ["cleanup"]);
        return;
      }
      yield* Fiber.join(rollback);
      if (laterCleanup !== undefined) yield* Fiber.join(laterCleanup);
      const rollbackCalls = restoreFiles
        ? ["session", "files", "projection"]
        : ["session", "projection"];
      assert.deepEqual(
        calls,
        order === "cleanup-first"
          ? ["cleanup", "prune", "create", ...rollbackCalls]
          : order === "rollback-first"
            ? [...rollbackCalls, "cleanup"]
            : rollbackCalls,
      );
    }).pipe(Effect.provide(testLayer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(!symlinksSupported)(
  "rejects an archived thread sharing a worktree through a symlink",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-restore-isolation-" });
      const path = yield* Path.Path;
      const alias = path.join(cwd, "alias");
      yield* fileSystem.symlink(cwd, alias);
      const threadId = ThreadId.make("restore-alias-current");
      const otherId = ThreadId.make("restore-alias-archived");
      const projections = ProjectionStore.ProjectionStoreV2.of({
        getReviewLedgerEntries: () => Effect.die("unused review ledger query"),
        getShellSnapshot: () =>
          Effect.succeed({
            schemaVersion: 1,
            snapshotSequence: 0,
            threads: [],
            archivedThreads: [{ id: otherId, deletedAt: null, worktreePath: alias } as never],
          }),
        getThreadProviderContext: () => Effect.succeed({ providerSessions: [] } as never),
        getCheckpointContext: () =>
          Effect.succeed({ runs: [], checkpointScopes: [], checkpoints: [] }),
      } as never);
      const isolated = yield* isCheckpointRestoreIsolated(
        { id: threadId, worktreePath: cwd },
        { cwd },
        {
          fileSystem,
          path,
          projections,
          projects: ProjectStore.ProjectStoreV2.of({
            get: () => Effect.succeed(unrelatedProject),
          } as never),
        },
      );
      assert.isFalse(isolated);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
