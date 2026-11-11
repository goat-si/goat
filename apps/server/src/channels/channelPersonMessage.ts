import type { ChannelInboundMessage, ChannelMessageMeta, ChannelRequester } from "@goat/contracts";

import type { ChannelStoredTask } from "./ChannelLedger.ts";
import { mayAnswerTask } from "./channelSkillProposalText.ts";

/**
 * The task question a person's message was sent to answer, when the server can stand behind it:
 * the task is the sender's, in this conversation, theirs to answer, and still asks that question.
 * Anything else carries no reference, so the chat shows it as a plain message.
 */
export const verifiedAnswerClaim = (input: {
  readonly message: Pick<
    ChannelInboundMessage,
    "intent" | "taskId" | "questionId" | "connectionId"
  >;
  readonly requester: ChannelRequester | undefined;
  readonly conversationId: string;
  readonly task: ChannelStoredTask | undefined;
}): Pick<ChannelMessageMeta, "answersQuestionId"> => {
  const { message, requester, task } = input;
  return message.intent === "answer" &&
    message.questionId !== undefined &&
    task !== undefined &&
    requester !== undefined &&
    task.task.taskId === message.taskId &&
    task.ownerId === requester.ownerId &&
    task.task.conversationId === input.conversationId &&
    mayAnswerTask(requester, task.task, message.connectionId) &&
    task.task.openQuestions.some((question) => question.questionId === message.questionId)
    ? { answersQuestionId: message.questionId }
    : {};
};
