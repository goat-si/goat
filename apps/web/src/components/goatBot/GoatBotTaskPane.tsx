import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  acknowledgeTaskRead,
  botTaskWait,
  canSendToGoatBot,
  goatBotOpenQuestionPlaceholder,
  goatBotTaskWait,
  isRetryableTaskStatus,
  presentTaskStatus,
  taskAttemptLabel,
} from "@goat/client-runtime/goatBot";
import { BotId, ChannelQuestionId, type ChannelTaskId, type EnvironmentId } from "@goat/contracts";
import { useState, type CSSProperties } from "react";
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
import { GoatBotUnavailableWork, GoatBotWorkDetails } from "./GoatBotWorkDetails";
import { GoatBotStepsProvider, GoatBotStepsReader } from "./GoatBotStepsProvider";
import { GoatBotTimeline } from "./GoatBotTimeline";
import { GoatBotTaskRetry } from "./GoatBotTaskRetry";
import { memberThreadsKey, useGoatBotMember, useGoatBotName } from "./goatBotMemberContext";
import { goatBotHomeKey } from "./goatBotHomeRequest";
import { useBotThreads } from "./useBotRoster";
import { useGoatBotSession } from "./useGoatBotSession";
import { focusTaskHeading, getTaskPaneFocus } from "./taskPaneFocus";
import { useBotTaskLookup } from "./useBotTaskLookup";
import { useAcknowledgeTaskRead } from "./useAcknowledgeTaskRead";
import type { GoatBotLocalSubmission } from "./useGoatBotFollow";

