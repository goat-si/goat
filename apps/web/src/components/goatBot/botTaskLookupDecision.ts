export type BotTaskLookupInput = {
  /** The server has the lookup capability, the client may read, and the bot is not deleted. */
  readonly readable: boolean;
  /** A current-list read for this environment and bot has succeeded. */
  readonly established: boolean;
  readonly refreshing: boolean;
  /** The last successful current list holds the task. */
  readonly holdsTask: boolean;
  /** The saved answer is for this task. */
  readonly held: boolean;
  /** An action on this task completed after its last read started. */
  readonly stale: boolean;
  /** A read for this task is running. */
  readonly inFlight: boolean;
};

/** What the task pane shows for a task it may read by id, and when a read starts. */
export function botTaskLookupDecision(input: BotTaskLookupInput) {
  const view = !input.established
    ? "dev"
    : input.holdsTask
      ? "row"
      : input.held
        ? "held"
        : "waiting";
  const canRetry = input.readable && input.established && !input.holdsTask && !input.inFlight;
  return {
    view,
    startRead: canRetry && !input.refreshing && (!input.held || input.stale),
    canRetry,
  } as const;
}
