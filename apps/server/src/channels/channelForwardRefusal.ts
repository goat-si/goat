import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as ChannelLedger from "./ChannelLedger.ts";
import { questionIdFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";

export const refuseForward = Effect.fn("channel.refuseForward")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
  stored: ChannelLedger.ChannelStoredTask,
  text: string,
  owner: string,
  sequence: number,
  messageIds: ReadonlyArray<string>,
) {
  const latest = (yield* ledger.getTask(stored.task.taskId)) ?? stored;
  const ownsFence =
    latest.pendingAnswerMessageId !== undefined &&
    messageIds.includes(latest.pendingAnswerMessageId);
  if (
    latest.task.status === "completed" ||
    latest.task.status === "failed" ||
    latest.task.status === "cancelled"
  ) {
    yield* ledger.completeForward({
      owner,
      sequence,
      clearPendingAnswerMessageId: ownsFence ? latest.pendingAnswerMessageId : undefined,
    });
    return;
  }
  yield* commitTransition(
    ledger,
    latest,
    {
      type: "task.question.opened",
      payload: {
        question: {
          questionId: questionIdFor(latest.task.taskId, latest.task.version + 1),
          text,
          askedAt: DateTime.formatIso(yield* DateTime.now),
          ...(latest.task.requester.externalActorId === undefined
            ? {}
            : { requesterExternalActorId: latest.task.requester.externalActorId }),
        },
      },
    },
    {
      owner,
      narrate: true,
      ...(ownsFence ? { pendingAnswerMessageId: null } : {}),
      completeForwardSequence: sequence,
    },
  );
});
