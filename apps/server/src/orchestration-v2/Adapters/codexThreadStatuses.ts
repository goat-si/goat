/** Added to a turn whose computer use change waits for a quiet conversation (#1564). */
export const CUA_DEFERRED_NOTE =
  "This conversation's computer use connection changed (for example after Stop), and the change applies only once this conversation and its subagents are idle and none of their goals is active. Until then computer use keeps its previous connection, which may refuse calls. If it does, tell the person to send their next message after this turn ends (pausing an active goal first), or to start a new thread.";

/**
 * What Codex last reported for each native thread, from thread/status/changed and thread/start.
 * Only a thread reported idle or notLoaded is quiet; an unreported one is not. Codex answers
 * turn/start before the new turn's own notifications, and a finished turn's notifications can
 * arrive after that answer, so a start stays pending until turn/started names its turn.
 */
export function makeCodexThreadStatuses() {
  const statuses = new Map<string, string>();
  const lastStarted = new Map<string, string>();
  // The turn a thread waits to see start; null until Codex answers turn/start.
  const pending = new Map<string, string | null>();
  // An active goal lets Codex start continuation turns on its own. Goal updates can arrive out of
  // order, so an older one never replaces a newer one, and on a tie the inactive state wins.
  const goals = new Map<string, { readonly active: boolean; readonly updatedAt: number }>();
  return {
    goal: (threadId: string, status: string | null, updatedAt?: number) => {
      const known = goals.get(threadId);
      const active = status === "active";
      const at = updatedAt ?? known?.updatedAt ?? 0;
      if (known && (at < known.updatedAt || (at === known.updatedAt && active))) return;
      goals.set(threadId, { active, updatedAt: at });
    },
    goalActive: (threadIds: ReadonlyArray<string>) =>
      threadIds.some((threadId) => goals.get(threadId)?.active === true),
    record: (threadId: string, status: string) => void statuses.set(threadId, status),
    turnStarted: (threadId: string, turnId: string) => {
      lastStarted.set(threadId, turnId);
      if (pending.get(threadId) === turnId) pending.delete(threadId);
    },
    quiet: (threadIds: ReadonlyArray<string>) =>
      threadIds.every((threadId) => {
        const status = statuses.get(threadId);
        return !pending.has(threadId) && (status === "idle" || status === "notLoaded");
      }),
    starting: (threadId: string) => {
      pending.set(threadId, null);
      return {
        failed: () => void pending.delete(threadId),
        // A folded input names the turn already running, whose start was seen.
        answered: (turnId: string) =>
          void (lastStarted.get(threadId) === turnId
            ? pending.delete(threadId)
            : pending.set(threadId, turnId)),
      };
    },
  };
}
