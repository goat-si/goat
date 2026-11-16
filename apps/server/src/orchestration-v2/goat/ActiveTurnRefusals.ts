/** Agent- and client-visible: why a selection change waits for the running turn. */
const PROVIDER_SELECTION_BUSY =
  "This thread has a turn running, and this provider change would end it. Wait for the turn to finish, or press Stop, then try again.";

/** Agent- and client-visible: why a worktree change waits for the running turn. */
const WORKTREE_CHANGE_BUSY =
  "This thread has a turn running, and moving it to another worktree would end it. Wait for the turn to finish, or press Stop, then try again.";

/**
 * The refusal for a change during an active run, or undefined when it ends no turn. Only releasing
 * a live provider session ends one. Rebinds with expectedWorktreePath or a continuation are the
 * server's or the agent's own move (launches, worktree.handoff) and proceed.
 */
export function activeTurnRefusal(input: {
  readonly command: {
    readonly type: string;
    readonly worktreePath?: string | null | undefined;
    readonly expectedWorktreePath?: string | null | undefined;
    readonly continuation?: unknown;
  };
  readonly threadWorktreePath: string | null;
  readonly releasesLiveSession: boolean;
}): string | undefined {
  const { command } = input;
  if (!input.releasesLiveSession) return undefined;
  if (command.type === "thread.model-selection.set" || command.type === "provider.switch")
    return PROVIDER_SELECTION_BUSY;
  if (
    command.type === "thread.metadata.update" &&
    command.worktreePath !== undefined &&
    command.worktreePath !== input.threadWorktreePath &&
    command.expectedWorktreePath === undefined &&
    command.continuation === undefined
  )
    return WORKTREE_CHANGE_BUSY;
  return undefined;
}
