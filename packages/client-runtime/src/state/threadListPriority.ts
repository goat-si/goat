import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";

/** A thread row's status, shared by the web sidebar and the mobile thread list. */
export type ThreadListStatus =
  | "approval"
  | "input"
  | "request"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

type ThreadListStatusInput = Pick<
  EnvironmentThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "runtime"
> & {
  readonly pendingSubagentRequest?: EnvironmentThreadShell["pendingSubagentRequest"] | undefined;
  readonly pendingGuestMessageCount?: number | undefined;
  readonly blockedOnThreadWait?: boolean | undefined;
};

export function resolveThreadListStatus(thread: ThreadListStatusInput): ThreadListStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

type UnseenCompletionInput = {
  readonly latestRun?: { readonly completedAt: string | null } | null | undefined;
  readonly notificationCompletedAt?: string | null | undefined;
  readonly markedUnreadCompletionAt?: string | null | undefined;
  readonly lastVisitedAt?: string | null | undefined;
};

export function hasUnseenCompletion(thread: UnseenCompletionInput): boolean {
  const automatic =
    thread.notificationCompletedAt === undefined
      ? thread.latestRun?.completedAt
      : thread.notificationCompletedAt;
  const times = [automatic, thread.markedUnreadCompletionAt]
    .map((at) => Date.parse(at ?? ""))
    .filter(Number.isFinite);
  if (times.length === 0 || !thread.lastVisitedAt) return false;
  const visited = Date.parse(thread.lastVisitedAt);
  return Number.isNaN(visited) || Math.max(...times) > visited;
}

export function resolveThreadLastVisitedAt(
  serverLastVisitedAt: string | null | undefined,
  localLastVisitedAt: string | undefined,
): string | undefined {
  // Server visits override local watermarks, including mark-unread rewinds; use local values only on older
  // servers.
  if (serverLastVisitedAt === undefined) return localLastVisitedAt;
  return serverLastVisitedAt ?? undefined;
}

/** A visit acknowledges a wake without changing the thread's lifecycle. */
export function isThreadWoke(wokeAt: string | null, lastVisitedAt: string | undefined): boolean {
  if (wokeAt === null || !Number.isFinite(Date.parse(wokeAt))) return false;
  const visited = lastVisitedAt === undefined ? NaN : Date.parse(lastVisitedAt);
  return !Number.isFinite(visited) || visited < Date.parse(wokeAt);
}

export type ThreadPriorityInput = ThreadListStatusInput &
  Omit<UnseenCompletionInput, "lastVisitedAt"> & {
    readonly lastVisitedAt?: string | null | undefined;
  };

/** 0: a request waits on the user; 1: work runs; 2: unread. Priority never changes lifecycle. */
export type ThreadPriorityRank = 0 | 1 | 2;

export function resolveThreadPriorityRank(input: {
  readonly thread: ThreadPriorityInput;
  readonly localLastVisitedAt?: string | undefined;
  readonly wokeAt: string | null;
  readonly hasChildAttention: boolean;
}): ThreadPriorityRank | null {
  const status = resolveThreadListStatus(input.thread);
  if (status === "approval" || status === "input" || input.hasChildAttention) return 0;
  if (status === "working" || status === "waiting") return 1;
  const lastVisitedAt = resolveThreadLastVisitedAt(
    input.thread.lastVisitedAt,
    input.localLastVisitedAt,
  );
  return hasUnseenCompletion({ ...input.thread, lastVisitedAt }) ||
    isThreadWoke(input.wokeAt, lastVisitedAt)
    ? 2
    : null;
}

/** Settled state each Priority row had when the list last showed it, by scoped thread key. */
export type ThreadPriorityHolds = ReadonlyMap<string, EnvironmentThreadShell["settledOverride"]>;

/**
 * Reading a thread does not pull its row out of Priority while the list stays mounted; Clear read
 * releases it. Settling or unsettling the row is the user's own move, so that ends the hold.
 */
export function holdThreadPriorityRank(input: {
  readonly rank: ThreadPriorityRank | null;
  readonly key: string;
  readonly settledOverride: EnvironmentThreadShell["settledOverride"];
  readonly holds: ThreadPriorityHolds;
  /** Mark all as read drops the row once it no longer qualifies, instead of holding it. */
  readonly released?: boolean;
}): ThreadPriorityRank | null {
  if (input.released) return input.rank;
  if (input.rank !== null || !input.holds.has(input.key)) return input.rank;
  return input.holds.get(input.key) === input.settledOverride ? 2 : null;
}

export type ThreadListSection =
  | "priority"
  | "pinned"
  | "active"
  | "working"
  | "snoozed"
  | "settled";

/** Snooze wins until its wake boundary. Priority overlays lifecycle; otherwise settlement wins over a stale pin. */
export function resolveThreadListSection(input: {
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly pinned: boolean;
  readonly priority?: boolean;
}): Exclude<ThreadListSection, "working"> {
  if (input.snoozed) return "snoozed";
  if (input.priority) return "priority";
  if (input.settled) return "settled";
  if (input.pinned) return "pinned";
  return "active";
}

