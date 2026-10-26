/**
 * Whether an answer from a channel can reach the question it names. A question can close before the
 * answer arrives: someone answered it first, or a second tap repeats an answer already passed on.
 * Those get a plain "already answered" instead of the ask-again reply for a question never seen.
 *
 * @module channelQuestionAnswers
 */
import type { ChannelConversationId, ChannelQuestionId, ChannelTaskId } from "@goat/contracts";
import type { ChannelReceptionResult } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { CHANNEL_COPY } from "./channelCopy.ts";
import type * as ChannelLedger from "./ChannelLedger.ts";

type StoredTask = NonNullable<
  Effect.Success<ReturnType<ChannelLedger.ChannelLedger["Service"]["getTask"]>>
>;
type Checked =
  | { readonly stored: StoredTask; readonly refused?: undefined }
  | { readonly stored?: undefined; readonly refused: ChannelReceptionResult };

const unmatched = "I couldn't match that to an open question. Which task do you mean?";

/** The task holding the open question, or the reply that says why the answer was not passed on. */
export const openQuestionTask = Effect.fn("channelQuestionAnswers.openQuestionTask")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
  target: {
    readonly taskId: ChannelTaskId;
    readonly questionId: ChannelQuestionId;
    readonly conversationId: ChannelConversationId;
  },
): Effect.fn.Return<Checked, ChannelLedger.ChannelLedgerError> {
  const stored = yield* ledger.getTask(target.taskId);
  if (stored === undefined || stored.task.conversationId !== target.conversationId)
    return { refused: { replyText: unmatched, action: { type: "clarify", question: unmatched } } };
  if (stored.task.openQuestions.some((question) => question.questionId === target.questionId))
    return { stored };
  const answered = (yield* ledger.recentAnswers(stored.task.taskId, 20)).some(
    (event) => event.payload.questionId === target.questionId,
  );
  const refused: ChannelReceptionResult = answered
    ? { replyText: CHANNEL_COPY.questionAlreadyAnswered, action: { type: "report_only" } }
    : { replyText: unmatched, action: { type: "clarify", question: unmatched } };
  return { refused };
});
