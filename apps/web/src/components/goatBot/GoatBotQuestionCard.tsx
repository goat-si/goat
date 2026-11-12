import { goatBotChoiceLetter, type GoatBotRow } from "@goat/client-runtime/goatBot";
import { type ReactNode, useId, useState } from "react";

import { cn } from "~/lib/utils";
import { HoldsNavigation } from "~/lib/navigationHolds";

type QuestionRow = Extract<GoatBotRow, { kind: "bot" }>;

/**
 * A bot question with choices: one card, lettered rows and a last row to type something else.
 * Once answered it keeps the question, dimmed, and only the picked row.
 */
export function GoatBotQuestionCard({
  row,
  body,
  onPick,
}: {
  readonly row: QuestionRow;
  /** The question's text as the timeline renders bot prose. */
  readonly body: ReactNode;
  /** Sends an answer; absent while the bot can't take messages. */
  readonly onPick?: ((answer: string, taskId?: string, questionId?: string) => void) | undefined;
}) {
  const [other, setOther] = useState("");
  const otherId = useId();
  const choices = row.choices ?? row.options;
  const open = row.options.length > 0;
  const picked = row.answerIndex === undefined ? undefined : choices[row.answerIndex];
  const send = (answer: string) => onPick?.(answer, row.answerTaskId, row.answerQuestionId);
  return (
    <div className="goat-bot-card flex w-full max-w-[min(100%,34rem)] min-w-0 flex-col gap-2 py-3">
      <div className={cn("goat-bot-prose min-w-0", !open && "text-muted-foreground")}>{body}</div>
      {open ? (
        <div role="group" aria-label="Choices" className="-mx-1.5 flex flex-col">
          {other.trim() === "" ? null : <HoldsNavigation />}
          {row.options.map((option, index) => (
            <button
              key={option}
              type="button"
              aria-label={`${goatBotChoiceLetter(index)}. ${option}`}
              disabled={onPick === undefined}
              onClick={() => send(option)}
              className="flex min-h-9 items-center gap-2.5 rounded-lg px-1.5 py-1 text-start text-sm outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-60"
            >
              <span aria-hidden className="goat-choice-badge">
                {goatBotChoiceLetter(index)}
              </span>
              <span className="min-w-0 break-words">{option}</span>
            </button>
          ))}
          <div className="flex min-h-9 items-center gap-2.5 rounded-lg px-1.5 py-1 has-focus-visible:bg-accent has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-ring">
            <label htmlFor={otherId} aria-hidden className="goat-choice-badge">
              {goatBotChoiceLetter(row.options.length)}
            </label>
            <input
              id={otherId}
              value={other}
              disabled={onPick === undefined}
              onChange={(event) => setOther(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.currentTarget.blur();
                  return;
                }
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                const answer = other.trim();
                if (answer === "") return;
                send(answer);
                setOther("");
              }}
              placeholder="Something else"
              aria-label="Something else"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
      ) : picked !== undefined && row.answerIndex !== undefined ? (
        <div className="-mx-1.5 flex min-h-9 items-center gap-2.5 px-1.5 py-1 text-sm">
          <span aria-hidden data-chosen className="goat-choice-badge">
            {goatBotChoiceLetter(row.answerIndex)}
          </span>
          <span className="sr-only">You answered {goatBotChoiceLetter(row.answerIndex)}:</span>
          <span className="min-w-0 break-words">{picked}</span>
          {row.answerSending ? (
            <span className="text-xs text-muted-foreground">Sending…</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
