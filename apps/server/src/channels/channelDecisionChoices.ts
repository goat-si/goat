/**
 * Choices a person can answer without a model: an open question's options, which Slack and
 * iMessage list as `1. label`. A reply that is only a number picks from the latest question
 * still open, by `askedAt`. Approvals take no number (see channelApprovalReplies).
 *
 * @module channelDecisionChoices
 */
import type { ChannelQuestionId, ChannelTaskId } from "@goat/contracts";

export interface DeliveredChoiceTarget {
  readonly type: "question";
  readonly taskId: ChannelTaskId;
  readonly questionId: ChannelQuestionId;
}

/** One numbered list still open in a conversation. */
export interface DeliveredChoices {
  /** When the question was asked, ISO-8601. */
  readonly at: string;
  readonly options: ReadonlyArray<string>;
  readonly target: DeliveredChoiceTarget;
}

/** The list issued last. Empty option lists are not choices. */
export const latestDeliveredChoices = (
  choices: ReadonlyArray<DeliveredChoices>,
): DeliveredChoices | undefined =>
  choices
    .filter((entry) => entry.options.length > 0)
    .toSorted((left, right) => left.at.localeCompare(right.at))
    .at(-1);

/** A reply that is only digits, "0" and "2." included. */
export const isNumericReply = (text: string): boolean => /^\d+\.?$/.test(text.trim());

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
 * The option whose label equals `text`, ignoring case, surrounding space, and Unicode form
 * (Hangul typed on a Mac can arrive decomposed). The returned label is the one that was offered,
 * so a project question matches the real name.
 */
const matchingOption = (text: string, options: ReadonlyArray<string>): string | undefined => {
  const loose = (value: string) => value.normalize("NFC").trim().toLowerCase();
  const wanted = loose(text);
  if (wanted === "") return undefined;
  return options.find((option) => loose(option) === wanted);
};

/** How Slack, iMessage, and other non-button transports list choices under the card text. */
export const numberedChoiceLines = (options: ReadonlyArray<string>): string =>
  options.map((option, index) => `${index + 1}. ${option}`).join("\n");

/** Choices answered only by their words: `Reply "Deny A1" or "Approve A1".` */
export const wordChoiceLine = (options: ReadonlyArray<string>): string => {
  const quoted = options.map((option) => '"' + option + '"');
  const last = quoted.at(-1) ?? "";
  const words = quoted.length > 1 ? quoted.slice(0, -1).join(", ") + " or " + last : last;
  return "Reply " + words + ".";
};

export interface OpenQuestionChoice {
  readonly taskId: ChannelTaskId;
  readonly questionId: ChannelQuestionId;
  readonly options: ReadonlyArray<string> | undefined;
}

/**
 * A typed or tapped label answers the one open question that offers it. A label offered by two
 * open questions stays with the model, which can ask which.
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
  const matches = questions.flatMap((question) => {
    const answer =
      question.options === undefined ? undefined : matchingOption(text, question.options);
    return answer === undefined
      ? []
      : [{ taskId: question.taskId, questionId: question.questionId, answer }];
  });
  return matches.length === 1 ? matches[0] : undefined;
};
