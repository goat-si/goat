import { unsentManualContinuationSource } from "../manualContinuation.ts";
import {
  getProviderAttachmentLimitError,
  isCompactionCommandMessage,
  parseGoalCommand,
  type ChatAttachment,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
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

export function missedTurnImages(input: {
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "attempts" | "providerTurns" | "messages"
  >;
  readonly history: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly missedRuns: ReadonlyArray<OrchestrationV2Run>;
  readonly acceptedAttempts: ReadonlyArray<OrchestrationV2RunAttempt>;
  readonly run: OrchestrationV2Run;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly goalDriver: boolean;
}) {
  const runs = new Map(input.projection.runs.map((run) => [run.id, run]));
  const messages = new Map(input.projection.messages.map((message) => [message.id, message]));
  const missed = new Map(input.missedRuns.map((run) => [run.id, run]));
  let lastAccepted = 0;
  for (const attempt of input.acceptedAttempts) {
    const run = runs.get(attempt.runId);
    if (!run || run.ordinal >= input.run.ordinal || missed.has(run.id)) continue;
    const message = messages.get(run.userMessageId);
    if (
      message &&
      (isCompactionCommandMessage(message) ||
        (input.goalDriver && parseGoalCommand(message) !== null))
    )
      continue;
    if (
      run.manualContinuationOfRunId !== undefined &&
      attempt.reason !== "steering_restart" &&
      unsentManualContinuationSource(run, input.projection) === undefined
    )
      continue;
    lastAccepted = Math.max(lastAccepted, run.ordinal);
  }

  const selected: ChatAttachment[] = [];
  const seen = new Set(input.attachments.map((attachment) => attachment.id));
  for (const item of input.history) {
    if (item.type !== "user_message" || item.runId === null) continue;
    const source = missed.get(item.runId);
    if (!source || source.ordinal <= lastAccepted || item.messageId !== source.userMessageId)
      continue;
    for (const image of item.attachments) {
      if (image.type !== "image" || seen.has(image.id)) continue;
      if (getProviderAttachmentLimitError([...input.attachments, ...selected, image]) !== undefined)
        continue;
      seen.add(image.id);
      selected.push(image);
    }
  }
  return selected;
}
