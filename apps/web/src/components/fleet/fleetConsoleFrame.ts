import { cn } from "~/lib/utils";

/**
 * The console and its placeholder share one frame, so swapping one for the other never moves
 * the page. The frame is a size container: the body lays out by the console's own width.
 */
export function fleetConsoleFrameClassName() {
  return "@container/fleet-console fleet-console relative shrink-0 overflow-hidden rounded-xl border bg-card";
}

/** Expanded body height for each layout (stacked, two rows, three columns); hosts beyond it scroll. */
export function fleetConsoleBodyClassName(className?: string) {
  return cn(
    "h-[24.5rem] @min-[32rem]/fleet-console:h-[17.5rem] @min-[56rem]/fleet-console:h-[13rem]",
    className,
  );
}
