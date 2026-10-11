import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { BotIcon, ChevronRightIcon, SquareIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { create } from "zustand";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentScope } from "../../state/session";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import {
  canStopSidebarDelegatedChild,
  resolveSidebarDelegatedChildWindow,
  sidebarDelegatedChildState,
  SIDEBAR_CHILD_FINISHED_INITIAL_COUNT,
  SIDEBAR_CHILD_FINISHED_PAGE_COUNT,
  SIDEBAR_CHILD_RUNNING_LIMIT,
  type SidebarDelegatedChildren as DelegatedChildren,
} from "../Sidebar.logic";
import { Button } from "../ui/button";

interface SidebarDelegatedChildrenUi {
  readonly running: boolean;
  readonly finished: boolean;
  readonly finishedVisible: number;
}

export const DEFAULT_SIDEBAR_DELEGATED_CHILDREN_UI: SidebarDelegatedChildrenUi = {
  running: false,
  finished: false,
  finishedVisible: SIDEBAR_CHILD_FINISHED_INITIAL_COUNT,
};

// Parent row variants remount as they move between shelves. Keep their temporary
// expansion state for this client session, including those remounts.
export const useSidebarDelegatedChildrenUiStore = create<{
  readonly parents: ReadonlyMap<string, SidebarDelegatedChildrenUi>;
  readonly update: (
    parentKey: string,
    change: (ui: SidebarDelegatedChildrenUi) => SidebarDelegatedChildrenUi,
  ) => void;
}>((set) => ({
  parents: new Map(),
  update: (parentKey, change) =>
    set((state) => ({
      parents: new Map(state.parents).set(
        parentKey,
        change(state.parents.get(parentKey) ?? DEFAULT_SIDEBAR_DELEGATED_CHILDREN_UI),
      ),
    })),
}));

function useSidebarDelegatedChildrenUi(parentKey: string) {
  return useSidebarDelegatedChildrenUiStore(
    (state) => state.parents.get(parentKey) ?? DEFAULT_SIDEBAR_DELEGATED_CHILDREN_UI,
  );
}

interface SidebarDelegatedChildrenProps {
  readonly parentKey: string;
  readonly children: DelegatedChildren<EnvironmentThreadShell>;
  readonly showFinished: boolean;
  readonly openThreadKey: string | null;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
  readonly onStop: (threadRef: ScopedThreadRef) => void;
  readonly onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  readonly stoppingThreadKey: string | null;
}

const SidebarDelegatedChildRow = memo(function SidebarDelegatedChildRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly isOpen: boolean;
  readonly isStopping: boolean;
  readonly onOpen: SidebarDelegatedChildrenProps["onOpen"];
  readonly onStop: SidebarDelegatedChildrenProps["onStop"];
  readonly onContextMenu: SidebarDelegatedChildrenProps["onContextMenu"];
}) {
  const { thread, onOpen, onStop, onContextMenu } = props;
  const canOperate = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const state = sidebarDelegatedChildState(thread);
  useNowMinute();
  const label =
    state === "attention"
      ? "needs input"
      : state === "working"
        ? thread.runtime?.status === "idle"
          ? "background"
          : "running"
        : state === "queued"
          ? "queued"
          : formatRelativeTimeLabel(thread.latestRun?.completedAt ?? thread.updatedAt);
  const open = useCallback(
    () => onOpen(scopeThreadRef(thread.environmentId, thread.id)),
    [onOpen, thread.environmentId, thread.id],
  );
  const stop = useCallback(
    () => onStop(scopeThreadRef(thread.environmentId, thread.id)),
    [onStop, thread.environmentId, thread.id],
  );
  const contextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onContextMenu(scopeThreadRef(thread.environmentId, thread.id), {
        x: event.clientX,
        y: event.clientY,
      });
    },
    [onContextMenu, thread.environmentId, thread.id],
  );
  const keyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      open();
    },
    [open],
  );

  return (
    <li
      className={cn(
        "group/delegated-child flex h-7 items-center rounded-md pl-6 pr-2 text-xs text-sidebar-muted-foreground [content-visibility:auto] [contain-intrinsic-size:auto_28px] hover:bg-sidebar-row-hover",
        props.isOpen && "bg-sidebar-row-active text-sidebar-foreground",
      )}
      onContextMenu={contextMenu}
    >
      <div
        role="button"
        tabIndex={0}
        aria-current={props.isOpen ? "page" : undefined}
        aria-label={`${thread.title}, ${label}`}
        onClick={open}
        onKeyDown={keyDown}
        className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <BotIcon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
          {state !== "finished" ? (
            <span aria-hidden className="size-1 rounded-full bg-sidebar-muted-foreground" />
          ) : null}
          {label}
        </span>
      </div>
      {canOperate && canStopSidebarDelegatedChild(thread) ? (
        <span className="ml-1 shrink-0 opacity-0 focus-within:opacity-100 group-hover/delegated-child:opacity-100">
          <Button
            size="icon-micro"
            variant="ghost"
            aria-label={`Stop task ${thread.title}`}
            disabled={props.isStopping}
            onClick={stop}
          >
            <SquareIcon aria-hidden className="size-3" />
          </Button>
        </span>
      ) : null}
    </li>
  );
});

