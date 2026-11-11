import type { ChannelInboundMessage, ChannelMessageMeta, ChannelRequester } from "@goat/contracts";

import type { ChannelStoredTask } from "./ChannelLedger.ts";
import { isSkillProposalAnswer, mayAnswerTask } from "./channelSkillProposalText.ts";

/**
 * What the server decided about a message sent from a task question's card: the question, when
 * the task is the sender's, in this conversation, theirs to answer, still asks it, and takes this
 * answer; null otherwise, so the chat keeps it as a plain message. Other messages get nothing.
 * Decided once, when the message is accepted; later revisions of the message keep it.
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
