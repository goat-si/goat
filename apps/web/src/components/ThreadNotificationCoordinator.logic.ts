import {
  isPendingApprovalRequest,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@goat/contracts";

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
 * One notification per approval. The first list announces only what opened after watching began
 * (announceOnFirst); every later list, including the first after an outage, announces each id never
 * seen before. Seen ids, including ones the shell announced, are kept after they leave.
 */
export function createApprovalNotificationGate<Id>(notify: (id: Id) => void) {
  const seen = new Set<Id>();
  let seeded = false;
  const remember = (id: Id) => {
    seen.add(id);
    if (seen.size > SEEN_APPROVAL_LIMIT) seen.delete(seen.values().next().value as Id);
  };
  return {
    observe(ids: ReadonlyArray<Id>, announceOnFirst: (id: Id) => boolean = () => false): void {
      const fresh = ids.filter((id) => !seen.has(id));
      for (const id of fresh) remember(id);
      const first = !seeded;
      seeded = true;
      for (const id of fresh) if (!first || announceOnFirst(id)) notify(id);
    },
    remember,
  };
}

const NO_THREADS: ReadonlySet<ThreadId> = new Set();

/**
 * Threads whose approval the decision feed announces, so their shell status stays quiet: a thread
 * waiting on its own approval handoff, and each subagent ancestor that shows only such handoffs.
 * Until the feed has listed approvals once, the shell announces them all.
 */
export function feedOwnedApprovalThreads(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  feedReady: boolean,
): ReadonlySet<ThreadId> {
  if (!feedReady) return NO_THREADS;
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  const owned = new Set<ThreadId>();
  const viaHandoff = new Set<ThreadId>();
  const viaProvider = new Set<ThreadId>();
  for (const thread of threads) {
    const request = thread.pendingRuntimeRequest;
    if (!isPendingApprovalRequest(request)) continue;
    const handoff = request?.handoff !== undefined;
    if (handoff) viaHandoff.add(thread.id);
    // The same walk that raises a subagent's approval on its ancestors.
    const seen = new Set<ThreadId>([thread.id]);
    let current: OrchestrationV2ThreadShell | undefined = thread;
    while (current?.lineage.relationshipToParent === "subagent") {
      const parentId: ThreadId | null = current.lineage.parentThreadId;
      if (parentId === null || seen.has(parentId)) break;
      seen.add(parentId);
      (handoff ? viaHandoff : viaProvider).add(parentId);
      current = byId.get(parentId);
    }
  }
  for (const id of viaHandoff) {
    const own = byId.get(id)?.pendingRuntimeRequest;
    // A provider approval anywhere below keeps the shell notification it raises.
    if (!viaProvider.has(id) && (own === null || own?.handoff !== undefined)) owned.add(id);
  }
  return owned;
}

/** The approval handoffs a thread's shell notification stands for: its own and its subagents'. */
export function approvalHandoffsShownBy(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  threadId: ThreadId,
): ReadonlyArray<string> {
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  return threads.flatMap((thread) => {
    const request = thread.pendingRuntimeRequest;
    if (request?.handoff?.kind !== "approval") return [];
    const seen = new Set<ThreadId>();
    let current: OrchestrationV2ThreadShell | undefined = thread;
    while (current !== undefined && !seen.has(current.id)) {
      if (current.id === threadId) return [String(request.id)];
      seen.add(current.id);
      current =
        current.lineage.relationshipToParent === "subagent" && current.lineage.parentThreadId
          ? byId.get(current.lineage.parentThreadId)
          : undefined;
    }
    return [];
  });
}
