import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as ChannelLedger from "./ChannelLedger.ts";
import { questionIdFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";

export const refuseForward = Effect.fn("channel.refuseForward")(function* (
  sql: SqlClient.SqlClient,
  ledger: ChannelLedger.ChannelLedger["Service"],
  stored: ChannelLedger.ChannelStoredTask,
  text: string,
  owner: string,
  sequence: number,
) {
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const state = yield* sql<{ readonly forward_state: string }>`
        SELECT forward_state FROM channel_task_events WHERE sequence = ${sequence}
      `;
      if (state[0]?.forward_state !== "pending") return;
      const latest = (yield* ledger.getTask(stored.task.taskId)) ?? stored;
      const asked = yield* commitTransition(
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
        { owner, narrate: true, pendingAnswerMessageId: null },
      );
      if (asked !== undefined) yield* ledger.completeForward({ owner, sequence });
    }),
  );
});
