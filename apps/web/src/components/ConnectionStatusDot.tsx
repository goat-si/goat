import type { EnvironmentConnectionPhase } from "@goat/client-runtime/connection";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/**
 * Canonical connection-phase → dot color mapping shared by every status dot.
 * An unreachable host is expected to be away (asleep, off the network), so it
 * reads as idle instead of in progress.
 */
export function connectionPhaseDotClassName(
  phase: EnvironmentConnectionPhase,
  unreachable = false,
): string {
  if (unreachable) return "bg-muted-foreground/40";
  switch (phase) {
    case "connected":
      return "bg-success";
    case "connecting":
    case "reconnecting":
      return "bg-warning";
    case "error":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

/**
 * Ping halo for transitional phases; null renders no ping. An unreachable host
 * can stay away for hours, so it gets no animation.
 */
export function connectionPhasePingClassName(
  phase: EnvironmentConnectionPhase,
  unreachable = false,
): string | null {
  if (unreachable) return null;
  return phase === "connecting" || phase === "reconnecting" ? "bg-warning/60 duration-2000" : null;
}

type ConnectionStatusDotProps = {
  tooltipText?: string | null;
  dotClassName: string;
  pingClassName?: string | null;
};

export function ConnectionStatusDot({
  tooltipText,
  dotClassName,
  pingClassName,
}: ConnectionStatusDotProps) {
  const dotContent = (
    <>
      {pingClassName ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full motion-safe:animate-status-ping rounded-full",
            pingClassName,
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", dotClassName)} />
    </>
  );

  if (!tooltipText) {
    return (
      <span className="relative flex size-3 shrink-0 items-center justify-center">
        {dotContent}
      </span>
    );
  }

  const dot = (
    <button
      type="button"
      aria-label={tooltipText}
      className="relative flex size-3 shrink-0 cursor-help items-center justify-center rounded-full outline-hidden"
    >
      {dotContent}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={dot} />
      <TooltipPopup side="top" className="whitespace-pre-wrap">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}
