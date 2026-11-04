import * as Effect from "effect/Effect";
import { mayAnswerFor } from "./ChannelGateway.ts";
import type * as ChannelLedger from "./ChannelLedger.ts";

export const isTerminalThread = Effect.fn("ChannelTaskThread.isTerminal")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
  stored: ChannelLedger.ChannelStoredInput,
) {
  if (
    stored.message.intent !== "message" ||
    stored.message.taskId === undefined ||
    stored.requester === undefined
  )
    return false;
  const target = yield* ledger.getTask(stored.message.taskId);
  return (
    target !== undefined &&
    target.ownerId === stored.requester.ownerId &&
    target.task.conversationId === stored.snapshot.conversationId &&
    mayAnswerFor(stored.requester, target.task.requester) &&
    ["completed", "failed", "cancelled"].includes(target.task.status)
  );
});

export const mainThreadInput = (stored: ChannelLedger.ChannelStoredInput) =>
  stored.message.intent === "message"
    ? { ...stored, message: { ...stored.message, taskId: undefined } }
    : stored;

export const shouldRefuseTaskThread = Effect.fn("ChannelTaskThread.shouldRefuse")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
  stored: ChannelLedger.ChannelStoredInput,
) {
  return (
    stored.message.intent === "message" &&
    stored.message.taskId !== undefined &&
    !(yield* isTerminalThread(ledger, stored))
  );
});
