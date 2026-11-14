import type { RunId } from "@goat/contracts";

export type ThinkingRow = {
  readonly type: "thinking";
  readonly id: string;
  readonly createdAt: string;
  readonly runId: RunId | null;
  readonly providerStartingLabel?: string;
};

let cachedThinkingRow: ThinkingRow | null = null;
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
