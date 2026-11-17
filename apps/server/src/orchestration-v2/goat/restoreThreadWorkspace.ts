import {
  ThreadWorkspaceRestoreError,
  type ThreadId,
  type ThreadWorkspaceRestoreFailure,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import { reuseHeldWorkspaceLease } from "../../workspace/workspaceLease.ts";
import { WorktreeSnapshotStore } from "../../worktreeSnapshots/WorktreeSnapshotStore.ts";
import { makeDiscardWorktree, makeRecreateMissingWorktree } from "./RecreateWorktree.ts";
import { makeRestorePending, type RestorePendingState } from "./restorePending.ts";
import { git, RestoreSnapshotError, verifyRestoredWorktree } from "./restoreSnapshot.ts";
import { makeSetAsideFolder } from "./setAsideFolder.ts";

export { makeRestorePending } from "./restorePending.ts";

export interface RestoredThreadWorkspace {
  readonly restoredFrom: RestorePendingState["restoredFrom"];
  readonly headSha: string;
  readonly setupScript: "started" | "none";
  /** Where a folder that held only a failed removal's leftovers went to make room. */
  readonly setAsidePath?: string;
}

/**
 * Whether a restore that stopped before it finished left a usable folder: the right path and
 * branch, at or after the head it restored. Commits and edits made since are the thread's own.
 */
export const verifyInterruptedRestore = Effect.fn("ThreadWorkspace.verifyInterruptedRestore")(
  function* (input: {
    readonly worktreePath: string;
    readonly branch: string;
    readonly state: RestorePendingState;
  }) {
    if (input.state.snapshotSha !== null && input.state.applied !== true)
      return yield* new RestoreSnapshotError({ detail: "snapshot" });
    const head = yield* Effect.tryPromise({
      try: async () => {
        // Status asks this too; a hung Git must not hold up the thread view for minutes.
        const quick = { timeoutMs: 30_000 };
        const head = (await git(input.worktreePath, ["rev-parse", "HEAD"], quick))
          .toString()
          .trim();
        await git(
          input.worktreePath,
          ["merge-base", "--is-ancestor", input.state.headSha, head],
          quick,
        );
        return head;
      },
      catch: (cause) => new RestoreSnapshotError({ detail: "head", cause }),
    });
    yield* verifyRestoredWorktree({
      cwd: input.worktreePath,
      expectedPath: input.worktreePath,
      branch: input.branch,
      expectedHead: head,
    });
  },
);

interface RestoreInput {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string;
  readonly branch: string;
}

/**
 * Brings back a thread's missing worktree from its newest snapshot, else its branch, reruns setup
 * and verifies it before any provider may use it. An unfinished restore resumes at setup, and a
 * folder holding only a failed removal's leftovers is set aside first. The caller holds the lease.
 */
export const makeRestoreThreadWorkspace = Effect.gen(function* () {
  const recreate = yield* makeRecreateMissingWorktree;
  const discardWorktree = yield* makeDiscardWorktree;
  const pending = yield* makeRestorePending;
  const setAside = yield* makeSetAsideFolder;
  // Optional so turn-start harnesses without the ledger or setup runner keep plain recreation.
  const snapshots = yield* Effect.serviceOption(WorktreeSnapshotStore);
  const setupScripts = yield* Effect.serviceOption(
    ProjectSetupScriptRunner.ProjectSetupScriptRunner,
  );
  const restore = Effect.fn("ThreadWorkspace.restoreFolder")(function* (input: RestoreInput) {
    const fail = (reason: ThreadWorkspaceRestoreFailure, detail: string) =>
      new ThreadWorkspaceRestoreError({ threadId: input.threadId, reason, detail });
    // A rollback that could not delete the folder keeps the marker, so this repeats until it passes.
    const discard = discardWorktree({ cwd: input.cwd, worktreePath: input.worktreePath });
    const resumed = yield* pending.marked(input.worktreePath);
    const state: RestorePendingState = resumed
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
          if (snapshot === null) return marker(restored);
          const applied = { ...marker(restored), applied: true };
          yield* pending
            .write(input.worktreePath, applied)
            .pipe(Effect.mapError((error) => fail("verify-failed", error.message)));
          return applied;
        });
    // A folder an earlier restore finished filling may hold work since; this attempt never removes it.
    const lenient = resumed && (state.snapshotSha === null || state.applied === true);
    const setup = yield* Effect.gen(function* () {
      const setup = Option.isNone(setupScripts)
        ? ({ status: "no-script" } as const)
        : // Its terminal takes the worktree's lease, which this restore holds.
          yield* reuseHeldWorkspaceLease(
            setupScripts.value.runForThread({
              threadId: input.threadId,
              projectCwd: input.cwd,
              worktreePath: input.worktreePath,
              trigger: "setup",
              // The runner reports the exit code only when asked to watch for it.
              observeCompletion: {},
            }),
          ).pipe(Effect.mapError((error) => fail("setup-failed", error.message)));
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
      // Once setup is done, a stopped run must not leave a checked folder marked unready.
      yield* (
        lenient
          ? verifyInterruptedRestore({
              worktreePath: input.worktreePath,
              branch: input.branch,
              state,
            })
          : verifyRestoredWorktree({
              cwd: input.worktreePath,
              expectedPath: input.worktreePath,
              branch: input.branch,
              expectedHead: state.headSha,
              ...(state.snapshotSha === null ? {} : { snapshot: state.snapshotSha }),
            })
      ).pipe(
        Effect.mapError((error) => fail("verify-failed", error.detail)),
        Effect.andThen(
          pending
            .clear(input.worktreePath)
            .pipe(Effect.mapError((error) => fail("verify-failed", error.message))),
        ),
        Effect.uninterruptible,
      );
      return setup;
    }).pipe(Effect.tapError(() => (lenient ? Effect.void : discard)));
    if (state.snapshotRef !== null && Option.isSome(snapshots))
      yield* snapshots.value.markRestored(state.snapshotRef);
    return {
      restoredFrom: state.restoredFrom,
      headSha: state.headSha,
      setupScript: setup.status === "started" ? ("started" as const) : ("none" as const),
    };
  });
  return Effect.fn("ThreadWorkspace.restoreMissing")(function* (
    input: RestoreInput,
  ): Effect.fn.Return<RestoredThreadWorkspace, ThreadWorkspaceRestoreError> {
    // Git refuses a folder that is not empty; a failed restore moves the leftovers back.
    if (!(yield* setAside.leftover(input.worktreePath))) return yield* restore(input);
    const { result, setAsidePath } = yield* setAside
      .around(input.worktreePath, restore(input))
      .pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            Effect.fail(
              new ThreadWorkspaceRestoreError({
                threadId: input.threadId,
                reason: "git-failed",
                detail: `GOAT couldn't move the leftover folder at ${input.worktreePath} aside: ${error.message}`,
              }),
            ),
        }),
      );
    return { ...result, setAsidePath };
  });
});
