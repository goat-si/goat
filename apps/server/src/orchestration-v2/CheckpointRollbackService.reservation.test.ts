import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { tryTurnStartReservation } from "../workspace/testkit/turnStartReservation.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

it.effect.each([{ restoreFiles: true }, { restoreFiles: false }])(
  "turn starts inside the worktree go back to retry during a rollback with restoreFiles $restoreFiles",
  ({ restoreFiles }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-rollback-reservation-" }),
      );
      const worktreesDir = path.join(workspaceRoot, "worktrees");
      const worktreePath = path.join(worktreesDir, "repo", "feature");
      yield* fileSystem.makeDirectory(path.join(worktreePath, ".git"), { recursive: true });
      const threadId = ThreadId.make("rollback-reservation");
      const providerThreadId = ProviderThreadId.make("rollback-reservation-provider-thread");
      const providerInstanceId = ProviderInstanceId.make("rollback-reservation-provider");
      const checkpointId = CheckpointId.make("rollback-reservation-checkpoint");
      const scopeId = CheckpointScopeId.make("rollback-reservation-scope");
      const release = Deferred.makeUnsafe<void>();
      const openEntered = Deferred.makeUnsafe<void>();
      const restoreEntered = Deferred.makeUnsafe<void>();
      const releaseRestore = Deferred.makeUnsafe<void>();
      const projection = {
        thread: {
          id: threadId,
          projectId: ProjectId.make("rollback-reservation-project"),
          worktreePath,
          branch: "feature/rollback-reservation",
          activeProviderThreadId: providerThreadId,
          modelSelection: { instanceId: providerInstanceId, model: "test-model" },
        },
        providerThread: {
          id: providerThreadId,
          providerSessionId: ProviderSessionId.make("rollback-reservation-session"),
          providerInstanceId,
        },
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
            Layer.mock(ServerConfig.ServerConfig)({
              worktreesDir,
              stateDir: workspaceRoot,
            } as never),
            ServerSettings.layerTest(),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              get: () => Effect.succeedSome({ workspaceRoot } as never),
            }),
            Layer.mock(GitWorkflow.GitWorkflowService)({}),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              restore: () =>
                Deferred.succeed(restoreEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseRestore)),
                ),
            }),
            Layer.mock(EventSink.EventSinkV2)({ write: () => Effect.succeed([]) }),
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
              open: () =>
                Deferred.succeed(openEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({} as never),
                ),
            }),
            Layer.mock(RuntimePolicy.RuntimePolicyV2)({
              resolve: () => Effect.succeed({ cwd: worktreePath } as never),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
        const rollback = yield* service
          .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(openEntered);
        const startTurn = tryTurnStartReservation(
          fileSystem,
          path,
          path.join(worktreePath, "packages", "app"),
          Effect.succeed("started"),
        );
        if (restoreFiles) {
          assert.isTrue(Option.isNone(yield* startTurn));
          yield* Deferred.succeed(release, undefined);
          // Still held while files are being restored, not only during the provider rollback.
          yield* Deferred.await(restoreEntered);
          assert.isTrue(Option.isNone(yield* startTurn));
          yield* Deferred.succeed(releaseRestore, undefined);
        } else {
          // Nothing is rewritten, so a turn start does not wait for the provider.
          assert.deepStrictEqual(yield* startTurn, Option.some("started"));
          yield* Deferred.succeed(release, undefined);
        }
        yield* Fiber.join(rollback);
        assert.deepStrictEqual(yield* startTurn, Option.some("started"));
      }).pipe(Effect.provide(testLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