export const SidebarDelegatedChildren = memo(function SidebarDelegatedChildren(
  props: SidebarDelegatedChildrenProps,
) {
  const ui = useSidebarDelegatedChildrenUi(props.parentKey);
  const update = useSidebarDelegatedChildrenUiStore((state) => state.update);
  const toggleRunning = useCallback(
    () => update(props.parentKey, (current) => ({ ...current, running: !current.running })),
    [props.parentKey, update],
  );
  const toggleFinished = useCallback(
    () => update(props.parentKey, (current) => ({ ...current, finished: !current.finished })),
    [props.parentKey, update],
  );
  const showMoreFinished = useCallback(
    () =>
      update(props.parentKey, (current) => ({
        ...current,
        finishedVisible: current.finishedVisible + SIDEBAR_CHILD_FINISHED_PAGE_COUNT,
      })),
    [props.parentKey, update],
  );
  const stopPointerPropagation = useCallback(
    (event: React.PointerEvent) => event.stopPropagation(),
    [],
  );
  const rows = resolveSidebarDelegatedChildWindow({
    children: props.children,
    runningExpanded: ui.running,
    finishedExpanded: ui.finished,
    finishedVisibleCount: ui.finishedVisible,
    showFinished: props.showFinished,
    openThreadKey: props.openThreadKey,
  });
  if (rows.activeRows.length === 0 && rows.finishedCount === 0 && rows.pinnedOpenRow === null)
    return null;
  const runningCount = props.children.active.filter(
    (thread) => sidebarDelegatedChildState(thread) !== "attention",
  ).length;
  const renderRow = (thread: EnvironmentThreadShell) => {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    return (
      <SidebarDelegatedChildRow
        key={key}
        thread={thread}
        isOpen={key === props.openThreadKey}
        isStopping={key === props.stoppingThreadKey}
        onOpen={props.onOpen}
        onStop={props.onStop}
        onContextMenu={props.onContextMenu}
      />
    );
  };
  const toggleClassName =
    "flex h-7 w-full cursor-pointer items-center gap-1 rounded-md pl-6 text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
  return (
    <ul role="group" aria-label="Delegated tasks" onPointerDown={stopPointerPropagation}>
      {rows.activeRows.map(renderRow)}
      {runningCount > SIDEBAR_CHILD_RUNNING_LIMIT ? (
        <li>
          <button
            type="button"
            className={toggleClassName}
            aria-expanded={ui.running}
            onClick={toggleRunning}
          >
            {ui.running ? "Show fewer running" : `+${rows.hiddenActiveCount} more running`}
          </button>
        </li>
      ) : null}
      {rows.finishedCount > 0 ? (
        <li>
          <button
            type="button"
            className={toggleClassName}
            aria-expanded={ui.finished}
            onClick={toggleFinished}
          >
            <ChevronRightIcon aria-hidden className={cn("size-3", ui.finished && "rotate-90")} />
            {rows.finishedCount} finished
          </button>
        </li>
      ) : null}
      {rows.finishedRows.map(renderRow)}
      {props.showFinished && ui.finished && rows.hiddenFinishedCount > 0 ? (
        <li>
          <button type="button" className={toggleClassName} onClick={showMoreFinished}>
            Show {Math.min(rows.hiddenFinishedCount, SIDEBAR_CHILD_FINISHED_PAGE_COUNT)} more
          </button>
        </li>
      ) : null}
      {rows.pinnedOpenRow !== null ? renderRow(rows.pinnedOpenRow) : null}
    </ul>
  );
});
