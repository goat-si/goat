/** Agent- and client-visible: why a selection change waits for the running turn. */
const PROVIDER_SELECTION_BUSY =
  "This thread has a turn running, and this provider change would end it. Wait for the turn to finish, or press Stop, then try again.";

/** Agent- and client-visible: why a worktree change waits for the running turn. */
const WORKTREE_CHANGE_BUSY =
  "This thread has a turn running, and moving it to another worktree would end it. Wait for the turn to finish, or press Stop, then try again.";

/** Agent- and client-visible: why a permission mode change waits for the running turn. */
const RUNTIME_MODE_BUSY =
  "This thread has a turn running, and changing its permission mode would end it. Wait for the turn to finish, or press Stop first.";

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
}): { readonly cause: string; readonly refusal: "active_turn" } | undefined {
  const cause = refusalText(input);
  return cause === undefined ? undefined : { cause, refusal: "active_turn" };
}

/**
 * A refusal means "not now": it commits no rejected receipt, so a retry with the same command id
 * (the phone's outbox sends one per message) is decided again once the turn has ended.
 */
export const isActiveTurnRefusal = (error: {
  readonly _tag: string;
  readonly refusal?: "active_turn" | undefined;
}): boolean => error._tag === "OrchestratorDispatchError" && error.refusal === "active_turn";

function refusalText(input: Parameters<typeof activeTurnRefusal>[0]): string | undefined {
  const { command } = input;
  if (!input.releasesLiveSession) return undefined;
  if (command.type === "thread.model-selection.set" || command.type === "provider.switch")
    return PROVIDER_SELECTION_BUSY;
  // Only providers that cannot switch modes inside a session release one for a mode change.
  if (command.type === "thread.runtime-mode.set") return RUNTIME_MODE_BUSY;
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
