import { useAtomValue } from "@effect/atom-react";
import { botHomeWork, presentTaskStatus, type BotWorkTask } from "@goat/client-runtime/goatBot";
import type {
  BotRemoteWork,
  BotThreadRow,
  ChannelTaskId,
  ChannelUpdateTaskViewInput,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import { type ReactNode, useState } from "react";
import { Link } from "@tanstack/react-router";
import { holdNavigation } from "~/lib/navigationHolds";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  BookmarkIcon,
  CheckIcon,
  ChevronRightIcon,
  EllipsisIcon,
  MessageCircleQuestionIcon,
} from "../solar";
import { Button } from "../ui/button";
import { goatBotSearch, useGoatBotMember } from "./goatBotMemberContext";
import { GoatBotCardSkeleton, GoatBotShowMoreRow } from "./GoatBotSectionCard";
import { GoatBotWorkDetails } from "./GoatBotWorkDetails";

type TaskRow = Extract<BotThreadRow, { kind: "task" }>;

/** Finished work past this many rows waits behind Show more. */
const COLLAPSED_FINISHED = 5;
const NO_REMOTE: ReadonlyArray<BotRemoteWork> = [];

/** A refusal that reading again cannot change, so no Retry is offered for it. */
function accessDenied(failure: unknown): boolean {
  return (
    typeof failure === "object" &&
    failure !== null &&
    (failure as { readonly _tag?: unknown })._tag === "EnvironmentAuthorizationError"
  );
}

const MARK = {
  running: "bg-info",
  waiting: "text-warning-foreground",
  finished: "text-muted-foreground",
} as const;
type Mark = keyof typeof MARK;

/** Whether Back's row now sits behind Show more, so the list opens to give it focus again. */
export function workRowCollapsed(
  rows: ReadonlyArray<BotThreadRow>,
  environmentId: EnvironmentId,
  remoteWork: ReadonlyArray<BotRemoteWork>,
  taskId: ChannelTaskId,
): boolean {
  return botHomeWork(rows, [], environmentId, remoteWork)
    .finished.slice(COLLAPSED_FINISHED)
    .some((task) => task.row.task.taskId === taskId);
}

/**
 * Home's Work card: going, then waiting on a person, then finished. Rows come from the bot's task
 * list; a merged history will supply the same rows here without changing this component.
 */
