import {
  ThreadWorkspaceRestoreError,
  type ThreadId,
  type ThreadWorkspaceRestoreFailure,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import { WorktreeSnapshotStore } from "../../worktreeSnapshots/WorktreeSnapshotStore.ts";
import { makeDiscardWorktree, makeRecreateMissingWorktree } from "./RecreateWorktree.ts";
import { makeRestorePending, type RestorePendingState } from "./restorePending.ts";
import { verifyRestoredWorktree } from "./restoreSnapshot.ts";

export { makeRestorePending } from "./restorePending.ts";

/**
 * Brings back a thread's missing worktree: from its newest snapshot when cleanup saved one,
 * otherwise from its branch. Setup runs again, and the result is verified before any provider
 * may use the folder. A worktree whose earlier restore did not finish resumes at setup. The
 * caller holds the workspace lease.
 */
export const makeRestoreThreadWorkspace = Effect.gen(function* () {
  const recreate = yield* makeRecreateMissingWorktree;
  const discardWorktree = yield* makeDiscardWorktree;
  const pending = yield* makeRestorePending;
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
    // A rollback that could not delete the folder keeps the marker, so this repeats until it passes.
    const discard = discardWorktree({ cwd: input.cwd, worktreePath: input.worktreePath });
    const state: RestorePendingState = (yield* pending.marked(input.worktreePath))
      ? yield* pending.read(input.worktreePath).pipe(
          Effect.filterOrFail(
            (resumed): resumed is RestorePendingState => resumed !== null,
            () => fail("verify-failed", "GOAT couldn't read where the earlier restore stopped."),
          ),
        )
      : yield* Effect.gen(function* () {
          const snapshot = Option.isSome(snapshots)
            ? yield* snapshots.value.latestForThread(input.threadId)
            : null;
          const marker = (created: Pick<RestorePendingState, "restoredFrom" | "headSha">) => ({
            ...created,
            snapshotSha: snapshot?.snapshotSha ?? null,
            snapshotRef: snapshot?.snapshotRef ?? null,
          });
          // Marked before the snapshot is applied, so a rollback that fails cannot pass for done.
          const restored = yield* recreate({
            cwd: input.cwd,
            worktreePath: input.worktreePath,
            branch: input.branch,
            onCreated: (created) => pending.write(input.worktreePath, marker(created)),
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
          return marker(restored);
        });
    const setup = yield* Effect.gen(function* () {
      const setup = Option.isNone(setupScripts)
        ? ({ status: "no-script" } as const)
        : yield* setupScripts.value
            .runForThread({
              threadId: input.threadId,
              projectCwd: input.cwd,
              worktreePath: input.worktreePath,
              trigger: "setup",
              // The runner reports the exit code only when asked to watch for it.
              observeCompletion: {},
            })
            .pipe(Effect.mapError((error) => fail("setup-failed", error.message)));
      if (setup.status === "started" && !setup.async) {
        if (setup.completion === undefined)
          return yield* fail("setup-failed", "GOAT couldn't follow the setup script to its end.");
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
        expectedHead: state.headSha,
        ...(state.snapshotSha === null ? {} : { snapshot: state.snapshotSha }),
      }).pipe(Effect.mapError((error) => fail("verify-failed", error.detail)));
      yield* pending
        .clear(input.worktreePath)
        .pipe(Effect.mapError((error) => fail("verify-failed", error.message)));
      return setup;
    }).pipe(Effect.tapError(() => discard));
    if (state.snapshotRef !== null && Option.isSome(snapshots))
      yield* snapshots.value.markRestored(state.snapshotRef);
    return {
      restoredFrom: state.restoredFrom,
      headSha: state.headSha,
      setupScript: setup.status === "started" ? ("started" as const) : ("none" as const),
    };
  });
});
