import {
  GOAT_BOT_READING_LIMIT_MS,
  goatBotActivity,
  goatBotStampParts,
  goatBotReceiptLabel,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import { ChannelTaskId, type EnvironmentId } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { CircleAlertIcon, MessageCircleQuestionIcon } from "~/components/solar";
import {
  createContext,
  type UIEvent,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import {
  goatBotSearch,
  useGoatBotAvatar,
  useGoatBotMember,
  useGoatBotName,
} from "./goatBotMemberContext";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { formatShortTimestamp } from "~/timestampFormat";

import { MemorySettingsEntry } from "../settings/MemorySettings";
import { Button } from "../ui/button";
import { GoatBotLinkedText } from "./GoatBotLinkedText";
import {
  GoatBotActivityLine,
  GoatBotMessageHeader,
  GoatBotSentAttachments,
  type GoatBotTimelineActivity,
} from "./GoatBotMessageParts";
import { GoatBotTaskChip } from "./GoatBotTaskChip";
import { recordTaskOpener, getTaskPaneFocus } from "./taskPaneFocus";

/** How close to the bottom still counts as "following" new messages. */
const FOLLOW_THRESHOLD_PX = 48;

/** What the acknowledged work is doing, from the bot conversation's session; null elsewhere. */
export const GoatBotActivityContext = createContext<GoatBotTimelineActivity | null>(null);

export function GoatBotTimeline({
  rows,
  environmentId = null,
  replyingSince = null,
  onRetry,
  onDiscard,
  onPick,
  taskDetails = false,
  taskThreads = false,
  retryEnvironmentId = null,
}: {
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly taskDetails?: boolean;
  /** Task chips become task-thread pills; the caller knows whether the server supports them. */
  readonly taskThreads?: boolean;
  /** Where failed or stopped work can be retried from its card; null when it can't. */
  readonly retryEnvironmentId?: EnvironmentId | null;
  /** The environment whose history these rows show; links in bot text resolve there. */
  readonly environmentId?: EnvironmentId | null;
  readonly replyingSince?: string | null;
  readonly onRetry: (clientKey: string) => void;
  readonly onDiscard?: ((clientKey: string) => void) | undefined;
  /** Sends a question's choice as the user's answer; absent while the bot can't take messages. */
  readonly onPick?: ((answer: string, taskId?: string) => void) | undefined;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const member = useGoatBotMember();
  const botName = useGoatBotName();
  const avatar = useGoatBotAvatar();
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
  const [nowMs] = useState(() => Date.now());
  const replying = useReplying(replyingSince);
  const working = useContext(GoatBotActivityContext);
  const activity: GoatBotTimelineActivity | null = replying
    ? goatBotActivity({ reading: true, task: null, worker: null })
    : working;
  const activityText = activity?.text ?? null;
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
    followingRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
    updateEdges();
  };
  // Messages finish laying out after they render (Markdown, highlighting, images), and the
  // column can get its height after mounting; a reader following the newest message stays there.
  const followResize = useStableCallback(() => {
    const scroll = scrollRef.current;
    if (scroll !== null && followingRef.current) scroll.scrollTop = scroll.scrollHeight;
    updateEdges();
  });
  useLayoutEffect(() => {
    updateEdges();
    const scroll = scrollRef.current;
    const list = listRef.current;
    if (!scroll || !list) return;
    return observeResize([scroll, list], followResize);
  }, [updateEdges, followResize]);
  // New rows and the activity bubble keep the view pinned to the latest message unless the
  // reader scrolled up.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element !== null && (rows.length > 0 || activityText !== null) && followingRef.current) {
      element.scrollTop = element.scrollHeight;
    }
    updateEdges();
  }, [rows, activityText, updateEdges]);

  const time = (iso: string) => formatShortTimestamp(iso, timestampFormat);
  const activitySince = replying ? replyingSince : (activity?.since ?? null);

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
        className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-stable"
      >
        <ol
          ref={listRef}
          aria-label={`Conversation with ${botName}`}
          className="mx-auto flex w-full max-w-[52rem] flex-col px-4 py-4"
        >
          {rows.map((row, index) => {
            const gap = index > 0 && row.kind !== "day" && (row.firstInGroup ? "mt-6" : "mt-2");
            switch (row.kind) {
              case "day": {
                const stamp = goatBotStampParts(row.at, nowMs, time);
                return (
                  <li
                    key={row.id}
                    className="mt-6 mb-1 text-center text-xs leading-4 text-muted-foreground first:mt-2"
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
                    {row.text}
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
                      "goat-message-row flex flex-col items-end gap-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      arrives && "goat-arrive",
                      index > 0 && (row.firstInGroup ? "mt-6" : "mt-1"),
                    )}
                  >
                    <span className="sr-only">You</span>
                    {row.attachments && row.attachments.length > 0 ? (
                      <GoatBotSentAttachments
                        attachments={row.attachments}
                        environmentId={environmentId}
                      />
                    ) : null}
                    {row.text.trim().length > 0 || retryable ? (
                      <div className="flex w-full items-center justify-end gap-2">
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
                        {row.text.trim().length > 0 ? (
                          <div className="goat-person-pill w-fit max-w-[min(80%,35rem)]">
                            {row.text}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {!failed ? (
                      <time id={timeId} dateTime={row.createdAt} className="sr-only">
                        {time(row.createdAt)}
                      </time>
                    ) : null}
                    {failed ? (
                      <div className="flex items-center gap-2 text-xs leading-4 font-medium text-destructive-foreground">
                        <span>{delivery.rejectionReason ?? "Not Delivered"}</span>
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
                const header = row.firstInGroup || rows[index - 1]?.kind !== "bot";
                const toneIcon =
                  row.tone === "failure" ? (
                    <CircleAlertIcon
                      aria-label="Failed"
                      className="mt-1 size-4 shrink-0 text-destructive-foreground"
                    />
                  ) : row.tone === "question" ? (
                    <MessageCircleQuestionIcon
                      aria-label="Question"
                      className="mt-1 size-4 shrink-0 text-warning-foreground"
                    />
                  ) : null;
                const prose = (
                  <div className="flex min-w-0 gap-2">
                    {toneIcon}
                    <div className="goat-bot-prose min-w-0 flex-1">
                      <GoatBotLinkedText text={row.text} environmentId={environmentId} />
                      {row.memory ? (
                        <MemorySettingsEntry
                          environmentId={row.memory.environmentId}
                          reference={row.memory}
                          label="View memory details"
                        />
                      ) : null}
                    </div>
                  </div>
                );
                return (
                  <li
                    key={row.id}
                    tabIndex={0}
                    aria-describedby={timeId}
                    className={cn(
                      "goat-message-row flex flex-col items-stretch outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      index > 0 && (header ? "mt-6" : gap),
                    )}
                  >
                    {header ? (
                      <GoatBotMessageHeader
                        name={botName}
                        avatar={avatar}
                        proactive={row.proactive}
                        timeId={timeId}
                        createdAt={row.createdAt}
                        time={time(row.createdAt)}
                      />
                    ) : (
                      <time id={timeId} dateTime={row.createdAt} className="sr-only">
                        {time(row.createdAt)}
                      </time>
                    )}
                    {row.replyTo ? (
                      <blockquote className="mb-2 max-w-[44rem] border-s-2 border-border ps-2 text-xs text-muted-foreground">
                        <span className="block truncate">{row.replyTo}</span>
                      </blockquote>
                    ) : null}
                    {row.options.length > 0 ? (
                      <div className="max-w-[44rem] rounded-xl border border-border p-3">
                        {prose}
                        <div
                          role="group"
                          aria-label="Suggested answers"
                          className="mt-3 flex flex-wrap gap-2"
                        >
                          {row.options.map((option) => (
                            <Button
                              key={option}
                              variant="outline"
                              size="sm"
                              disabled={onPick === undefined}
                              onClick={() => onPick?.(option, row.answerTaskId)}
                              className="max-w-full"
                            >
                              <span className="truncate">{option}</span>
                            </Button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      prose
                    )}
                  </li>
                );
              }
              case "task":
                return (
                  <li key={row.id} className={cn("flex", gap)}>
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
                            <GoatBotTaskChip
                              card={row.card}
                              retryEnvironmentId={retryEnvironmentId}
                            />
                          </div>
                        </details>
                      </div>
                    )}
                  </li>
                );
            }
          })}
          {activity !== null ? (
            <li className={cn("flex", rows.length > 0 && "mt-6")}>
              <GoatBotActivityLine activity={activity} since={activitySince} />
            </li>
          ) : null}
        </ol>
      </div>
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
