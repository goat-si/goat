import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { BotIcon, SquareIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentScope } from "../../state/session";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { canStopSidebarDelegatedChild, sidebarDelegatedChildState } from "../Sidebar.logic";
import { Button } from "../ui/button";

interface SidebarOpenSubagentProps {
  readonly thread: EnvironmentThreadShell;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
  // Views without delegated-task controls omit these; Lineage still offers Stop.
  readonly onStop?: ((threadRef: ScopedThreadRef) => void) | undefined;
  readonly onContextMenu?:
    | ((threadRef: ScopedThreadRef, position: { x: number; y: number }) => void)
    | undefined;
  readonly isStopping?: boolean | undefined;
}

/**
 * Subagents have no sidebar rows. The open one shows beneath its owner row so the
 * user keeps their place, and disappears when they navigate away.
 */
export const SidebarOpenSubagent = memo(function SidebarOpenSubagent(
  props: SidebarOpenSubagentProps,
) {
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
    () => onStop?.(scopeThreadRef(thread.environmentId, thread.id)),
    [onStop, thread.environmentId, thread.id],
  );
  const contextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (!onContextMenu) return;
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
  const stopPointerPropagation = useCallback(
    (event: React.PointerEvent) => event.stopPropagation(),
    [],
  );

  return (
    <ul role="group" aria-label="Open subagent" onPointerDown={stopPointerPropagation}>
      <li
        className="group/delegated-child flex h-7 items-center rounded-md bg-sidebar-row-active pl-6 pr-2 text-xs text-sidebar-foreground hover:bg-sidebar-row-hover"
        onContextMenu={contextMenu}
      >
        <div
          role="button"
          tabIndex={0}
          aria-current="page"
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
        {onStop && canOperate && canStopSidebarDelegatedChild(thread) ? (
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
    </ul>
  );
});
