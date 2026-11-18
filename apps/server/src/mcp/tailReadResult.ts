import type { OrchestratorMcpThreadReadResult } from "@goat/contracts";

// subagentResultForRun reports a run's newest assistant message, or its error when it failed.
const RESULT_TYPES = new Set(["assistant_message", "error"]);

/** A tail read that cut the finished run's result leaves it to the completion wake, which sends it whole. */
export const tailCutsResult = (read: Pick<OrchestratorMcpThreadReadResult, "thread" | "items">) =>
  read.items
    .filter(
      (item) =>
        item.runId === read.thread.latestRunId && RESULT_TYPES.has(item.type) && item.text !== null,
    )
    .reduce<OrchestratorMcpThreadReadResult["items"][number] | undefined>(
      (newest, item) => (newest === undefined || item.position > newest.position ? item : newest),
      undefined,
    )?.textTruncated === true;
