// GOAT 2 seam (lane F, devlog 070 wp6): a GOAT 2 thread drawn with v1's own timeline. GOAT 2 log lines become v1 turn
// items (projectThread.ts); v1's session-logic and MessagesTimeline.logic turn them into rows; the lifted row
// components (WorkLogBlock, WorkGroupSection, WorkingTimelineRow, ThinkingTimelineRow, LiveWorkEntryTimelineRow,
// WorkGroupToggleTimelineRow, TurnFoldLabel) draw them inside v1's row contexts.
//
// Until v1 MessagesTimeline.tsx is lifted (wp7), this file carries its row switch for the work-log rows
// (TimelineRowContent and TurnFoldTimelineRow, copied from v1 MessagesTimeline.tsx @916b5cc with the same markup and
// classes; the deferred-work skeleton is left out because GOAT 2 replays every item). Message rows go back to GOAT 2
// through renderMessage. Callbacks for features GOAT 2 rows never produce (checkpoints, artifacts, attachments, pull
// requests, worktrees, cloud runs) are no-ops; optional ones (diff, fork, shell, app messages) stay undefined so v1
// hides their actions. A row kind GOAT 2 cannot produce yet is logged and marked, never silently dropped.
import { use, useMemo, useRef, useState, type ReactNode } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { RunId, ThreadId, type OrchestrationV2RunStatus } from "@goat/contracts";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../../session-logic.ts";
import { deriveMessagesTimelineRows, type TimelineLatestRun } from "../../../components/chat/MessagesTimeline.logic.ts";
import {
  TimelineRowActivityCtx,
  TimelineRowCtx,
  type TimelineRow,
  type TimelineRowActivityState,
  type TimelineRowSharedState,
  type WorkGroupViewState,
} from "../../../components/chat/timelineRowContext.ts";
import { WorkLogBlock } from "../../../components/chat/WorkLog.tsx";
import { TurnFoldLabel } from "../../../components/chat/TurnFoldLabel.tsx";
import {
  LiveWorkEntryTimelineRow,
  ThinkingTimelineRow,
  WorkGroupSection,
  WorkGroupToggleTimelineRow,
  WorkingTimelineRow,
} from "../../../components/chat/TimelineWorkGroupRows.tsx";
import { TimelineRowTimestamp } from "../../../components/chat/TimelineRowParts.tsx";
import { ChevronDownIcon, ChevronRightIcon } from "../../../components/solar/index.tsx";
import { cn } from "../../../lib/utils.ts";
import { GOAT2_ENVIRONMENT_ID } from "../environment.ts";
import { projectGoat2Thread, type Goat2RunSummary, type Goat2ThreadInput } from "./projectThread.ts";

export interface V1TimelineMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string;
}

export interface V1ThreadTimelineProps extends Goat2ThreadInput {
  readonly renderMessage: (message: V1TimelineMessage) => ReactNode;
  readonly onOpenThread: (threadId: string) => void;
}

const RUN_STATUS: Record<string, OrchestrationV2RunStatus> = {
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
  // The host lost track of the run (e.g. across a restart): v1 shows that as an interruption.
  unknown: "interrupted",
};

function latestRunOf(runs: ReadonlyArray<Goat2RunSummary>): TimelineLatestRun | null {
  const run = runs.at(-1);
  if (!run) return null;
  return {
    runId: RunId.make(run.runId),
    status: run.finishedAt === null ? "running" : (RUN_STATUS[run.outcome ?? "unknown"] ?? "interrupted"),
    startedAt: run.startedAt,
    completedAt: run.finishedAt,
  };
}

const noop = () => {};
const reportedKinds = new Set<string>();

