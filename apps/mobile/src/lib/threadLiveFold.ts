import { RunId } from "@goat/contracts";
import { isLiveSubagentTurnItem } from "@goat/client-runtime/state/subagentRuntime";
import type { ThreadFeedEntry } from "./threadActivityTypes";
import { feedEntryRunId, isUserMessageEntry } from "./threadFeedIdentity";

let cachedRow: Extract<ThreadFeedEntry, { type: "run-fold" }> | null = null;

export function createLiveFold(input: {
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly prefix: ReadonlyArray<ThreadFeedEntry>;
  readonly activeRunId: RunId | null;
  readonly startedAt: string | null;
  readonly working: boolean;
  readonly runless: boolean;
  readonly zen: boolean;
  readonly compactionRuns: ReadonlySet<RunId>;
}) {
  const prompt =
    input.activeRunId === null && input.runless
      ? input.feed.findLast((entry) => isUserMessageEntry(entry) && feedEntryRunId(entry) === null)
      : undefined;
  const runId = input.activeRunId ?? (prompt ? RunId.make(`runless:${prompt.id}`) : null);
  let row: Extract<ThreadFeedEntry, { type: "run-fold" }> | null = null;
  if (!input.zen && input.working && input.startedAt && runId && !input.compactionRuns.has(runId)) {
    if (cachedRow?.runId !== runId || cachedRow.workingSince !== input.startedAt) {
      cachedRow = {
        type: "run-fold",
        id: `run-fold:${runId}`,
        createdAt: input.startedAt,
        runId,
        label: "Working",
        expanded: false,
        workingSince: input.startedAt,
      };
    }
    row = cachedRow;
  }
  let placed = row !== null && input.prefix.some((entry) => entry.id === row.id);
  let ready =
    row !== null &&
    input.activeRunId !== null &&
    !input.feed.some(
      (entry) => isUserMessageEntry(entry) && feedEntryRunId(entry) === input.activeRunId,
    );
  return {
    before(entry: ThreadFeedEntry): ThreadFeedEntry | null {
      if (!row || placed || feedEntryRunId(entry) !== input.activeRunId) return null;
      if (isUserMessageEntry(entry)) {
        ready = input.activeRunId !== null || entry === prompt;
        return null;
      }
      const outside =
        entry.type === "html-render" ||
        entry.type === "sent-message" ||
        entry.type === "mcp-app" ||
        (entry.type === "activity-group" &&
          entry.activities.some(
            (activity) =>
              activity.prominent ||
              activity.workEntry.questionAnswer !== undefined ||
              activity.projectedItem.item.type === "notification" ||
              activity.projectedItem.item.type === "handoff" ||
              isLiveSubagentTurnItem(activity.projectedItem.item) ||
              activity.projectedItem.item.type === "compaction",
          ));
      if (!ready || outside) return null;
      placed = true;
      return row;
    },
    end(): ThreadFeedEntry | null {
      return placed ? null : row;
    },
  };
}
