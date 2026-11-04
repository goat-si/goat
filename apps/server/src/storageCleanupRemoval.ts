import type { ProjectId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { verifySnapshot } from "./worktreeSnapshots/captureSnapshot.ts";
import { findOpenHandles } from "./worktreeSnapshots/openHandles.ts";
import { WorktreeSnapshotStore } from "./worktreeSnapshots/WorktreeSnapshotStore.ts";

export type RemovalDecision =
  | { readonly _tag: "remove"; readonly snapshotRef: string; readonly hasChanges: boolean }
  | { readonly _tag: "keep"; readonly reason: string };

/**
 * The last step before cleanup removes a worktree: save and verify a snapshot, refuse while a
 * process holds the folder, then verify the snapshot still matches. Any doubt keeps the worktree.
 */
export const makeWorktreeRemovalGate = Effect.gen(function* () {
  const store = yield* WorktreeSnapshotStore;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const read = (cwd: string, args: string[]) =>
    git
      .execute({ operation: "StorageCleanup.removalGate", cwd, args, maxOutputBytes: 64 * 1024 })
      .pipe(Effect.map((result) => result.stdout.trim()));
  return Effect.fn("StorageCleanup.prepareRemoval")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly worktreePath: string;
      readonly branch: string | null;
      readonly reason: string;
    }) {
      const status = yield* read(input.worktreePath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]);
      const hasChanges = status !== "";
      const snapshot = yield* store.capture({ ...input, baseRef: null }).pipe(Effect.result);
      if (snapshot._tag === "Failure")
        return { _tag: "keep", reason: `snapshot failed: ${snapshot.failure.detail}` } as const;
      const handles = yield* findOpenHandles(input.worktreePath);
      const holder = handles.holders[0];
      if (holder !== undefined)
        return {
          _tag: "keep",
          reason: `a process is using this worktree (pid ${holder.pid})`,
        } as const;
      if (!handles.complete && hasChanges)
        return {
          _tag: "keep",
          reason: "couldn't check which processes use this worktree",
        } as const;
      const { snapshotRef, snapshotSha, headSha } = snapshot.success;
      const [treeSha, indexSha, indexTreeSha] = yield* Effect.all([
        read(input.worktreePath, ["rev-parse", "--verify", `${snapshotSha}^{tree}`]),
        read(input.worktreePath, ["rev-parse", "--verify", `${snapshotSha}^2`]),
        read(input.worktreePath, ["rev-parse", "--verify", `${snapshotSha}^2^{tree}`]),
      ]);
      const verified = yield* verifySnapshot(input.worktreePath, {
        snapshotRef,
        snapshotSha,
        headSha,
        treeSha,
        indexSha,
        indexTreeSha,
      }).pipe(Effect.result);
      if (verified._tag === "Failure")
        return { _tag: "keep", reason: verified.failure.detail } as const;
      return { _tag: "remove", snapshotRef, hasChanges } as const;
    },
    Effect.catch((error) =>
      Effect.succeed({
        _tag: "keep",
        reason: `couldn't save a snapshot (${error.message.split("\n")[0]})`,
      } as const),
    ),
  );
});
