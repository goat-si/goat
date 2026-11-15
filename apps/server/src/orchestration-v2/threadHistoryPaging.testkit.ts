import {
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

export const NOW = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
export const THREAD = ThreadId.make("thread-1");

export function makeRow(
  index: number,
  options?: { readonly outputBytes?: number },
): OrchestrationV2ProjectedTurnItem {
  const id = TurnItemId.make(`item-${index}`);
  const output =
    options?.outputBytes !== undefined ? "x".repeat(options.outputBytes) : `output-${index}`;
  return {
    position: index,
    visibility: "local",
    sourceThreadId: THREAD,
    sourceItemId: id,
    item: {
      id,
      type: "command_execution",
      threadId: THREAD,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed",
      title: `Command ${index}`,
      input: `cmd-${index}`,
      output,
      exitCode: 0,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    },
  };
}

export function makeTurnStart(
  index: number,
  createdBy: "user" | "agent",
): OrchestrationV2ProjectedTurnItem {
  const row = makeRow(index);
  return {
    ...row,
    item: {
      ...row.item,
      type: "user_message",
      createdBy,
      creationSource: "provider",
      inputIntent: "turn_start",
      messageId: MessageId.make(`prompt-${index}`),
      text: `Prompt ${index}`,
      attachments: [],
    },
  } as OrchestrationV2ProjectedTurnItem;
}
