import type { OrchestrationV2ThreadProjection, RunId } from "@goat/contracts";
import { CLOUD_DELIVERY_REJECTED_CODE } from "@goat/provider-core/server/cloudTask";

/**
 * A run's own message, the messages earlier runs on the same cloud instance delivered, and
 * whether it is the thread's first run there. A run whose delivery Claude refused sent nothing,
 * so its text claims no cloud prompt; a run with an uncertain delivery still counts, because a
 * missed reply is safer than another run's reply.
 */
export function cloudRunHistory(
  records: Pick<OrchestrationV2ThreadProjection, "runs" | "messages" | "turnItems">,
  runId: RunId,
) {
  const run = records.runs.find((item) => item.id === runId);
  if (!run) return undefined;
  const text = (messageId: string) =>
    records.messages.find((message) => message.id === messageId)?.text;
  const earlier = records.runs.filter(
    (item) =>
      item.providerInstanceId === run.providerInstanceId &&
      item.ordinal < run.ordinal &&
      item.startedAt !== null &&
      item.status !== "rolled_back",
  );
  const refused = (id: RunId) =>
    records.turnItems.some(
      (item) =>
        item.runId === id &&
        item.type === "error" &&
        item.failure.code === CLOUD_DELIVERY_REJECTED_CODE,
    );
  return {
    prompt: text(run.userMessageId),
    earlierPrompts: earlier.flatMap((item) => {
      const sent = refused(item.id) ? undefined : text(item.userMessageId);
      return sent === undefined ? [] : [sent];
    }),
    first: earlier.length === 0,
  };
}