export function GoatBotHomeWork({
  environmentId,
  botName,
  rows,
  remoteWork = NO_REMOTE,
  loaded,
  failed,
  failure = null,
  supported = true,
  offline = false,
  onRetry,
  onOpenTask,
  peekable = true,
  showAll,
  onShowAllChange,
  focusTaskId = null,
  focusRef,
  notice = null,
}: {
  readonly environmentId: EnvironmentId;
  /** Kept for the history walk, which will read this bot's older work for these rows. */
  readonly threadId?: ThreadId | undefined;
  readonly botName: string;
  readonly rows: ReadonlyArray<BotThreadRow>;
  readonly remoteWork?: ReadonlyArray<BotRemoteWork> | undefined;
  readonly loaded: boolean;
  readonly failed: boolean;
  /** Why the read failed; an authorization refusal gets no Retry. */
  readonly failure?: unknown;
  /** False on a server that cannot list this bot's work at all. */
  readonly supported?: boolean;
  /** The computer is offline, so nothing can be read until it reconnects. */
  readonly offline?: boolean;
  readonly onRetry: () => void;
  /** Opens a row's conversation in place; absent leaves each row a link to the task's thread. */
  readonly onOpenTask: (row: TaskRow) => void;
  readonly peekable?: boolean;
  /** Work's list is open past its collapsed tail; the panel holds this so a peek keeps it. */
  readonly showAll: boolean;
  readonly onShowAllChange: (showAll: boolean) => void;
  /** The row Back returns to; it takes focus when it shows again. */
  readonly focusTaskId?: ChannelTaskId | null | undefined;
  readonly focusRef?: ((element: HTMLElement | null) => void) | undefined;
  /** The bot's own turn waiting in the chat, which no task row lists. */
  readonly notice?: ReactNode;
}) {
  const work = botHomeWork(rows, [], environmentId, remoteWork);
  const empty = work.running.length + work.waiting.length + work.finished.length === 0;
  const denied = failed && accessDenied(failure);
  const hidden = work.finished.length - COLLAPSED_FINISHED;
  const finished = showAll ? work.finished : work.finished.slice(0, COLLAPSED_FINISHED);
  const row = (task: BotWorkTask, mark: Mark) => (
    <WorkRow
      key={task.row.task.taskId}
      task={task}
      mark={mark}
      rows={rows}
      remoteWork={remoteWork}
      environmentId={environmentId}
      onOpenTask={onOpenTask}
      onRefresh={onRetry}
      peekable={peekable}
      focusRef={task.row.task.taskId === focusTaskId ? focusRef : undefined}
    />
  );
  return (
    <div className="flex flex-col">
      {notice}
      {offline ? (
        <p className="px-3 py-3">
          {botName}'s tasks are unavailable while the computer is offline.
        </p>
      ) : !supported ? (
        <p className="px-3 py-3">Tasks can't be listed from this server right now.</p>
      ) : denied ? (
        <p className="px-3 py-3">This device can't read {botName}'s work.</p>
      ) : failed ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
          <p className="min-w-0 flex-1">Couldn't load {botName}'s tasks.</p>
          <Button size="xs" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
      {supported && !offline && !loaded && !failed && (
        <>
          <p className="sr-only">Loading tasks…</p>
          <GoatBotCardSkeleton rows={3} />
        </>
      )}
      {loaded && !failed && empty && (
        <div className="space-y-0.5 px-3 py-3">
          <p className="font-medium text-foreground">No recent tasks</p>
          <p className="text-muted-foreground">
            Ask {botName} in chat to start work. Unpinned tasks that finished more than three days
            ago aren't listed here.
          </p>
        </div>
      )}
      {work.running.map((task) => row(task, "running"))}
      {work.waiting.map((task) => row(task, "waiting"))}
      {finished.map((task) => row(task, "finished"))}
      {hidden > 0 && (
        <GoatBotShowMoreRow expanded={showAll} onToggle={() => onShowAllChange(!showAll)} />
      )}
    </div>
  );
}

function MarkIcon({ mark }: { readonly mark: Mark }) {
  if (mark === "waiting")
    return <MessageCircleQuestionIcon aria-hidden className={cn("size-4", MARK[mark])} />;
  if (mark === "finished") return <CheckIcon aria-hidden className={cn("size-4", MARK[mark])} />;
  // Still, never pulsing: a repainting mark costs frames on a high-refresh display.
  return <span aria-hidden className={cn("size-2 rounded-full", MARK[mark])} />;
}

function WorkRow({
  task,
  mark,
  rows,
  remoteWork,
  environmentId,
  onOpenTask,
  onRefresh,
  peekable,
  focusRef,
}: {
  readonly task: BotWorkTask;
  readonly mark: Mark;
  readonly rows: ReadonlyArray<BotThreadRow>;
  readonly remoteWork: ReadonlyArray<BotRemoteWork>;
  readonly environmentId: EnvironmentId;
  readonly onOpenTask: (row: TaskRow) => void;
  readonly onRefresh: () => void;
  readonly peekable: boolean;
  readonly focusRef?: ((element: HTMLElement | null) => void) | undefined;
}) {
  const row = task.row;
  const title = row.task.title;
  const member = useGoatBotMember();
  const update = useAtomCommand(channelEnvironment.updateTaskView);
  const canUpdate = useAtomValue(channelEnvironment.updateTaskView.permissionAtom(environmentId));
  const [expanded, setExpanded] = useState(false);
  const status = presentTaskStatus(row.task.status, row.view.doneAt);
  async function menu(position: { readonly x: number; readonly y: number }) {
    const api = readLocalApi();
    if (api == null) return;
    const release = holdNavigation();
    const action = await api.contextMenu
      .show(
        [
          { id: "work", label: expanded ? "Hide work" : "Show work" },
          ...(canUpdate
            ? [
                { id: "pin", label: row.view.pinnedAt ? "Unpin" : "Pin" },
                { id: "done", label: row.view.doneAt ? "Reopen" : "Mark done" },
                { id: "read", label: "Mark read", disabled: !row.unread },
              ]
            : []),
        ],
        position,
      )
      .catch(() => null)
      .finally(release);
    if (action === null) return;
    if (action === "work") {
      setExpanded((value) => !value);
      return;
    }
    const input: ChannelUpdateTaskViewInput =
      action === "pin"
        ? { taskId: row.task.taskId, pinned: row.view.pinnedAt === null }
        : action === "done"
          ? { taskId: row.task.taskId, done: row.view.doneAt === null }
          : action === "read"
            ? { taskId: row.task.taskId, readThrough: row.lastActivityAt }
            : { taskId: row.task.taskId };
    const result = await update({ environmentId, input });
    if (result._tag === "Success") onRefresh();
  }
  return (
    <div className="border-t border-border/50 first:border-t-0">
      <div className="flex min-h-11 items-center gap-2 px-3">
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
          <MarkIcon mark={mark} />
        </span>
        {peekable ? (
          <button
            type="button"
            ref={focusRef}
            onClick={() => onOpenTask(row)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <WorkRowText title={title} status={status.label} unread={row.unread} />
          </button>
        ) : (
          <Link
            to="/bot"
            search={{ task: row.task.taskId, ...goatBotSearch(member) }}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <WorkRowText title={title} status={status.label} unread={row.unread} />
          </Link>
        )}
        {row.view.pinnedAt !== null && (
          <BookmarkIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${title}`}
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            void menu({ x: rect.left, y: rect.bottom });
          }}
        >
          <EllipsisIcon />
        </Button>
      </div>
      {expanded && (
        <div className="pb-2 pl-9">
          <GoatBotWorkDetails
            environmentId={environmentId}
            taskId={row.task.taskId}
            rows={rows}
            remoteWork={remoteWork}
          />
        </div>
      )}
    </div>
  );
}

/** A row's title and status, then the chevron that says the row opens. */
function WorkRowText({
  title,
  status,
  unread,
}: {
  readonly title: string;
  readonly status: string;
  readonly unread: boolean;
}) {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{status}</span>
      </span>
      {unread ? (
        <>
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-info" />
          {/* The open control says it, so a person tabbing through hears it with the title. */}
          <span className="sr-only">Unread</span>
        </>
      ) : null}
      <ChevronRightIcon
        data-work-chevron
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground"
      />
    </>
  );
}
