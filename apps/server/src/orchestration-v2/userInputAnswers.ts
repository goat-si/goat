/**
 * Answers to a user-input question arrive as option values, option labels, or free text: the
 * composers send values, agents relaying a person's pick through MCP often send the label, and
 * typed replies differ in case, spacing, or Unicode form (Hangul from macOS can arrive
 * decomposed). Each answer that names one offered option is mapped to that option's value, so the
 * provider receives what it offered and every path resolves the same way.
 *
 * @module userInputAnswers
 */
import type { OrchestrationV2UserInputQuestion } from "@goat/contracts";

type UserInputOption = OrchestrationV2UserInputQuestion["options"][number];
export type UserInputAnswer = string | ReadonlyArray<string>;

const optionValue = (option: UserInputOption) => option.value ?? option.label;
const loose = (text: string) => text.normalize("NFC").trim().toLocaleLowerCase();

/**
 * The option `text` names. An exact value wins, because provider option ids are kept byte for
 * byte; then an exact label; then a label or value equal after trimming, case, and Unicode
 * normalization, when exactly one option matches.
 */
export function matchUserInputOption(
  question: Pick<OrchestrationV2UserInputQuestion, "options">,
  text: string,
): UserInputOption | undefined {
  const byValue = question.options.find((option) => optionValue(option) === text);
  if (byValue !== undefined) return byValue;
  const byLabel = question.options.filter((option) => option.label === text);
  if (byLabel.length === 1) return byLabel[0];
  const wanted = loose(text);
  if (wanted === "") return undefined;
  const near = question.options.filter(
    (option) => loose(option.label) === wanted || loose(optionValue(option)) === wanted,
  );
  return near.length === 1 ? near[0] : undefined;
}

/** Each answer naming an option becomes that option's value; free text stays as written. */
export function canonicalUserInputAnswers(
  questions: ReadonlyArray<Pick<OrchestrationV2UserInputQuestion, "id" | "options">>,
  answers: Readonly<Record<string, UserInputAnswer>>,
): Record<string, UserInputAnswer> {
  const byId = new Map(questions.map((question) => [question.id, question]));
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, answer]) => {
      const question = byId.get(questionId);
      if (question === undefined || question.options.length === 0) return [questionId, answer];
      const canonical = (text: string) => {
        const option = matchUserInputOption(question, text);
        return option === undefined ? text : optionValue(option);
      };
      return [
        questionId,
        typeof answer === "string" ? canonical(answer) : [...new Set(answer.map(canonical))],
      ];
    }),
  );
}

/** An answer as an agent reads it back: option labels, comma-joined for several picks. */
export function userInputAnswerText(
  question: Pick<OrchestrationV2UserInputQuestion, "options">,
  answer: UserInputAnswer | undefined,
): string {
  if (answer === undefined) return "";
  return (typeof answer === "string" ? [answer] : answer)
    .map((value) => (matchUserInputOption(question, value)?.label ?? value).trim())
    .filter((text) => text.length > 0)
    .join(", ");
}
