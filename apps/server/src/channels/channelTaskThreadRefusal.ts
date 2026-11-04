import { ChannelReceptionId, type ChannelReplyAddress } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as ChannelLedger from "./ChannelLedger.ts";
import { deliveryIdFor } from "./channelIds.ts";

export const refuseTaskThread = Effect.fn("ChannelTaskThread.refuse")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
  stored: ChannelLedger.ChannelStoredInput,
  owner: string,
) {
  const taskId = stored.message.taskId;
  if (taskId === undefined) return;
  const inputId = stored.snapshot.inputId;
  const now = DateTime.formatIso(yield* DateTime.now);
  const receptionId = ChannelReceptionId.make("channel-task-thread-refusal:" + inputId);
  const claimed = yield* ledger.beginReception({ owner, inputId, receptionId, readAt: now });
  if (claimed === undefined) return;
  const text = "That task isn't available here. Send it in the main chat.";
  const causeKey = "reply:" + inputId;
  const deliveryId = deliveryIdFor(causeKey);
  yield* ledger.completeReception({
    owner,
    inputId,
    receptionId,
    replyText: text,
    decision: { replyText: text, action: { type: "report_only" } },
    deliveries: [
      {
        causeKey,
        deliveryId,
        inputId,
        message: {
          deliveryId,
          destination: stored.message.replyAddress,
          kind: "receipt",
          text,
          inReplyToInputId: inputId,
        },
      },
    ],
    now,
  });
});

export const mentionFor = (address: ChannelReplyAddress, externalActorId: string | undefined) =>
  address.kind === "slack" ? externalActorId : undefined;
