import type {
  GoatBotCardTarget,
  GoatBotCardTone,
  GoatBotTaskCard,
} from "@goat/client-runtime/goatBot";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  MessageCircleQuestionIcon,
} from "~/components/solar";

import { usePrimarySettings } from "~/hooks/useSettings";
import { formatShortTimestamp } from "~/timestampFormat";
import { cn } from "~/lib/utils";
import { useEnvironmentShellsBootstrapped, useThreadShell } from "~/state/entities";
import { useConnectedEnvironmentIds } from "~/state/environments";

import { Button } from "../ui/button";
import { GoatBotLinkedText } from "./GoatBotLinkedText";

const TONE_ICON = {
  neutral: CircleIcon,
  active: CircleDotIcon,
  attention: MessageCircleQuestionIcon,
  success: CircleCheckIcon,
  danger: CircleAlertIcon,
} satisfies Record<GoatBotCardTone, unknown>;

const TONE_TEXT = {
  neutral: "text-muted-foreground",
  active: "text-info-foreground",
  attention: "text-warning-foreground",
  success: "text-success-foreground",
  danger: "text-destructive-foreground",
} satisfies Record<GoatBotCardTone, string>;

/** One piece of work GOAT Bot started. Its details live in the worker's own thread. */
export function GoatBotTaskChip({
  card,
  tail,
}: {
  readonly card: GoatBotTaskCard;
  readonly tail: boolean;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const Icon = TONE_ICON[card.tone];
  return (
    <div
      className={cn(
        "relative w-72 max-w-full rounded-2xl bg-goat-bubble-in text-goat-bubble-in-foreground",
        tail && "goat-bubble-tail-in",
      )}
    >
      <div className="overflow-hidden rounded-2xl">
        <div className="flex items-center gap-1.5 px-3 pt-2.5 text-2xs leading-4 font-medium">
          <Icon className={cn("size-3.5 shrink-0", TONE_TEXT[card.tone])} />
          <span className="truncate">{card.statusLabel}</span>
          {card.attentionLabel ? (
            <span className="ml-auto shrink-0 text-warning-foreground">{card.attentionLabel}</span>
          ) : null}
        </div>
        <div className="space-y-1.5 px-3 pt-1.5 pb-2">
          <div className="goat-task-title font-semibold break-words">{card.title}</div>
          {card.summary ? (
            // A new summary measures afresh and starts collapsed.
            <GoatBotTaskSummary key={card.summary} summary={card.summary} />
          ) : null}
          {card.sourceLabel ? (
            <div className="truncate text-xs text-goat-bubble-in-foreground/65">
              {card.sourceLabel}
            </div>
          ) : null}
          {card.continuationLabel ? (
            <div className="truncate text-xs text-goat-bubble-in-foreground/65">
              {card.continuationLabel}
            </div>
          ) : null}
          {card.pullRequests.length > 0 ? (
            <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs">
              {card.pullRequests.map((pullRequest) => (
                <a
                  key={pullRequest.key}
                  href={pullRequest.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-info-foreground hover:underline"
                >
                  {pullRequest.label}
                </a>
              ))}
            </div>
          ) : null}
          {card.evidenceLabels && card.evidenceLabels.length > 0 ? (
            <ul aria-label="Verification" className="space-y-0.5 text-xs break-words">
              {card.evidenceLabels.map((label) => (
                <li key={label} className="text-goat-bubble-in-foreground/75">
                  {label}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-1 border-t border-black/10 px-3 py-1 text-xs text-muted-foreground dark:border-white/10">
          <time dateTime={card.updatedAt} className="shrink-0">
            Updated {formatShortTimestamp(card.updatedAt, timestampFormat)}
          </time>
          <GoatBotTaskTarget target={card.target} />
        </div>
      </div>
    </div>
  );
}

/** The card is the task's result, so a long summary opens in place instead of staying cut off. */
function GoatBotTaskSummary({ summary }: { readonly summary: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element !== null && !expanded) setClamped(element.scrollHeight > element.clientHeight);
  }, [expanded]);
  return (
    <div>
      <p
        ref={ref}
        className={cn(
          "goat-task-summary break-words whitespace-pre-wrap text-goat-bubble-in-foreground/80",
          !expanded && "line-clamp-4",
        )}
      >
        <GoatBotLinkedText text={summary} />
      </p>
      {clamped || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="text-xs font-medium text-info-foreground hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function GoatBotTaskTarget({ target }: { readonly target: GoatBotCardTarget }) {
  if (target.kind === "none") return <DisabledTarget label={target.label} />;
  return <GoatBotThreadTarget target={target} />;
}

function GoatBotThreadTarget({
  target,
}: {
  readonly target: Extract<GoatBotCardTarget, { kind: "thread" }>;
}) {
  const threadRef = scopeThreadRef(target.environmentId, target.threadId);
  const shell = useThreadShell(threadRef);
  const bootstrapped = useEnvironmentShellsBootstrapped(target.environmentId);
  const connected = useConnectedEnvironmentIds().includes(target.environmentId);
  if (!connected) {
    // Remote work names its machine, so point at where that machine is connected.
    if (target.host === undefined) return <DisabledTarget label="Can't reach the work computer" />;
    return (
      <Button size="xs" variant="ghost" render={<Link to="/settings/connections" />}>
        Connect {target.host} in Settings
        <ArrowUpRightIcon />
      </Button>
    );
  }
  if (bootstrapped && (shell === null || shell.deletedAt != null)) {
    return <DisabledTarget label="Work history not found" />;
  }
  if (!bootstrapped) return <DisabledTarget label="Loading work history…" />;
  return (
    <Button
      size="xs"
      variant="ghost"
      render={
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: target.environmentId, threadId: target.threadId }}
        />
      }
    >
      Open thread
      <ChevronRightIcon />
    </Button>
  );
}

function DisabledTarget({ label }: { readonly label: string }) {
  return (
    <Button size="xs" variant="ghost" disabled>
      {label}
    </Button>
  );
}
