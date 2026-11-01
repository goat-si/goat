import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@goat/contracts";

import type { ThreadHistoryMeta } from "./threadHistoryMerge.ts";

export function historyMetaFromCachedSnapshot(
  snapshot: OrchestrationV2ThreadDetailSnapshot,
): ThreadHistoryMeta {
  const historyCursor = snapshot.historyCursor ?? null;
  const hasMoreHistory = snapshot.hasMoreHistory ?? false;
  return {
    historyCursor,
    hasMoreHistory,
    loading: false,
    error: null,
    expanded: false,
    latestLocalTurnOrdinal: snapshot.latestLocalTurnOrdinal ?? null,
  };
}

export function snapshotToPersist(
  snapshotSequence: number,
  projection: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
  acceptsBoundedSnapshots: boolean,
): OrchestrationV2ThreadDetailSnapshot {
  // A complete bounded snapshot still proves paging support. Retain that evidence
  // so a thread that grows while closed can resume with a bounded fallback.
  if (acceptsBoundedSnapshots || history.hasMoreHistory || history.historyCursor !== null) {
    return {
      snapshotSequence,
      projection,
      historyCursor: history.historyCursor,
      hasMoreHistory: history.hasMoreHistory,
      latestLocalTurnOrdinal: history.latestLocalTurnOrdinal,
    };
  }
  return { snapshotSequence, projection };
}

export function shouldPersistThread(
  thread: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
): boolean {
  // After the user loads older pages the in-memory timeline can grow large.
  // Keep those expanded projections out of the monolithic cache.
  if (history.expanded) {
    return false;
  }
  return !thread.runs.some(
    (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
  );
}

// Only still-active local copies take the server's item: events applied meanwhile win,
// and inherited rows belong to another thread.
export function settleTurnItems(
  threadId: ThreadId,
  projection: OrchestrationV2ThreadProjection,
  settled: ReadonlyMap<string, OrchestrationV2TurnItem>,
): OrchestrationV2ThreadProjection {
  let changed = false;
  const settle = (item: OrchestrationV2TurnItem, id: string) => {
    const server = settled.get(id);
    if (server === undefined || !isOrchestrationV2WorkActive(item.status)) return item;
    changed = true;
    return server;
  };
  const turnItems = projection.turnItems.map((item) => settle(item, item.id));
  const visibleTurnItems = projection.visibleTurnItems.map((row) => {
    if (row.sourceThreadId !== threadId) return row;
    const item = settle(row.item, row.sourceItemId);
    return item === row.item ? row : { ...row, item };
  });
  return changed ? { ...projection, turnItems, visibleTurnItems } : projection;
}
