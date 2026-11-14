import { useAtomValue } from "@effect/atom-react";
import {
  accessDenied,
  botHomeWork,
  botTaskWait,
  COLLAPSED_FINISHED,
  presentTaskStatus,
  type BotWorkTask,
  type HomeCurrentOpenableLink,
} from "@goat/client-runtime/goatBot";
import { BotId } from "@goat/contracts";
import type {
  BotRemoteWork,
  BotThreadRow,
  ChannelTaskId,
  ChannelTaskChip,
  ChannelUpdateTaskViewInput,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
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
import { rememberHomeOrigin } from "./goatBotHomeRequest";
import { GoatBotWorkDetails } from "./GoatBotWorkDetails";

type TaskRow = Extract<BotThreadRow, { kind: "task" }>;
export type HomeHistory = {
  readonly supported: boolean;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly incomplete: boolean;
  readonly launchesTruncated: ReadonlySet<ChannelTaskId>;
  readonly currentTaskIds: ReadonlySet<ChannelTaskId>;
  readonly loadMore: () => void;
};

const NO_REMOTE: ReadonlyArray<BotRemoteWork> = [];
const NO_CHIPS: ReadonlyMap<ChannelTaskId, ChannelTaskChip> = new Map();

const MARK = {
  running: "bg-info",
  waiting: "text-warning-foreground",
  finished: "text-muted-foreground",
} as const;
type Mark = keyof typeof MARK;

/**
 * Home's Work card: going, then waiting on a person, then finished. Rows come from the bot's task
 * list; a merged history will supply the same rows here without changing this component.
 */
export function GoatBotHomeWork({
  environmentId,
  botName,
  rows,
  remoteWork = NO_REMOTE,
  chips = NO_CHIPS,
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
  returnTaskId = null,
  notice = null,
  history,
}: {
  readonly environmentId: EnvironmentId;
  /** Kept for the history walk, which will read this bot's older work for these rows. */
  readonly threadId?: ThreadId | undefined;
  readonly botName: string;
  readonly rows: ReadonlyArray<BotThreadRow>;
  readonly remoteWork?: ReadonlyArray<BotRemoteWork> | undefined;
  /** Each task's newest chip in the conversation, which says what its worker asks the person. */
  readonly chips?: ReadonlyMap<ChannelTaskId, ChannelTaskChip> | undefined;
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
  readonly returnTaskId?: ChannelTaskId | null | undefined;
  /** The bot's own turn waiting in the chat, which no task row lists. */
  readonly notice?: ReactNode;
  /** The bot's older work; rows missing from currentTaskIds came from this walk. */
  readonly history?: HomeHistory | undefined;
}) {
  const member = useGoatBotMember();
  const current = useAtomValue(
    channelEnvironment.homeCurrentOpenableWorkAtom([
      environmentId,
      member?.botId ?? BotId.make("main"),
    ]),
  );
  const currentLinks = current.eligible && current.list === "ready" ? current.links : null;
  const historyAvailable = history?.hasMore === true;
  const work = botHomeWork(rows, [], environmentId, remoteWork, chips);
  const empty = work.running.length + work.waiting.length + work.finished.length === 0;
  const denied = failed && accessDenied(failure);
  const hidden = work.finished.length - COLLAPSED_FINISHED;
  const finished = showAll ? work.finished : work.finished.slice(0, COLLAPSED_FINISHED);
  const showMoreRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<ChannelTaskId, HTMLElement>());
  const pendingFocus = useRef<Set<ChannelTaskId> | null>(null);
  const showMore = historyAvailable || hidden > 0;
  // oxlint-disable-next-line goat/react-effect-budget -- Preserve focus when history removes its continuation button.
  useLayoutEffect(() => {
    if (
      returnTaskId !== null &&
      focusTaskId === returnTaskId &&
      loaded &&
      !failed &&
      !rows.some((row) => row.kind === "task" && row.task.taskId === returnTaskId)
    ) {
      const heading = containerRef.current?.closest("section")?.querySelector<HTMLElement>("h3");
      if (heading) focusRef?.(heading);
    }
    if (showMore || pendingFocus.current === null) return;
    if (document.activeElement === document.body) {
      const added = [...work.running, ...work.waiting, ...finished].find(
        (task) => !pendingFocus.current?.has(task.row.task.taskId),
      );
      const heading = containerRef.current?.closest("section")?.querySelector<HTMLElement>("h3");
      (added ? rowRefs.current.get(added.row.task.taskId) : heading)?.focus();
    }
    pendingFocus.current = null;
  });
  const row = (task: BotWorkTask, mark: Mark) => (
    <WorkRow
      key={task.row.task.taskId}
      task={task}
      mark={mark}
      wait={botTaskWait(task.row, chips.get(task.row.task.taskId))}
      returned={task.row.task.taskId === returnTaskId}
      rows={rows}
      remoteWork={remoteWork}
      environmentId={environmentId}
      onOpenTask={onOpenTask}
      onRefresh={onRetry}
      older={history?.supported === true && !history.currentTaskIds.has(task.row.task.taskId)}
      currentRemoteIds={
        currentLinks === null
          ? null
          : ([...current.work.running, ...current.work.waiting, ...current.work.finished]
              .find((entry) => entry.row.task.taskId === task.row.task.taskId)
              ?.remote.map((item) => item.childWorkId) ?? [])
      }
      currentLinks={
        history?.supported === true && !history.currentTaskIds.has(task.row.task.taskId)
          ? null
          : currentLinks
      }
      peekable={peekable}
      focusRef={(element) => {
        if (element) rowRefs.current.set(task.row.task.taskId, element);
        else rowRefs.current.delete(task.row.task.taskId);
        if (task.row.task.taskId === focusTaskId) focusRef?.(element);
      }}
      launchesTruncated={
        history?.launchesTruncated.has(task.row.task.taskId) === true &&
        !(current.eligible && history.currentTaskIds.has(task.row.task.taskId))
      }
    />
  );
  return (
    <div ref={containerRef} tabIndex={-1} aria-label="Work" className="flex flex-col">
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
            Ask {botName} in chat to start work.
            {!history?.supported &&
              " Unpinned tasks that finished more than three days ago aren't listed here."}
          </p>
        </div>
      )}
      {work.running.map((task) => row(task, "running"))}
      {work.waiting.map((task) => row(task, "waiting"))}
      {finished.map((task) => row(task, "finished"))}
      {/* One region per notice, mounted with Home's history, so one never repeats the other. */}
      {history && (
        <div role="status" className="px-3 text-xs text-muted-foreground">
          {history.incomplete && <p className="py-2">Older work may be missing</p>}
        </div>
      )}
      {history && (
        <div role="status" className="px-3 text-xs text-muted-foreground">
          {history.failed && <p className="py-2">Couldn't load older work.</p>}
        </div>
      )}
      {showMore && (
        <GoatBotShowMoreRow
          buttonRef={showMoreRef}
          onBlur={() => {
            pendingFocus.current = null;
          }}
          expanded={showAll}
          label={historyAvailable ? "Show more" : undefined}
          onToggle={() => {
            if (history?.loading) {
              // A governed Home's links hide threads, so its held rows never wait on a server read.
              if (current.eligible && hidden > 0 && !showAll) onShowAllChange(true);
              return;
            }
            if (historyAvailable) {
              if (document.activeElement === showMoreRef.current)
                pendingFocus.current = new Set(
                  [...work.running, ...work.waiting, ...finished].map(
                    (task) => task.row.task.taskId,
                  ),
                );
              onShowAllChange(true);
              history?.loadMore();
            } else onShowAllChange(!showAll);
          }}
        />
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
  wait,
  returned,
  rows,
  remoteWork,
  environmentId,
  onOpenTask,
  onRefresh,
  peekable,
  focusRef,
  launchesTruncated,
  older,
  currentLinks,
  currentRemoteIds,
}: {
  readonly task: BotWorkTask;
  readonly mark: Mark;
  /** What the task waits on the person for, which its row says instead of its status. */
  readonly wait: string | null;
  readonly returned: boolean;
  readonly rows: ReadonlyArray<BotThreadRow>;
  readonly remoteWork: ReadonlyArray<BotRemoteWork>;
  readonly environmentId: EnvironmentId;
  readonly onOpenTask: (row: TaskRow) => void;
  readonly onRefresh: () => void;
  readonly peekable: boolean;
  readonly focusRef?: ((element: HTMLElement | null) => void) | undefined;
  readonly launchesTruncated: boolean;
  readonly older: boolean;
  readonly currentLinks: ReadonlyArray<HomeCurrentOpenableLink> | null;
  readonly currentRemoteIds: ReadonlyArray<string> | null;
}) {
  const row = task.row;
  const title = row.task.title;
  const member = useGoatBotMember();
  const navigate = useNavigate();
  const router = useRouter();
  const remember = (event: React.MouseEvent) => {
    if (
      !event.defaultPrevented &&
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    )
      rememberHomeOrigin(router, environmentId, member?.botId ?? null, row.task.taskId);
  };
  const update = useAtomCommand(channelEnvironment.updateTaskView);
  const canUpdate = useAtomValue(channelEnvironment.updateTaskView.permissionAtom(environmentId));
  const [expanded, setExpanded] = useState(false);
  const status = wait ?? presentTaskStatus(row.task.status, row.view.doneAt).label;
  async function menu(position: { readonly x: number; readonly y: number }) {
    const api = readLocalApi();
    if (api == null) return;
    const release = holdNavigation();
    const action = await api.contextMenu
      .show(
        // Older work offers Pin; once pinned it joins the current list, whose row has the rest.
        older
          ? [
              { id: "work", label: expanded ? "Hide work" : "Show work" },
              { id: "open", label: "Open" },
              { id: "pin", label: "Pin", disabled: !canUpdate },
            ]
          : [
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
    if (action === "open") {
      if (peekable) onOpenTask(row);
      else
        void navigate({
          to: "/bot",
          search: { task: row.task.taskId, taskTitle: title, ...goatBotSearch(member) },
        });
      return;
    }
    const input: ChannelUpdateTaskViewInput =
      action === "pin"
        ? { taskId: row.task.taskId, pinned: older || row.view.pinnedAt === null }
        : action === "done"
          ? { taskId: row.task.taskId, done: row.view.doneAt === null }
          : action === "read"
            ? { taskId: row.task.taskId, readThrough: row.lastActivityAt }
            : { taskId: row.task.taskId };
    const result = await update({ environmentId, input });
    // A pinned older task joins the current list after this refresh, unless the bot has 100
    // newer listed tasks (the server's first page is capped at 100 rows).
    if (result._tag === "Success") onRefresh();
  }
  return (
    <div
      data-home-return={returned || undefined}
      className={cn("border-t border-border/50 first:border-t-0", returned && "bg-accent/40")}
    >
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
            <WorkRowText title={title} status={status} unread={row.unread} returned={returned} />
          </button>
        ) : (
          <Link
            to="/bot"
            onClick={remember}
            ref={focusRef}
            search={{ task: row.task.taskId, taskTitle: title, ...goatBotSearch(member) }}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <WorkRowText title={title} status={status} unread={row.unread} returned={returned} />
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
      {launchesTruncated && (
        <p className="px-9 pb-2 text-xs text-muted-foreground">
          Some threads are listed in Threads.
        </p>
      )}
      {expanded && (
        <div className="pb-2 pl-9">
          <GoatBotWorkDetails
            environmentId={environmentId}
            taskId={row.task.taskId}
            rows={rows}
            remoteWork={remoteWork}
            currentLinks={currentLinks?.filter((link) => link.taskId === row.task.taskId) ?? null}
            currentRemoteIds={older ? null : currentRemoteIds}
            onHomeNavigate={remember}
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
  returned,
}: {
  readonly title: string;
  readonly status: string;
  readonly unread: boolean;
  readonly returned: boolean;
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
      {/* The returned row's highlight, said to a screen reader on the control it focuses. */}
      {returned ? <span className="sr-only">Where you left off</span> : null}
      <ChevronRightIcon
        data-work-chevron
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground"
      />
    </>
  );
}
