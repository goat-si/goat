import type {
  GoatBotCardTarget,
  GoatBotCardTone,
  GoatBotTaskCard,
} from "@goat/client-runtime/goatBot";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  MessageCircleQuestionIcon,
} from "~/components/solar";
import { useMemo } from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { formatShortTimestamp } from "~/timestampFormat";
import { cn } from "~/lib/utils";
import { useEnvironmentShellsBootstrapped, useThreadShell } from "~/state/entities";
import { useConnectedEnvironmentIds } from "~/state/environments";

import { Button } from "../ui/button";

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
export function GoatBotTaskChip({ card }: { readonly card: GoatBotTaskCard }) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const Icon = TONE_ICON[card.tone];
  return (
    <div className="flex w-72 max-w-full flex-col gap-1.5 rounded-xl border border-border bg-card p-3 text-card-foreground">
      <div className={cn("flex items-center gap-1.5 text-xs font-medium", TONE_TEXT[card.tone])}>
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{card.statusLabel}</span>
        {card.attentionLabel ? (
          <span className="ml-auto shrink-0 text-warning-foreground">{card.attentionLabel}</span>
        ) : null}
      </div>
      <div className="text-sm font-medium break-words">{card.title}</div>
      {card.sourceLabel ? (
        <div className="truncate text-xs text-muted-foreground">{card.sourceLabel}</div>
      ) : null}
      {card.summary ? (
        <p className="line-clamp-2 text-xs text-muted-foreground">{card.summary}</p>
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
      <time dateTime={card.updatedAt} className="text-xs text-muted-foreground">
        Updated {formatShortTimestamp(card.updatedAt, timestampFormat)}
      </time>
      <div className="pt-0.5">
        <GoatBotTaskTarget target={card.target} />
      </div>
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
  const threadRef = useMemo(
    () => scopeThreadRef(target.environmentId, target.threadId),
    [target.environmentId, target.threadId],
  );
  const shell = useThreadShell(threadRef);
  const bootstrapped = useEnvironmentShellsBootstrapped(target.environmentId);
  const connected = useConnectedEnvironmentIds().includes(target.environmentId);
  if (!connected) {
    // Remote work names its machine, so point at where that machine is connected.
    if (target.host === undefined) return <DisabledTarget label="Can't reach the work computer" />;
    return (
      <Button size="xs" variant="outline" render={<Link to="/settings/connections" />}>
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
      variant="outline"
      render={
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: target.environmentId, threadId: target.threadId }}
        />
      }
    >
      Open thread
      <ArrowUpRightIcon />
    </Button>
  );
}

function DisabledTarget({ label }: { readonly label: string }) {
  return (
    <Button size="xs" variant="outline" disabled>
      {label}
    </Button>
  );
}
