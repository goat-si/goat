import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { RocketIcon, SendIcon } from "~/components/solar";
import { use, useState } from "react";

import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { TimelineRowCtx } from "./timelineRowContext";
import type { TurnThreadTarget } from "./turnThreadTargets";

const VISIBLE_CARDS = 3;

type CardStatus = "working" | "waiting" | "done" | "failed" | "idle";

const STATUS: Record<CardStatus, { readonly label: string; readonly dot: string }> = {
  working: { label: "Working", dot: "bg-info" },
  waiting: { label: "Waiting", dot: "bg-amber-500 dark:bg-amber-300/90" },
  done: { label: "Done", dot: "bg-emerald-500 dark:bg-emerald-300/90" },
  failed: { label: "Failed", dot: "bg-red-500 dark:bg-red-300/90" },
  idle: { label: "Not started", dot: "bg-muted-foreground/50" },
};

function cardStatus(shell: EnvironmentThreadShell): CardStatus {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return "waiting";
  const runtime = shell.runtime?.status;
  if (
    runtime === "preparing" ||
    runtime === "starting" ||
    runtime === "running" ||
    runtime === "waiting" ||
    runtime === "queued"
  )
    return "working";
  const run = shell.latestRun?.status;
  if (run === "failed" || run === "interrupted" || run === "cancelled") return "failed";
  return run === undefined ? "idle" : "done";
}

/** The threads a turn started or messaged, as cards after its answer. */
export function TurnThreadCardsRow({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "thread-cards" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? row.targets : row.targets.slice(0, VISIBLE_CARDS);
  const hidden = row.targets.length - shown.length;
  return (
    <div className="chat-content-lane flex flex-col gap-1.5" data-turn-thread-cards="">
      {shown.map((target) => (
        <TurnThreadCard
          key={`${target.host ?? ""}:${target.threadId}`}
          target={target}
          environmentId={ctx.activeThreadEnvironmentId}
          onOpen={ctx.onOpenThread}
        />
      ))}
      {hidden > 0 ? (
        <div>
          <Button size="xs" variant="ghost" onClick={() => setShowAll(true)}>
            +{hidden} more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function TurnThreadCard(props: {
  readonly target: TurnThreadTarget;
  readonly environmentId: EnvironmentId;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const { target } = props;
  // A thread on another machine has no proven connection here, so it is named but not opened.
  const shell = useThreadShell(
    target.host === null ? scopeThreadRef(props.environmentId, target.threadId as ThreadId) : null,
  );
  const title = shell?.title.trim() || target.title || "Another thread";
  const openable = shell !== null && shell.deletedAt === null;
  const status = shell === null ? null : cardStatus(shell);
  const Icon = target.via === "launch" ? RocketIcon : SendIcon;
  const detail =
    target.host !== null
      ? `On ${target.host} · open it from that machine's GOAT`
      : shell === null
        ? "Not available in this app"
        : shell.deletedAt !== null
          ? "Deleted"
          : target.via === "launch"
            ? "Started in this turn"
            : "Messaged in this turn";
  const content = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
        <Icon aria-hidden className="size-4 text-secondary-label" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      {status !== null ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className={cn("size-1.5 rounded-full", STATUS[status].dot)} />
          {STATUS[status].label}
        </span>
      ) : null}
    </>
  );
  const className =
    "flex w-full min-w-0 items-center gap-3 rounded-lg border border-border/60 px-3 py-2 text-left";
  return openable ? (
    <button
      type="button"
      aria-label={`Open ${title}${status === null ? "" : `, ${STATUS[status].label}`}`}
      onClick={() => props.onOpen(target.threadId as ThreadId)}
      className={cn(
        className,
        "cursor-pointer hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring",
      )}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}
