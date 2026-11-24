import { goatBotNewestTaskChips, type GoatBotRow } from "@goat/client-runtime/goatBot";
import type { OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import { createContext, use, useEffect, useState, type ReactNode } from "react";

import { HoldsNavigation, NavigationHoldsPaused } from "~/lib/navigationHolds";
import { useGoatBotRouteDraft, type GoatBotTypedAnswer } from "./GoatBotRouteDrafts";

type QuestionRow = Extract<GoatBotRow, { kind: "bot" }>;

interface TypedAnswers {
  readonly answers: ReadonlyMap<string, GoatBotTypedAnswer>;
  readonly recorded: ReadonlySet<string>;
  readonly mainChat: boolean;
  readonly update: (rowId: string, next: GoatBotTypedAnswer | null) => void;
}

const TypedAnswersContext = createContext<TypedAnswers | null>(null);
const NO_ANSWERS: ReadonlyMap<string, GoatBotTypedAnswer> = new Map();
const NO_RECORDS: ReadonlySet<string> = new Set();

const recordKey = (taskId: string, questionId: string) => taskId + "\u0000" + questionId;
const hasWords = (answer: GoatBotTypedAnswer | undefined) =>
  answer !== undefined && answer.text.trim() !== "";
const isRecorded = (answer: GoatBotTypedAnswer | undefined, recorded: ReadonlySet<string>) =>
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
  routeDestination = null,
  visibleTurnItems,
  mainChat = false,
  children,
}: {
  readonly destination: string | null;
  readonly routeDestination?: string | null;
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  /** The main chat, where a task message without a question id would not show. */
  readonly mainChat?: boolean;
  readonly children: ReactNode;
}) {
  const [state, setState] = useState({ destination, answers: NO_ANSWERS });
  const routeAnswers = useGoatBotRouteDraft(routeDestination, "answers");
  const answers = routeAnswers?.value ?? state.answers;
  const tracking = answers.size > 0;
  const recorded = tracking ? recordedQuestions(visibleTurnItems) : NO_RECORDS;
  // An answer its task recorded while the field held no words has ended; nothing is left to show.
  const endedEmpty = (answer: GoatBotTypedAnswer) =>
    !hasWords(answer) && isRecorded(answer, recorded);
  const prune = (previous: typeof answers) =>
    [...previous.values()].some(endedEmpty)
      ? new Map([...previous].filter(([, answer]) => !endedEmpty(answer)))
      : previous;
  if (routeAnswers === null) {
    if (destination !== null && destination !== state.destination) {
      setState({ destination, answers: state.destination === null ? state.answers : NO_ANSWERS });
    } else if (tracking) {
      const next = prune(state.answers);
      if (next !== state.answers) setState({ ...state, answers: next });
    }
  }
  // Both panes can be mounted; do not publish to the other pane while rendering this one.
  // oxlint-disable-next-line goat/react-effect-budget -- Retire empty recorded answers in the shared route store.
  useEffect(() => {
    routeAnswers?.update(prune);
  }, [prune, routeAnswers]);
  const paused = use(NavigationHoldsPaused);
  const holding = (!paused || routeAnswers === null) && [...answers.values()].some(hasWords);
  const update = (rowId: string, next: GoatBotTypedAnswer | null) => {
    const replace = (previous: typeof answers) => {
      const result = new Map(previous);
      if (next === null) result.delete(rowId);
      else result.set(rowId, next);
      return result;
    };
    if (routeAnswers !== null) routeAnswers.update(replace);
    else setState((previous) => ({ ...previous, answers: replace(previous.answers) }));
  };
  return (
    <TypedAnswersContext value={{ answers, recorded, mainChat, update }}>
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
  // Judged on the current target: a held answer's question id can arrive after its last keystroke.
  const ended =
    answer !== undefined &&
    target.taskId !== undefined &&
    target.questionId !== undefined &&
    scope.recorded.has(recordKey(target.taskId, target.questionId));
  // A closed card's Enter would send a task message the main chat hides, so the words are held.
  const gated =
    scope.mainChat &&
    row.options.length === 0 &&
    target.taskId !== undefined &&
    target.questionId === undefined;
  return {
    text: answer?.text ?? "",
    kept: answer !== undefined,
    /** The task recorded an answer to this question, so the words can no longer answer it. */
    ended,
    /** The words stay visible, unsent, until the person discards them. */
    unsent: hasWords(answer) && (ended || (answer?.held === true && gated)),
    target,
    gated,
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
