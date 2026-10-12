import { CircleAlertIcon, MessageCircleQuestionIcon } from "lucide-react";
import { type UIEvent, useCallback, useLayoutEffect, useRef } from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatShortTimestamp } from "~/timestampFormat";

import { Button } from "../ui/button";
import { GoatBotAvatar } from "./GoatBotAvatar";
import { GoatBotTaskChip } from "./GoatBotTaskChip";
import type { GoatBotDelivery, GoatBotRow } from "./goatBotRows";

/** How close to the bottom still counts as "following" new messages. */
const FOLLOW_THRESHOLD_PX = 48;

export function GoatBotTimeline({
  rows,
  onRetry,
}: {
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly onRetry: (clientKey: string) => void;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    followingRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
  }, []);
  // New rows keep the view pinned to the latest message unless the reader scrolled up.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (rows.length === 0 || element === null || !followingRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [rows]);

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
                <li key={row.id} className={cn("flex items-end gap-2", row.firstInGroup && "mt-2")}>
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
      </ol>
    </div>
  );
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
