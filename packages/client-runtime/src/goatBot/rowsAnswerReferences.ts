import type { GoatBotAnsweredQuestion, GoatBotRow } from "./rows.ts";

type BotRow = Extract<GoatBotRow, { kind: "bot" }>;
type UserRow = Extract<GoatBotRow, { kind: "user" }>;

/** The person's inputs a task's record names as the answer to one of its questions. */
export function decidedAnswerInputs(
  states: Iterable<{ readonly answeredQuestions?: ReadonlyArray<GoatBotAnsweredQuestion> }>,
): Map<string, string> {
  const decided = new Map<string, string>();
  for (const state of states) {
    for (const answered of state.answeredQuestions ?? []) {
      if (answered.inputId !== undefined) decided.set(answered.inputId, answered.questionId);
    }
  }
  return decided;
}

/**
 * Which question a person's message answers, the task's record first: a message it names answers
 * that question, and a claim on a question it records another message as answering is refused.
 * Otherwise the message's own field, which the server settles from reception's decision; this also
 * covers messages recorded before it did, and a decision whose write was lost.
 */
export function answerReferenceOf(
  decided: ReadonlyMap<string, string>,
): (
  claim: string | null | undefined,
  requestKey: string | null | undefined,
) => string | null | undefined {
  const answeredBy = new Map<string, string>();
  for (const [inputId, questionId] of decided) answeredBy.set(questionId, inputId);
  return (claim, requestKey) => {
    const recorded = requestKey ? decided.get(requestKey) : undefined;
    if (recorded !== undefined) return recorded;
    if (claim == null) return claim;
    const answerer = answeredBy.get(claim);
    return answerer !== undefined && answerer !== requestKey ? null : claim;
  };
}

/**
 * A task question's answer, from what the server recorded or the person's own send still on its
 * way: a pick when it says one of the choices, typed words otherwise. Without either the question
 * keeps its choices as its card says, and a message sent to it reads as a plain message.
 */
export function foldTaskQuestionAnswer<B extends Omit<BotRow, "firstInGroup" | "groupPosition">>(
  row: B,
  answer: Pick<UserRow, "id" | "text" | "attachments" | "createdAt" | "delivery"> | undefined,
): { readonly row: B; readonly folded?: string } {
  if (answer === undefined) return { row };
  const files = answer.attachments ?? [];
  const text = answer.text.trim() || files.map((file) => file.name).join(", ");
  const answerIndex = files.length === 0 ? (row.choices ?? []).indexOf(text) : -1;
  const sending = answer.delivery.state === "queued" || answer.delivery.state === "sending";
  return {
    row: {
      ...row,
      options: [],
      answer: text,
      ...(answerIndex >= 0
        ? { answerIndex, answeredAt: answer.createdAt, answerInputRowId: answer.id }
        : {}),
      ...(sending ? { answerSending: true } : {}),
    },
    ...(answerIndex >= 0 ? { folded: answer.id } : {}),
  };
}
