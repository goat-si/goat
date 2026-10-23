import {
  latestProviderTurnForAttempt,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";

export function isBufferedProviderNotification(
  message: OrchestrationV2ConversationMessage,
): boolean {
  return (
    message.createdBy === "agent" &&
    message.creationSource === "provider" &&
    message.notification !== undefined &&
    message.delegatedCompletion === undefined
  );
}

/**
 * Delivery is at least once: provider acceptance and our receipt cannot commit
 * atomically. Reusing the message ID keeps recovery from duplicating timeline items.
 */
export function isUndeliveredMailboxSteer(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs" | "providerTurns">,
  messageId: MessageId,
): boolean {
  const message = projection.messages.find((candidate) => candidate.id === messageId);
  if (message?.delegatedCompletion === undefined) return false;
  const run = projection.runs.find((candidate) => candidate.id === message.runId);
  return (
    run !== undefined &&
    run.userMessageId !== message.id &&
    (["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status) ||
      latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId)?.status ===
        "completed")
  );
}

export function followsCurrentConversation(
  message: OrchestrationV2ConversationMessage | undefined,
): boolean {
  return (
    message?.notification?.source.kind === "monitor" && !isBufferedProviderNotification(message)
  );
}

export function queuedRunModelSelection(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "messages">,
  run: OrchestrationV2Run,
): ModelSelection {
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  // App-owned monitor updates follow the agent currently handling the thread.
  return followsCurrentConversation(message)
    ? projection.thread.modelSelection
    : run.modelSelection;
}
