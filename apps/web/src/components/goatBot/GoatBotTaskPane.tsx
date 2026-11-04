import { useAtomValue } from "@effect/atom-react";
import { canSendToGoatBot, presentTaskStatus } from "@goat/client-runtime/goatBot";
import type { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { useEffect, type CSSProperties } from "react";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { useResizableWidth, RESIZABLE_WIDTH_PROPERTY } from "~/hooks/useResizableWidth";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { Button } from "../ui/button";
import { GoatBotComposer } from "./GoatBotComposer";
import { GoatBotWorkDetails } from "./GoatBotWorkDetails";
import { GoatBotTimeline } from "./GoatBotTimeline";
import { useBotRoster } from "./useBotRoster";
import { useGoatBotSession } from "./useGoatBotSession";

export function GoatBotTaskPane({
  environmentId,
  session,
  taskId,
  onClose,
  narrow,
}: {
  readonly environmentId: EnvironmentId;
  readonly session: ReturnType<typeof useGoatBotSession>;
  readonly taskId: ChannelTaskId;
  readonly onClose: () => void;
  readonly narrow: boolean;
}) {
  const { width, handlers } = useResizableWidth({
    storageKey: "goat-bot-task-pane-width",
    defaultWidth: 480,
    minWidth: 320,
    maxWidth: 900,
    edge: "left",
  });
  const { rows, refresh } = useBotRoster();
  const task = rows.find((row) => row.kind === "task" && row.task.taskId === taskId);
  const update = useAtomCommand(channelEnvironment.updateTaskView);
  const canUpdate = useAtomValue(channelEnvironment.updateTaskView.permissionAtom(environmentId));
  const readThrough = task?.kind === "task" && task.unread ? task.lastActivityAt : null;
  // oxlint-disable-next-line goat/react-effect-budget -- Opening a task acknowledges its current activity on the server.
  useEffect(() => {
    if (!canUpdate || readThrough === null) return;
    void update({ environmentId, input: { taskId, readThrough } }).then((result) => {
      if (result._tag === "Success") refresh();
    });
  }, [canUpdate, environmentId, taskId, readThrough, update, refresh]);
  const canSend = canSendToGoatBot(session.availability, session.canOperate);
  return (
    <section
      aria-label="Task thread"
      style={
        narrow
          ? undefined
          : ({
              width: `var(${RESIZABLE_WIDTH_PROPERTY})`,
              [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
            } as CSSProperties)
      }
      className={
        narrow
          ? "relative flex min-h-0 min-w-0 flex-1 flex-col bg-background"
          : "relative flex min-h-0 min-w-0 max-w-[65%] shrink-0 flex-col border-l border-border bg-background"
      }
    >
      {!narrow && <RightPanelResizeHandle handlers={handlers} />}
      <header
        className={
          narrow
            ? "flex flex-wrap items-center gap-2 border-b border-border p-3 pl-14"
            : "flex flex-wrap items-center gap-2 border-b border-border p-3"
        }
      >
        <Button variant="ghost" size="sm" onClick={onClose}>
          {narrow ? "Back to Tasks" : "Close"}
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">
            {task?.kind === "task" ? task.task.title : "Task thread"}
          </h2>
          {task?.kind === "task" && (
            <p className="text-xs text-muted-foreground">
              {presentTaskStatus(task.view.doneAt ? "completed" : task.task.status).label}
            </p>
          )}
        </div>
        {task?.kind === "task" && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={!canUpdate}
              onClick={() =>
                void update({
                  environmentId,
                  input: { taskId, pinned: task.view.pinnedAt === null },
                }).then((result) => {
                  if (result._tag === "Success") refresh();
                })
              }
            >
              {task.view.pinnedAt ? "Unpin" : "Pin"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!canUpdate}
              onClick={() =>
                void update({
                  environmentId,
                  input: { taskId, done: task.view.doneAt === null },
                }).then((result) => {
                  if (result._tag === "Success") refresh();
                })
              }
            >
              {task.view.doneAt ? "Reopen" : "Mark done"}
            </Button>
          </>
        )}
      </header>
      <GoatBotWorkDetails environmentId={environmentId} taskId={taskId} rows={rows} />
      <GoatBotTimeline
        taskDetails
        rows={session.rowsForTask(taskId)}
        environmentId={environmentId}
        onRetry={session.onRetryInput}
        onDiscard={session.onDiscardInput}
        onPick={canSend ? (text) => session.onSendToTask(taskId, text) : undefined}
      />
      <GoatBotComposer
        disabled={!canSend}
        placeholder={canSend ? "Message GOAT Bot" : "GOAT Bot isn't available"}
        attachmentSupport={session.attachmentSupport}
        onSend={(text, attachments) => session.onSendToTask(taskId, text, attachments)}
      />
    </section>
  );
}
