import type { RunId } from "@goat/contracts";
import type { ThreadFeedEntry } from "./threadActivity";
let cachedThinkingRow: Extract<ThreadFeedEntry, { readonly type: "thinking" }> | null = null;
export const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

export function thinkingRow(
  createdAt: string,
  runId: RunId | null,
  providerStartingLabel: string | undefined,
) {
  if (
    cachedThinkingRow?.createdAt !== createdAt ||
    cachedThinkingRow.runId !== runId ||
    cachedThinkingRow.providerStartingLabel !== providerStartingLabel
  ) {
    cachedThinkingRow = {
      type: "thinking",
      id: LIVE_ACTIVITY_ROW_ID,
      createdAt,
      runId,
      ...(providerStartingLabel === undefined ? {} : { providerStartingLabel }),
    };
  }
  return cachedThinkingRow;
}
