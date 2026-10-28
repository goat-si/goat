import {
  isCompactionCommandMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type RunAttemptId,
} from "@goat/contracts";

export function missedTurnInputRuns(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
  deliveredAttemptIds: ReadonlySet<RunAttemptId | null>,
) {
  const compactionMessageIds = new Set(
    projection.messages.filter(isCompactionCommandMessage).map((message) => message.id),
  );
  return projection.runs.filter(
    (source) =>
      source.ordinal < run.ordinal &&
      source.providerThreadId === run.providerThreadId &&
      (source.status === "failed" || source.status === "interrupted") &&
      !deliveredAttemptIds.has(source.activeAttemptId) &&
      !compactionMessageIds.has(source.userMessageId),
  );
}
