import { use } from "react";

import { CloudRunCard } from "./CloudRunCard";
import { type TimelineRow, TimelineRowCtx } from "./timelineRowContext";
import { WorktreeSetupCard } from "./WorktreeSetupCard";

export function CloudRunTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "cloud-run" }> }) {
  const ctx = use(TimelineRowCtx);
  const retry = row.card.retry;
  const onRetryCloudRun = ctx.onRetryCloudRun;
  return (
    <CloudRunCard
      card={row.card}
      onRetry={retry && onRetryCloudRun ? () => onRetryCloudRun(retry.runId) : null}
    />
  );
}

export function WorktreeSetupTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "worktree-setup" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const terminalId = row.snapshot.setupScript?.terminalId ?? null;
  const openTerminal = ctx.onOpenWorktreeSetupTerminal;
  const onOpenTerminal = openTerminal && terminalId ? () => openTerminal(terminalId) : null;
  return (
    <WorktreeSetupCard
      snapshot={row.snapshot}
      embedded={row.embedded}
      onCancel={row.embedded ? null : ctx.onCancelWorktreeSetup}
      onWorkLocally={
        !row.embedded && row.snapshot.phase === "running" ? ctx.onWorktreeSetupWorkLocally : null
      }
      onOpenTerminal={onOpenTerminal}
    />
  );
}
