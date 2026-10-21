import type { FleetThread } from "@goat/client-runtime/state/fleet";
import { Link } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { FleetSubagents } from "./FleetSubagents";

export const STATE_LABEL: Record<FleetThread["state"], string> = {
  running: "Running",
  attention: "Needs you",
  reported: "Reported",
};

export const STATE_DOT: Record<FleetThread["state"], string> = {
  running: "bg-info",
  attention: "bg-warning",
  reported: "border border-muted-foreground bg-transparent",
};

/** One machine's threads, in the order buildFleet gives: oldest first, so rows hold still. */
export function FleetThreadList({ threads }: { readonly threads: ReadonlyArray<FleetThread> }) {
  return (
    <ul className="flex flex-col">
      {threads.map((thread) => (
        <li key={thread.key}>
          <FleetThreadRow thread={thread} />
        </li>
      ))}
    </ul>
  );
}

function FleetThreadRow({ thread }: { readonly thread: FleetThread }) {
  const titleClass = "min-w-0 truncate";
  return (
    // The link stretches over the row so the subagent chip can be its own button beside the title.
    <div
      className={cn(
        "relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        thread.ref !== null && "hover:bg-accent",
      )}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATE_DOT[thread.state])} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {thread.ref === null ? (
          <span className={titleClass}>{thread.title}</span>
        ) : (
          <Link
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams(thread.ref)}
            className={cn(
              titleClass,
              "outline-hidden after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset",
            )}
          >
            {thread.title}
          </Link>
        )}
        <FleetSubagents subagents={thread.subagents} />
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        {thread.agentDriver ? (
          <ProviderInstanceIcon
            driverKind={thread.agentDriver}
            displayName={thread.agentLabel}
            iconClassName="size-3.5"
          />
        ) : null}
        {thread.ref === null && thread.reportedBy !== null
          ? "Last reported by " + thread.reportedBy
          : thread.agentLabel}
      </span>
      <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
        {STATE_LABEL[thread.state]}
      </span>
    </div>
  );
}