type PriorityRow = ThreadPriorityInput & Pick<EnvironmentThreadShell, "environmentId" | "id">;

const keyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** Writable unread completions and woke-only rows are targets of Priority's Mark all as read. */
export function selectPriorityMarkReadTargets<T extends PriorityRow>(input: {
  readonly threads: readonly T[];
  readonly localLastVisitedAtByKey: Readonly<Record<string, string | undefined>>;
  readonly wokeAtByKey?: ReadonlyMap<string, string | null>;
  readonly canOperate: (thread: T) => boolean;
}): T[] {
  return input.threads.filter((thread) => {
    if (!input.canOperate(thread)) return false;
    const key = keyOf(thread);
    const lastVisitedAt = resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      input.localLastVisitedAtByKey[key],
    );
    return (
      hasUnseenCompletion({ ...thread, lastVisitedAt }) ||
      isThreadWoke(input.wokeAtByKey?.get(key) ?? null, lastVisitedAt)
    );
  });
}

export interface ThreadPriorityReadPlan<T> {
  readonly markRead: readonly T[];
  readonly releaseKeys: readonly string[];
  /** The row to restore when a visit fails, by visited key; absent means the visited row. */
  readonly restoreKeyByKey?: ReadonlyMap<string, string>;
}

/**
 * Clear read takes every finished row out of Priority: rows held only because the list stayed
 * open, and unread completions or wakes this connection can mark read. Work in progress and
 * pending requests stay. Wakes are the effective ones Priority ranked the row with.
 */
export function selectPriorityClear<T extends PriorityRow>(input: {
  readonly threads: readonly T[];
  readonly localLastVisitedAtByKey: Readonly<Record<string, string | undefined>>;
  readonly wokeAtByKey: ReadonlyMap<string, string | null>;
  readonly attentionByOwnerKey: ReadonlyMap<string, unknown>;
  readonly canOperate: (thread: T) => boolean;
}): ThreadPriorityReadPlan<T> {
  const markRead: T[] = [];
  const releaseKeys: string[] = [];
  for (const thread of input.threads) {
    const key = keyOf(thread);
    const rank = resolveThreadPriorityRank({
      thread,
      localLastVisitedAt: input.localLastVisitedAtByKey[key],
      wokeAt: input.wokeAtByKey.get(key) ?? null,
      hasChildAttention: input.attentionByOwnerKey.has(key),
    });
    if (rank === null) {
      releaseKeys.push(key);
    } else if (rank === 2 && input.canOperate(thread)) {
      markRead.push(thread);
      releaseKeys.push(key);
    }
  }
  return { markRead, releaseKeys };
}

/** Rows leave Priority at once; a row whose visit fails comes back. */
export async function markPriorityRead<
  T extends Pick<EnvironmentThreadShell, "environmentId" | "id">,
>(input: {
  readonly plan: ThreadPriorityReadPlan<T>;
  readonly release: (keys: readonly string[]) => void;
  readonly restore: (key: string) => void;
  readonly visit: (thread: T) => Promise<"visited" | "skipped" | "failed">;
}): Promise<void> {
  input.release(input.plan.releaseKeys);
  for (const thread of input.plan.markRead) {
    if ((await input.visit(thread)) === "failed") {
      const key = keyOf(thread);
      input.restore(input.plan.restoreKeyByKey?.get(key) ?? key);
    }
  }
}

/**
 * Reads the unread work folded under Priority rows along with a plan: each row's operable folded
 * unread threads are visited, and a failed visit restores the row. A row is released when the plan
 * already releases it or it sits in Priority only through that work; attention and working lifts
 * keep it there either way.
 */
export function withFoldedUnseen<T extends Pick<EnvironmentThreadShell, "environmentId" | "id">>(
  plan: ThreadPriorityReadPlan<T>,
  input: {
    readonly rows: readonly T[];
    readonly unseenUnder: (key: string) => readonly T[];
    readonly canOperate: (thread: T) => boolean;
    readonly liftedOnly: (row: T) => boolean;
  },
): ThreadPriorityReadPlan<T> {
  const markRead = [...plan.markRead];
  const releaseKeys = [...plan.releaseKeys];
  const visiting = new Set(markRead.map(keyOf));
  const restoreKeyByKey = new Map(plan.restoreKeyByKey ?? []);
  for (const row of input.rows) {
    const rowKey = keyOf(row);
    const children = input.unseenUnder(rowKey).filter(input.canOperate);
    if (children.length === 0) continue;
    for (const child of children) {
      const childKey = keyOf(child);
      if (!visiting.has(childKey)) {
        visiting.add(childKey);
        markRead.push(child);
      }
      restoreKeyByKey.set(childKey, rowKey);
    }
    if (!releaseKeys.includes(rowKey) && input.liftedOnly(row)) releaseKeys.push(rowKey);
  }
  return { markRead, releaseKeys, restoreKeyByKey };
}
