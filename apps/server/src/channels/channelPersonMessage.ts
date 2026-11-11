import type {
  ChannelInboundMessage,
  ChannelMessageMeta,
  ChannelQuestionId,
  ChannelRequester,
  ChannelTimelineRecord,
} from "@goat/contracts";

import type {
  ChannelOutboxInsert,
  ChannelStoredInput,
  ChannelStoredTask,
  ChannelTaskEventWrite,
} from "./ChannelLedger.ts";
import { deliveryIdFor } from "./channelIds.ts";
import { isSkillProposalAnswer, mayAnswerTask } from "./channelSkillProposalText.ts";

/**
 * What acceptance expects of a message sent from a task question's card: the question when the
 * task is the sender's, in this conversation, theirs to answer, still asks it, and takes this
 * answer; null otherwise. Other messages get nothing. Reception's committed decision replaces it
 * once (answerDecisionDelivery); other later revisions keep it.
 */
export const answerVerdict = (input: {
  readonly message: Pick<
    ChannelInboundMessage,
    "intent" | "taskId" | "questionId" | "connectionId" | "text"
  >;
  readonly requester: ChannelRequester | undefined;
  readonly conversationId: string;
  readonly task: ChannelStoredTask | undefined;
}): Pick<ChannelMessageMeta, "answersQuestionId"> => {
  const { message, requester, task } = input;
  if (message.intent !== "answer" || message.questionId === undefined) return {};
  const taken =
    task !== undefined &&
    requester !== undefined &&
    task.task.taskId === message.taskId &&
    task.ownerId === requester.ownerId &&
    task.task.conversationId === input.conversationId &&
    mayAnswerTask(requester, task.task, message.connectionId) &&
    task.task.openQuestions.some((question) => question.questionId === message.questionId) &&
    (task.task.skillProposal === undefined || isSkillProposalAnswer(message.text));
  return { answersQuestionId: taken ? message.questionId : null };
};

type PersonMessageEntry = Extract<ChannelTimelineRecord["entry"], { readonly type: "message" }>;

/**
 * The person's message as the bot thread shows it, from fields fixed when it was stored, plus
 * what the revision adds (its read time or the answer decision).
 */
export const personMessageEntry = (
  stored: ChannelStoredInput,
  added: Pick<ChannelMessageMeta, "readAt" | "answersQuestionId">,
): PersonMessageEntry => ({
  type: "message",
  role: "user",
  text: stored.message.text,
  ...(stored.message.attachments.length === 0 ? {} : { attachments: stored.message.attachments }),
  meta: {
    conversationId: stored.snapshot.conversationId,
    originKind: "goat",
    kind: "inbound",
    inputId: stored.snapshot.inputId,
    clientMessageId: stored.message.externalMessageId,
    ...added,
  },
});

/**
 * The delivery that records reception's decision on a GOAT answer, committed with the decision:
 * the question when this settling pass recorded the input as its answer, null otherwise.
 */
export const answerDecisionDelivery = (
  stored: ChannelStoredInput,
  taskEvents: ReadonlyArray<ChannelTaskEventWrite> = [],
): ReadonlyArray<ChannelOutboxInsert> => {
  const { message, snapshot } = stored;
  if (
    message.replyAddress.kind !== "goat" ||
    message.intent !== "answer" ||
    message.questionId === undefined ||
    message.taskId === undefined
  )
    return [];
  let answersQuestionId: ChannelQuestionId | null = null;
  for (const { event } of taskEvents) {
    if (event.type === "task.question.answered" && event.payload.inputId === snapshot.inputId)
      answersQuestionId = event.payload.questionId;
  }
  const causeKey = "answer:" + snapshot.inputId;
  const deliveryId = deliveryIdFor(causeKey);
  return [
    {
      deliveryId,
      causeKey,
      inputId: snapshot.inputId,
      message: {
        deliveryId,
        destination: message.replyAddress,
        kind: "receipt",
        text: "",
        inReplyToInputId: snapshot.inputId,
        personAnswer: { answersQuestionId },
      },
    },
  ];
};
