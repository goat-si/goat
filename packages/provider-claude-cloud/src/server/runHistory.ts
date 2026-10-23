import type { OrchestrationV2ThreadProjection, RunId } from "@goat/contracts";

/**
 * A run's own message and whether it is the thread's first run on its cloud instance, which is
 * the run that registered a session started outside GOAT.
 */
export function cloudRunHistory(
  records: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
) {
  const run = records.runs.find((item) => item.id === runId);
  if (!run) return undefined;
  return {
    prompt: records.messages.find((message) => message.id === run.userMessageId)?.text,
    first: !records.runs.some(
      (item) =>
        item.providerInstanceId === run.providerInstanceId &&
        item.ordinal < run.ordinal &&
        item.startedAt !== null &&
        item.status !== "rolled_back",
    ),
  };
}
