/**
 * Whether someone other than a task's requester may still direct it when their follow-up or answer
 * is delivered: the acceptance rule (mayAnswerFor) again, with both people as they stand now.
 */
import type { ChannelRequester, ChannelTask, ChannelTaskSender } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { isSameIdentity, mayAnswerFor } from "./ChannelGateway.ts";
import type * as ChannelLedger from "./ChannelLedger.ts";
import { currentRequester, requesterForDispatch } from "./channelDispatchAuthority.ts";
import { deliveryIdFor } from "./channelIds.ts";

export const senderOf = (requester: ChannelRequester, connectionId: string): ChannelTaskSender => ({
  requester,
  connectionId,
});

/** The message an approval reply came in: its channel for the record, its connection for identity. */
export type ApprovalVia = {
  readonly kind: ChannelRequester["originKind"];
  readonly connectionId: string;
};

/**
 * The requester to deliver under, or why not. An event stored before senders were recorded is
 * delivered as before: it cannot say who sent it, and it passed mayAnswerFor when accepted.
 */
export const requesterForDelivery = Effect.fn("channel.requesterForDelivery")(function* (
  task: ChannelTask,
  sender: ChannelTaskSender | undefined,
) {
  const requester = yield* requesterForDispatch(task);
  if (requester === undefined) return { _tag: "requester_changed" } as const;
  if (sender === undefined) return { _tag: "allowed", requester } as const;
  const current = yield* currentRequester(sender.requester, sender.connectionId);
  const same = isSameIdentity(sender.requester, sender.connectionId, task);
  if (current === undefined || !mayAnswerFor(current, requester, same))
    return { _tag: "sender_changed", name: sender.requester.displayName } as const;
  return { _tag: "allowed", requester } as const;
});

export const senderAnswerRefused = (name: string) =>
  name +
  "'s answer wasn't passed on: their access changed after they sent it. " +
  "Answer again, or answer in the thread.";

/**
 * Drops a follow-up whose sender may no longer direct the work: one notice to the conversation
 * written in the same transaction that ends the forward (so a crash leaves neither, and the next
 * pass checks again), lifting the fence only when this follow-up holds it. The task runs on.
 */
export const refuseSenderFollowUp = Effect.fn("channel.refuseSenderFollowUp")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
  stored: ChannelLedger.ChannelStoredTask,
  input: {
    readonly eventId: string;
    readonly name: string;
    readonly owner: string;
    readonly sequence: number;
    readonly own: ReadonlyArray<string>;
  },
) {
  const latest = (yield* ledger.getTask(stored.task.taskId)) ?? stored;
  const causeKey = "sender-refused:" + input.eventId;
  const deliveryId = deliveryIdFor(causeKey);
  const fence = latest.pendingAnswerMessageId;
  yield* ledger.completeForward({
    owner: input.owner,
    sequence: input.sequence,
    clearPendingAnswerMessageId:
      fence !== undefined && input.own.includes(fence) ? fence : undefined,
    deliveries: {
      rows: [
        {
          deliveryId,
          causeKey,
          taskId: latest.task.taskId,
          message: {
            deliveryId,
            destination: latest.task.originAddress,
            kind: "receipt",
            text:
              "I didn't pass on " +
              input.name +
              "'s follow-up: their access changed after they sent it.",
            taskId: latest.task.taskId,
            taskVersion: latest.task.version,
          },
        },
      ],
      now: DateTime.formatIso(yield* DateTime.now),
    },
  });
});
