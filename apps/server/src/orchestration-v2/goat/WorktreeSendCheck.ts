import type { ProjectId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface SendTarget {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  /** The instance the send's turn would run on. */
  readonly instanceId: ProviderInstanceId;
}

/** The only reads the check makes: the folder, GOAT's worktrees folder, the project. No Git. */
export interface SendCheckReads {
  readonly exists: (path: string) => Effect.Effect<boolean>;
  readonly isManaged: (path: string) => Effect.Effect<boolean>;
  readonly projectExists: (projectId: ProjectId) => Effect.Effect<boolean>;
  /** Turn start prepares no local workspace for an instance that runs in the cloud. */
  readonly runsInCloud: (instanceId: ProviderInstanceId) => Effect.Effect<boolean>;
}

/**
 * Why a send to this thread cannot start a turn: its worktree is gone and turn start would not
 * restore it (the cases prepareTurnWorkspace skips). A restorable worktree passes; turn start
 * restores it.
 */
export const worktreeSendRefusal = Effect.fn("WorktreeSendCheck.refusal")(function* (
  reads: SendCheckReads,
  thread: SendTarget,
) {
  if (thread.worktreePath === null || (yield* reads.exists(thread.worktreePath))) return undefined;
  if (yield* reads.runsInCloud(thread.instanceId)) return undefined;
  const missing = `The worktree of thread ${thread.id} at ${thread.worktreePath} is missing, and GOAT can't recreate it`;
  if (thread.branch === null)
    return `${missing}: the thread has no branch to recreate it from. Move the thread to an existing folder, or start a new thread.`;
  if (!(yield* reads.isManaged(thread.worktreePath)))
    return `${missing}: GOAT only recreates worktrees at <worktrees folder>/<repository>/<name>. Put the folder back at that path, or move the thread to another worktree.`;
  if (!(yield* reads.projectExists(thread.projectId)))
    return `${missing}: its project is no longer available. Start a new thread in an available project.`;
  return undefined;
});

export class WorktreeSendCheck extends Context.Service<
  WorktreeSendCheck,
  { readonly refusal: (thread: SendTarget) => Effect.Effect<string | undefined> }
>()("goat/orchestration-v2/goat/WorktreeSendCheck") {}
