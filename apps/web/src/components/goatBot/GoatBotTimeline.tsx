import {
  goatBotStampParts,
  goatBotReceiptLabel,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import { BellIcon, CircleAlertIcon, MessageCircleQuestionIcon } from "~/components/solar";
import {
  Fragment,
  type UIEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { formatShortTimestamp } from "~/timestampFormat";

import { MemorySettingsEntry } from "../settings/MemorySettings";
import { GoatBotLinkedText } from "./GoatBotLinkedText";
import { GoatBotTaskChip } from "./GoatBotTaskChip";

/** How close to the bottom still counts as "following" new messages. */
const FOLLOW_THRESHOLD_PX = 48;

/**
 * Reception gives up after 45 seconds and then sends a failure note, so a reply that has not
 * come by this point is not coming. The indicator stops instead of spinning forever.
 */
const REPLYING_LIMIT_MS = 90_000;

/** Each dot hops a beat after the one before it, so the three read as a wave. */
const TYPING_DOT_DELAYS = ["0ms", "150ms", "300ms"] as const;

export function GoatBotTimeline({
  rows,
  replyingSince = null,
  onRetry,
  onPick,
}: {
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly replyingSince?: string | null;
  readonly onRetry: (clientKey: string) => void;
  /** Sends a question's choice as the user's answer; absent while the bot can't take messages. */
  readonly onPick?: ((answer: string) => void) | undefined;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
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
  useLayoutEffect(() => {
    updateEdges();
    const scroll = scrollRef.current;
    const list = listRef.current;
    if (!scroll || !list) return;
    return observeResize([scroll, list], updateEdges);
  }, [updateEdges]);
  // New rows and the replying bubble keep the view pinned to the latest message unless the
  // reader scrolled up.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element !== null && (rows.length > 0 || replying) && followingRef.current) {
      element.scrollTop = element.scrollHeight;
    }
    updateEdges();
  }, [rows, replying, updateEdges]);

  const time = (iso: string) => formatShortTimestamp(iso, timestampFormat);

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
          aria-label="Conversation with GOAT Bot"
          className="mx-auto flex w-full max-w-3xl flex-col px-4 py-4"
        >
          {rows.map((row, index) => {
            switch (row.kind) {
              case "day": {
                const stamp = goatBotStampParts(row.at, nowMs, time);
                return (
                  <li
                    key={row.id}
                    className="mt-4 mb-1 text-center text-xs leading-4 text-muted-foreground"
                  >
                    <span className="font-semibold">{stamp.lead}</span>{" "}
                    <span className="font-normal">{stamp.time}</span>
                  </li>
                );
              }
              case "user": {
                const delivery = row.delivery;
                const failed = delivery.state === "failed";
                const timeId = `${timePrefix}-time-${row.id}`;
                const sendKey =
                  row.sendKey ??
                  (row.requestKey === null ? undefined : sendKeyByRequest.get(row.requestKey));
                const arrives = sendKey !== undefined;
                return (
                  <li
                    key={sendKey === undefined ? row.id : `send:${sendKey}`}
                    tabIndex={failed ? undefined : 0}
                    aria-describedby={failed ? undefined : timeId}
                    className={cn(
                      "goat-message-row group flex flex-col items-end outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      arrives && "goat-arrive",
                      index > 1 && (row.firstInGroup ? "mt-3" : "mt-1"),
                    )}
                  >
                    <div
                      className={cn(
                        // Full width so the bubble's 75% cap measures the conversation column.
                        "flex w-full items-end justify-end",
                        delivery.state === "failed" && delivery.rejectionReason === undefined
                          ? "gap-7"
                          : "gap-2",
                      )}
                    >
                      <div className="relative ml-auto w-fit max-w-[min(75%,34rem)]">
                        <div
                          className={cn(
                            "goat-bubble goat-bubble-out-fill max-w-full text-goat-bubble-out-foreground",
                            (row.groupPosition === "single" || row.groupPosition === "last") &&
                              "goat-bubble-tail-out",
                          )}
                        >
                          {row.text}
                        </div>
                        {!failed ? (
                          <time
                            id={timeId}
                            dateTime={row.createdAt}
                            className="absolute right-[calc(100%+8px)] bottom-1 max-w-20 truncate whitespace-nowrap text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 max-[360px]:sr-only"
                          >
                            {time(row.createdAt)}
                          </time>
                        ) : null}
                      </div>
                      {delivery.state === "failed" && delivery.rejectionReason === undefined ? (
                        <button
                          type="button"
                          aria-label="Retry sending"
                          onClick={() => onRetry(delivery.clientKey)}
                          className="mb-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive text-white"
                        >
                          <CircleAlertIcon className="size-4" />
                          <span className="sr-only">Retry</span>
                        </button>
                      ) : null}
                    </div>
                    {row.delivery.state === "failed" ? (
                      <span className="mt-1 text-xs leading-4 font-medium text-destructive-foreground">
                        {row.delivery.rejectionReason ?? "Not Delivered"}
                      </span>
                    ) : row.showReceipt ? (
                      <span
                        className="mt-1 text-xs leading-4 font-medium text-muted-foreground"
                        aria-label={goatBotReceiptLabel(row.delivery, time)?.accessibleText}
                      >
                        {goatBotReceiptLabel(row.delivery, time)?.text}
                      </span>
                    ) : null}
                  </li>
                );
              }
              case "bot":
                return (
                  <Fragment key={row.id}>
                    <li
                      tabIndex={0}
                      aria-describedby={`${timePrefix}-time-${row.id}`}
                      className={cn(
                        "goat-message-row group flex flex-col items-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        index > 1 && (row.firstInGroup ? "mt-3" : "mt-1"),
                      )}
                    >
                      {row.proactive && row.firstInGroup ? (
                        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                          <BellIcon className="size-3.5" aria-hidden />
                          GOAT Bot · Update
                        </div>
                      ) : null}
                      {row.replyTo ? (
                        <blockquote className="goat-reply-line mb-1 ml-1.5 max-w-[min(75%,34rem)] px-2 py-1 text-xs text-muted-foreground">
                          <span className="block truncate">{row.replyTo}</span>
                        </blockquote>
                      ) : null}
                      <div className="relative mr-auto w-fit max-w-[min(75%,34rem)]">
                        <div
                          className={cn(
                            "goat-bubble flex max-w-full gap-1 bg-goat-bubble-in text-goat-bubble-in-foreground",
                            (row.groupPosition === "single" || row.groupPosition === "last") &&
                              "goat-bubble-tail-in",
                          )}
                        >
                          {row.tone === "failure" ? (
                            <CircleAlertIcon className="mt-1 size-3.5 shrink-0 text-destructive-foreground" />
                          ) : row.tone === "question" ? (
                            <MessageCircleQuestionIcon className="mt-1 size-3.5 shrink-0 text-warning-foreground" />
                          ) : null}
                          <div className="min-w-0">
                            <GoatBotLinkedText text={row.text} />
                            {row.memory ? (
                              <MemorySettingsEntry
                                environmentId={row.memory.environmentId}
                                reference={row.memory}
                                label="View memory details"
                              />
                            ) : null}
                          </div>
                        </div>
                        <time
                          id={`${timePrefix}-time-${row.id}`}
                          dateTime={row.createdAt}
                          className="absolute bottom-1 left-[calc(100%+8px)] max-w-20 truncate whitespace-nowrap text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 max-[360px]:sr-only"
                        >
                          {time(row.createdAt)}
                        </time>
                      </div>
                    </li>
                    {row.options.length > 0 ? (
                      <li className="flex gap-2 pt-1">
                        <div
                          role="group"
                          aria-label="Suggested answers"
                          className="flex max-w-3/4 flex-wrap gap-1.5"
                        >
                          {row.options.map((option) => (
                            <button
                              type="button"
                              key={option}
                              disabled={onPick === undefined}
                              onClick={() => onPick?.(option)}
                              className="rounded-full border border-goat-bubble-out/40 px-3 py-1 text-sm text-goat-bubble-out hover:bg-goat-bubble-out/8 disabled:opacity-50"
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </li>
                    ) : null}
                  </Fragment>
                );
              case "task":
                return (
                  <li
                    key={row.id}
                    className={cn(
                      "flex items-end",
                      index > 1 && (row.firstInGroup ? "mt-3" : "mt-1"),
                    )}
                  >
                    <GoatBotTaskChip
                      card={row.card}
                      tail={row.groupPosition === "last" || row.groupPosition === "single"}
                    />
                  </li>
                );
            }
          })}
          {replying ? (
            <li className={cn("flex items-end", rows.at(-1)?.kind === "user" && "mt-3")}>
              <div
                role="status"
                aria-label="GOAT Bot is replying"
                className="goat-typing-tail relative flex h-10 items-center gap-1 rounded-2xl bg-goat-bubble-in px-4"
              >
                {TYPING_DOT_DELAYS.map((delay) => (
                  <span
                    key={delay}
                    aria-hidden
                    className="size-[7px] animate-typing-wave rounded-full bg-muted-foreground motion-reduce:animate-none"
                    style={{ animationDelay: delay }}
                  />
                ))}
              </div>
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
  const deadlineMs = (since === null ? Number.NaN : Date.parse(since)) + REPLYING_LIMIT_MS;
  const getSnapshot = () => Date.now() < deadlineMs;
  const subscribe = (onChange: () => void) => {
    const remaining = deadlineMs - Date.now();
    const timer = remaining > 0 ? setTimeout(onChange, remaining) : undefined;
    return () => clearTimeout(timer);
  };
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
