import { useAtomValue } from "@effect/atom-react";
import {
  canSendToGoatBot,
  goatBotOpenQuestionPlaceholder,
  isRetryableTaskStatus,
  presentTaskStatus,
  taskAttemptLabel,
} from "@goat/client-runtime/goatBot";
import { ChannelQuestionId, type ChannelTaskId, type EnvironmentId } from "@goat/contracts";
import type { CSSProperties } from "react";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { cn } from "~/lib/utils";
import { useStableCallback } from "~/hooks/useStableCallback";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { useResizableWidth, RESIZABLE_WIDTH_PROPERTY } from "~/hooks/useResizableWidth";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GoatBotComposer } from "./GoatBotComposer";
import { GoatBotWorkDetails } from "./GoatBotWorkDetails";
import { GoatBotStepsProvider, GoatBotStepsReader } from "./GoatBotStepsProvider";
import { GoatBotTimeline } from "./GoatBotTimeline";
import { GoatBotTaskRetry } from "./GoatBotTaskRetry";
import { memberThreadsKey, useGoatBotMember, useGoatBotName } from "./goatBotMemberContext";
import { useBotThreads } from "./useBotRoster";
import { useGoatBotSession } from "./useGoatBotSession";
import { focusTaskHeading, getTaskPaneFocus } from "./taskPaneFocus";
import { useAcknowledgeTaskRead } from "./useAcknowledgeTaskRead";

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
  const taskFocus = getTaskPaneFocus();
  const headingRef = useStableCallback((element: HTMLHeadingElement | null) =>
    focusTaskHeading(taskFocus, taskId, element),
  );
  const member = useGoatBotMember();
  const botName = useGoatBotName();
  const { rows, remoteWork, refresh } = useBotThreads(environmentId, memberThreadsKey(member));
  const task = rows.find((row) => row.kind === "task" && row.task.taskId === taskId);
  const update = useAtomCommand(channelEnvironment.updateTaskView);
  const canUpdate = useAtomValue(channelEnvironment.updateTaskView.permissionAtom(environmentId));
  const readThrough = task?.kind === "task" && task.unread ? task.lastActivityAt : null;
  useAcknowledgeTaskRead({ environmentId, taskId, readThrough, onAcknowledged: refresh });
  const memberDeleted = member?.state === "deleted";
  const canSend = !memberDeleted && canSendToGoatBot(session.availability, session.canOperate);
  const timelineRows = session.rowsForTask(taskId);
  return (
    <section
      aria-label="Task thread"
      data-task-pane={taskId}
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
        className={cn(
          "flex flex-wrap items-center gap-2 border-b border-border p-3",
          narrow && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <Button variant="ghost" size="sm" onClick={onClose}>
          {narrow ? "Back to Tasks" : "Close"}
        </Button>
        <div
          className={
            narrow ? "order-last flex min-w-0 w-full items-baseline gap-2" : "min-w-0 flex-1"
          }
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <h2
                  key={taskId}
                  className="min-w-0 flex-1 truncate font-semibold"
                  tabIndex={-1}
                  ref={headingRef}
                />
              }
            >
              {task?.kind === "task" ? task.task.title : "Task thread"}
            </TooltipTrigger>
            <TooltipPopup>{task?.kind === "task" ? task.task.title : "Task thread"}</TooltipPopup>
          </Tooltip>
          {task?.kind === "task" && (
            <p className="shrink-0 text-xs text-muted-foreground">
              {presentTaskStatus(task.task.status, task.view.doneAt).label}
              {taskAttemptLabel(task.task.generation)
                ? ` · ${taskAttemptLabel(task.task.generation)}`
                : ""}
            </p>
          )}
        </div>
        {task?.kind === "task" && (
          <>
            {session.supportsTaskRetry && isRetryableTaskStatus(task.task.status) ? (
              <GoatBotTaskRetry environmentId={environmentId} taskId={taskId} onStarted={refresh} />
            ) : null}
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
      <div className="px-3">
        <GoatBotWorkDetails
          environmentId={environmentId}
          taskId={taskId}
          rows={rows}
          remoteWork={remoteWork}
        />
      </div>
      <GoatBotStepsProvider
        visibleTurnItems={session.visibleTurnItems}
        environmentId={environmentId}
        taskId={taskId}
      >
        <GoatBotStepsReader rows={timelineRows}>
          <GoatBotTimeline
            taskDetails
            rows={timelineRows}
            environmentId={environmentId}
            onRetry={session.onRetryInput}
            onDiscard={session.onDiscardInput}
            onPick={
              canSend
                ? (text, answerTask, questionId) =>
                    // A question id goes only with the task that asked it.
                    session.onSendToTask(
                      taskId,
                      text,
                      [],
                      answerTask === taskId && questionId !== undefined
                        ? ChannelQuestionId.make(questionId)
                        : undefined,
                    )
                : undefined
            }
          />
        </GoatBotStepsReader>
      </GoatBotStepsProvider>
      <GoatBotComposer
        disabled={!canSend}
        botName={botName}
        placeholder={
          canSend
            ? (goatBotOpenQuestionPlaceholder(timelineRows) ?? `Message ${botName}`)
            : memberDeleted
              ? `${member.name} was deleted`
              : `${botName} isn't available`
        }
        attachmentSupport={session.attachmentSupport}
        onSend={(text, attachments) => session.onSendToTask(taskId, text, attachments)}
      />
    </section>
  );
}
