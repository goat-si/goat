/**
 * Whether someone other than a task's requester may still direct it when their follow-up or answer
 * is delivered: the acceptance rule (mayAnswerFor) again, with both people as they stand now.
 */
import type {
  ChannelInputId,
  ChannelRequester,
  ChannelTask,
  ChannelTaskSender,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { mayAnswerFor } from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { currentRequester, requesterForDispatch } from "./channelDispatchAuthority.ts";
import { refuseForward } from "./channelForwardRefusal.ts";
import { deliveryIdFor } from "./channelIds.ts";
import { canReadChannelBotNotes } from "./slack/slackNoteAccess.ts";

export const senderOf = (
  requester: ChannelRequester,
  connectionId: string,
  inputId: ChannelInputId,
): ChannelTaskSender => ({ requester, connectionId, inputId });

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
  inputId: ChannelInputId | undefined,
  requiresMemory = false,
) {
  const requester = yield* requesterForDispatch(task);
  if (requester === undefined || (requiresMemory && !canReadChannelBotNotes(requester)))
    return { _tag: "requester_changed" } as const;
  const sourceId = sender?.inputId ?? inputId;
  if (sender === undefined && !requiresMemory) return { _tag: "allowed", requester } as const;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const original =
    sender === undefined && sourceId !== undefined ? yield* ledger.getInput(sourceId) : undefined;
  const snapshot = sender?.requester ?? original?.requester;
  if (
    snapshot === undefined ||
    (requiresMemory && snapshot.originKind === "goat" && sourceId === undefined)
  )
    return { _tag: "requester_changed" } as const;
  const current = yield* currentRequester(
    snapshot,
    sender?.connectionId ?? original?.message.connectionId,
    sourceId,
  );
  if (
    current === undefined ||
    !mayAnswerFor(current, requester) ||
    (requiresMemory && !canReadChannelBotNotes(current))
  )
    return { _tag: "sender_changed", name: snapshot.displayName } as const;
  return { _tag: "allowed", requester } as const;
});

export const senderAnswerRefused = (name: string) =>
  name +
  "'s answer wasn't passed on: their access changed after they sent it. " +
  "Answer again, or answer in the thread.";

/** Asks again for an answer that was not delivered because its sender's or requester's access changed. */
export const refuseAnswerForward = Effect.fn("channel.refuseAnswerForward")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
  stored: ChannelLedger.ChannelStoredTask,
  authority:
    | { readonly _tag: "requester_changed" }
    | { readonly _tag: "sender_changed"; readonly name: string },
  owner: string,
  sequence: number,
  ids: { readonly messageId: string },
) {
  yield* refuseForward(
    ledger,
    stored,
    authority._tag === "sender_changed"
      ? senderAnswerRefused(authority.name)
      : "The requester’s permission changed; your answer was not sent. Open the thread in GOAT.",
    owner,
    sequence,
    [ids.messageId],
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ChannelLedger.ChannelLedgerError({
          reason: "persistence",
          detail: "Could not record forward refusal.",
          cause,
        }),
    ),
  );
});

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
