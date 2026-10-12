import type { GoatBotDelivery, GoatBotRow } from "@t3tools/client-runtime/goatBot";
import { CircleAlertIcon, MessageCircleQuestionIcon } from "lucide-react";
import {
  Fragment,
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatShortTimestamp } from "~/timestampFormat";

import { Button } from "../ui/button";
import { GoatBotAvatar } from "./GoatBotAvatar";
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
  const followingRef = useRef(true);
  const replying = useReplying(replyingSince);
  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    followingRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
  }, []);
  // New rows and the replying bubble keep the view pinned to the latest message unless the
  // reader scrolled up.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if ((rows.length === 0 && !replying) || element === null || !followingRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [rows, replying]);

  const time = (iso: string) => formatShortTimestamp(iso, timestampFormat);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-stable"
    >
      <ol
        aria-label="Conversation with GOAT Bot"
        className="mx-auto flex w-full max-w-3xl flex-col gap-1 px-4 py-6"
      >
        {rows.map((row) => {
          switch (row.kind) {
            case "day":
              return (
                <li key={row.id} className="my-3 text-center text-xs text-muted-foreground">
                  {formatGoatBotDay(row.at)}
                </li>
              );
            case "user":
              return (
                <li
                  key={row.id}
                  className={cn("flex items-end justify-end gap-2", row.firstInGroup && "mt-2")}
                >
                  <DeliveryMark
                    delivery={row.delivery}
                    time={time(row.delivery.state === "read" ? row.delivery.readAt : row.createdAt)}
                    onRetry={onRetry}
                  />
                  <div className="max-w-3/4 rounded-2xl bg-goat-bubble px-3 py-2 text-sm break-words whitespace-pre-wrap text-goat-bubble-foreground">
                    {row.text}
                  </div>
                </li>
              );
            case "bot":
              return (
                <Fragment key={row.id}>
                  <li className={cn("flex items-end gap-2", row.firstInGroup && "mt-2")}>
                    <BotSlot first={row.firstInGroup} />
                    <div
                      className={cn(
                        "flex max-w-3/4 gap-1.5 rounded-2xl bg-secondary px-3 py-2 text-sm text-secondary-foreground",
                        row.tone === "failure" && "border border-destructive/32",
                      )}
                    >
                      {row.tone === "failure" ? (
                        <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive-foreground" />
                      ) : row.tone === "question" ? (
                        <MessageCircleQuestionIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
                      ) : null}
                      <div className="min-w-0 break-words whitespace-pre-wrap">
                        {row.replyTo ? (
                          <blockquote className="mb-1 border-l-2 border-border pl-2 text-xs text-muted-foreground">
                            {row.replyTo}
                          </blockquote>
                        ) : null}
                        {row.text}
                      </div>
                    </div>
                    <span className="shrink-0 pb-0.5 text-xs text-muted-foreground">
                      {time(row.createdAt)}
                    </span>
                  </li>
                  {row.options.length > 0 ? (
                    <li className="flex gap-2 pt-1">
                      <span aria-hidden className="w-7 shrink-0" />
                      <div
                        role="group"
                        aria-label="Suggested answers"
                        className="flex max-w-3/4 flex-wrap gap-1.5"
                      >
                        {row.options.map((option) => (
                          <Button
                            key={option}
                            size="sm-multiline"
                            variant="outline"
                            disabled={onPick === undefined}
                            onClick={() => onPick?.(option)}
                          >
                            {option}
                          </Button>
                        ))}
                      </div>
                    </li>
                  ) : null}
                </Fragment>
              );
            case "task":
              return (
                <li key={row.id} className={cn("flex items-end gap-2", row.firstInGroup && "mt-2")}>
                  <BotSlot first={row.firstInGroup} />
                  <GoatBotTaskChip card={row.card} />
                </li>
              );
          }
        })}
        {replying ? (
          <li className={cn("flex items-end gap-2", rows.at(-1)?.kind === "user" && "mt-2")}>
            <BotSlot first={rows.at(-1)?.kind === "user"} />
            <div
              role="status"
              aria-label="GOAT Bot is replying"
              className="flex h-9 items-center gap-1 rounded-2xl bg-secondary px-3.5"
            >
              {TYPING_DOT_DELAYS.map((delay) => (
                <span
                  key={delay}
                  aria-hidden
                  className="size-1.5 animate-typing-wave rounded-full bg-muted-foreground motion-reduce:animate-none"
                  style={{ animationDelay: delay }}
                />
              ))}
            </div>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

/** True from when GOAT Bot starts reading until its reply lands or the limit passes. */
function useReplying(since: string | null): boolean {
  const startedMs = since === null ? Number.NaN : Date.parse(since);
  const [expiredFor, setExpiredFor] = useState<string | null>(null);
  useEffect(() => {
    if (since === null || Number.isNaN(startedMs)) return;
    const remaining = Math.max(0, startedMs + REPLYING_LIMIT_MS - Date.now());
    const timer = setTimeout(() => setExpiredFor(since), remaining);
    return () => clearTimeout(timer);
  }, [since, startedMs]);
  return since !== null && !Number.isNaN(startedMs) && expiredFor !== since;
}

function BotSlot({ first }: { readonly first: boolean }) {
  return first ? <GoatBotAvatar size="md" /> : <span aria-hidden className="w-7 shrink-0" />;
}

function DeliveryMark({
  delivery,
  time,
  onRetry,
}: {
  readonly delivery: GoatBotDelivery;
  readonly time: string;
  readonly onRetry: (clientKey: string) => void;
}) {
  switch (delivery.state) {
    case "sending":
      return <span className="shrink-0 pb-0.5 text-xs text-muted-foreground">Sending…</span>;
    case "failed":
      return (
        <span className="flex shrink-0 items-center gap-1 pb-0.5 text-xs text-destructive-foreground">
          {delivery.rejectionReason ?? "Not sent"}
          {delivery.rejectionReason === undefined ? (
            <Button size="xs" variant="ghost" onClick={() => onRetry(delivery.clientKey)}>
              Retry
            </Button>
          ) : null}
        </span>
      );
    case "read":
      return (
        <span className="flex shrink-0 flex-col items-end pb-0.5 text-xs text-muted-foreground">
          <span>Read</span>
          <span>{time}</span>
        </span>
      );
    case "sent":
      return <span className="shrink-0 pb-0.5 text-xs text-muted-foreground">Sent</span>;
  }
}

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

function formatGoatBotDay(iso: string, nowMs: number = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const startOf = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(new Date(nowMs)) - startOf(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return dayFormatter.format(date);
}
