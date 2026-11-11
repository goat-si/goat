import type {
  GoatBotActivityLine,
  GoatBotActivityMark,
  GoatBotActivityPlacement,
} from "@goat/client-runtime/goatBot";
import { createContext, useId, useState } from "react";

/** Where GOAT Bot's activity lines sit in the open chat; null where no chat reads them. */
export const GoatBotStepsContext = createContext<GoatBotActivityPlacement | null>(null);

/** A stretch of the bot's steps, or a note that they ran on another machine. */
export function GoatBotStepsMark({
  mark,
  onToggle,
}: {
  readonly mark: GoatBotActivityMark;
  /** Runs the open or close so the conversation keeps its place. */
  readonly onToggle: (toggle: () => void) => void;
}) {
  if (mark.kind === "steps") return <GoatBotStepsLine line={mark.line} onToggle={onToggle} />;
  return (
    <p className="ps-1 text-xs leading-5 text-muted-foreground">
      {mark.host === null ? "Steps ran on another server" : "Steps ran on " + mark.host}
    </p>
  );
}

function GoatBotStepsLine({
  line,
  onToggle,
}: {
  readonly line: GoatBotActivityLine;
  readonly onToggle: (toggle: () => void) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  // Collapsed earlier work is not loaded, so a line of it alone has nothing to open.
  if (line.steps.length === 0)
    return <p className="ps-1 text-xs leading-5 text-muted-foreground">{line.summary}</p>;
  return (
    <div className="flex max-w-[44rem] min-w-0 flex-col items-start ps-1 text-xs leading-5 text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => onToggle(() => setOpen((value) => !value))}
        className="min-w-0 rounded-sm text-start outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {line.live ? line.summary + " so far" : line.summary}
        {line.failedCount > 0 ? " · " + line.failedCount + " failed" : null}
      </button>
      {open ? (
        <ol id={listId} className="mt-1 flex min-w-0 flex-col gap-0.5 border-s border-border ps-3">
          {line.earlier ? <li>Earlier work, not listed</li> : null}
          {line.steps.map((step) => (
            <li key={step.id} className="min-w-0 break-words">
              {step.label}
              {step.state === "running"
                ? " · running"
                : step.state === "failed"
                  ? " · failed"
                  : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
