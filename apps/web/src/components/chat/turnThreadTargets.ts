import type { RunId } from "@goat/contracts";

import type { TimelineEntry } from "../../session-logic";
import { goatThreadCallOf } from "./goatThreadCalls";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/** A thread a turn started or messaged, shown as a card at the end of that turn. */
export interface TurnThreadTarget {
  readonly threadId: string;
  readonly title: string | null;
  readonly via: "launch" | "send";
  /** The machine the thread runs on when it is not this environment's. */
  readonly host: string | null;
}

export function turnThreadTargetsEqual(
  left: ReadonlyArray<TurnThreadTarget>,
  right: ReadonlyArray<TurnThreadTarget>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (target, index) =>
        target.threadId === right[index]?.threadId &&
        target.title === right[index]?.title &&
        target.via === right[index]?.via &&
        target.host === right[index]?.host,
    )
  );
}

/** Threads each run started (thread_created items, launch calls) or messaged, first mention first. */
function collectTurnThreadTargets(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): ReadonlyMap<RunId, TurnThreadTarget[]> {
  const byRun = new Map<RunId, TurnThreadTarget[]>();
  const add = (runId: RunId | null | undefined, target: TurnThreadTarget) => {
    if (runId == null) return;
    const targets = byRun.get(runId) ?? [];
    const same = targets.find(
      (existing) => existing.threadId === target.threadId && existing.host === target.host,
    );
    if (same === undefined) targets.push(target);
    // A launch outranks a later send to the same thread; a title fills in when first known.
    else if (same.title === null && target.title !== null)
      targets[targets.indexOf(same)] = { ...same, title: target.title };
    byRun.set(runId, targets);
  };
  for (const entry of timelineEntries) {
    const projected =
      entry.kind === "work"
        ? entry.entry.projectedItem
        : entry.kind === "event"
          ? entry.projectedItem
          : undefined;
    if (projected?.item.type === "thread_created") {
      add(projected.item.runId, {
        threadId: projected.item.targetThreadId,
        title: projected.item.title,
        via: "launch",
        host: null,
      });
      continue;
    }
    if (entry.kind !== "work") continue;
    const call = goatThreadCallOf(entry.entry);
    if (call === null) continue;
    for (const threadId of call.threadIds) {
      add(call.runId as RunId | null, {
        threadId,
        title: call.kind === "send" || call.threadIds.length > 1 ? null : call.title,
        via: call.kind === "send" ? "send" : "launch",
        host: call.kind === "ssh_launch" || call.kind === "send" ? call.host : null,
      });
    }
  }
  return byRun;
}

/**
 * Collects the threads each run started or messaged into one card row after its closing
 * answer. The created-thread events themselves leave the timeline once a closing answer holds
 * them, or when their turn is folded away.
 */
export function attachTurnThreadCards(
  rows: MessagesTimelineRow[],
  timelineEntries: ReadonlyArray<TimelineEntry>,
  collapsedFoldMemberIds: ReadonlySet<string>,
): MessagesTimelineRow[] {
  const terminalIndexes = new Map<RunId, number>();
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && row.showAssistantMeta && row.message.runId) {
      terminalIndexes.set(row.message.runId, index);
    }
  }
  const targetsByRun = collectTurnThreadTargets(timelineEntries);
  return rows.flatMap((row, index): MessagesTimelineRow[] => {
    if (row.kind === "event" && row.projectedItem.item.type === "thread_created") {
      const runId = row.projectedItem.item.runId;
      const terminalIndex = runId === null ? undefined : terminalIndexes.get(runId);
      if (
        terminalIndex !== undefined &&
        (collapsedFoldMemberIds.has(row.id) || index > terminalIndex)
      )
        return [];
    }
    if (row.kind === "message" && row.showAssistantMeta && row.message.runId) {
      const targets = targetsByRun.get(row.message.runId) ?? [];
      return targets.length === 0
        ? [row]
        : [
            row,
            {
              kind: "thread-cards",
              id: `thread-cards:${row.message.id}`,
              createdAt: row.createdAt,
              runId: row.message.runId,
              targets,
            },
          ];
    }
    return [row];
  });
}
