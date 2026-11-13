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
  /**
   * Refuses only while this holds. It runs under the write lock the refusal commits in, so
   * nothing it reads can change before the commit.
   */
  guard?: (
    latest: ChannelLedger.ChannelStoredTask,
  ) => Effect.Effect<boolean, ChannelLedger.ChannelLedgerError>,
) {
  const refuse = Effect.gen(function* () {
    const latest = (yield* ledger.getTask(stored.task.taskId)) ?? stored;
    if (guard !== undefined && !(yield* guard(latest))) return;
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
  yield* guard === undefined ? refuse : ledger.underWorkerLock(owner, refuse);
});
