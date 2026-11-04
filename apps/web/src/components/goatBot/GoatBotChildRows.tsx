import { useAtomValue } from "@effect/atom-react";
import { botThreadKey, presentTaskStatus, selectBotChildren } from "@goat/client-runtime/goatBot";
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
    const action = await api.contextMenu
      .show(
        [
          { id: "pin", label: row.view.pinnedAt ? "Unpin" : "Pin" },
          { id: "done", label: row.view.doneAt ? "Reopen" : "Mark done" },
          { id: "read", label: "Mark read", disabled: !row.unread },
        ],
        position,
      )
      .catch(() => null);
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
          const status = task
            ? presentTaskStatus(task.view.doneAt ? "completed" : task.task.status)
            : null;
          const statusPill = status && {
            label: status.label,
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
                  : { colorClass: "text-info-foreground", dotClass: "bg-info" }),
            pulse: status.tone === "active",
          };
          return (
            <SidebarMenuItem key={botThreadKey(row)}>
              <SidebarMenuButton
                isActive={active}
                tooltip={{ children: title, hidden: false }}
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
                    <Link to="/bot" search={{ task: row.task.taskId }} />
                  ) : (
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId: row.environmentId, threadId: row.threadId }}
                    />
                  )
                }
              >
                <span className="w-4" />
                {statusPill && <ThreadStatusLabel status={statusPill} />}
                <span className="min-w-0 flex-1 truncate">{title}</span>
                {row.kind === "coding" && (
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    GOAT thread
                  </span>
                )}
                {task?.unread && (
                  <span role="img" aria-label="Unread" className="size-2 rounded-full bg-info" />
                )}
              </SidebarMenuButton>
              {task && (
                <div className="pointer-events-none absolute top-1 right-1 opacity-0 group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100 group-focus-within/menu-item:pointer-events-auto group-focus-within/menu-item:opacity-100">
                  <Button
                    variant="ghost-muted"
                    size="icon-xs"
                    aria-label={`Actions for ${title}`}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      void menu(task, { x: rect.left, y: rect.bottom });
                    }}
                  >
                    <EllipsisIcon />
                  </Button>
                </div>
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
              <span className="w-4" />
              {showMore ? "Show less" : "Show more"}
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
