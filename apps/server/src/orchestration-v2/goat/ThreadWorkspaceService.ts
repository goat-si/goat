import {
  CommandId,
  ThreadWorkspaceRestoreError,
  type ThreadId,
  type ThreadWorkspaceRestoreFailure,
  type ThreadWorkspaceRestoreInput,
  type ThreadWorkspaceRestoreResult,
  type ThreadWorkspaceStatus,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { tryWithWorkspaceLease } from "../../workspace/workspaceLease.ts";
import { makeIsManagedWorktreePath } from "../../worktreesDirectory.ts";
import { WorktreeSnapshotStore } from "../../worktreeSnapshots/WorktreeSnapshotStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import { makeRestoreThreadWorkspace } from "./restoreThreadWorkspace.ts";

/** What a client shows for a thread whose worktree cleanup removed, and the ways back. */
export class ThreadWorkspaceService extends Context.Service<
  ThreadWorkspaceService,
  {
    readonly status: (threadId: ThreadId) => Effect.Effect<ThreadWorkspaceStatus>;
    readonly restore: (
      input: ThreadWorkspaceRestoreInput,
    ) => Effect.Effect<ThreadWorkspaceRestoreResult, ThreadWorkspaceRestoreError>;
  }
>()("goat/orchestration-v2/goat/ThreadWorkspaceService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const vcs = yield* GitVcsDriver.GitVcsDriver;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const snapshots = yield* WorktreeSnapshotStore;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
  const restoreMissing = yield* makeRestoreThreadWorkspace;

  const load = Effect.fn("ThreadWorkspace.load")(function* (threadId: ThreadId) {
    const fail = (reason: ThreadWorkspaceRestoreFailure, detail: string) =>
      new ThreadWorkspaceRestoreError({ threadId, reason, detail });
    const shell = yield* projections
      .getThreadShell(threadId)
      .pipe(Effect.mapError((error) => fail("project-unavailable", error.message)));
    if (shell === null || shell.worktreePath === null || shell.branch === null)
      return yield* fail("not-a-worktree-thread", "This thread does not use a worktree.");
    const project = yield* projects.getById(shell.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (project === undefined)
      return yield* fail("project-unavailable", "The thread's project is no longer available.");
    return {
      fail,
      project,
      worktreePath: path.resolve(shell.worktreePath),
      branch: shell.branch,
    };
  });

  const present = (worktreePath: string) =>
    fs.exists(path.join(worktreePath, ".git")).pipe(Effect.orElseSucceed(() => false));

  const status = Effect.fn("ThreadWorkspace.status")(function* (threadId: ThreadId) {
    const loaded = yield* load(threadId).pipe(Effect.option);
    if (Option.isNone(loaded))
      return { threadId, state: "none", worktreePath: null, branch: null, snapshot: null } as const;
    const { worktreePath, branch } = loaded.value;
    if (yield* present(worktreePath))
      return { threadId, state: "present", worktreePath, branch, snapshot: null } as const;
    const snapshot = yield* snapshots.latestForThread(threadId);
    return {
      threadId,
      state: snapshot === null ? "missing" : "cleaned",
      worktreePath,
      branch,
      snapshot,
    } as const;
  });

  const headOf = (cwd: string) =>
    vcs.resolveCommit({ cwd, revision: "HEAD" }).pipe(
      Effect.map((head) => head.commitSha),
      Effect.orElseSucceed(() => ""),
    );

  const restoreInPlace = Effect.fn("ThreadWorkspace.restoreInPlace")(function* (
    threadId: ThreadId,
  ) {
    const { fail, project, worktreePath, branch } = yield* load(threadId);
    if (!(yield* isManagedWorktreePath(worktreePath)))
      return yield* fail(
        "not-a-worktree-thread",
        "GOAT only restores worktrees in its worktrees folder.",
      );
    const held = yield* tryWithWorkspaceLease(
      worktreePath,
      Effect.gen(function* () {
        if (yield* present(worktreePath))
          return {
            restoredFrom: "present" as const,
            headSha: yield* headOf(worktreePath),
            setupScript: "none" as const,
          };
        return yield* restoreMissing({
          threadId,
          cwd: project.workspaceRoot,
          worktreePath,
          branch,
        });
      }),
    ).pipe(
      Effect.mapError((error) =>
        "_tag" in error && error._tag === "ThreadWorkspaceRestoreError"
          ? error
          : fail("busy", error.message),
      ),
    );
    if (Option.isNone(held))
      return yield* fail("busy", "Another task is using this worktree. Try again in a moment.");
    return { threadId, worktreePath, branch, ...held.value };
  });

  const startFresh = Effect.fn("ThreadWorkspace.startFresh")(function* (threadId: ThreadId) {
    const { fail, project, branch } = yield* load(threadId);
    const stamp = (yield* Clock.currentTimeMillis).toString(36);
    const created = yield* git
      .createWorktree({
        cwd: project.workspaceRoot,
        refName: "HEAD",
        newRefName: `${branch}-fresh-${stamp}`,
        path: null,
      })
      .pipe(Effect.mapError((error) => fail("git-failed", error.message)));
    const worktreePath = created.worktree.path;
    const newBranch = created.worktree.refName;
    const rebind = threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`workspace-fresh:${threadId}:${stamp}`),
      threadId,
      branch: newBranch,
      worktreePath,
    });
    yield* rebind.pipe(
      Effect.catchCause((cause) =>
        git
          .removeWorktree({ cwd: project.workspaceRoot, path: worktreePath, force: true })
          .pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause))),
      ),
      Effect.mapError(() => fail("git-failed", "Couldn't switch the thread to the new worktree.")),
    );
    const setup = yield* setupScripts
      .runForThread({ threadId, projectCwd: project.workspaceRoot, worktreePath, trigger: "setup" })
      .pipe(Effect.mapError((error) => fail("setup-failed", error.message)));
    return {
      threadId,
      worktreePath,
      branch: newBranch,
      headSha: yield* headOf(worktreePath),
      restoredFrom: "fresh" as const,
      setupScript: setup.status === "started" ? ("started" as const) : ("none" as const),
    };
  });

  return ThreadWorkspaceService.of({
    status,
    restore: Effect.fn("ThreadWorkspaceService.restore")(function* (input) {
      return input.mode === "fresh"
        ? yield* startFresh(input.threadId)
        : yield* restoreInPlace(input.threadId);
    }),
  });
});

export const layer = Layer.effect(ThreadWorkspaceService, make);
