import { useAtomValue } from "@effect/atom-react";
import { botThreadKey, selectBotChildren } from "@goat/client-runtime/goatBot";
import {
  isChannelTaskTerminal,
  type BotThreadRow,
  type ChannelUpdateTaskViewInput,
  type EnvironmentId,
} from "@goat/contracts";
import { Link, useLocation, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { readLocalApi } from "~/localApi";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
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
  const [now] = useState(Date.now);
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
            ? task.view.doneAt || isChannelTaskTerminal(task.task.status)
              ? "done"
              : task.task.status === "waiting_input"
                ? "blocked"
                : "working"
            : null;
          return (
            <SidebarMenuItem key={botThreadKey(row)}>
              <SidebarMenuButton
                isActive={active}
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
                {status && (
                  <span
                    role="img"
                    aria-label={status}
                    className={
                      status === "blocked"
                        ? "size-2 rounded-full bg-warning"
                        : status === "done"
                          ? "size-2 rounded-full bg-muted-foreground"
                          : "size-2 rounded-full bg-success"
                    }
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{title}</span>
                {row.kind === "coding" && (
                  <span className="text-xs text-muted-foreground">GOAT thread</span>
                )}
                {task?.unread && (
                  <span role="img" aria-label="Unread" className="size-2 rounded-full bg-info" />
                )}
              </SidebarMenuButton>
              {task && (
                <button
                  type="button"
                  aria-label={`Actions for ${title}`}
                  className="absolute right-1 top-1"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    void menu(task, { x: rect.left, y: rect.bottom });
                  }}
                >
                  ⋯
                </button>
              )}
            </SidebarMenuItem>
          );
        })}
        {visible.hasMore && (
          <button type="button" onClick={() => setShowMore(true)}>
            Show more
          </button>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
