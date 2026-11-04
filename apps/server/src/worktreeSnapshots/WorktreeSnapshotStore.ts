import type { ProjectId, ThreadId, WorktreeSnapshot } from "@goat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class WorktreeSnapshotError extends Schema.TaggedError<WorktreeSnapshotError>()(
  "WorktreeSnapshotError",
  {
    worktreePath: Schema.String,
    /** Shown as the reason cleanup kept the worktree. */
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface WorktreeSnapshotCaptureInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly baseRef: string | null;
  readonly reason: string;
}

/** Saves a worktree's state under refs/goat/snapshots before cleanup removes it, and the ledger of those refs. */
export class WorktreeSnapshotStore extends Context.Service<
  WorktreeSnapshotStore,
  {
    /** Creates the ref and returns only after the ref and its tree are verified. */
    readonly capture: (
      input: WorktreeSnapshotCaptureInput,
    ) => Effect.Effect<WorktreeSnapshot, WorktreeSnapshotError>;
    /** The newest snapshot whose ref still resolves, or null. */
    readonly latestForThread: (threadId: ThreadId) => Effect.Effect<WorktreeSnapshot | null>;
    readonly markRestored: (snapshotRef: string) => Effect.Effect<void>;
    /** Deletes the thread's refs and ledger rows; returns how many were removed. */
    readonly deleteForThread: (threadId: ThreadId) => Effect.Effect<number>;
    /** Deletes snapshots older than days; returns how many were removed. */
    readonly expire: (nowMs: number, days: number) => Effect.Effect<number>;
  }
>()("goat/worktreeSnapshots/WorktreeSnapshotStore") {}
