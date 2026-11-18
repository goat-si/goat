import { workEntryDisplayIndicatesToolFailure } from "@goat/client-runtime/work-log/presentation";
import type { RunId } from "@goat/contracts";
import { resolveGoatMcpItemCall } from "@goat/shared/goatMcpToolPresentation";
import { compactDynamicToolOutput } from "@goat/shared/toolOutput";

import type {
  RawThreadFeedEntry,
  ThreadFeedActivity,
  ThreadFeedActivityGroup,
  ThreadFeedEntry,
} from "./threadActivityTypes";

const activityGroupsCache = new WeakMap<ThreadFeedActivity, ThreadFeedActivityGroup>();

function isEmptyMessage(entry: RawThreadFeedEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message.text.trim().length === 0 &&
    entry.message.attachments.length === 0
  );
}

/**
 * `onRestart` hears each entry after which no group is open, with the grouped
 * length so far: the entries before it group the same whatever follows.
 */
export function groupAdjacentActivities(
  entries: ReadonlyArray<RawThreadFeedEntry>,
  childrenByRun: ReadonlyMap<RunId, ReadonlySet<string>>,
  onRestart?: (entryIndex: number, groupedLength: number) => void,
): ThreadFeedEntry[] {
  const grouped: ThreadFeedEntry[] = [];
  let firstActivityEntry: Extract<RawThreadFeedEntry, { readonly type: "activity" }> | null = null;
  let openGroupActivities: ThreadFeedActivity[] = [];
  const flushGroup = () => {
    if (firstActivityEntry === null) return;
    const cached = activityGroupsCache.get(firstActivityEntry.activity);
    if (
      cached &&
      cached.activities.length === openGroupActivities.length &&
      cached.activities.every((activity, index) => activity === openGroupActivities[index])
    ) {
      grouped.push(cached);
    } else {
      const group: ThreadFeedActivityGroup = {
        type: "activity-group",
        id: firstActivityEntry.id,
        createdAt: firstActivityEntry.createdAt,
        runId: firstActivityEntry.runId,
        activities: openGroupActivities,
      };
      activityGroupsCache.set(firstActivityEntry.activity, group);
      grouped.push(group);
    }
    firstActivityEntry = null;
    openGroupActivities = [];
  };

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!;
    if (entry.type === "activity") {
      const item = entry.activity.projectedItem.item;
      if (
        item.type === "dynamic_tool" &&
        item.runId !== null &&
        (item.status === "running" || item.status === "completed") &&
        resolveGoatMcpItemCall(item).definition?.summaryAction === "delegate" &&
        !workEntryDisplayIndicatesToolFailure(entry.activity.workEntry)
      ) {
        const output = compactDynamicToolOutput(item.output);
        if (
          !output?.isError &&
          output?.taskId !== undefined &&
          childrenByRun.get(item.runId)?.has(output.taskId)
        )
          continue;
      }
    }
    if (isEmptyMessage(entry)) {
      continue;
    }

    if (entry.type !== "activity") {
      flushGroup();
      grouped.push(entry);
      onRestart?.(entryIndex, grouped.length);
      continue;
    }

    const isStandaloneActivity =
      entry.activity.workEntry.questionAnswer !== undefined ||
      entry.activity.projectedItem.item.type === "compaction" ||
      entry.activity.projectedItem.item.type === "handoff" ||
      entry.activity.projectedItem.item.type === "notification";
    if (
      isStandaloneActivity ||
      entry.activity.prominent ||
      (entry.activity.projectedItem.item.type === "subagent") !==
        (firstActivityEntry?.activity.projectedItem.item.type === "subagent") ||
      firstActivityEntry?.runId !== entry.runId ||
      (entry.activity.projectedItem.item.type === "subagent" &&
        firstActivityEntry?.activity.projectedItem.item.providerTurnId !==
          entry.activity.projectedItem.item.providerTurnId) ||
      (entry.activity.projectedItem.item.type !== "subagent" &&
        firstActivityEntry?.activity.attemptId !== entry.activity.attemptId)
    ) {
      flushGroup();
    }
    firstActivityEntry ??= entry;
    openGroupActivities.push(entry.activity);
    if (isStandaloneActivity || entry.activity.prominent) {
      flushGroup();
    }
  }
  flushGroup();
  return grouped;
}