export function GoatBotTaskPane({
  environmentId,
  session,
  taskId,
  taskTitle,
  onClose,
  narrow,
}: {
  readonly environmentId: EnvironmentId;
  readonly session: ReturnType<typeof useGoatBotSession>;
  readonly taskId: ChannelTaskId;
  readonly taskTitle?: string | undefined;
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
  const navigate = useNavigate();
  const botName = useGoatBotName();
  const { rows, remoteWork, refresh, established, pending, chips } = useBotThreads(
    environmentId,
    memberThreadsKey(member),
  );
  const listedTask = rows.find((row) => row.kind === "task" && row.task.taskId === taskId);
  const lookup = useBotTaskLookup(
    environmentId,
    taskId,
    member?.botId ?? BotId.make("main"),
    { established, refreshing: pending, holdsTask: listedTask !== undefined },
    member?.state !== "deleted",
  );
  const found = listedTask === undefined ? lookup.value?.task : undefined;
  const task = listedTask ?? (found?.state === "known" ? found.row : undefined);
  const taskSummary =
    task?.kind === "task" ? task.task : found?.state === "unavailable" ? found.task : undefined;
  const chip = chips.get(taskId);
  // What Home's row and the bot's face say this task waits for; an unlisted task has no view.
  const wait =
    task?.kind === "task"
      ? botTaskWait(task, chip)
      : taskSummary
        ? goatBotTaskWait({
            status: taskSummary.status,
            openQuestionCount: chip?.openQuestionCount ?? 0,
            observed: chip?.observed,
          })
        : null;
  const sentFor = lookup.key;
  /** A completion counts only for the task it was sent for; another task's is dropped. */
  const finish = (sent: string) => {
    if (lookup.complete(sent)) refresh();
  };
  const update = useAtomCommand(channelEnvironment.updateTaskView);
  const canUpdate = useAtomValue(channelEnvironment.updateTaskView.permissionAtom(environmentId));
  const readThrough = task?.kind === "task" && task.unread ? task.lastActivityAt : null;
  useAcknowledgeTaskRead({
    environmentId,
    taskId,
    readThrough,
    identity: sentFor,
    onAcknowledged: (_task, _through, sent) => {
      if (sent !== undefined) finish(sent);
    },
  });
  const memberDeleted = member?.state === "deleted";
  const canSend = !memberDeleted && canSendToGoatBot(session.availability, session.canOperate);
  const timelineRows = session.rowsForTask(taskId);
  const sourceIdentity = session.source?.identity ?? null;
  const [local, setLocal] = useState<{
    taskId: ChannelTaskId;
    sourceIdentity: string | null;
    submissions: ReadonlyArray<GoatBotLocalSubmission>;
  }>({ taskId, sourceIdentity, submissions: [] });
  if (local.taskId !== taskId || local.sourceIdentity !== sourceIdentity)
    setLocal({ taskId, sourceIdentity, submissions: [] });
  const send = (
    text: string,
    attachments: Parameters<typeof session.onSendToTask>[2] = [],
    questionId?: ChannelQuestionId,
  ) => {
    const result =
      questionId === undefined
        ? session.onSendToTask(taskId, text, attachments)
        : session.onSendToTask(taskId, text, attachments, questionId);
    if (typeof result === "string") {
      const submission = { key: result };
      setLocal((previous) => ({
        taskId,
        sourceIdentity,
        submissions: [
          ...(previous.taskId === taskId && previous.sourceIdentity === sourceIdentity
            ? previous.submissions
            : []),
          submission,
        ],
      }));
    }
    return result !== false;
  };
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
              {taskSummary?.title ?? taskTitle ?? "Task thread"}
            </TooltipTrigger>
            <TooltipPopup>{taskSummary?.title ?? taskTitle ?? "Task thread"}</TooltipPopup>
          </Tooltip>
          {taskSummary && (
            <p className="shrink-0 text-xs text-muted-foreground">
              {wait ??
                (found?.state === "unavailable" && taskSummary.status === "completed"
                  ? "Completed"
                  : presentTaskStatus(
                      taskSummary.status,
                      task?.kind === "task" ? task.view.doneAt : null,
                    ).label)}
              {taskAttemptLabel(taskSummary.generation)
                ? ` · ${taskAttemptLabel(taskSummary.generation)}`
                : ""}
            </p>
          )}
        </div>
        {task?.kind === "task" && (
          <>
            {session.supportsTaskRetry && isRetryableTaskStatus(task.task.status) ? (
              <GoatBotTaskRetry
                environmentId={environmentId}
                taskId={taskId}
                onStarted={() => finish(sentFor)}
              />
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
                  if (result._tag === "Success") finish(sentFor);
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
                  if (result._tag === "Success") finish(sentFor);
                })
              }
            >
              {task.view.doneAt ? "Reopen" : "Mark done"}
            </Button>
            {lookup.supported && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!canUpdate || !task.unread}
                onClick={() => {
                  void acknowledgeTaskRead({
                    environmentId,
                    taskId,
                    readThrough: task.lastActivityAt,
                    update,
                  }).then((outcome) => {
                    if (outcome === "accepted") finish(sentFor);
                  });
                }}
              >
                Mark read
              </Button>
            )}
          </>
        )}
        {found?.state === "unavailable" && (
          <>
            <Button variant="ghost" size="sm" disabled aria-describedby="task-view-unavailable">
              Pin
            </Button>
            <Button variant="ghost" size="sm" disabled aria-describedby="task-view-unavailable">
              Mark done
            </Button>
            <Button variant="ghost" size="sm" disabled aria-describedby="task-view-unavailable">
              Mark read
            </Button>
          </>
        )}
      </header>
      {found?.state === "unavailable" && (
        <p id="task-view-unavailable" role="status">
          Task view unavailable; pin, done and read status cannot be determined.
        </p>
      )}
      {lookup.supported && !lookup.permitted && listedTask === undefined && (
        <p role="status">Permission to read this task is unavailable.</p>
      )}
      {lookup.value?.partial && listedTask === undefined && (
        <p role="status">Some task details could not be checked.</p>
      )}
      {lookup.loading && (
        <p role="status" className="px-3 pt-3 text-sm text-muted-foreground">
          Loading task…
        </p>
      )}
      {lookup.error === "denied" && (
        <p role="status">Permission to read this task is unavailable.</p>
      )}
      {lookup.error === "missing" && <p role="status">This task cannot be found here.</p>}
      {lookup.error === "failed" && (
        <div className="flex flex-wrap items-center gap-2 px-3 pt-3 text-sm text-muted-foreground">
          <p role="alert">Couldn't load this task.</p>
          <Button variant="outline" size="xs" onClick={() => lookup.retry()}>
            Try again
          </Button>
        </div>
      )}
      {task === undefined && (!lookup.supported || lookup.view === "dev") && (
        <div className="flex flex-wrap items-center gap-2 px-3 pt-3 text-sm text-muted-foreground">
          <p>Status and actions for older work are in {botName}'s Home.</p>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              const bot = session.availability.kind === "ready" ? session.availability.bot : null;
              if (bot == null) return onClose();
              // Straight to the bot's chat: /bot would mount a chat that redirects away.
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: bot.environmentId, threadId: bot.threadId },
                state: { goatBotOpenHome: goatBotHomeKey(environmentId, member?.botId ?? null) },
              });
            }}
          >
            Open Home
          </Button>
        </div>
      )}
      {task !== undefined && listedTask !== undefined && (
        <div className="px-3">
          <GoatBotWorkDetails
            environmentId={environmentId}
            taskId={taskId}
            rows={rows}
            remoteWork={remoteWork}
          />
        </div>
      )}
      {task !== undefined && listedTask === undefined && (
        <details className="px-3 text-xs text-muted-foreground">
          <summary>Show work</summary>
          <GoatBotWorkDetails
            environmentId={environmentId}
            taskId={taskId}
            rows={[task, ...(lookup.value?.codingRows ?? [])]}
            remoteWork={lookup.value?.remoteWork ?? []}
          />
        </details>
      )}
      {found?.state === "unavailable" && lookup.value && (
        <GoatBotUnavailableWork work={lookup.value} />
      )}
      {listedTask === undefined && lookup.value?.launchesTruncated && (
        <p>Some threads are listed in Threads.</p>
      )}
      <GoatBotStepsProvider
        visibleTurnItems={session.visibleTurnItems}
        environmentId={environmentId}
        taskId={taskId}
      >
        <GoatBotStepsReader rows={timelineRows}>
          <GoatBotTimeline
            key={`${session.source?.identity ?? ""}:${taskId}`}
            taskDetails
            rows={timelineRows}
            baselineIds={session.source?.baselineIds}
            sourceIds={session.source?.sourceIds}
            submissions={
              local.taskId === taskId && local.sourceIdentity === sourceIdentity
                ? local.submissions
                : []
            }
            committedSends={session.source?.committedSends}
            environmentId={environmentId}
            onRetry={session.onRetryInput}
            onDiscard={session.onDiscardInput}
            onPick={
              canSend
                ? (text, answerTask, questionId) =>
                    // A question id goes only with the task that asked it.
                    send(
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
        onSend={(text, attachments) => send(text, attachments)}
      />
    </section>
  );
}
