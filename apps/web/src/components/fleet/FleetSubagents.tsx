import type { FleetSubagent } from "@goat/client-runtime/state/fleet";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FLEET_COUNT_CHIP_CLASS } from "./FleetUncountedHosts";

const LISTED = 8;

const STATUS_LABEL: Record<FleetSubagent["status"], string> = {
  pending: "Starting",
  running: "Running",
  waiting: "Waiting",
};

/**
 * "+N" on a thread's row: provider-native subagents working in its session. They share the
 * thread's sandbox and count against its lane limit, so they stay on its row instead of adding rows.
 */
export function FleetSubagents(props: { readonly subagents: ReadonlyArray<FleetSubagent> }) {
  const { subagents } = props;
  if (subagents.length === 0) return null;
  const summary = subagents.length === 1 ? "1 subagent" : subagents.length + " subagents";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={
              summary +
              ": " +
              subagents
                .map((subagent) => subagent.title + ", " + STATUS_LABEL[subagent.status])
                .join("; ")
            }
            className={cn(FLEET_COUNT_CHIP_CLASS, "relative shrink-0")}
          />
        }
      >
        +{subagents.length}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex max-w-72 flex-col gap-0.5 text-xs">
          <span className="font-medium">{summary} working in this thread</span>
          {subagents.slice(0, LISTED).map((subagent) => (
            <span key={subagent.key} className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  subagent.status === "running" ? "bg-info" : "bg-muted-foreground",
                )}
              />
              <span className="truncate">{subagent.title}</span>
              <span className="shrink-0 text-muted-foreground">
                · {STATUS_LABEL[subagent.status]}
              </span>
            </span>
          ))}
          {subagents.length > LISTED ? (
            <span className="text-muted-foreground">and {subagents.length - LISTED} more</span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
