// @effect-diagnostics nodeBuiltinImport:off -- the fresh worktree is a real Git fixture.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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

interface HarnessOptions {
  readonly dispatchFails?: boolean;
  readonly setupExitCode?: number | null;
  readonly duringSetup?: (worktreePath: string) => void;
}

const harness = Effect.fn("ThreadWorkspaceTest.harness")(function* (
  thread: OrchestrationV2ThreadShell,
  options: HarnessOptions = {},
) {
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-fresh-test-"))),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );
  const repo = NodePath.join(root, "repo");
  const freshPath = NodePath.join(root, "fresh");
  const git = (cwd: string, ...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd, stdio: "ignore" });
  NodeFS.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(
    repo,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "base",
  );
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
      getById: () => Effect.succeedSome({ id: "project-1" as ProjectId, workspaceRoot: repo }),
    } as unknown as ProjectService.ProjectService["Service"]),
    Layer.succeed(GitWorkflowService.GitWorkflowService, {
      createWorktree: (input: { readonly newRefName?: string }) =>
        Effect.sync(() => {
          const refName = input.newRefName ?? "";
          calls.created.push(refName);
          git(repo, "worktree", "add", "-q", "-b", refName, freshPath, "HEAD");
          return { worktree: { path: freshPath, refName } };
        }),
      removeWorktree: (input: { readonly path: string }) =>
        Effect.sync(() => void calls.removed.push(input.path)),
    } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
    GitVcsDriver.layer.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "thread-workspace-git-" })),
      Layer.provide(NodeServices.layer),
    ),
    Layer.succeed(ThreadManagement.ThreadManagementService, {
      dispatch: (command: unknown) =>
        options.dispatchFails === true
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
            options.duringSetup?.(input.worktreePath);
            const exitCode = options.setupExitCode ?? null;
            return exitCode === null
              ? { status: "no-script" as const }
              : {
                  status: "started" as const,
                  scriptId: "setup",
                  scriptName: "setup",
                  scriptCommand: "true",
                  terminalId: "terminal-1",
                  cwd: input.worktreePath,
                  async: false,
                  // Like the real runner, the exit code is reported only to a caller that asks.
                  ...(input.observeCompletion === undefined
                    ? {}
                    : { completion: Effect.succeed({ exitCode, durationMs: 1 }) }),
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
  return { calls, layer, freshPath, git };
});

const idle = storageShell({ branch: "feature", worktreePath: "/worktrees/feature" });

it.effect("will not replace the worktree of a thread that is running", () =>
  Effect.gen(function* () {
    const { calls, layer } = yield* harness({ ...idle, activeRunId: "run-1" as never });
    const service = yield* ThreadWorkspace.ThreadWorkspaceService.pipe(Effect.provide(layer));
    const error = yield* Effect.flip(service.restore({ threadId, mode: "fresh" }));
    assert.equal(error.reason, "busy");
    assert.deepEqual(calls.created, []);
  }).pipe(Effect.scoped),
);

it.effect("rebinds only if the thread still uses the worktree it replaced", () =>
  Effect.gen(function* () {
    const { calls, layer, freshPath } = yield* harness(idle, { setupExitCode: 0 });
    const service = yield* ThreadWorkspace.ThreadWorkspaceService.pipe(Effect.provide(layer));
    const result = yield* service.restore({ threadId, mode: "fresh" });
    assert.equal(result.restoredFrom, "fresh");
    assert.equal(result.worktreePath, freshPath);
    assert.deepInclude(calls.dispatched[0] as object, {
      type: "thread.metadata.update",
      worktreePath: freshPath,
      expectedWorktreePath: "/worktrees/feature",
      expectedBranch: "feature",
    });
  }).pipe(Effect.scoped),
);

it.effect("removes the new worktree when another change won the rebinding", () =>
  Effect.gen(function* () {
    const { calls, layer, freshPath } = yield* harness(idle, { dispatchFails: true });
    const service = yield* ThreadWorkspace.ThreadWorkspaceService.pipe(Effect.provide(layer));
    const error = yield* Effect.flip(service.restore({ threadId, mode: "fresh" }));
    assert.equal(error.reason, "git-failed");
    assert.deepEqual(calls.removed, [freshPath]);
  }).pipe(Effect.scoped),
);

it.effect("keeps the new worktree leased through setup, and a failed setup never rebinds", () =>
  Effect.gen(function* () {
    const { calls, layer, freshPath } = yield* harness(idle, { setupExitCode: 1 });
    const service = yield* ThreadWorkspace.ThreadWorkspaceService.pipe(Effect.provide(layer));
    const error = yield* Effect.flip(service.restore({ threadId, mode: "fresh" }));
    assert.equal(error.reason, "setup-failed");
    // A turn trying the new folder during setup is turned away instead of starting there.
    assert.deepEqual(calls.newWorktreeFreeDuringSetup, [false]);
    assert.deepEqual(calls.dispatched, []);
    assert.deepEqual(calls.removed, [freshPath]);
  }).pipe(Effect.scoped),
);

it.effect("refuses a fresh worktree that setup moved off its branch", () =>
  Effect.gen(function* () {
    const { calls, layer, freshPath, git } = yield* harness(idle, {
      setupExitCode: 0,
      duringSetup: (worktreePath) => void git(worktreePath, "checkout", "-q", "--detach"),
    });
    const service = yield* ThreadWorkspace.ThreadWorkspaceService.pipe(Effect.provide(layer));
    const error = yield* Effect.flip(service.restore({ threadId, mode: "fresh" }));
    assert.equal(error.reason, "verify-failed");
    assert.deepEqual(calls.dispatched, []);
    assert.deepEqual(calls.removed, [freshPath]);
  }).pipe(Effect.scoped),
);
