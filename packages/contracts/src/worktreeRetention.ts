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
  /** The folder is back and checks out, but the setup of an interrupted restore has not finished. */
  setupIncomplete: Schema.optionalKey(Schema.Boolean),
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
  /** Where a "fresh" worktree started: the thread's branch, its pushed copy, or the project base. */
  startedFrom: Schema.optionalKey(Schema.Literals(["branch", "remote-branch", "base"])),
});
export type ThreadWorkspaceRestoreResult = typeof ThreadWorkspaceRestoreResult.Type;

/**
 * What a restore brought back and what it could not, in the words the thread notice and every
 * client use. previousBranch is the branch the thread had before a "fresh" restore.
 */
export function describeThreadWorkspaceRestore(input: {
  readonly restoredFrom: ThreadWorkspaceRestoreResult["restoredFrom"];
  readonly startedFrom?: ThreadWorkspaceRestoreResult["startedFrom"];
  readonly branch: string;
  readonly previousBranch?: string;
  readonly setupScript: ThreadWorkspaceRestoreResult["setupScript"];
}): { readonly summary: string; readonly lost: string | null } {
  const setup = input.setupScript === "started" ? " The setup script is running." : "";
  const previous = input.previousBranch ?? input.branch;
  const [summary, lost] = ((): readonly [string, string | null] => {
    switch (input.restoredFrom) {
      case "present":
        return ["The worktree was already in place.", null];
      case "snapshot":
        return [
          `Restored the worktree on ${input.branch} from the snapshot saved when it was cleaned up.`,
          "Ignored files such as .env and node_modules were not saved, so they are not back.",
        ];
      case "branch":
        return [
          `Recreated the worktree from branch ${input.branch}.`,
          "Changes that were never committed are not in it.",
        ];
      case "remote-branch":
        return [
          `Recreated the worktree from ${input.branch} as it was last pushed.`,
          "Commits that were never pushed and changes that were never committed are not in it.",
        ];
      case "base":
        return [
          `Branch ${input.branch} no longer existed, so GOAT started it again from the project's base.`,
          "Its earlier commits and changes are not in this worktree.",
        ];
      case "fresh":
        return input.startedFrom === "branch" || input.startedFrom === "remote-branch"
          ? [
              `Now working in a new worktree on ${input.branch}, started from ${previous}${input.startedFrom === "remote-branch" ? " as it was last pushed" : ""}.`,
              "Changes that were never committed are not in it.",
            ]
          : [
              `Now working in a new worktree on ${input.branch}, started from the project's base.`,
              `Commits and changes on ${previous} are not in it.`,
            ];
    }
  })();
  return { summary: summary + setup, lost };
}

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