export function V1ThreadTimeline(props: V1ThreadTimelineProps) {
  const { threadId, lines, streaming, streamKinds, renderMessage, onOpenThread } = props;
  const listRef = useRef<LegendListRef | null>(null);
  const [expandedRunIds, setExpandedRunIds] = useState<ReadonlySet<RunId>>(() => new Set());
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(() => new Set());
  const [workGroupViewState] = useState<WorkGroupViewState>(() => ({ scrollPositions: new Map(), expandedEntries: new Set() }));
  const projected = useMemo(
    () => projectGoat2Thread({ threadId, lines, streaming, ...(streamKinds ? { streamKinds } : {}) }),
    [threadId, lines, streaming, streamKinds],
  );
  if (projected.undecodable.length > 0) console.error("v1 timeline: items v1 cannot decode", projected.undecodable);
  const latestRun = latestRunOf(projected.runs);
  const isWorking = projected.activeRunId !== null;
  const rows = useMemo(() => {
    const entries = deriveTimelineEntriesFromVisibleTurnItems({ visibleTurnItems: projected.visibleTurnItems, optimisticMessages: [] });
    return deriveMessagesTimelineRows({
      timelineEntries: entries,
      latestRun,
      runningRunId: projected.activeRunId === null ? null : RunId.make(projected.activeRunId),
      expandedRunIds: expandedRunIds as Set<RunId>,
      expandedWorkGroupIds: expandedWorkGroupIds as Set<string>,
      isWorking,
      activeTurnStartedAt: projected.activeRunStartedAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
  }, [projected, latestRun?.runId, latestRun?.status, isWorking, expandedRunIds, expandedWorkGroupIds]);

  const toggle = <T,>(set: (f: (s: ReadonlySet<T>) => ReadonlySet<T>) => void, id: T) =>
    set((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const threadRef = scopeThreadRef(GOAT2_ENVIRONMENT_ID, ThreadId.make(threadId));
  const shared: TimelineRowSharedState = {
    citationRequest: null,
    listRef,
    timestampFormat: "locale",
    routeThreadKey: threadId,
    threadRef,
    markdownCwd: undefined,
    resolvedTheme: "light",
    workspaceRoot: undefined,
    skills: [],
    runs: [],
    activeThreadEnvironmentId: GOAT2_ENVIRONMENT_ID,
    onRevertToTurnCount: noop, // no checkpoints in GOAT 2 (supportsConversationRollback: false)
    onUseArtifactTemplate: noop, // no artifact templates
    onSendAppMessage: undefined,
    onAppFullscreenChange: noop, // no MCP apps
    onRunShellCommand: undefined,
    findActive: false,
    onImageExpand: noop, // no GOAT 2 asset route, so no images to expand
    onOpenTurnDiff: undefined,
    renderHtmlRender: undefined,
    turnItemSource: undefined,
    onOpenThread: (id) => onOpenThread(id),
    workflowOpening: null,
    onForkFromRun: undefined,
    onRollbackCheckpoint: noop, // no checkpoints
    onToggleTurnFold: (runId) => toggle(setExpandedRunIds, runId),
    onToggleAttemptFold: noop, // GOAT 2 runs have one attempt
    onFileOpen: noop, // no attachments yet
    onFileDownload: noop,
    openPullRequest: noop, // no pull request links
    onToggleWorkGroup: (groupId) => toggle(setExpandedWorkGroupIds, groupId),
    onToggleWorkEntry: noop, // v1 keeps the scroll position here; GOAT 2's column scrolls natively
    onCancelWorktreeSetup: null,
    onRetryCloudRun: null,
    retryableWorkspacePreparationRunIds: new Set(),
    onRetryWorkspacePreparation: null,
    onWorktreeSetupWorkLocally: null,
    onOpenWorktreeSetupTerminal: null,
    workGroupViewState,
  };
  const activity: TimelineRowActivityState = {
    isWorking,
    isCompacting: false,
    isRevertingCheckpoint: false,
    activeTurnInProgress: isWorking,
    awaitingUser: false,
    isPreparingWorktree: false,
    providerStartingLabel: null,
    latestRunId: latestRun?.runId ?? null,
    liveAnswerPreview: null,
    backgroundWorktreeSetup: null,
  };
  return (
    <TimelineRowCtx value={shared}>
      <TimelineRowActivityCtx value={activity}>
        {rows.map((row) => <TimelineRowContent key={row.id} row={row} renderMessage={renderMessage} />)}
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
}

const WORK_LOG_KINDS = new Set(["work", "work-live", "work-toggle", "thinking"]);

// v1 MessagesTimeline.tsx TimelineRowContent @916b5cc, the work-log and fold branches (wp7 lifts the whole file).
function TimelineRowContent({ row, renderMessage }: { row: TimelineRow; renderMessage: V1ThreadTimelineProps["renderMessage"] }) {
  const isExpandedToolGroup = row.kind === "work" && row.isExpandedToolGroup;
  const isWorkLogRow = WORK_LOG_KINDS.has(row.kind);
  const isExpandedToolGroupHeader =
    (row.kind === "work-toggle" || row.kind === "work-live" || row.kind === "thinking") && row.expanded === true;
  if (row.kind === "message") {
    return (
      <div data-timeline-row-id={row.id} data-timeline-row-kind={row.kind} data-message-role={row.message.role}>
        {renderMessage({ id: row.message.id, role: row.message.role, text: row.message.text, streaming: row.message.streaming, createdAt: row.message.createdAt })}
      </div>
    );
  }
  if (!isWorkLogRow && row.kind !== "turn-fold" && row.kind !== "working") {
    if (!reportedKinds.has(row.kind)) {
      reportedKinds.add(row.kind);
      console.error(`v1 timeline: row kind "${row.kind}" is not drawn in GOAT 2 yet (wp7)`);
    }
    return <div data-timeline-row-id={row.id} data-timeline-row-kind={row.kind} data-v1-row-not-drawn="" />;
  }
  return (
    <div
      className={cn(isWorkLogRow ? undefined : "pb-1.5")}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
    >
      {isWorkLogRow ? (
        <WorkLogBlock
          continues={"continuesWorkLog" in row ? row.continuesWorkLog : undefined}
          layout={isExpandedToolGroup ? "group-content" : isExpandedToolGroupHeader ? "group-header" : "standalone"}
        >
          {row.kind === "work" ? (
            <WorkGroupSection
              anchorKey={row.id}
              groupedEntries={row.groupedEntries}
              isExpandedToolGroup={row.isExpandedToolGroup}
              displayLabel={row.displayLabel}
            />
          ) : null}
          {row.kind === "work-live" ? <LiveWorkEntryTimelineRow row={row} /> : null}
          {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
          {row.kind === "thinking" ? <ThinkingTimelineRow row={row} /> : null}
        </WorkLogBlock>
      ) : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
    </div>
  );
}

// v1 MessagesTimeline.tsx TurnFoldTimelineRow @916b5cc, without the deferred-work loading state.
function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const Chevron = row.expanded ? ChevronDownIcon : ChevronRightIcon;
  const ctx = use(TimelineRowCtx);
  return (
    <div className="group/timeline-row border-b border-border/60 pb-2 pe-0.5 pt-1">
      <div className="relative flex items-center gap-1">
        <button
          type="button"
          aria-expanded={row.expanded}
          data-scroll-anchor-ignore
          onClick={() => ctx.onToggleTurnFold(row.runId)}
          className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-work-log text-secondary-label/85 tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <span>
            <TurnFoldLabel status={row.status} duration={row.duration} />
          </span>
          <Chevron className="size-3.5" />
        </button>
        <TimelineRowTimestamp createdAt={row.createdAt} timestampFormat={ctx.timestampFormat} className="ms-auto" />
      </div>
    </div>
  );
}
