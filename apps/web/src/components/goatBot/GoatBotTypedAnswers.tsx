import { goatBotNewestTaskChips, type GoatBotRow } from "@goat/client-runtime/goatBot";
import type { OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import { createContext, use, useState, type ReactNode } from "react";

import { HoldsNavigation } from "~/lib/navigationHolds";

type QuestionRow = Extract<GoatBotRow, { kind: "bot" }>;

interface TypedAnswer {
  readonly text: string;
  /** Where the words go once the row no longer says: kept from the row while it did. */
  readonly taskId?: string | undefined;
  readonly questionId?: string | undefined;
  /** Held back on Enter: the main chat hides a task message that names no question. */
  readonly held?: true;
}

interface TypedAnswers {
  readonly answers: ReadonlyMap<string, TypedAnswer>;
  readonly recorded: ReadonlySet<string>;
  readonly mainChat: boolean;
  readonly update: (rowId: string, next: TypedAnswer | null) => void;
}

const TypedAnswersContext = createContext<TypedAnswers | null>(null);
const NO_ANSWERS: ReadonlyMap<string, TypedAnswer> = new Map();
const NO_RECORDS: ReadonlySet<string> = new Set();

const recordKey = (taskId: string, questionId: string) => taskId + "\u0000" + questionId;
const hasWords = (answer: TypedAnswer | undefined) =>
  answer !== undefined && answer.text.trim() !== "";
const isRecorded = (answer: TypedAnswer | undefined, recorded: ReadonlySet<string>) =>
  answer?.taskId !== undefined &&
  answer.questionId !== undefined &&
  recorded.has(recordKey(answer.taskId, answer.questionId));

/** Every question a task's newest chip records an answer to. */
function recordedQuestions(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
  const recorded = new Set<string>();
  for (const chip of goatBotNewestTaskChips(items).values())
    for (const answered of chip.answeredQuestions ?? [])
      recorded.add(recordKey(chip.taskId, answered.questionId));
  return recorded;
}

/**
 * Keeps what a person types into question cards' Something else while the view showing them is
 * mounted, so the words outlive a card that closes, unmounts or remounts. Another destination drops
 * them, as it drops the message box's draft; null, such as while reconnecting, keeps them.
 */
export function GoatBotTypedAnswersScope({
  destination,
  visibleTurnItems,
  mainChat = false,
  children,
}: {
  readonly destination: string | null;
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  /** The main chat, where a task message without a question id would not show. */
  readonly mainChat?: boolean;
  readonly children: ReactNode;
}) {
  const [state, setState] = useState({ destination, answers: NO_ANSWERS });
  const tracking = state.answers.size > 0;
  const recorded = tracking ? recordedQuestions(visibleTurnItems) : NO_RECORDS;
  // An answer its task recorded while the field held no words has ended; nothing is left to show.
  const endedEmpty = (answer: TypedAnswer) => !hasWords(answer) && isRecorded(answer, recorded);
  if (destination !== null && destination !== state.destination) {
    setState({ destination, answers: state.destination === null ? state.answers : NO_ANSWERS });
  } else if (tracking && [...state.answers.values()].some(endedEmpty)) {
    setState((previous) => {
      const answers = new Map(previous.answers);
      for (const [rowId, answer] of previous.answers) if (endedEmpty(answer)) answers.delete(rowId);
      return { destination: previous.destination, answers };
    });
  }
  const holding = [...state.answers.values()].some(hasWords);
  const update = (rowId: string, next: TypedAnswer | null) =>
    setState((previous) => {
      const answers = new Map(previous.answers);
      if (next === null) answers.delete(rowId);
      else answers.set(rowId, next);
      return { destination: previous.destination, answers };
    });
  return (
    <TypedAnswersContext value={{ answers: state.answers, recorded, mainChat, update }}>
      {holding ? <HoldsNavigation /> : null}
      {children}
    </TypedAnswersContext>
  );
}

/** A question card's kept answer; null outside a scope, where the card cannot be typed in. */
export function useGoatBotTypedAnswer(row: QuestionRow) {
  const scope = use(TypedAnswersContext);
  if (scope === null) return null;
  const answer = scope.answers.get(row.id);
  // The row's own target while it carries one, so ids that arrive late still route the words.
  const target =
    row.answerTaskId === undefined
      ? { taskId: answer?.taskId, questionId: answer?.questionId }
      : { taskId: row.answerTaskId, questionId: row.answerQuestionId };
  const ended = isRecorded(answer, scope.recorded);
  return {
    text: answer?.text ?? "",
    kept: answer !== undefined,
    /** The task recorded an answer to this question, so the words can no longer answer it. */
    ended,
    /** The words stay visible, unsent, until the person discards them. */
    unsent: hasWords(answer) && (ended || (answer?.held === true && row.options.length === 0)),
    target,
    /** A closed card's Enter would send a task message the main chat hides, so the words are held. */
    gated:
      scope.mainChat &&
      row.options.length === 0 &&
      target.taskId !== undefined &&
      target.questionId === undefined,
    set: (text: string) => scope.update(row.id, { text, ...target }),
    hold: () => {
      if (answer !== undefined) scope.update(row.id, { ...answer, held: true });
    },
    remove: () => scope.update(row.id, null),
    dropIfEmpty: () => {
      if (answer !== undefined && !hasWords(answer)) scope.update(row.id, null);
    },
  };
}
