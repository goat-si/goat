import { useAtomValue } from "@effect/atom-react";
import {
  botTaskWait,
  botThreadKey,
  presentTaskStatus,
  selectBotChildren,
} from "@goat/client-runtime/goatBot";
import {
  type BotThreadRow,
  type ChannelUpdateTaskViewInput,
  type EnvironmentId,
} from "@goat/contracts";
import { Link, useLocation, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { readLocalApi } from "~/localApi";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { EllipsisIcon } from "../solar";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { holdNavigation } from "~/lib/navigationHolds";
import { recordTaskOpener, getTaskPaneFocus } from "./taskPaneFocus";

export function GoatBotChildRows({
  environmentId,
  rows,
  refresh,
}: {
  environmentId: EnvironmentId;
  rows: readonly BotThreadRow[];
  refresh: () => void;
}) {
  const [showMore, setShowMore] = useState(false);
  const taskFocus = getTaskPaneFocus();
  // oxlint-disable-next-line react/purity -- Visibility ages are evaluated when the roster changes.
  const now = Date.now();
  const location = useLocation();
  const params = useParams({ strict: false });
  const search = location.search as { task?: string };
  const selectedKey =
    location.pathname === "/bot" && search.task
      ? `task:${search.task}`
      : params.environmentId && params.threadId
        ? `coding:${params.environmentId}:${params.threadId}`
        : null;
  const visible = selectBotChildren({ rows, selectedKey, showMore, now });
  const update = useAtomCommand(channelEnvironment.updateTaskView);
  const canUpdate = useAtomValue(channelEnvironment.updateTaskView.permissionAtom(environmentId));
  async function menu(
    row: Extract<BotThreadRow, { kind: "task" }>,
    position: { x: number; y: number },
  ) {
    const api = readLocalApi();
    if (!api || !canUpdate) return;
    const release = holdNavigation();
    const action = await api.contextMenu
      .show(
        [
          { id: "pin", label: row.view.pinnedAt ? "Unpin" : "Pin" },
          { id: "done", label: row.view.doneAt ? "Reopen" : "Mark done" },
          { id: "read", label: "Mark read", disabled: !row.unread },
        ],
        position,
      )
      .catch(() => null)
      .finally(release);
    const input: ChannelUpdateTaskViewInput =
      action === "pin"
        ? { taskId: row.task.taskId, pinned: row.view.pinnedAt === null }
        : action === "done"
          ? { taskId: row.task.taskId, done: row.view.doneAt === null }
          : action === "read"
            ? { taskId: row.task.taskId, readThrough: row.lastActivityAt }
            : { taskId: row.task.taskId };
    if (!action) return;
    const result = await update({ environmentId, input });
    if (result._tag === "Success") refresh();
  }
  return (
    <SidebarGroup>
      <SidebarMenu>
        {visible.rows.map((row) => {
          const active = botThreadKey(row) === selectedKey;
          const task = row.kind === "task" ? row : null;
          const title = task
            ? task.task.title
            : row.kind === "coding"
              ? row.title || "GOAT thread"
              : "";
          const status = task ? presentTaskStatus(task.task.status, task.view.doneAt) : null;
          const statusPill = status && {
            // These rows hold no chips, so only waiting_input reads as waiting, in Home's words.
            label: (task && botTaskWait(task, undefined)) ?? status.label,
            ...(status.tone === "danger"
              ? {
                  colorClass: "text-red-600 dark:text-red-300/90",
                  dotClass: "bg-red-500 dark:bg-red-300/90",
                }
              : status.tone === "success"
                ? {
                    colorClass: "text-emerald-600 dark:text-emerald-300/90",
                    dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
                  }
                : status.tone === "neutral"
                  ? {
                      colorClass: "text-sidebar-muted-foreground",
                      dotClass: "bg-sidebar-muted-foreground",
                    }
                  : status.tone === "attention"
                    ? { colorClass: "text-warning-foreground", dotClass: "bg-warning" }
                    : { colorClass: "text-info-foreground", dotClass: "bg-info" }),
            pulse: status.tone === "active",
          };
          return (
            <SidebarMenuItem key={botThreadKey(row)} className="flex items-center">
              <SidebarMenuButton
                isActive={active}
                className="min-w-0 flex-1"
                tooltip={row.kind === "coding" ? `GOAT thread: ${title}` : title}
                aria-label={row.kind === "coding" ? `GOAT thread: ${title}` : undefined}
                aria-current={active ? "page" : undefined}
                onContextMenu={
                  task
                    ? (event) => {
                        event.preventDefault();
                        void menu(task, { x: event.clientX, y: event.clientY });
                      }
                    : undefined
                }
                render={
                  row.kind === "task" ? (
                    <Link
                      to="/bot"
                      search={{ task: row.task.taskId }}
                      data-task-opener={`sidebar:${row.task.taskId}`}
                      onClick={(event) => {
                        if (
                          !event.metaKey &&
                          !event.ctrlKey &&
                          !event.shiftKey &&
                          !event.altKey &&
                          event.button === 0
                        )
                          recordTaskOpener(
                            taskFocus,
                            event.currentTarget,
                            row.task.taskId,
                            `sidebar:${row.task.taskId}`,
                          );
                      }}
                    />
                  ) : (
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId: row.environmentId, threadId: row.threadId }}
                    />
                  )
                }
              >
                <span aria-hidden="true" className="w-4 shrink-0" />
                {statusPill && <ThreadStatusLabel status={statusPill} compact />}
                <span className="min-w-0 flex-1 truncate">{title}</span>
                {task?.unread && (
                  <span role="img" aria-label="Unread" className="size-2 rounded-full bg-info" />
                )}
              </SidebarMenuButton>
              {task && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${title}`}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    void menu(task, { x: rect.left, y: rect.bottom });
                  }}
                >
                  <EllipsisIcon />
                </Button>
              )}
            </SidebarMenuItem>
          );
        })}
        {(visible.hasMore || showMore) && (
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<button type="button" />}
              aria-expanded={showMore}
              onClick={() => setShowMore((value) => !value)}
            >
              <span aria-hidden="true" className="w-4 shrink-0" />
              {showMore ? "Show less" : "Show more"}
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
