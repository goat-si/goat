import { cn } from "~/lib/utils";

/**
 * The console and its placeholder share one frame, so swapping one for the other never moves
 * the page. Expanded height is fixed; hosts beyond it scroll inside.
 */
export function fleetConsoleFrameClassName(collapsed: boolean) {
  return cn(
    "fleet-console relative shrink-0 overflow-hidden rounded-xl border bg-card",
    collapsed ? "h-10" : "h-[27rem] md:h-[15.5rem]",
  );
}
