import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

interface Row {
  readonly restoreFiles?: boolean;
  readonly createFails?: boolean;
  readonly shared?: boolean;
  readonly unmanaged?: boolean;
  readonly checkout?: boolean;
  readonly empty?: boolean;
}

// A failed `git worktree remove` can leave the folder holding the person's files without its .git link.
const rollBackOverLeftover = (row: Row) =>
  Effect.gen(function* () {
    const { restoreFiles = true, createFails, shared, unmanaged, checkout, empty } = row;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-rollback-aside-" }),
    );
    const worktreesDir = path.join(workspaceRoot, "worktrees");
    const worktreePath = unmanaged
      ? path.join(workspaceRoot, "elsewhere", "feature")
      : path.join(worktreesDir, "repo", "feature");
    yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
    if (!empty) yield* fileSystem.writeFileString(path.join(worktreePath, "unsaved.txt"), "keep");
    if (checkout) yield* fileSystem.makeDirectory(path.join(worktreePath, ".git"));
    const threadId = ThreadId.make("rollback-aside");
    const projectId = ProjectId.make("rollback-aside-project");
    const providerThreadId = ProviderThreadId.make("rollback-aside-provider-thread");
    const providerInstanceId = ProviderInstanceId.make("rollback-aside-provider-instance");
    const checkpointId = CheckpointId.make("rollback-aside-checkpoint");
    const scopeId = CheckpointScopeId.make("rollback-aside-scope");
    const branch = "feature/rollback";
    const calls: string[] = [];
    const written: OrchestrationV2DomainEvent[] = [];
    const projection = {
      thread: {
        id: threadId,
        projectId,
        worktreePath,
        branch,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      },
      providerThread: {
        id: providerThreadId,
        providerSessionId: ProviderSessionId.make("rollback-aside-session"),
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
    const sharer = { id: ThreadId.make("rollback-aside-sharer"), projectId, worktreePath };
    const testLayer = CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ThreadCommandExecutor.layer,
          NodeServices.layer,
          Layer.mock(ServerConfig.ServerConfig)({ worktreesDir } as never),
          ServerSettings.layerTest(),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeedSome({ workspaceRoot } as never),
          }),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            pruneWorktrees: () => Effect.sync(() => void calls.push("prune")),
            createWorktree: (input) =>
              Effect.gen(function* () {
                assert.deepEqual(input, {
                  cwd: workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                });
                calls.push("create");
                // Git refuses a folder that is not empty, so a create that reaches here saw it moved.
                const entries = yield* fileSystem
                  .readDirectory(worktreePath)
                  .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
                assert.deepEqual(entries, []);
                yield* fileSystem
                  .makeDirectory(path.join(worktreePath, ".git"), { recursive: true })
                  .pipe(Effect.orDie);
                if (createFails) return yield* Effect.die("the branch is gone");
                return {} as never;
              }),
          }),
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            restore: () => Effect.sync(() => void calls.push("files")),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: ({ events }) =>
              Effect.sync(() => {
                calls.push("projection");
                written.push(...events);
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
                threads: shared ? [{ ...sharer, deletedAt: null, lineage: {} }] : [],
                archivedThreads: [],
              } as never),
            getCheckpointContext: () => Effect.succeed({ checkpointScopes: [] } as never),
            getThreadProviderContext: () => Effect.succeed({ providerSessions: [] } as never),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            open: () => Effect.sync(() => (calls.push("session"), {} as never)),
          }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({
            resolve: ({ thread }) => Effect.succeed({ cwd: thread.worktreePath } as never),
          }),
        ),
      ),
    );
    const exit = yield* Effect.gen(function* () {
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      return yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.exit);
    }).pipe(Effect.provide(testLayer));
    const siblings = (yield* fileSystem.readDirectory(path.dirname(worktreePath))).toSorted();
    const notices = written.flatMap((event) =>
      event.type === "turn-item.updated" && event.payload.type === "system_notice"
        ? [event.payload]
        : [],
    );
    const read = (target: string) =>
      fileSystem
        .readFileString(path.join(target, "unsaved.txt"))
        .pipe(Effect.orElseSucceed(() => null));
    const setAside = siblings.find((name) => name !== "feature");
    const setAsidePath =
      setAside === undefined ? null : path.join(path.dirname(worktreePath), setAside);
    return {
      exit,
      calls,
      siblings,
      notices,
      setAsidePath,
      inPlace: yield* read(worktreePath),
      setAsideFiles: setAsidePath === null ? null : yield* read(setAsidePath),
    };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect(
  "Edit from here sets aside a folder without .git holding unsaved files and names it",
  () =>
    Effect.gen(function* () {
      const { exit, calls, siblings, notices, setAsidePath, inPlace, setAsideFiles } =
        yield* rollBackOverLeftover({});
      assert.equal(exit._tag, "Success");
      assert.deepEqual(calls, ["prune", "create", "session", "files", "projection"]);
      assert.equal(siblings.length, 2);
      assert.match(setAsidePath ?? "", /feature-set-aside-[^/\\]+$/);
      assert.equal(setAsideFiles, "keep");
      assert.isNull(inPlace);
      assert.equal(notices.length, 1);
      assert.include(notices[0]?.message ?? "", setAsidePath ?? "missing");
    }),
);

// The shape "locks rollback with %s" used for a healthy worktree before the ported rule.
it.effect(
  "Edit from here recreates an empty folder without .git in place, setting nothing aside",
  () =>
    Effect.gen(function* () {
      const { exit, calls, siblings, notices } = yield* rollBackOverLeftover({ empty: true });
      assert.equal(exit._tag, "Success");
      assert.deepEqual(calls, ["prune", "create", "session", "files", "projection"]);
      assert.deepEqual(siblings, ["feature"]);
      assert.deepEqual(notices, []);
    }),
);

it.effect("a failed checkout puts the set-aside folder and its files back", () =>
  Effect.gen(function* () {
    const { exit, calls, siblings, notices, inPlace } = yield* rollBackOverLeftover({
      createFails: true,
    });
    assert.equal(exit._tag, "Failure");
    assert.deepEqual(calls, ["prune", "create"]);
    assert.deepEqual(siblings, ["feature"]);
    assert.equal(inPlace, "keep");
    assert.deepEqual(notices, []);
  }),
);

it.effect.each<Row & { readonly name: string; readonly rollsBack: boolean }>([
  { name: "a shared workspace", shared: true, rollsBack: false },
  { name: "a conversation-only rewind", restoreFiles: false, rollsBack: true },
  { name: "a folder that still has its checkout", checkout: true, rollsBack: true },
  { name: "a path outside GOAT's worktrees folder", unmanaged: true, rollsBack: true },
])("Edit from here leaves the folder in place for $name", (row) =>
  Effect.gen(function* () {
    const { exit, calls, siblings, notices, inPlace } = yield* rollBackOverLeftover(row);
    assert.equal(exit._tag, row.rollsBack ? "Success" : "Failure");
    assert.notInclude(calls, "create");
    assert.deepEqual(siblings, ["feature"]);
    assert.equal(inPlace, "keep");
    assert.deepEqual(notices, []);
  }),
);
