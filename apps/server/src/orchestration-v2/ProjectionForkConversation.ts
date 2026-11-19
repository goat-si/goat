import type { OrchestrationV2ThreadProjection } from "@goat/contracts";

// A fork inherits its source's history before it has messages of its own,
// unless a portable handoff's budget left none of that history to deliver.
export const inheritsForkConversation = ({
  thread,
  contextTransfers,
  contextHandoffs,
}: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers" | "contextHandoffs">) => {
  if (thread.forkedFrom?.type !== "run") return false;
  const resolution = contextTransfers.find(
    (transfer) => transfer.type === "fork" && transfer.targetThreadId === thread.id,
  )?.resolution;
  return (
    resolution?.strategy !== "portable_context" ||
    contextHandoffs.some(
      (handoff) =>
        handoff.id === resolution.contextHandoffId && (handoff.history?.messages.length ?? 0) > 0,
    )
  );
};
