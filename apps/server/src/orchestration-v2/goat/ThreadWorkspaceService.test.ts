import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  ThreadWorkspaceRestoreError,
  type OrchestrationV2ThreadShell,
  type ProjectId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { shell as storageShell } from "../../storageCleanup.testFixtures.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { tryWithWorkspaceLease } from "../../workspace/workspaceLease.ts";
import { WorktreeSnapshotStore } from "../../worktreeSnapshots/WorktreeSnapshotStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import * as ThreadWorkspace from "./ThreadWorkspaceService.ts";

const threadId = ThreadId.make("thread-1");

const harness = (
  thread: OrchestrationV2ThreadShell,
  dispatchFails = false,
  setupExitCode: number | null = null,
) => {
  const calls = {
    created: [] as string[],
    removed: [] as string[],
    dispatched: [] as unknown[],
    newWorktreeFreeDuringSetup: [] as boolean[],
  };
  const fakes = Layer.mergeAll(
    Layer.succeed(ProjectionStore.ProjectionStoreV2, {
      getThreadShell: () => Effect.succeed(thread),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
    Layer.succeed(ProjectService.ProjectService, {
      getById: () => Effect.succeedSome({ id: "project-1" as ProjectId, workspaceRoot: "/repo" }),
    } as unknown as ProjectService.ProjectService["Service"]),
    Layer.succeed(GitWorkflowService.GitWorkflowService, {
      createWorktree: (input: { readonly newRefName?: string }) =>
        Effect.sync(() => {
          calls.created.push(input.newRefName ?? "");
          return { worktree: { path: "/worktrees/fresh", refName: input.newRefName ?? "" } };
        }),
      removeWorktree: (input: { readonly path: string }) =>
        Effect.sync(() => void calls.removed.push(input.path)),
    } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
    Layer.succeed(GitVcsDriver.GitVcsDriver, {
      resolveCommit: () => Effect.succeed({ commitSha: "abc" }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
    Layer.succeed(ThreadManagement.ThreadManagementService, {
      dispatch: (command: unknown) =>
        dispatchFails
          ? Effect.fail(
              new ThreadWorkspaceRestoreError({
                threadId,
                reason: "busy",
                detail: "binding changed",
              }),
            )
          : Effect.sync(() => void calls.dispatched.push(command)),
    } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    Layer.succeed(WorktreeSnapshotStore, {
      capture: () => Effect.die("unused"),
      latestForThread: () => Effect.succeed(null),
      markRestored: () => Effect.void,
      deleteForThread: () => Effect.succeed(0),
      purgeDeletedThreads: () => Effect.succeed(0),
      expire: () => Effect.succeed(0),
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: (input) =>
        tryWithWorkspaceLease(input.worktreePath, Effect.void).pipe(
          Effect.orElseSucceed(() => Option.none()),
          Effect.map((held) => {
            calls.newWorktreeFreeDuringSetup.push(Option.isSome(held));
            return setupExitCode === null
              ? { status: "no-script" as const }
              : {
                  status: "started" as const,
                  scriptId: "setup",
                  scriptName: "setup",
                  scriptCommand: "true",
                  terminalId: "terminal-1",
                  cwd: input.worktreePath,
                  async: false,
                  completion: Effect.succeed({ exitCode: setupExitCode, durationMs: 1 }),
                };
          }),
        ),
    }),
    ServerSettings.ServerSettingsService.layerTest(),
    ServerConfig.layerTest(process.cwd(), { prefix: "thread-workspace-test-" }),
  );
  const layer = ThreadWorkspace.layer.pipe(
    Layer.provide(fakes),
    Layer.provideMerge(NodeServices.layer),
  );
  return { calls, layer };
};

const idle = storageShell({ branch: "feature", worktreePath: "/worktrees/feature" });

it.effect("will not replace the worktree of a thread that is running", () => {
  const { calls, layer } = harness({ ...idle, activeRunId: "run-1" as never });
  return Effect.gen(function* () {
    const service = yield* ThreadWorkspace.ThreadWorkspaceService;
    const error = yield* Effect.flip(service.restore({ threadId, mode: "fresh" }));
    assert.equal(error.reason, "busy");
    assert.deepEqual(calls.created, []);
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("rebinds only if the thread still uses the worktree it replaced", () => {
  const { calls, layer } = harness(idle);
  return Effect.gen(function* () {
    const service = yield* ThreadWorkspace.ThreadWorkspaceService;
    const result = yield* service.restore({ threadId, mode: "fresh" });
    assert.equal(result.restoredFrom, "fresh");
    assert.equal(result.worktreePath, "/worktrees/fresh");
    assert.deepInclude(calls.dispatched[0] as object, {
      type: "thread.metadata.update",
      worktreePath: "/worktrees/fresh",
      expectedWorktreePath: "/worktrees/feature",
      expectedBranch: "feature",
    });
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("removes the new worktree when another change won the rebinding", () => {
  const { calls, layer } = harness(idle, true);
  return Effect.gen(function* () {
    const service = yield* ThreadWorkspace.ThreadWorkspaceService;
    const error = yield* Effect.flip(service.restore({ threadId, mode: "fresh" }));
    assert.equal(error.reason, "git-failed");
    assert.deepEqual(calls.removed, ["/worktrees/fresh"]);
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("keeps the new worktree leased through setup, and a failed setup never rebinds", () => {
  const { calls, layer } = harness(idle, false, 1);
  return Effect.gen(function* () {
    const service = yield* ThreadWorkspace.ThreadWorkspaceService;
    const error = yield* Effect.flip(service.restore({ threadId, mode: "fresh" }));
    assert.equal(error.reason, "setup-failed");
    // A turn trying the new folder during setup is turned away instead of starting there.
    assert.deepEqual(calls.newWorktreeFreeDuringSetup, [false]);
    assert.deepEqual(calls.dispatched, []);
    assert.deepEqual(calls.removed, ["/worktrees/fresh"]);
  }).pipe(Effect.provide(layer), Effect.scoped);
});
