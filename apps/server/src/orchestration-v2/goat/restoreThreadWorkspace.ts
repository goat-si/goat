import {
  ThreadWorkspaceRestoreError,
  type ThreadId,
  type ThreadWorkspaceRestoreFailure,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import { WorktreeSnapshotStore } from "../../worktreeSnapshots/WorktreeSnapshotStore.ts";
import { makeRecreateMissingWorktree } from "./RecreateWorktree.ts";
import { verifyRestoredWorktree } from "./restoreSnapshot.ts";

/**
 * Brings back a thread's missing worktree: from its newest snapshot when cleanup saved one,
 * otherwise from its branch. Setup runs again, and the result is verified before any provider
 * may use the folder. The caller holds the workspace lease.
 */
export const makeRestoreThreadWorkspace = Effect.gen(function* () {
  const recreate = yield* makeRecreateMissingWorktree;
  // Optional so turn-start harnesses without the ledger or setup runner keep plain recreation.
  const snapshots = yield* Effect.serviceOption(WorktreeSnapshotStore);
  const setupScripts = yield* Effect.serviceOption(
    ProjectSetupScriptRunner.ProjectSetupScriptRunner,
  );
  return Effect.fn("ThreadWorkspace.restoreMissing")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly worktreePath: string;
    readonly branch: string;
  }) {
    const fail = (reason: ThreadWorkspaceRestoreFailure, detail: string) =>
      new ThreadWorkspaceRestoreError({ threadId: input.threadId, reason, detail });
    const snapshot = Option.isSome(snapshots)
      ? yield* snapshots.value.latestForThread(input.threadId)
      : null;
    const restored = yield* recreate({
      cwd: input.cwd,
      worktreePath: input.worktreePath,
      branch: input.branch,
      ...(snapshot === null
        ? {}
        : { snapshot: { snapshotSha: snapshot.snapshotSha, headSha: snapshot.headSha } }),
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "WorktreeSnapshotConflictError"
          ? fail(
              "snapshot-conflict",
              `Branch ${input.branch} moved since the worktree was cleaned up; restoring the snapshot there could overwrite work.`,
            )
          : fail("git-failed", error.message),
      ),
    );
    const setup = Option.isNone(setupScripts)
      ? ({ status: "no-script" } as const)
      : yield* setupScripts.value
          .runForThread({
            threadId: input.threadId,
            projectCwd: input.cwd,
            worktreePath: input.worktreePath,
            trigger: "setup",
          })
          .pipe(Effect.mapError((error) => fail("setup-failed", error.message)));
    if (setup.status === "started" && !setup.async && setup.completion !== undefined) {
      const completion = yield* setup.completion;
      if (completion.exitCode !== 0)
        return yield* fail(
          "setup-failed",
          `Setup script "${setup.scriptName}" exited with ${completion.exitCode ?? "no exit code"}.`,
        );
    }
    yield* verifyRestoredWorktree({
      cwd: input.worktreePath,
      expectedPath: input.worktreePath,
      branch: input.branch,
      expectedHead: restored.headSha,
      ...(snapshot === null ? {} : { snapshot: snapshot.snapshotSha }),
    }).pipe(Effect.mapError((error) => fail("verify-failed", error.detail)));
    if (snapshot !== null && Option.isSome(snapshots))
      yield* snapshots.value.markRestored(snapshot.snapshotRef);
    return {
      restoredFrom: restored.restoredFrom,
      headSha: restored.headSha,
      setupScript: setup.status === "started" ? ("started" as const) : ("none" as const),
    };
  });
});
