import {
  isPendingApprovalRequest,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@goat/contracts";
import { subagentRequest } from "@goat/client-runtime/state/threads";
import * as DateTime from "effect/DateTime";

export type ThreadNotificationKind = "input" | "completion";

export interface ThreadNotificationObservation {
  /** Run and status key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  readonly requestId?: string | null;
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
  const attended = new Map<Key, Set<string>>();
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
      let fresh = next.attention !== null && next.attention !== prior?.attention;
      if (next.attention === null) attended.delete(key);
      else if (next.requestId != null) {
        const seen = attended.get(key) ?? new Set<string>();
        fresh = !seen.has(next.attention);
        seen.add(next.attention);
        const oldest = seen.values().next().value;
        if (seen.size > 1000 && oldest !== undefined) seen.delete(oldest);
        attended.set(key, seen);
      }
      if (!prior || options.archived) return;
      if (fresh) {
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
      for (const key of attended.keys()) if (!keys.has(key)) attended.delete(key);
    },
    clear(): void {
      handled.clear();
      attended.clear();
    },
  };
}

// Closed approvals remembered for a long session; open ones are always kept.
const SEEN_APPROVAL_LIMIT = 1000;

/**
 * One notification per approval. Until the first shell snapshot sets the baseline (server time), a
 * feed list waits. The first list announces only approvals created after the baseline; every later
 * list, including the first after an outage, announces each id never seen before. Seen ids,
 * including ones the shell announced, are kept after they leave.
 */
export function createApprovalNotificationGate<Id>(notify: (id: Id) => void) {
  const seen = new Set<Id>();
  let baseline: number | null = null;
  let seeded = false;
  let waiting: ReadonlyArray<{ readonly id: Id; readonly createdAt: number }> | null = null;
  const remember = (id: Id) => {
    seen.add(id);
  };
  const process = (items: ReadonlyArray<{ readonly id: Id; readonly createdAt: number }>) => {
    const since = seeded ? null : baseline;
    seeded = true;
    for (const item of items) {
      if (seen.has(item.id)) continue;
      remember(item.id);
      if (since === null || item.createdAt > since) notify(item.id);
    }
    const open = new Set(items.map((item) => item.id));
    for (const id of seen) {
      if (seen.size <= SEEN_APPROVAL_LIMIT) break;
      if (!open.has(id)) seen.delete(id);
    }
  };
  return {
    observe(items: ReadonlyArray<{ readonly id: Id; readonly createdAt: number }>): void {
      if (baseline === null && !seeded) waiting = items;
      else process(items);
    },
    setBaseline(ms: number): void {
      if (baseline !== null) return;
      baseline = ms;
      if (waiting !== null) process(waiting);
      waiting = null;
    },
    remember,
  };
}

const NOTIFYING_STATUSES: ReadonlySet<string> = new Set([
  "input",
  "request",
  "approval",
  "failed",
  "limited",
]);

/** The run and status a thread notifies for; an approval the feed announces is left to it. */
export function notificationAttention(
  status: string,
  runId: string,
  feedOwned: boolean,
  requestId: string | null = null,
): string | null {
  if (!NOTIFYING_STATUSES.has(status) || (feedOwned && status === "approval")) return null;
  return requestId === null ? `${runId}:${status}` : `${runId}:${status}:${requestId}`;
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
    // Only a request the shell raises on the ancestors counts for them.
    if (subagentRequest(thread) === null) continue;
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
    // A provider approval here or below keeps the shell notification it raises.
    const ownProviderApproval = own?.handoff === undefined && isPendingApprovalRequest(own);
    if (!viaProvider.has(id) && !ownProviderApproval) owned.add(id);
  }
  return owned;
}

/**
 * The one approval handoff a thread's shell notification stands for, with the title it names: the
 * newest among its own and its live subagents'. None when a provider approval raises it.
 * Only an approval notification stands for one. Others are left for the feed to announce.
 */
export function approvalHandoffShownBy(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  threadId: ThreadId,
  status: string,
): { readonly id: string; readonly title: string } | null {
  if (status !== "approval") return null;
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  // Whether the thread's approval is raised on threadId: its own, or a live subagent's below it.
  const raisedOn = (thread: OrchestrationV2ThreadShell) => {
    if (thread.id !== threadId && subagentRequest(thread) === null) return false;
    const seen = new Set<ThreadId>();
    let current: OrchestrationV2ThreadShell | undefined = thread;
    while (current !== undefined && !seen.has(current.id)) {
      if (current.id === threadId) return true;
      seen.add(current.id);
      current =
        current.lineage.relationshipToParent === "subagent" && current.lineage.parentThreadId
          ? byId.get(current.lineage.parentThreadId)
          : undefined;
    }
    return false;
  };
  let newest: { readonly id: string; readonly title: string; readonly at: number } | null = null;
  for (const thread of threads) {
    const request = thread.pendingRuntimeRequest;
    if (!isPendingApprovalRequest(request) || request == null || !raisedOn(thread)) continue;
    // A provider approval raises the same status; the notification may stand for it instead.
    if (request.handoff === undefined) return null;
    const at = DateTime.toEpochMillis(request.createdAt);
    if (newest === null || at > newest.at)
      newest = { id: String(request.id), title: request.handoff.title, at };
  }
  return newest === null ? null : { id: newest.id, title: newest.title };
}
