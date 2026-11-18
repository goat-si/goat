import type { MouseEventHandler, ReactNode } from "react";
import { ArrowUpIcon, PlayIcon, SquareIcon } from "~/components/solar";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerRoundActionClassName } from "./ComposerPrimaryActions";
import { useComposerStopState } from "./useComposerStopState";

type StopProps = {
  canOperateThread: boolean;
  canInterrupt: boolean;
  runId: string | null;
  hasSendableContent: boolean;
  isEditingQueuedMessage: boolean;
  onInterrupt: () => void;
};

export function CollapsedComposerStopAction(props: StopProps & { children: ReactNode }) {
  const stop = useComposerStopState(props.runId, props.canInterrupt, props.canOperateThread);
  if (
    !(props.canInterrupt || stop.phase === "pending" || stop.phase === "timedOut") ||
    props.hasSendableContent ||
    props.isEditingQueuedMessage
  )
    return props.children;
  const label = stop.phase === "pending" ? "Stopping" : "Stop generation";
  return (
    <span
      data-chat-composer-transition-actions="true"
      data-chat-composer-collapsed-controls="true"
      className="flex shrink-0"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={cn(
                composerRoundActionClassName,
                "cursor-pointer bg-composer-stop text-white shadow-xs hover:bg-destructive disabled:opacity-64",
              )}
              onPointerDown={(event) => event.preventDefault()}
              disabled={!props.canOperateThread || stop.disabled}
              onClick={() => {
                if (!props.canOperateThread || stop.disabled) return;
                stop.start();
                props.onInterrupt();
              }}
              aria-label={label}
            />
          }
        >
          <SquareIcon className="size-3.5 fill-current" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup>{stop.phase === "pending" ? "Stopping…" : "Interrupt"}</TooltipPopup>
      </Tooltip>
    </span>
  );
}

export function CollapsedComposerPrimaryAction(
  props: StopProps & {
    disabled: boolean;
    label: string;
    showResume: boolean;
    onAction: MouseEventHandler<HTMLButtonElement>;
  },
) {
  return (
    <CollapsedComposerStopAction {...props}>
      <button
        type="button"
        data-chat-composer-transition-actions="true"
        className={cn(
          composerRoundActionClassName,
          "bg-composer-send text-message-action-foreground hover:bg-message-action disabled:opacity-64",
        )}
        disabled={props.disabled}
        aria-label={props.label}
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onAction}
      >
        {props.showResume ? (
          <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
        ) : (
          <ArrowUpIcon className="size-4" aria-hidden="true" />
        )}
      </button>
    </CollapsedComposerStopAction>
  );
}
