import type { RunId } from "@goat/contracts";

import type { TimelineEntry } from "../../session-logic";

export function timelineEntryIsSteer(entry: TimelineEntry): boolean {
  return (
    entry.kind === "message" &&
    entry.message.role === "user" &&
    (entry.message.inputIntent === "steer" ||
      entry.message.inputIntent === "promoted_queued_to_steer")
  );
}

export function timelineEntryStartsResponse(entry: TimelineEntry): boolean {
  return (
    (entry.kind === "message" && entry.message.role === "user" && !timelineEntryIsSteer(entry)) ||
    (entry.kind === "work" && entry.entry.itemType === "notification")
  );
}

export function timelineEntryEnd(entry: TimelineEntry): string {
  return entry.kind === "message" ? entry.message.updatedAt : entry.createdAt;
}

export function timelineEntryIsCompaction(entry: TimelineEntry): boolean {
  return entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction";
}

export function responseBoundaryRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message") return entry.message.runId ?? null;
  if (entry.kind === "work") return entry.entry.runId ?? null;
  return null;
}

// Group promptless restarts under the initiating prompt until settled.
export function lastResponseBoundaryIndex(timelineEntries: ReadonlyArray<TimelineEntry>): number {
  return timelineEntries.findLastIndex(timelineEntryStartsResponse);
}
