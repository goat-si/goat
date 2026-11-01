import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { ChevronRightIcon } from "~/components/solar";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import {
  launchGroupSummaryText,
  summarizeLaunchGroup,
  type LaunchChildState,
  type LaunchFoldThread,
} from "@goat/client-runtime/state/launch-fold";

const MAX_DOTS = 8;
const DOT_CLASS: Record<LaunchChildState, string> = {
  working: "bg-info",
  attention: "bg-amber-500 dark:bg-amber-300/90",
  finished: "bg-emerald-500 dark:bg-emerald-300/90",
};
const LINE_CLASS =
  "flex h-5.5 w-full min-w-0 items-center gap-1 rounded-md text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * Threads a row launched, folded to one thin line under it. Expanded, they are ordinary rows one
 * indent deeper, so a launched thread reads the same here as at the top level.
 */
export function SidebarLaunchGroup<T extends LaunchFoldThread>(props: {
  readonly parentKey: string;
  readonly threads: readonly T[];
  readonly stateByKey: ReadonlyMap<string, LaunchChildState>;
  readonly shownChildren: readonly T[];
  readonly expanded: boolean;
  readonly onToggle: (parentKey: string) => void;
  readonly onShowAll: (parentKey: string) => void;
  readonly renderRow: (thread: T) => ReactNode;
}) {
  const summary = summarizeLaunchGroup(
    props.threads.map(
      (thread) =>
        props.stateByKey.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))) ??
        "finished",
    ),
  );
  const text = launchGroupSummaryText(summary);
  const hidden = props.expanded ? props.threads.length - props.shownChildren.length : 0;
  return (
    <div data-launch-group={props.parentKey} onPointerDown={(event) => event.stopPropagation()}>
      <button
        type="button"
        aria-expanded={props.expanded}
        aria-label={`Launched threads: ${text}`}
        onClick={() => props.onToggle(props.parentKey)}
        className={cn(LINE_CLASS, "pr-2 pl-3")}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", props.expanded && "rotate-90")}
        />
        <span className="shrink-0 tabular-nums">{text}</span>
        <span
          aria-hidden
          className="ml-auto flex min-w-0 items-center justify-end gap-0.5 overflow-hidden pl-1"
        >
          {summary.states.slice(0, MAX_DOTS).map((state, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- Dots have no identity beyond their position.
            <span key={index} className={cn("size-1.5 rounded-full", DOT_CLASS[state])} />
          ))}
        </span>
      </button>
      {props.expanded ? (
        <ul role="group" aria-label="Launched threads" className="flex flex-col gap-px pl-3">
          {props.shownChildren.map((child) => props.renderRow(child))}
          {hidden > 0 ? (
            <li>
              <button
                type="button"
                onClick={() => props.onShowAll(props.parentKey)}
                className={cn(LINE_CLASS, "px-3")}
              >
                +{hidden} more
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
