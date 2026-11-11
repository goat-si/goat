import type { ChannelInboundMessage, ChannelMessageMeta } from "@goat/contracts";

/**
 * What a person's own message in the bot chat says about itself, read only from the message they
 * sent, so every revision of it (accepted, read) carries the same fields in whatever order they land.
 */
export const personMessageClaim = (
  message: Pick<ChannelInboundMessage, "intent" | "taskId" | "questionId">,
): Pick<ChannelMessageMeta, "answersQuestionId"> =>
  message.intent === "answer" && message.taskId !== undefined && message.questionId !== undefined
    ? { answersQuestionId: message.questionId }
    : {};
