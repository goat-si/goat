export type ThreadNotificationKind = "input" | "completion";

export interface ThreadNotificationObservation {
  /** Run and status key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
}

export function createThreadNotificationGate<Key>(
  notify: (key: Key, kind: ThreadNotificationKind) => void,
) {
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  return {
    observe(
      key: Key,
      prior: ThreadNotificationObservation | undefined,
      next: ThreadNotificationObservation,
      options: { readonly archived: boolean; readonly quiet: boolean },
    ): void {
      // The first sighting, archived threads, and stopped or silent runs never notify completion.
      if (!prior || options.archived || options.quiet) skip(key, next.completedAt);
      if (!prior || options.archived) return;
      if (next.attention && next.attention !== prior.attention) {
        notify(key, "input");
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      handled.set(key, at);
      notify(key, "completion");
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
    },
    clear(): void {
      handled.clear();
    },
  };
}

// Enough for a long session; the oldest are forgotten first.
const SEEN_APPROVAL_LIMIT = 1000;

/**
 * One notification per approval. The first list seeds what was already open; every later list,
 * including the first after an outage, announces each id never seen before. Seen ids are kept
 * after they leave, so an approval that leaves and returns stays quiet.
 */
export function createApprovalNotificationGate<Id>(notify: (id: Id) => void) {
  const seen = new Set<Id>();
  let seeded = false;
  const remember = (id: Id) => {
    seen.add(id);
    if (seen.size > SEEN_APPROVAL_LIMIT) seen.delete(seen.values().next().value as Id);
  };
  return {
    observe(ids: ReadonlyArray<Id>): void {
      const fresh = ids.filter((id) => !seen.has(id));
      for (const id of fresh) remember(id);
      if (!seeded) {
        seeded = true;
        return;
      }
      for (const id of fresh) notify(id);
    },
  };
}
