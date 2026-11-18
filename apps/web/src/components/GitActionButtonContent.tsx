import { useEffect, useState } from "react";

import { CheckIcon } from "~/components/solar";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "./chat/threadDetailsPanelStyles";
import {
  formatGitActionElapsed,
  type GitActionProgressPresentation,
} from "./GitActionsControl.logic";

export interface InlineGitActionSuccess {
  readonly title: string;
  readonly description: string | null;
  readonly scopeKey: string;
}

export function GitActionElapsedTime({
  startedAtMs,
  className,
}: {
  startedAtMs: number | null;
  className?: string;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (startedAtMs === null) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => window.clearInterval(intervalId);
  }, [startedAtMs]);
  const elapsed = formatGitActionElapsed(startedAtMs, nowMs);
  if (!elapsed) {
    return null;
  }

  return <p className={className}>{elapsed}</p>;
}

export function GitActionProgressButtonContent({
  progress,
  isPanel,
}: {
  progress: GitActionProgressPresentation;
  isPanel: boolean;
}) {
  const hasOutput = progress.output !== null;

  return (
    <div
      aria-atomic="false"
      aria-live="polite"
      className={cn(
        "grid min-w-0 flex-1 items-center",
        isPanel
          ? "grid-cols-[auto_minmax(0,1fr)] grid-rows-[1.5rem] gap-x-3"
          : "grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[1.25rem] gap-x-2.5 sm:grid-rows-[1rem]",
      )}
      role="status"
    >
      <Spinner aria-hidden="true" className="row-start-1 -mx-0.5 shrink-0" />
      <p
        className={cn(
          "row-start-1 min-w-0 truncate text-left",
          isPanel && THREAD_DETAILS_PANEL_LABEL_CLASS,
        )}
      >
        {progress.status}
      </p>
      {!isPanel ? (
        <GitActionElapsedTime
          startedAtMs={progress.startedAtMs}
          className="row-start-1 text-2xs font-normal tabular-nums text-muted-foreground"
        />
      ) : null}
      <div
        className={cn(
          "col-start-2 grid min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          !isPanel && "col-span-2",
          hasOutput ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <Tooltip>
            <TooltipTrigger
              render={
                <p className="truncate pt-0.5 text-left text-2xs font-normal text-muted-foreground" />
              }
            >
              {progress.output}
            </TooltipTrigger>
            <TooltipPopup side="bottom" className="max-w-96 break-words">
              {progress.output}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

export function GitActionSuccessButtonContent({ success }: { success: InlineGitActionSuccess }) {
  const hasDescription = success.description !== null;

  return (
    <div
      aria-live="polite"
      className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] grid-rows-[1.5rem] items-center gap-x-3"
      role="status"
    >
      <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" />
      <p className={cn("min-w-0 truncate text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
        {success.title}
      </p>
      <div
        className={cn(
          "col-start-2 grid min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          hasDescription ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <Tooltip>
            <TooltipTrigger
              render={
                <p className="truncate pt-0.5 text-left text-2xs font-normal text-muted-foreground" />
              }
            >
              {success.description}
            </TooltipTrigger>
            <TooltipPopup side="bottom" className="max-w-96 break-words">
              {success.description}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
