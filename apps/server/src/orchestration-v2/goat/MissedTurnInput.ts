import { isSlashCommandMessage } from "../ContextHandoffDelivery.ts";
import { indexRunInputDelivery } from "@goat/shared/orchestrationV2ManualContinuation";
import {
  getProviderAttachmentLimitError,
  isCompactionCommandMessage,
  type ChatAttachment,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";

export function missedTurnInputRuns(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "messages">,
  run: OrchestrationV2Run,
) {
  const compactionMessageIds = new Set(
    projection.messages.filter(isCompactionCommandMessage).map((message) => message.id),
  );
  const evidence = indexRunInputDelivery(projection);
  return projection.runs.filter((source) => {
    const input = evidence.get(source.id);
    return (
      input?.delivery === "unsent" &&
      (input.replaced ||
        (source.manualContinuationOfRunId === undefined &&
          source.restartContinuationOfRunId === undefined &&
          source.usageLimitContinuationOfRunId === undefined)) &&
      source.ordinal < run.ordinal &&
      source.providerThreadId === run.providerThreadId &&
      (source.status === "failed" || source.status === "interrupted") &&
      !compactionMessageIds.has(source.userMessageId)
    );
  });
}

export function missedTurnImages(input: {
  readonly projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "messages">;
  readonly history: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly missedRuns: ReadonlyArray<OrchestrationV2Run>;
  readonly run: OrchestrationV2Run;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly goalDriver: boolean;
}) {
  const runs = new Map(input.projection.runs.map((run) => [run.id, run]));
  const messages = new Map(input.projection.messages.map((message) => [message.id, message]));
  const missed = new Map(input.missedRuns.map((run) => [run.id, run]));
  let lastPossibleDelivery = 0;
  for (const attempt of input.projection.attempts) {
    if (
      attempt.providerThreadId !== input.run.providerThreadId ||
      attempt.inputDelivery === "unsent"
    )
      continue;
    const run = runs.get(attempt.runId);
    if (!run || run.ordinal >= input.run.ordinal || missed.has(run.id)) continue;
    const message = messages.get(run.userMessageId);
    if (message && isSlashCommandMessage(message)) continue;
    // A replay may have carried older missed images alongside its identified source.
    lastPossibleDelivery = Math.max(lastPossibleDelivery, run.ordinal);
  }

  const selected: ChatAttachment[] = [];
  const seen = new Set(input.attachments.map((attachment) => attachment.id));
  for (const item of input.history) {
    if (item.type !== "user_message" || item.runId === null) continue;
    const source = missed.get(item.runId);
    if (
      !source ||
      source.ordinal <= lastPossibleDelivery ||
      item.messageId !== source.userMessageId
    )
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
