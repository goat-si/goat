/** Added to a turn whose computer use change waits for a quiet conversation (#1564). */
export const CUA_DEFERRED_NOTE =
  "This conversation's computer use connection changed (for example after Stop), and the change applies only once this conversation and its subagents are idle. Until then computer use keeps its previous connection, which may refuse calls. If it does, tell the person to send their next message after this turn ends, or to start a new thread.";

/**
 * What Codex last reported for each native thread, from thread/status/changed and thread/start.
 * Only a thread reported idle or notLoaded is quiet; an unreported one is not.
 */
export function makeCodexThreadStatuses() {
  const statuses = new Map<string, string>();
  return {
    record: (threadId: string, status: string) => void statuses.set(threadId, status),
    quiet: (threadIds: ReadonlyArray<string>) =>
      threadIds.every((threadId) => {
        const status = statuses.get(threadId);
        return status === "idle" || status === "notLoaded";
      }),
    /** Codex answers turn/start before it reports the thread active; returns the undo. */
    starting: (threadId: string) => {
      const before = statuses.get(threadId);
      statuses.set(threadId, "starting");
      return () =>
        void (before === undefined ? statuses.delete(threadId) : statuses.set(threadId, before));
    },
  };
}
