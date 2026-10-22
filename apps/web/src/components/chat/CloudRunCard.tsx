import type {
  CloudRunCard as CloudRunCardModel,
  CloudRunStage,
} from "@goat/client-runtime/state/cloud-task";
import { formatDuration } from "@goat/shared/orchestrationTiming";
import { ExternalLinkIcon, GitPullRequestArrowIcon, RotateCcwIcon } from "~/components/solar";
import { ChevronDown, ChevronRight } from "~/components/solar/nodes";
import { useState } from "react";

import { MorphIcon } from "~/components/MorphIcon";
import { Button } from "~/components/ui/button";
import { MiddleTruncate } from "~/components/ui/middle-truncate";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";
import { WorkLogRow } from "./WorkLog";
import { ShimmerOverlay, StageIcon, stageRowClassName, useNowWhile } from "./WorktreeSetupCard";

function elapsedMs(startedAt: string | null, endedAt: string | null, nowMs: number) {
  if (startedAt === null) return null;
  const start = Date.parse(startedAt);
  const end = endedAt === null ? nowMs : Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function StageRow({ stage, nowMs }: { stage: CloudRunStage; nowMs: number }) {
  const running = stage.status === "running";
  const elapsed =
    stage.status === "pending" || stage.status === "skipped"
      ? null
      : elapsedMs(stage.startedAt, stage.endedAt, nowMs);
  return (
    <WorkLogRow
      data-cloud-run-stage={stage.id}
      data-cloud-run-status={stage.status}
      icon={
        <span className={cn("text-icon-muted", stage.status === "pending" && "opacity-40")}>
          <StageIcon status={stage.status} />
        </span>
      }
      label={
        <span
          ref={running ? observeVisibleAnimation : undefined}
          className={cn("relative block truncate", stageRowClassName(stage.status))}
        >
          {stage.label}
          {running ? <ShimmerOverlay>{stage.label}</ShimmerOverlay> : null}
        </span>
      }
      trailing={
        <>
          {stage.detail ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{stage.detail}</span>
          ) : null}
          {elapsed !== null ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {formatDuration(elapsed)}
            </span>
          ) : null}
        </>
      }
    />
  );
}

function Details({ card }: { card: CloudRunCardModel }) {
  const rows: Array<readonly [string, string, boolean]> = [];
  if (card.source) {
    rows.push(["Repository", card.source.repository, true]);
    rows.push(["Started from", card.source.branch, true]);
    if (card.source.sha) rows.push(["Commit", card.source.sha.slice(0, 12), true]);
  }
  if (card.branch) rows.push(["Result branch", card.branch, true]);
  if (card.localChangesNotice) rows.push(["Local changes", card.localChangesNotice, false]);
  return (
    <div className="mt-1 mb-1.5 ml-8 text-xs text-muted-foreground">
      {rows.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {rows.map(([term, value, mono]) => (
            <div key={term} className="contents">
              <dt className="text-foreground/80">{term}</dt>
              <dd className={cn("min-w-0", mono && "font-mono")}>
                {mono ? <MiddleTruncate value={value} className="flex" /> : value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="mt-1">
        Files and the terminal here show your local checkout, not the cloud changes.
      </p>
    </div>
  );
}

function LinkButton({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: string;
}) {
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      render={<a href={href} target="_blank" rel="noopener noreferrer" />}
    >
      {icon}
      {children}
    </Button>
  );
}

/** A cloud run's launch, live stage and result in the shape of the worktree setup card. */
export function CloudRunCard({
  card,
  onRetry,
}: {
  card: CloudRunCardModel;
  onRetry: (() => void) | null;
}) {
  const running = card.phase === "running";
  const nowMs = useNowWhile(running);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const total = running ? null : elapsedMs(card.startedAt, card.endedAt, nowMs);
  const failed = card.phase === "failed" || card.phase === "unknown";
  // A finished run that needs nothing from the user folds to one line; a failure keeps
  // its stages so the user sees where it stopped.
  const collapsed = card.phase === "succeeded" || card.phase === "cancelled";
  const tone = failed ? "text-destructive-foreground" : "text-muted-foreground";
  return (
    <section aria-label={card.provider + " run"} data-cloud-run-phase={card.phase}>
      {collapsed ? (
        <WorkLogRow
          data-cloud-run-stage="summary"
          data-cloud-run-status={card.phase === "succeeded" ? "done" : "skipped"}
          icon={
            <span className="text-icon-muted">
              <StageIcon status={card.phase === "succeeded" ? "done" : "skipped"} />
            </span>
          }
          label={<span className="block truncate text-secondary-label">{card.title}</span>}
          trailing={
            total !== null ? (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatDuration(total)}
              </span>
            ) : null
          }
        />
      ) : (
        <>
          {!running ? (
            <div className="border-b border-border/60 pb-2 pt-1">
              <div
                role="status"
                className={cn(
                  "flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed tabular-nums",
                  tone,
                )}
              >
                <span className="min-w-0 truncate">{card.title}</span>
                {total !== null ? (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {formatDuration(total)}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className={running ? undefined : "pt-1.5"}>
            {card.stages.map((stage) => (
              <StageRow key={stage.id} stage={stage} nowMs={nowMs} />
            ))}
          </div>
        </>
      )}
      {card.message ? (
        <p className="mt-1 ml-8 text-xs whitespace-pre-wrap break-words text-muted-foreground">
          {card.message}
        </p>
      ) : null}
      <div className="mt-0.5 ml-[calc(--spacing(6)+2px-(--spacing(2)-1px))] flex flex-wrap items-center gap-0.5">
        {onRetry ? (
          <Button type="button" size="xs" variant="ghost-muted" onClick={onRetry}>
            <RotateCcwIcon aria-hidden />
            Retry
          </Button>
        ) : null}
        {card.prUrl ? (
          <LinkButton href={card.prUrl} icon={<GitPullRequestArrowIcon aria-hidden />}>
            Open pull request
          </LinkButton>
        ) : null}
        {card.taskUrl ? (
          <LinkButton href={card.taskUrl} icon={<ExternalLinkIcon aria-hidden />}>
            {"Open in " + card.provider}
          </LinkButton>
        ) : null}
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <MorphIcon aria-hidden icon={detailsOpen ? ChevronDown : ChevronRight} />
          Details
        </Button>
      </div>
      {detailsOpen ? <Details card={card} /> : null}
    </section>
  );
}
