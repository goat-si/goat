/**
 * Choices a person can answer without a model: the options on an approval card or an open
 * question. Slack and iMessage show them as `1. label`, `2. label`. A reply that is only a
 * number picks from the latest of those still open.
 *
 * "Latest" is derived, not stored. An approval card's time is when its code was issued, which
 * is when the card is built. A question's time is `askedAt`. A higher approval code wins a tie
 * because codes issued in one pass share a timestamp and are issued in order. A later "which
 * approval?" clarification is not its own list: a number answers the latest open card.
 *
 * @module channelDecisionChoices
 */
import type { ChannelQuestionId, ChannelTaskId } from "@goat/contracts";

export type DeliveredChoiceTarget =
  | { readonly type: "approval" }
  | {
      readonly type: "question";
      readonly taskId: ChannelTaskId;
      readonly questionId: ChannelQuestionId;
    };

/** One numbered list still open in a conversation. */
export interface DeliveredChoices {
  /** When the card or question was issued, ISO-8601. */
  readonly at: string;
  /** Higher means later when `at` ties. Approval codes use their number. */
  readonly tie: number;
  readonly options: ReadonlyArray<string>;
  readonly target: DeliveredChoiceTarget;
}

/** The list issued last. Empty option lists are not choices. */
export const latestDeliveredChoices = (
  choices: ReadonlyArray<DeliveredChoices>,
): DeliveredChoices | undefined =>
  choices
    .filter((entry) => entry.options.length > 0)
    .toSorted((left, right) => left.at.localeCompare(right.at) || left.tie - right.tie)
    .at(-1);

/** "2" and "2." are choice numbers. Anything else is a normal message. */
export const parseNumberedReply = (text: string): number | undefined => {
  const match = /^(\d+)\.?$/.exec(text.trim());
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
};

/** The option a number picks, 1-based. Out of range is not a choice. */
export const choiceAt = (choices: DeliveredChoices, number: number): string | undefined =>
  choices.options[number - 1];

/**
 * The option whose label equals `text`, ignoring case and surrounding space. The returned
 * label is the one that was offered, so a project question matches the real name.
 */
export const matchingOption = (
  text: string,
  options: ReadonlyArray<string>,
): string | undefined => {
  const wanted = text.trim().toLowerCase();
  if (wanted === "") return undefined;
  return options.find((option) => option.toLowerCase() === wanted);
};

/** How Slack, iMessage, and other non-button transports list choices under the card text. */
export const numberedChoiceLines = (options: ReadonlyArray<string>): string =>
  options.map((option, index) => `${index + 1}. ${option}`).join("\n");

/** Approval codes sort in the order they were issued: A1, then A2. */
export const approvalCodeOrder = (code: string): number => {
  const match = /^A(\d+)$/.exec(code);
  if (match?.[1] === undefined) return 0;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : 0;
};

export interface OpenQuestionChoice {
  readonly taskId: ChannelTaskId;
  readonly questionId: ChannelQuestionId;
  readonly options: ReadonlyArray<string> | undefined;
}

/**
 * A typed label answers a question only when the conversation has one open question and the
 * text is one of its options. Two open questions stay with the model, which can ask which.
 */
export const singleQuestionChoice = (
  text: string,
  questions: ReadonlyArray<OpenQuestionChoice>,
):
  | {
      readonly taskId: ChannelTaskId;
      readonly questionId: ChannelQuestionId;
      readonly answer: string;
    }
  | undefined => {
  if (questions.length !== 1) return undefined;
  const question = questions[0];
  if (question === undefined || question.options === undefined || question.options.length === 0) {
    return undefined;
  }
  const answer = matchingOption(text, question.options);
  if (answer === undefined) return undefined;
  return { taskId: question.taskId, questionId: question.questionId, answer };
};
