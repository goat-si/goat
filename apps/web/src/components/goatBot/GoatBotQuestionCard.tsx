import { goatBotChoiceLetter, type GoatBotRow } from "@goat/client-runtime/goatBot";
import { type ReactNode, useId } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useGoatBotTypedAnswer } from "./GoatBotTypedAnswers";

type QuestionRow = Extract<GoatBotRow, { kind: "bot" }>;

/** When the field goes while focused, focus moves to what replaced it, or else to its row. */
function keepFocus(node: HTMLInputElement | null) {
  if (node === null) return;
  return () => {
    if (document.activeElement !== node) return;
    const card = node.closest<HTMLElement>(".goat-bot-card");
    queueMicrotask(() => {
      if (card === null || !card.isConnected) return;
      if (document.activeElement !== null && document.activeElement !== document.body) return;
      const next =
        card.querySelector<HTMLElement>("[data-discard-unsent]") ??
        card.querySelector<HTMLElement>("input") ??
        card.closest<HTMLElement>("[data-bot-row]");
      next?.focus();
    });
  };
}

/**
 * A bot question with choices: one card, lettered rows and a last row to type something else.
 * Once answered it keeps the question, dimmed, and only the picked row. Typed words live in the
 * view's GoatBotTypedAnswersScope, so they stay while the question closes or the card remounts.
 */
export function GoatBotQuestionCard({
  row,
  body,
  onPick,
}: {
  readonly row: QuestionRow;
  /** The question's text as the timeline renders bot prose. */
  readonly body: ReactNode;
  /** Sends an answer and says whether it went in; absent while the bot can't take messages. */
  readonly onPick?:
    | ((answer: string, taskId?: string, questionId?: string) => boolean | void)
    | undefined;
}) {
  const typed = useGoatBotTypedAnswer(row);
  const otherId = useId();
  const unsentId = useId();
  if (import.meta.env.DEV && onPick !== undefined && typed === null)
    throw new Error("A question card that can send needs a GoatBotTypedAnswersScope above it.");
  const choices = row.choices ?? row.options;
  const open = row.options.length > 0;
  const picked = row.answerIndex === undefined ? undefined : choices[row.answerIndex];
  const pickedIndex = !open && picked !== undefined ? row.answerIndex : undefined;
  const text = typed?.text ?? "";
  // Closed, the field stays only for words kept in it; it has nothing new to answer.
  const showField = typed === null ? open : !typed.ended && !typed.unsent && (open || typed.kept);
  const unsent = typed?.unsent === true;
  const content = open || pickedIndex !== undefined || showField || unsent;
  return (
    <div className="goat-bot-card flex w-full max-w-[min(100%,34rem)] min-w-0 flex-col gap-2 py-3">
      <div className={cn("goat-bot-prose min-w-0", !open && "text-muted-foreground")}>{body}</div>
      {content ? (
        // One container in every state, so the field keeps its focus when the choices go.
        <div
          role={open ? "group" : undefined}
          aria-label={open ? "Choices" : undefined}
          className="-mx-1.5 flex flex-col"
        >
          {open
            ? row.options.map((option, index) => (
                <button
                  key={option}
                  type="button"
                  aria-label={`${goatBotChoiceLetter(index)}. ${option}`}
                  disabled={onPick === undefined}
                  onClick={() => onPick?.(option, row.answerTaskId, row.answerQuestionId)}
                  className="flex min-h-9 items-center gap-2.5 rounded-lg px-1.5 py-1 text-start text-sm outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-60"
                >
                  <span aria-hidden className="goat-choice-badge">
                    {goatBotChoiceLetter(index)}
                  </span>
                  <span className="min-w-0 break-words">{option}</span>
                </button>
              ))
            : null}
          {pickedIndex !== undefined ? (
            <div className="flex min-h-9 items-center gap-2.5 px-1.5 py-1 text-sm">
              <span aria-hidden data-chosen className="goat-choice-badge">
                {goatBotChoiceLetter(pickedIndex)}
              </span>
              <span className="sr-only">You answered {goatBotChoiceLetter(pickedIndex)}:</span>
              <span className="min-w-0 break-words">{picked}</span>
              {row.answerSending ? (
                <span className="text-xs text-muted-foreground">Sending…</span>
              ) : null}
            </div>
          ) : null}
          {showField ? (
            <div className="flex min-h-9 items-center gap-2.5 rounded-lg px-1.5 py-1 has-focus-visible:bg-accent has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-ring">
              <label htmlFor={otherId} aria-hidden className="goat-choice-badge">
                {goatBotChoiceLetter(choices.length)}
              </label>
              <input
                ref={keepFocus}
                id={otherId}
                value={text}
                disabled={onPick === undefined || typed === null}
                onChange={(event) => typed?.set(event.currentTarget.value)}
                onBlur={() => typed?.dropIfEmpty()}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.currentTarget.blur();
                    return;
                  }
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  const answer = text.trim();
                  if (answer === "" || typed === null) return;
                  if (typed.gated) {
                    typed.hold();
                    return;
                  }
                  const sent = onPick?.(answer, typed.target.taskId, typed.target.questionId);
                  if (sent !== false) typed.remove();
                }}
                placeholder="Something else"
                aria-label="Something else"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          ) : null}
          {unsent ? (
            <div className="flex min-h-9 items-center gap-2.5 px-1.5 py-1 text-sm">
              <span id={unsentId} className="min-w-0 flex-1 break-words text-muted-foreground">
                Not sent: “{text}”
              </span>
              <Button
                data-discard-unsent
                variant="ghost"
                size="xs"
                aria-label="Discard unsent answer"
                aria-describedby={unsentId}
                onClick={(event) => {
                  const question = event.currentTarget.closest<HTMLElement>("[data-bot-row]");
                  typed?.remove();
                  question?.focus();
                }}
              >
                Discard
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
