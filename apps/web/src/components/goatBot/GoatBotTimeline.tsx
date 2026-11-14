import {
  GOAT_BOT_READING_LIMIT_MS,
  goatBotActivity,
  goatBotPreviewText,
  goatBotStampParts,
  goatBotReceiptLabel,
  goatBotRejectionText,
  goatBotUnreadIds,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import { ChannelTaskId, type EnvironmentId } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { flushSync } from "react-dom";
import { ArrowUpLeftIcon, ChevronDownIcon, CircleAlertIcon, XIcon } from "~/components/solar";
import {
  createContext,
  type UIEvent,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usePrimarySettings } from "~/hooks/useSettings";
import { goatBotSearch, useGoatBotMember, useGoatBotName } from "./goatBotMemberContext";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { formatShortTimestamp } from "~/timestampFormat";

import { MemorySettingsEntry } from "../settings/MemorySettings";
import { GoatBotLinkedText } from "./GoatBotLinkedText";
import { GoatBotReplyFiles } from "./GoatBotReplyFiles";
import {
  GoatBotActivityLine,
  GoatBotMessageTime,
  GoatBotUpdateLabel,
  GoatBotSentAttachments,
  type GoatBotTimelineActivity,
} from "./GoatBotMessageParts";
import { GoatBotQuestionCard } from "./GoatBotQuestionCard";
import { GoatBotEventText } from "./GoatBotEventText";
import { GoatBotReplyCards } from "./GoatBotReplyCards";
import { goatBotReplySplit } from "./goatBotReplyParts";
import { GoatBotStepsContext, GoatBotStepsMark } from "./GoatBotStepsLine";
import { GoatBotTaskChip } from "./GoatBotTaskChip";
import { recordTaskOpener, getTaskPaneFocus } from "./taskPaneFocus";
import { useGoatBotFollow, type GoatBotLocalSubmission } from "./useGoatBotFollow";
import { GoatBotReplyCopy } from "./GoatBotReplyCopy";

/** How close to the bottom still counts as "following" new messages. */
const FOLLOW_THRESHOLD_PX = 48;
const NO_SUBMISSIONS: ReadonlyArray<GoatBotLocalSubmission> = Object.freeze([]);

/** What the acknowledged work is doing, from the bot conversation's session; null elsewhere. */
export const GoatBotActivityContext = createContext<GoatBotTimelineActivity | null>(null);

/** The "New" line above the first message the person has not read. */
interface UnreadDivider {
  readonly kind: "unread";
  readonly id: "unread";
  readonly firstInGroup: true;
}
const UNREAD_DIVIDER: UnreadDivider = { kind: "unread", id: "unread", firstInGroup: true };
const UNREAD_JUMP_MARGIN_PX = 24;
/** A row the server sent; a message still being sent can show before the history has loaded. */
const isHistoryRow = (row: GoatBotRow) =>
  row.kind !== "day" && !(row.kind === "user" && row.sendKey !== null);

export function GoatBotTimeline({
  rows,
  unreadSince,
  environmentId = null,
  replyingSince = null,
  onRetry,
  onDiscard,
  onPick,
  onOpenRoutine,
  onReply,
  taskDetails = false,
  taskThreads = false,
  retryEnvironmentId = null,
  baselineIds,
  sourceIds,
  submissions = NO_SUBMISSIONS,
  committedSends,
  onExposure,
}: {
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly baselineIds?: ReadonlySet<string> | null | undefined;
  readonly sourceIds?: ReadonlySet<string> | undefined;
  readonly submissions?: ReadonlyArray<GoatBotLocalSubmission> | undefined;
  readonly committedSends?: ReadonlyMap<string, string> | undefined;
  readonly onExposure?: ((rows: ReadonlyArray<GoatBotRow>) => void) | undefined;
  /** When the person last read this chat, read once at open; newer rows get a "New" divider. */
  readonly unreadSince?: string | null | undefined;
  readonly taskDetails?: boolean;
  /** Task chips become task-thread pills; the caller knows whether the server supports them. */
  readonly taskThreads?: boolean;
  /** Where failed or stopped work can be retried from its card; null when it can't. */
  readonly retryEnvironmentId?: EnvironmentId | null;
  /** The environment whose history these rows show; links in bot text resolve there. */
  readonly environmentId?: EnvironmentId | null;
  readonly replyingSince?: string | null;
  readonly onReply?: ((text: string) => void) | undefined;
  readonly onRetry: (clientKey: string) => void;
  /** How to open, by id, a routine an event line names; undefined when it no longer exists. */
  readonly onOpenRoutine?: ((routineId: string) => (() => void) | undefined) | undefined;
  readonly onDiscard?: ((clientKey: string) => void) | undefined;
  /** Sends a question's choice as the user's answer; absent while the bot can't take messages. */
  readonly onPick?: ((answer: string, taskId?: string, questionId?: string) => void) | undefined;
}) {
  const lastCopy = useRef<{ clear: () => void } | null>(null);
  const selectCopy = useStableCallback((owner: { clear: () => void }) => {
    lastCopy.current?.clear();
    lastCopy.current = owner;
  });
  const releaseCopy = useStableCallback((owner: { clear: () => void }) => {
    if (lastCopy.current === owner) lastCopy.current = null;
  });
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const member = useGoatBotMember();
  const botName = useGoatBotName();
  const taskFocus = getTaskPaneFocus();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Messages sent while this view is mounted, by send key, and the server id each one received.
  // A committed row reuses its pending row's element, so the send motion plays once and never
  // on history or reload.
  const [sentHere, setSentHere] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const pendingSends = rows.flatMap((row) =>
    row.kind === "user" && row.sendKey !== null ? [[row.sendKey, row.requestKey] as const] : [],
  );
  if (
    pendingSends.some(
      ([sendKey, requestKey]) =>
        !sentHere.has(sendKey) || (requestKey !== null && sentHere.get(sendKey) !== requestKey),
    )
  ) {
    setSentHere((previous) => {
      const next = new Map(previous);
      for (const [sendKey, requestKey] of pendingSends) {
        if (requestKey !== null || !next.has(sendKey)) next.set(sendKey, requestKey);
      }
      return next;
    });
  }
  const sendKeyByRequest = new Map<string, string>();
  for (const [sendKey, requestKey] of [...sentHere, ...pendingSends]) {
    if (requestKey !== null) sendKeyByRequest.set(requestKey, sendKey);
  }

  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const timePrefix = useId();
  const followingRef = useRef(true);
  // Where the transcript was last scrolled, by the reader or by following.
  const lastScrollTopRef = useRef(0);
  const follow = useGoatBotFollow({
    rows,
    baselineIds,
    sourceIds,
    submissions,
    committedSends,
    onExposure,
    scrollRef,
    listRef,
    followingRef,
    lastScrollTopRef,
  });
  const [nowMs] = useState(() => Date.now());
  const replying = useReplying(replyingSince);
  const working = useContext(GoatBotActivityContext);
  const steps = useContext(GoatBotStepsContext);
  const activity: GoatBotTimelineActivity | null = replying
    ? goatBotActivity({ reading: true, task: null, worker: null })
    : working;
  const activityText = activity?.text ?? null;
  // The transcript's height right after a line opened or closed in place and resized the list;
  // the one resize that reaches it is that toggle's own and does not follow the newest message.
  const toggledHeight = useRef<number | null>(null);
  const updateEdges = useStableCallback(() => {
    const scroll = scrollRef.current;
    const wrapper = wrapperRef.current;
    if (!scroll || !wrapper) return;
    const atTop = String(scroll.scrollTop <= 1);
    const atBottom = String(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 1);
    if (wrapper.dataset.atTop !== atTop) wrapper.dataset.atTop = atTop;
    if (wrapper.dataset.atBottom !== atBottom) wrapper.dataset.atBottom = atBottom;
  });
  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const top = element.scrollTop;
    // Only moving up stops following. A scroll event the timeline's own move left behind can
    // arrive after a message grew, far from the new bottom, without the reader moving at all.
    if (
      top !== lastScrollTopRef.current &&
      element.scrollHeight - top - element.clientHeight < FOLLOW_THRESHOLD_PX
    ) {
      follow.setFollowing(true);
      follow.reachedBottom();
    } else if (top < lastScrollTopRef.current) {
      follow.setFollowing(false);
      follow.readerMoved();
    } else if (top !== lastScrollTopRef.current) {
      follow.readerMoved();
    }
    lastScrollTopRef.current = element.scrollTop;
    updateEdges();
  };
  // Messages finish laying out after they render (Markdown, highlighting, images), and the
  // column can get its height after mounting; a reader following the newest message stays there.
  const followResize = useStableCallback(() => {
    const scroll = scrollRef.current;
    const toggled = toggledHeight.current;
    toggledHeight.current = null;
    if (scroll !== null && toggled !== null && scroll.scrollHeight === toggled) {
      lastScrollTopRef.current = scroll.scrollTop;
    } else if (scroll !== null && follow.alignAnchor()) {
      // A folded answer stays beside its question while the transcript resizes.
    } else if (scroll !== null && followingRef.current) {
      if (scroll.scrollTop < scroll.scrollHeight - scroll.clientHeight)
        scroll.scrollTop = scroll.scrollHeight;
      lastScrollTopRef.current = scroll.scrollTop;
    }
    updateEdges();
  });
  useLayoutEffect(() => {
    updateEdges();
    const scroll = scrollRef.current;
    const list = listRef.current;
    if (!scroll || !list) return;
    return observeResize([scroll, list], followResize);
  }, [updateEdges, followResize]);
  // The activity bubble keeps the view pinned unless the reader scrolled up; new rows are pinned
  // by useGoatBotFollow and streamed text by followResize.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element !== null && activityText !== null && followingRef.current) {
      element.scrollTop = element.scrollHeight;
      lastScrollTopRef.current = element.scrollTop;
    }
    updateEdges();
  }, [activityText, updateEdges]);

  // Which rows are new is decided once, from the first history and the visit before this open.
  // The divider sits above the first of them still shown, and the pill counts those shown.
  const [unreadIds, setUnreadIds] = useState<ReadonlySet<string> | undefined>();
  if (unreadIds === undefined && unreadSince !== undefined && rows.some(isHistoryRow)) {
    setUnreadIds(goatBotUnreadIds(rows, unreadSince));
  }
  const unreadRows =
    unreadIds === undefined || unreadIds.size === 0
      ? []
      : rows.filter((row) => unreadIds.has(row.id));
  const firstUnread = unreadRows[0];
  const firstUnreadId = firstUnread?.id;
  const dividerRef = useRef<HTMLLIElement>(null);
  const [dividerAbove, setDividerAbove] = useState(false);
  const [pillDismissed, setPillDismissed] = useState(false);
  // oxlint-disable-next-line goat/react-effect-budget -- The pill shows while the divider is scrolled above the transcript's viewport.
  useEffect(() => {
    const divider = dividerRef.current;
    const root = scrollRef.current;
    if (firstUnreadId === undefined || divider === null || root === null) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry === undefined) return;
        setDividerAbove(
          !entry.isIntersecting && entry.boundingClientRect.bottom < (entry.rootBounds?.top ?? 0),
        );
      },
      { root },
    );
    observer.observe(divider);
    return () => observer.disconnect();
  }, [firstUnreadId]);
  const unreadAt = firstUnread === undefined ? -1 : rows.indexOf(firstUnread);
  // Scrolls the transcript alone; scrollIntoView would also shift the page and hide the header.
  // Focus follows, since the pill that held it goes away once the divider is in view.
  const jumpToUnread = () => {
    const divider = dividerRef.current;
    const root = scrollRef.current;
    if (divider === null || root === null) return;
    const offset = divider.getBoundingClientRect().top - root.getBoundingClientRect().top;
    root.scrollTo({ top: root.scrollTop + offset - UNREAD_JUMP_MARGIN_PX });
    divider.focus({ preventScroll: true });
  };
  const shownRows: ReadonlyArray<GoatBotRow | UnreadDivider> =
    unreadAt < 0 ? rows : [...rows.slice(0, unreadAt), UNREAD_DIVIDER, ...rows.slice(unreadAt)];

  const time = (iso: string) => formatShortTimestamp(iso, timestampFormat);
  // Opening a line keeps the conversation where it is instead of following it.
  const keepPlace = (toggle: () => void) => {
    const scroll = scrollRef.current;
    const top = scroll?.scrollTop;
    const listHeight = listRef.current?.getBoundingClientRect().height;
    flushSync(toggle);
    if (scroll === null || top === undefined) return;
    scroll.scrollTop = top;
    lastScrollTopRef.current = scroll.scrollTop;
    // A toggle that left the list's height alone gets no resize to absorb.
    toggledHeight.current =
      listRef.current?.getBoundingClientRect().height === listHeight ? null : scroll.scrollHeight;
  };
  const trailingMark = steps?.trailing ?? null;
  const renderRow = (row: GoatBotRow | UnreadDivider, index: number) => {
    const gap = index > 0 && row.kind !== "day" && (row.firstInGroup ? "mt-4" : "mt-1.5");
    switch (row.kind) {
      case "unread":
        // A list item, so it can take focus; a focusable separator would be announced as a splitter.
        return (
          <li
            key={row.id}
            ref={dividerRef}
            tabIndex={-1}
            aria-label="New messages"
            className="mt-4 flex items-center gap-3 rounded-sm text-xs leading-4 text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            New
          </li>
        );
      case "day": {
        const stamp = goatBotStampParts(row.at, nowMs, time);
        return (
          <li
            key={row.id}
            className="mt-6 mb-2 text-center text-xs leading-4 text-muted-foreground first:mt-2"
          >
            <span className="font-medium">{stamp.lead}</span>{" "}
            <span className="font-normal">{stamp.time}</span>
          </li>
        );
      }
      case "event":
        return (
          <li
            key={row.id}
            role="note"
            className="my-3 text-center text-xs leading-4 text-muted-foreground"
          >
            <GoatBotEventText row={row} onOpenRoutine={onOpenRoutine} />
          </li>
        );
      case "user": {
        const delivery = row.delivery;
        const failed = delivery.state === "failed";
        const retryable = failed && delivery.rejectionReason === undefined;
        const timeId = `${timePrefix}-time-${row.id}`;
        const sendKey =
          row.sendKey ??
          (row.requestKey === null ? undefined : sendKeyByRequest.get(row.requestKey));
        const arrives = sendKey !== undefined;
        const receipt =
          row.showReceipt && (delivery.state === "queued" || delivery.state === "sending")
            ? goatBotReceiptLabel(delivery, time, botName)
            : null;
        return (
          <li
            key={sendKey === undefined ? row.id : `send:${sendKey}`}
            tabIndex={failed ? undefined : 0}
            aria-describedby={failed ? undefined : timeId}
            className={cn(
              "goat-message-row group/message flex flex-col items-end gap-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              arrives && "goat-arrive",
              index > 0 && (row.firstInGroup ? "mt-4" : "mt-1.5"),
            )}
          >
            <span className="sr-only">You</span>
            {row.quote
              ? (() => {
                  const prefix = normalize(row.quote).slice(0, 60);
                  const source =
                    prefix &&
                    rows.find(
                      (candidate) =>
                        candidate.kind === "bot" && normalize(candidate.text).startsWith(prefix),
                    );
                  const style =
                    "max-w-[min(80%,34rem)] truncate rounded-md border border-border px-2 py-1 text-xs text-muted-foreground";
                  return source ? (
                    <button
                      type="button"
                      className={style}
                      onClick={() => {
                        const element = Array.from(
                          listRef.current?.querySelectorAll<HTMLElement>("[data-bot-row]") ?? [],
                        ).find((node) => node.dataset.botRow === source.id);
                        element?.scrollIntoView({ block: "center" });
                        element?.focus({ preventScroll: true });
                      }}
                    >
                      {goatBotPreviewText(row.quote)}
                    </button>
                  ) : (
                    <span className={style}>{goatBotPreviewText(row.quote)}</span>
                  );
                })()
              : null}
            {row.attachments && row.attachments.length > 0 ? (
              <GoatBotSentAttachments attachments={row.attachments} environmentId={environmentId} />
            ) : null}
            {(row.reply ?? row.text).trim().length > 0 || retryable ? (
              <div className="flex w-full items-center justify-end gap-2">
                {!failed ? (
                  <GoatBotMessageTime
                    id={timeId}
                    createdAt={row.createdAt}
                    time={time(row.createdAt)}
                  />
                ) : null}
                {retryable ? (
                  <button
                    type="button"
                    aria-label="Retry sending"
                    onClick={() => onRetry(delivery.clientKey)}
                    className="flex size-6 shrink-0 items-center justify-center rounded-full text-destructive-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <CircleAlertIcon className="size-4" />
                    <span className="sr-only">Retry</span>
                  </button>
                ) : null}
                {(row.reply ?? row.text).trim().length > 0 ? (
                  <div className="goat-person-pill w-fit max-w-[min(80%,34rem)]">
                    {row.reply ?? row.text}
                  </div>
                ) : null}
              </div>
            ) : !failed ? (
              <time id={timeId} dateTime={row.createdAt} className="sr-only">
                {time(row.createdAt)}
              </time>
            ) : null}
            {failed ? (
              <div className="flex items-center gap-2 text-xs leading-4 font-medium text-destructive-foreground">
                <span>{goatBotRejectionText(delivery.rejectionReason, botName)}</span>
                {onDiscard ? (
                  <button
                    type="button"
                    onClick={() => onDiscard(delivery.clientKey)}
                    className="hover:underline"
                  >
                    Discard
                  </button>
                ) : null}
              </div>
            ) : receipt !== null ? (
              <span
                className="text-xs leading-4 text-muted-foreground"
                aria-label={receipt.accessibleText}
              >
                {receipt.text}
              </span>
            ) : null}
          </li>
        );
      }
      case "bot": {
        const timeId = `${timePrefix}-time-${row.id}`;
        const toneIcon =
          row.tone === "failure" ? (
            <CircleAlertIcon
              aria-label="Failed"
              className="mt-0.5 size-4 shrink-0 text-destructive-foreground"
            />
          ) : null;
        const memory = row.memory ? (
          <MemorySettingsEntry
            environmentId={row.memory.environmentId}
            reference={row.memory}
            label="View memory details"
          />
        ) : null;
        const body = (
          <>
            {toneIcon}
            <div className="min-w-0 flex-1">
              <GoatBotLinkedText text={row.text} environmentId={environmentId} />
              {memory}
            </div>
          </>
        );
        // An answer with a table reads as cards: its text, each table, and the rest.
        // The splitter caches by text, so only a row whose text changed is parsed.
        const reply = toneIcon === null ? goatBotReplySplit(row.text, rows.length) : null;
        const card = (
          <div className="flex w-full min-w-0 items-end gap-2">
            {reply !== null && reply.parts.some((part) => part.kind === "table") ? (
              <GoatBotReplyCards reply={reply} environmentId={environmentId} trail={memory} />
            ) : (
              <div className="goat-bot-prose goat-bot-card flex w-fit max-w-[min(100%,34rem)] min-w-0 gap-2">
                {body}
              </div>
            )}
            <GoatBotMessageTime id={timeId} createdAt={row.createdAt} time={time(row.createdAt)} />
          </div>
        );
        return (
          <li
            key={row.id}
            data-bot-row={row.id}
            data-follow-row={row.id}
            tabIndex={0}
            aria-describedby={timeId}
            className={cn(
              "goat-message-row group/message flex flex-col items-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              gap,
            )}
          >
            {row.proactive && row.firstInGroup ? <GoatBotUpdateLabel name={botName} /> : null}
            {row.replyTo ? (
              <blockquote className="ms-3.5 mb-1 max-w-[min(100%,32rem)] border-s-2 border-border ps-2 text-xs leading-5 text-muted-foreground">
                <span className="block truncate">{row.replyTo}</span>
              </blockquote>
            ) : null}
            <div className="flex w-full items-end gap-1">
              {(row.choices ?? row.options).length > 0 ? (
                <div className="flex w-full min-w-0 items-end gap-2">
                  <GoatBotQuestionCard row={row} body={body} onPick={onPick} />
                  <GoatBotMessageTime
                    id={timeId}
                    createdAt={row.createdAt}
                    time={time(row.createdAt)}
                  />
                </div>
              ) : (
                card
              )}
              <div className="flex shrink-0 opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100 pointer-coarse:opacity-100">
                {onReply ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Reply"
                          onClick={() => onReply(row.text)}
                        />
                      }
                    >
                      <ArrowUpLeftIcon className="size-4" />
                    </TooltipTrigger>
                    <TooltipPopup>Reply</TooltipPopup>
                  </Tooltip>
                ) : null}
                <GoatBotReplyCopy text={row.text} select={selectCopy} release={releaseCopy} />
              </div>
            </div>
            <GoatBotReplyFiles text={row.text} />
          </li>
        );
      }
      case "task":
        return (
          <li
            key={row.id}
            data-follow-row={row.id}
            tabIndex={-1}
            aria-label={`${row.card.title}, ${row.card.statusLabel}`}
            className={cn("flex", gap)}
          >
            {taskDetails || !taskThreads ? (
              <GoatBotTaskChip
                card={row.card}
                retryEnvironmentId={taskDetails ? null : retryEnvironmentId}
              />
            ) : (
              <div className="flex max-w-[44rem] min-w-0 flex-col items-start gap-1">
                <Link
                  to="/bot"
                  search={{
                    task: ChannelTaskId.make(row.card.key),
                    ...goatBotSearch(member),
                  }}
                  data-task-opener={`pill:${row.id}`}
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
                        row.card.key,
                        `pill:${row.id}`,
                      );
                  }}
                  className="inline-flex max-w-full rounded-full border border-border px-3 py-1.5 text-sm whitespace-normal break-words hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                >
                  Task thread · {row.card.title}
                </Link>
                <details className="w-full">
                  <summary className="cursor-default text-xs text-muted-foreground">
                    Task details
                  </summary>
                  <div className="mt-1">
                    <GoatBotTaskChip card={row.card} retryEnvironmentId={retryEnvironmentId} />
                  </div>
                </details>
              </div>
            )}
          </li>
        );
    }
  };
  return (
    <div
      ref={wrapperRef}
      className="goat-timeline relative flex min-h-0 flex-1 flex-col"
      data-at-top="true"
      data-at-bottom="true"
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-stable"
      >
        <ol
          ref={listRef}
          aria-label={`Conversation with ${botName}`}
          className="mx-auto flex w-full max-w-3xl flex-col px-4 py-4"
        >
          {[
            ...shownRows.flatMap((row, index) => {
              const mark =
                row.kind === "day" || row.kind === "unread"
                  ? undefined
                  : steps?.beforeRow.get(row.id);
              const rendered = renderRow(row, index);
              return mark === undefined
                ? [rendered]
                : [
                    <li
                      key={mark.kind === "steps" ? mark.line.key : "elsewhere:" + row.id}
                      className={cn("flex", index > 0 && "mt-4")}
                    >
                      <GoatBotStepsMark mark={mark} onToggle={keepPlace} />
                    </li>,
                    rendered,
                  ];
            }),
            ...(trailingMark === null
              ? []
              : [
                  <li
                    key={
                      trailingMark.kind === "steps" ? trailingMark.line.key : "elsewhere:trailing"
                    }
                    className={cn("flex", rows.length > 0 && "mt-4")}
                  >
                    <GoatBotStepsMark mark={trailingMark} onToggle={keepPlace} />
                  </li>,
                ]),
          ]}
          {activity !== null ? (
            <li className={cn("flex", rows.length > 0 && "mt-6")}>
              <GoatBotActivityLine activity={activity} onToggle={keepPlace} />
            </li>
          ) : null}
        </ol>
      </div>
      {follow.cueIds.length > 0 ? (
        <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
          <Button size="xs" variant="glass" onClick={follow.jump}>
            <ChevronDownIcon className="size-3.5" />
            {follow.cueIds.length === 1
              ? "Jump to latest"
              : `Jump to latest (${follow.cueIds.length} new)`}
          </Button>
        </div>
      ) : null}
      {follow.cueIds.length === 0 && unreadAt >= 0 && dividerAbove && !pillDismissed ? (
        <div className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-primary text-primary-foreground shadow-sm ring-2 ring-background">
          <Button size="sm" onClick={jumpToUnread}>
            {unreadRows.length === 1 ? "1 new message" : `${unreadRows.length} new messages`}
          </Button>
          <Button
            size="icon-sm"
            aria-label="Dismiss new messages"
            onClick={() => setPillDismissed(true)}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      <div
        aria-hidden="true"
        className="goat-top-fade pointer-events-none absolute top-0 right-3 left-0 h-6 bg-linear-to-b from-background to-transparent"
      />
      <div
        aria-hidden="true"
        className="goat-bottom-fade pointer-events-none absolute right-3 bottom-0 left-0 h-6 bg-linear-to-t from-background to-transparent"
      />
    </div>
  );
}

/** True from when GOAT Bot starts reading until its reply lands or the limit passes. */
function useReplying(since: string | null): boolean {
  const deadlineMs = (since === null ? Number.NaN : Date.parse(since)) + GOAT_BOT_READING_LIMIT_MS;
  const getSnapshot = () => Date.now() < deadlineMs;
  const subscribe = (onChange: () => void) => {
    const remaining = deadlineMs - Date.now();
    const timer = remaining > 0 ? setTimeout(onChange, remaining) : undefined;
    return () => clearTimeout(timer);
  };
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
