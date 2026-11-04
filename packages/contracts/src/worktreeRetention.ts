import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/** A removed worktree's saved state: HEAD plus uncommitted and untracked, non-ignored files. */
export const WorktreeSnapshot = Schema.Struct({
  threadId: ThreadId,
  worktreePath: Schema.String,
  branch: Schema.NullOr(Schema.String),
  /** The ref the worktree branch started from, when known. */
  baseRef: Schema.NullOr(Schema.String),
  headSha: Schema.String,
  /** refs/goat/snapshots/<threadId>/<timestamp> in the project repository. */
  snapshotRef: Schema.String,
  snapshotSha: Schema.String,
  createdAt: Schema.String,
  /** Why cleanup removed the worktree, as shown in the cleanup report. */
  reason: Schema.String,
});
export type WorktreeSnapshot = typeof WorktreeSnapshot.Type;

/**
 * `cleaned`: cleanup removed the folder and a snapshot can restore it.
 * `missing`: the folder is gone without a usable snapshot (deleted outside GOAT, or the snapshot expired);
 * restoring recreates it from the branch.
 */
export const ThreadWorkspaceState = Schema.Literals(["present", "cleaned", "missing", "none"]);
export type ThreadWorkspaceState = typeof ThreadWorkspaceState.Type;

export const ThreadWorkspaceStatus = Schema.Struct({
  threadId: ThreadId,
  state: ThreadWorkspaceState,
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  snapshot: Schema.NullOr(WorktreeSnapshot),
});
export type ThreadWorkspaceStatus = typeof ThreadWorkspaceStatus.Type;

export const ThreadWorkspaceStatusInput = Schema.Struct({ threadId: ThreadId });
export type ThreadWorkspaceStatusInput = typeof ThreadWorkspaceStatusInput.Type;

/** `fresh` starts the thread in a new worktree from the project's base and keeps the snapshot. */
export const ThreadWorkspaceRestoreInput = Schema.Struct({
  threadId: ThreadId,
  mode: Schema.Literals(["restore", "fresh"]),
});
export type ThreadWorkspaceRestoreInput = typeof ThreadWorkspaceRestoreInput.Type;

export const ThreadWorkspaceRestoreResult = Schema.Struct({
  threadId: ThreadId,
  worktreePath: Schema.String,
  branch: Schema.String,
  headSha: Schema.String,
  restoredFrom: Schema.Literals([
    "present",
    "snapshot",
    "branch",
    "remote-branch",
    "base",
    "fresh",
  ]),
  setupScript: Schema.Literals(["started", "none", "failed"]),
});
export type ThreadWorkspaceRestoreResult = typeof ThreadWorkspaceRestoreResult.Type;

export const ThreadWorkspaceRestoreFailure = Schema.Literals([
  "busy",
  "not-a-worktree-thread",
  "project-unavailable",
  "git-failed",
  "snapshot-conflict",
  "setup-failed",
  "verify-failed",
]);
export type ThreadWorkspaceRestoreFailure = typeof ThreadWorkspaceRestoreFailure.Type;

export class ThreadWorkspaceRestoreError extends Schema.TaggedError<ThreadWorkspaceRestoreError>()(
  "ThreadWorkspaceRestoreError",
  {
    threadId: ThreadId,
    reason: ThreadWorkspaceRestoreFailure,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Couldn't restore the thread's workspace (${this.reason}): ${this.detail}`;
  }
}
