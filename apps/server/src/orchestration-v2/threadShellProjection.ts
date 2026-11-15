import {
  pendingRuntimeRequestSummary,
  secretRequestAsPendingInput,
} from "./ProjectionPendingRequest.ts";
import {
  providerInstanceHistoryForShell,
  activeProviderGoalForShell,
} from "./ProjectionShellProvider.ts";
import * as RunNotification from "./ProjectionRunNotification.ts";
import { pendingGuestMessageCount } from "@goat/contracts";
import {
  latestRootProviderFailure,
  latestUnheldRun,
  threadErrorSummary,
  usageLimitRunPresentedAsLatest,
} from "@goat/shared/orchestrationV2ThreadError";
import { threadPullRequestsOf } from "../sourceControl/threadPullRequests.ts";
import type {
  OrchestrationV2PendingRuntimeRequestSummary,
  OrchestrationV2Run,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ShellThreadStatus,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@goat/contracts";
import {
  idleCompactionOf,
  orchestrationV2RunWorkStartedAt,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import { createOrchestrationV2TurnItemVisibility } from "@goat/shared/orchestrationV2Timeline";
import {
  activeNativeSubagents,
  deriveBlockedOnThreadWait,
  derivePendingBackgroundWork,
} from "@goat/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

export function activeLocalTurnItems(
  projection: OrchestrationV2ThreadProjection,
  selectedTurnItemIds?: ReadonlySet<string>,
): Array<OrchestrationV2ProjectedTurnItem> {
  const isVisible = createOrchestrationV2TurnItemVisibility({
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
  return projection.turnItems
    .filter((item) => selectedTurnItemIds === undefined || selectedTurnItemIds.has(String(item.id)))
    .filter(isVisible)
    .map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    }));
}

function localVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
  selectedTurnItemIds?: ReadonlySet<string>,
): Array<OrchestrationV2ProjectedTurnItem> {
  return activeLocalTurnItems(projection, selectedTurnItemIds);
}

function inheritedVisibleTurnItemsFromLocalItems(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): Array<Omit<OrchestrationV2ProjectedTurnItem, "position">> {
  return items.map((item) => ({
    visibility: "inherited" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  }));
}

export function withLocalVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
  selectedTurnItemIds?: ReadonlySet<string>,
): OrchestrationV2ThreadProjection {
  return {
    ...projection,
    visibleTurnItems: localVisibleTurnItems(projection, selectedTurnItemIds),
  };
}

function renumberVisibleTurnItems(
  rows: ReadonlyArray<Omit<OrchestrationV2ProjectedTurnItem, "position">>,
  offset = 0,
): Array<OrchestrationV2ProjectedTurnItem> {
  return rows.map((row, position) => ({ ...row, position: position + offset }));
}

export function makeForkMarkerTurnItem(input: {
  readonly targetProjection: Pick<OrchestrationV2ThreadProjection, "thread">;
  readonly sourceThreadId: ThreadId;
  readonly sourceRunId: NonNullable<OrchestrationV2TurnItem["runId"]>;
}): Extract<OrchestrationV2TurnItem, { type: "fork" }> {
  const createdAt = input.targetProjection.thread.createdAt;
  return {
    id: TurnItemId.make(`turn-item:fork:${input.targetProjection.thread.id}`),
    threadId: input.targetProjection.thread.id,
    runId: null,
    nodeId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: "Forked from conversation",
    startedAt: null,
    completedAt: createdAt,
    updatedAt: createdAt,
    type: "fork",
    source: { type: "run", threadId: input.sourceThreadId, runId: input.sourceRunId },
    targetThreadId: input.targetProjection.thread.id,
  };
}

export function isTurnItemAtOrBeforeRun(input: {
  readonly historyOrigin: OrchestrationV2ThreadProjection["thread"]["historyOrigin"];
  readonly itemRunId: OrchestrationV2TurnItem["runId"];
  readonly runOrdinalById: ReadonlyMap<NonNullable<OrchestrationV2TurnItem["runId"]>, number>;
  readonly sourceRunOrdinal: number;
}): boolean {
  if (input.itemRunId === null) {
    return input.historyOrigin === "v1_import";
  }
  const ordinal = input.runOrdinalById.get(input.itemRunId);
  return ordinal !== undefined && ordinal <= input.sourceRunOrdinal;
}

// Run ordinals enforce the fork cutoff; this keeps later rollbacks from hiding
// inherited history while retaining cancellation evidence for undelivered input.
export function createInheritedTurnItemVisibility(
  source: Parameters<typeof createOrchestrationV2TurnItemVisibility>[0],
) {
  const cancelledRunIds = new Set(
    source.attempts
      .filter((attempt) => attempt.status === "cancelled")
      .map((attempt) => attempt.runId),
  );
  return createOrchestrationV2TurnItemVisibility({
    ...source,
    runs: source.runs.flatMap((run) =>
      run.status !== "rolled_back"
        ? [run]
        : cancelledRunIds.has(run.id)
          ? [{ ...run, status: "cancelled" as const }]
          : [],
    ),
  });
}

// Rollback stamps completedAt; a fork made after the rewind never received that run.
function runRolledBackAt(run: Pick<OrchestrationV2Run, "status" | "completedAt">) {
  return run.status === "rolled_back" ? run.completedAt : null;
}

function isRolledBackBeforeFork(
  rolledBackAt: DateTime.Utc | null,
  forkCreatedAt: DateTime.Utc,
): boolean {
  return rolledBackAt !== null && DateTime.isLessThan(rolledBackAt, forkCreatedAt);
}

export function forkInheritedRunOrdinals(
  runs: ReadonlyArray<OrchestrationV2Run>,
  forkCreatedAt: DateTime.Utc,
): Map<RunId, number> {
  return new Map(
    runs
      .filter((run) => !isRolledBackBeforeFork(runRolledBackAt(run), forkCreatedAt))
      .map((run) => [run.id, run.ordinal]),
  );
}

function visibleTurnItemsThroughRun(input: {
  readonly sourceProjection: OrchestrationV2ThreadProjection;
  readonly sourceSelectedTurnItemIds?: ReadonlySet<string> | undefined;
  readonly sourceRunId: NonNullable<OrchestrationV2TurnItem["runId"]>;
  readonly forkCreatedAt: DateTime.Utc;
}): Array<Omit<OrchestrationV2ProjectedTurnItem, "position">> {
  const sourceRun = input.sourceProjection.runs.find((run) => run.id === input.sourceRunId);
  if (sourceRun === undefined) {
    return [];
  }

  const runOrdinalById = forkInheritedRunOrdinals(input.sourceProjection.runs, input.forkCreatedAt);
  const isVisible = createInheritedTurnItemVisibility({
    runs: input.sourceProjection.runs,
    attempts: input.sourceProjection.attempts,
    items: input.sourceProjection.turnItems,
  });
  const inheritedPrefix = input.sourceProjection.visibleTurnItems
    .filter(
      (row) => row.item.threadId !== input.sourceProjection.thread.id || row.item.type === "fork",
    )
    .map((row) => ({
      visibility: "inherited" as const,
      sourceThreadId: row.sourceThreadId,
      sourceItemId: row.sourceItemId,
      item: row.item,
    }));
  const localPrefix = inheritedVisibleTurnItemsFromLocalItems(
    input.sourceProjection.turnItems
      .filter(
        (item) =>
          input.sourceSelectedTurnItemIds === undefined ||
          input.sourceSelectedTurnItemIds.has(String(item.id)),
      )
      .filter(
        (item) =>
          isVisible(item) &&
          isTurnItemAtOrBeforeRun({
            historyOrigin: input.sourceProjection.thread.historyOrigin,
            itemRunId: item.runId,
            runOrdinalById,
            sourceRunOrdinal: sourceRun.ordinal,
          }),
      ),
  );

  return [...inheritedPrefix, ...localPrefix];
}

export function buildVisibleTurnItems(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly sourceProjection: OrchestrationV2ThreadProjection | null;
  readonly selectedTurnItemIds?: ReadonlySet<string> | undefined;
  readonly sourceSelectedTurnItemIds?: ReadonlySet<string> | undefined;
  readonly inheritedRowCount?: number;
}): Array<OrchestrationV2ProjectedTurnItem> {
  const forkedFrom = input.projection.thread.forkedFrom;
  if (
    forkedFrom?.type !== "run" ||
    (input.sourceProjection === null && input.inheritedRowCount === undefined)
  ) {
    return localVisibleTurnItems(input.projection, input.selectedTurnItemIds);
  }

  const inherited =
    input.sourceProjection === null
      ? []
      : visibleTurnItemsThroughRun({
          sourceProjection: input.sourceProjection,
          sourceSelectedTurnItemIds: input.sourceSelectedTurnItemIds,
          sourceRunId: forkedFrom.runId,
          forkCreatedAt: input.projection.thread.createdAt,
        });
  const markerItem = makeForkMarkerTurnItem({
    targetProjection: input.projection,
    sourceThreadId: forkedFrom.threadId,
    sourceRunId: forkedFrom.runId,
  });
  const local = activeLocalTurnItems(input.projection, input.selectedTurnItemIds).map((row) => ({
    visibility: "local" as const,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
    item: row.item,
  }));

  return renumberVisibleTurnItems(
    [
      ...inherited,
      {
        visibility: "synthetic",
        sourceThreadId: forkedFrom.threadId,
        sourceItemId: markerItem.id,
        item: markerItem,
      },
      ...local,
    ],
    input.inheritedRowCount ?? 0,
  );
}

export function threadShellFromProjection(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadShell {
  const providerSession =
    projection.providerSessions
      .filter((session) => session.providerInstanceId === projection.thread.providerInstanceId)
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      )[0] ?? null;
  // GOAT's own idle compactions stay out of the shell unless they fail, so thread lists,
  // notifications and the relay keep presenting the user's last turn.
  const runs = projection.runs.filter((run) => !isSilentRunForShell(run, projection));
  const latestRun =
    usageLimitRunPresentedAsLatest(
      runs,
      projection.turnItems,
      providerSession?.lastError ?? null,
    ) ?? latestUnheldRun(runs);
  const activeRun =
    runs
      .filter(isInterruptibleRunForShell)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  const activityRun =
    runs.filter(isActivityRunForShell).toSorted((left, right) => right.ordinal - left.ordinal)[0] ??
    null;
  const liveRunIds = new Set(runs.filter(isActivityRunForShell).map((run) => run.id));
  const pendingRuntimeRequests = projection.runtimeRequests
    .filter((request) => request.status === "pending")
    .toSorted((left, right) => {
      const byTime =
        Number(left.kind === "user_input") - Number(right.kind === "user_input") ||
        DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt);
      return byTime !== 0 ? byTime : left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
    });
  let pendingRuntimeRequest = pendingRuntimeRequestSummary(
    pendingRuntimeRequests.find(
      (request) => request.kind !== "auth_refresh" && request.kind !== "dynamic_tool_call",
    ) ??
      pendingRuntimeRequests[0] ??
      null,
  );
  if (pendingRuntimeRequest === null || pendingRuntimeRequest.kind === "user_input") {
    const waitingCard = secretRequestAsPendingInput(
      projection.turnItems
        .filter(
          (item) =>
            item.status === "waiting" &&
            (item.type === "human_handoff" ||
              (item.type === "secret_request" &&
                item.runId !== null &&
                liveRunIds.has(item.runId))),
        )
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.startedAt ?? right.updatedAt) -
              DateTime.toEpochMillis(left.startedAt ?? left.updatedAt) ||
            (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
        )[0] ?? null,
    );
    if (
      waitingCard !== null &&
      (pendingRuntimeRequest === null ||
        DateTime.toEpochMillis(waitingCard.createdAt) >=
          DateTime.toEpochMillis(pendingRuntimeRequest.createdAt))
    )
      pendingRuntimeRequest = waitingCard;
  }
  const userMessages = projection.messages
    .filter((message) => message.role === "user" && idleCompactionOf(message) === undefined)
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
  const latestUserMessage = userMessages[0] ?? null;
  const pendingBackgroundTasks = derivePendingBackgroundWork({
    latestRun,
    providerThreads: projection.providerThreads,
    turnItems: projection.turnItems,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    runs,
    pullRequests: projection.thread.pullRequests,
  });
  return {
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    id: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    providerInstanceId: projection.thread.providerInstanceId,
    modelSelection: projection.thread.modelSelection,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    pullRequests: threadPullRequestsOf(projection.thread),
    ...(projection.thread.launchedBy === undefined
      ? {}
      : { launchedBy: projection.thread.launchedBy }),
    ...(projection.thread.latestAnswerExcerpt === undefined
      ? {}
      : { latestAnswerExcerpt: projection.thread.latestAnswerExcerpt }),
    ...(projection.thread.externalLauncher === undefined
      ? {}
      : { externalLauncher: projection.thread.externalLauncher }),
    ...(projection.thread.historyArchive === undefined
      ? {}
      : { historyArchive: projection.thread.historyArchive }),
    ...(projection.thread.sideChatOf == null ? {} : { sideChatOf: projection.thread.sideChatOf }),
    ...(projection.thread.linkedPullRequest === undefined
      ? {}
      : { linkedPullRequest: projection.thread.linkedPullRequest }),
    ...(projection.thread.branchPullRequest === undefined
      ? {}
      : { branchPullRequest: projection.thread.branchPullRequest }),
    ...(projection.thread.activeOrderKey === undefined
      ? {}
      : { activeOrderKey: projection.thread.activeOrderKey }),
    lineage: projection.thread.lineage,
    forkedFrom: projection.thread.forkedFrom,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    ...(projection.thread.historyOrigin === undefined
      ? {}
      : { historyOrigin: projection.thread.historyOrigin }),
    latestRunId: latestRun?.id ?? null,
    ...(latestRun?.status === "starting" && latestRun.startHold !== undefined
      ? { latestRunStartHeld: true }
      : {}),
    latestRunRequestedAt: latestRun?.requestedAt ?? null,
    latestRunStartedAt: latestRun?.startedAt ?? null,
    latestRunCompletedAt: latestRun?.completedAt ?? null,
    ...(latestRun?.completionNotification === undefined
      ? {}
      : { latestRunCompletionNotification: latestRun.completionNotification }),
    notificationCompletedAt: projection.thread.notificationCompletedAt ?? null,
    ...(projection.thread.markedUnreadCompletionAt === undefined
      ? {}
      : { markedUnreadCompletionAt: projection.thread.markedUnreadCompletionAt }),
    latestRunStopRequested:
      latestRun != null &&
      projection.turnItems.some(
        (item) => item.runId === latestRun.id && item.type === "run_interrupt_request",
      ),
    ...(latestRun != null && isBackgroundWakeRunForShell(latestRun, projection)
      ? { latestRunBackgroundWake: true }
      : {}),
    activeRunId: activeRun?.id ?? null,
    blockedOnThreadWait: deriveBlockedOnThreadWait({ activeRun, turnItems: projection.turnItems }),
    activityRunStatus: activityRun?.status ?? null,
    activityRunStartedAt:
      activityRun === null ? null : orchestrationV2RunWorkStartedAt(activityRun),
    status: latestRun?.status ?? "idle",
    ...threadErrorSummary(
      latestRootProviderFailure(latestRun, projection.turnItems),
      providerSession?.lastError ?? null,
    ),
    pendingRuntimeRequest,
    pendingGuestMessageCount: pendingGuestMessageCount(projection.thread.guestShare),
    // Thread detail owns message bodies. Keeping them out of shell rows makes
    // initial hydration and streaming updates independent of transcript size.
    latestVisibleMessage: null,
    latestUserMessageAt: latestUserMessage?.updatedAt ?? null,
    latestUserAuthoredMessageAt:
      userMessages.find((message) => message.createdBy === "user")?.updatedAt ?? null,
    hasActionableProposedPlan: projection.plans.some(
      (plan) => plan.kind === "proposed_plan" && plan.status === "active",
    ),
    pendingBackgroundTasks: [...pendingBackgroundTasks],
    nativeSubagents: activeNativeSubagents({
      turnItems: projection.turnItems,
      runs: projection.runs,
    }),
    providerInstanceHistory: providerInstanceHistoryForShell({
      threadId: projection.thread.id,
      providerThreads: projection.providerThreads,
    }),
    goal: activeProviderGoalForShell(
      projection.providerThreads,
      projection.thread.activeProviderThreadId,
    ),
    itemCount: activeLocalTurnItems(projection).length,
    visibleItemCount: projection.visibleTurnItems.length,
    createdAt: projection.thread.createdAt,
    updatedAt: projection.thread.updatedAt,
    archivedAt: projection.thread.archivedAt,
    settledOverride: projection.thread.settledOverride,
    settledAt: projection.thread.settledAt,
    unsettledAt: projection.thread.unsettledAt ?? null,
    snoozedUntil: projection.thread.snoozedUntil ?? null,
    snoozedAt: projection.thread.snoozedAt ?? null,
    pinnedAt: projection.thread.pinnedAt ?? null,

    autoSettleDisabledAt: projection.thread.autoSettleDisabledAt ?? null,
    pinOrderKey: projection.thread.pinOrderKey ?? null,
    lastVisitedAt: projection.thread.lastVisitedAt,
    opens: projection.thread.opens ?? null,
    titleRegeneration: projection.thread.titleRegeneration ?? null,
    limitRecovery: projection.thread.limitRecovery ?? null,
    deletedAt: projection.thread.deletedAt,
  };
}

function isSilentRunForShell(
  run: OrchestrationV2ThreadProjection["runs"][number],
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems">,
): boolean {
  return run.status !== "failed" && isIdleCompactionRun(run, projection);
}

export function isIdleCompactionRun(
  run: OrchestrationV2ThreadProjection["runs"][number],
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems">,
): boolean {
  return (
    projection.messages.some(
      (message) => message.id === run.userMessageId && idleCompactionOf(message) !== undefined,
    ) &&
    !projection.turnItems.some(
      (item) => item.runId === run.id && item.type === "compaction" && item.status === "failed",
    )
  );
}

export function notificationCursorContext(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages" | "turnItems">,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
): RunNotification.NotificationCursorContext {
  const idleRunIds = new Set<RunId>();
  for (const event of events) {
    if (event.type !== "run.created" && event.type !== "run.updated") continue;
    const run = projection.runs.find((candidate) => candidate.id === event.payload.id);
    if (run !== undefined && isIdleCompactionRun(run, projection)) idleRunIds.add(run.id);
  }
  const failedIds = RunNotification.failedCompactionRunIds(events);
  const failedCompactions = projection.runs.flatMap((run) =>
    failedIds.has(run.id) && run.completedAt !== null && run.completionNotification !== "silent"
      ? [{ threadId: run.threadId, completedAt: run.completedAt }]
      : [],
  );
  return { idleRunIds, failedCompactions };
}

const BACKGROUND_WAKE_SOURCE_KINDS = new Set(["background_task", "command", "monitor"]);

function isBackgroundWakeRunForShell(
  run: OrchestrationV2ThreadProjection["runs"][number],
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
): boolean {
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  return (
    message?.delegatedCompletion === undefined &&
    // Only progress wakes; a terminal one ("Command … finished") is the work reporting its end.
    message?.notification?.outcome === "updated" &&
    BACKGROUND_WAKE_SOURCE_KINDS.has(message.notification.source.kind) &&
    // A follow-up the user steered into the wake makes the run theirs.
    !projection.messages.some(
      (candidate) => candidate.runId === run.id && candidate.createdBy === "user",
    )
  );
}

function isInterruptibleRunForShell(run: OrchestrationV2ThreadProjection["runs"][number]): boolean {
  return run.status === "preparing" || run.status === "starting" || run.status === "running";
}

type ShellActivityRunStatus = "preparing" | "running" | "starting" | "waiting";

export function isActivityRunForShell(
  run: OrchestrationV2ThreadProjection["runs"][number],
): run is OrchestrationV2ThreadProjection["runs"][number] & {
  readonly status: ShellActivityRunStatus;
} {
  return isInterruptibleRunForShell(run) || run.status === "waiting";
}

export type ShellRun = {
  readonly ordinal: number;
  readonly rolledBackAt: DateTime.Utc | null;
};

export type ShellThreadState = {
  readonly thread: OrchestrationV2ThreadProjection["thread"];
  readonly latestRunId: RunId | null;
  readonly latestRunStatus: OrchestrationV2ShellThreadStatus;
  readonly latestRunRequestedAt: DateTime.Utc | null;
  readonly latestRunStartedAt: DateTime.Utc | null;
  readonly latestRunCompletedAt: DateTime.Utc | null;
  readonly latestRunCompletionNotification?: string | undefined;
  readonly latestRunStopRequested: boolean;
  readonly latestRunStartHeld: boolean;
  readonly latestRunBackgroundWake: boolean;
  readonly activeRunId: RunId | null;
  readonly blockedOnThreadWait: boolean;
  readonly activityRunStatus: ShellActivityRunStatus | null;
  readonly activityRunStartedAt: DateTime.Utc | null;
  readonly lastError: string | null;
  readonly lastErrorClass: OrchestrationV2ThreadShell["lastErrorClass"];
  readonly lastErrorCode: OrchestrationV2ThreadShell["lastErrorCode"];
  readonly usageLimitResetAt: OrchestrationV2ThreadShell["usageLimitResetAt"];
  readonly pendingRuntimeRequest: OrchestrationV2PendingRuntimeRequestSummary | null;
  readonly latestUserMessageAt: DateTime.Utc | null;
  readonly latestUserAuthoredMessageAt: DateTime.Utc | null;
  readonly hasActionableProposedPlan: boolean;
  readonly pendingBackgroundTasks: OrchestrationV2ThreadShell["pendingBackgroundTasks"];
  readonly nativeSubagents: OrchestrationV2ThreadShell["nativeSubagents"];
  readonly providerInstanceHistory: OrchestrationV2ThreadShell["providerInstanceHistory"];
  readonly goal: OrchestrationV2ThreadShell["goal"];
  readonly itemCount: number;
  readonly runlessItemCount: number;
  readonly updatedAt: OrchestrationV2ThreadProjection["updatedAt"];
  readonly runsById: ReadonlyMap<RunId, ShellRun>;
  readonly itemCountByRunId: ReadonlyMap<RunId, number>;
};

function itemCountThroughRun(input: {
  readonly state: ShellThreadState;
  readonly runId: RunId;
  readonly forkCreatedAt: DateTime.Utc;
}): number {
  const runOrdinal = input.state.runsById.get(input.runId)?.ordinal;
  if (runOrdinal === undefined) {
    return 0;
  }

  let count = input.state.thread.historyOrigin === "v1_import" ? input.state.runlessItemCount : 0;
  for (const [runId, itemCount] of input.state.itemCountByRunId) {
    const itemRun = input.state.runsById.get(runId);
    if (
      itemRun !== undefined &&
      itemRun.ordinal <= runOrdinal &&
      !isRolledBackBeforeFork(itemRun.rolledBackAt, input.forkCreatedAt)
    ) {
      count += itemCount;
    }
  }
  return count;
}

export function visibleItemCountForShell(input: {
  readonly threadId: ThreadId;
  readonly statesByThreadId: ReadonlyMap<ThreadId, ShellThreadState>;
  readonly seenThreadIds?: ReadonlySet<ThreadId>;
}): number {
  const state = input.statesByThreadId.get(input.threadId);
  if (state === undefined) {
    return 0;
  }

  const forkedFrom = state.thread.forkedFrom;
  if (forkedFrom?.type !== "run") {
    return state.itemCount;
  }

  const seenThreadIds = input.seenThreadIds ?? new Set<ThreadId>();
  if (seenThreadIds.has(state.thread.id)) {
    return state.itemCount;
  }

  const sourceState = input.statesByThreadId.get(forkedFrom.threadId);
  if (sourceState === undefined) {
    return state.itemCount;
  }

  const sourceForkedFrom = sourceState.thread.forkedFrom;
  const inheritedPrefixCount =
    sourceForkedFrom?.type === "run"
      ? visibleItemCountForShell({
          threadId: sourceState.thread.id,
          statesByThreadId: input.statesByThreadId,
          seenThreadIds: new Set([...seenThreadIds, state.thread.id]),
        }) - sourceState.itemCount
      : 0;

  return (
    inheritedPrefixCount +
    itemCountThroughRun({
      state: sourceState,
      runId: forkedFrom.runId,
      forkCreatedAt: state.thread.createdAt,
    }) +
    1 +
    state.itemCount
  );
}

export function shellFromState(input: {
  readonly state: ShellThreadState;
  readonly visibleItemCount: number;
}): OrchestrationV2ThreadShell {
  return {
    createdBy: input.state.thread.createdBy,
    creationSource: input.state.thread.creationSource,
    id: input.state.thread.id,
    projectId: input.state.thread.projectId,
    title: input.state.thread.title,
    providerInstanceId: input.state.thread.providerInstanceId,
    modelSelection: input.state.thread.modelSelection,
    runtimeMode: input.state.thread.runtimeMode,
    interactionMode: input.state.thread.interactionMode,
    branch: input.state.thread.branch,
    worktreePath: input.state.thread.worktreePath,
    pullRequests: threadPullRequestsOf(input.state.thread),
    ...(input.state.thread.launchedBy === undefined
      ? {}
      : { launchedBy: input.state.thread.launchedBy }),
    ...(input.state.thread.latestAnswerExcerpt === undefined
      ? {}
      : { latestAnswerExcerpt: input.state.thread.latestAnswerExcerpt }),
    ...(input.state.thread.externalLauncher === undefined
      ? {}
      : { externalLauncher: input.state.thread.externalLauncher }),
    ...(input.state.thread.historyArchive === undefined
      ? {}
      : { historyArchive: input.state.thread.historyArchive }),
    ...(input.state.thread.sideChatOf == null ? {} : { sideChatOf: input.state.thread.sideChatOf }),
    ...(input.state.thread.linkedPullRequest === undefined
      ? {}
      : { linkedPullRequest: input.state.thread.linkedPullRequest }),
    ...(input.state.thread.branchPullRequest === undefined
      ? {}
      : { branchPullRequest: input.state.thread.branchPullRequest }),
    ...(input.state.thread.activeOrderKey === undefined
      ? {}
      : { activeOrderKey: input.state.thread.activeOrderKey }),
    lineage: input.state.thread.lineage,
    forkedFrom: input.state.thread.forkedFrom,
    activeProviderThreadId: input.state.thread.activeProviderThreadId,
    ...(input.state.thread.historyOrigin === undefined
      ? {}
      : { historyOrigin: input.state.thread.historyOrigin }),
    latestRunId: input.state.latestRunId,
    latestRunRequestedAt: input.state.latestRunRequestedAt,
    latestRunStartedAt: input.state.latestRunStartedAt,
    latestRunCompletedAt: input.state.latestRunCompletedAt,
    ...(input.state.latestRunCompletionNotification === undefined
      ? {}
      : { latestRunCompletionNotification: input.state.latestRunCompletionNotification }),
    notificationCompletedAt: input.state.thread.notificationCompletedAt ?? null,
    ...(input.state.thread.markedUnreadCompletionAt === undefined
      ? {}
      : { markedUnreadCompletionAt: input.state.thread.markedUnreadCompletionAt }),
    latestRunStopRequested: input.state.latestRunStopRequested,
    ...(input.state.latestRunStartHeld ? { latestRunStartHeld: true } : {}),
    ...(input.state.latestRunBackgroundWake ? { latestRunBackgroundWake: true } : {}),
    activeRunId: input.state.activeRunId,
    blockedOnThreadWait: input.state.blockedOnThreadWait,
    activityRunStatus: input.state.activityRunStatus,
    activityRunStartedAt: input.state.activityRunStartedAt,
    status: input.state.latestRunStatus,
    lastError: input.state.lastError,
    lastErrorClass: input.state.lastErrorClass,
    lastErrorCode: input.state.lastErrorCode,
    usageLimitResetAt: input.state.usageLimitResetAt,
    pendingRuntimeRequest: input.state.pendingRuntimeRequest,
    pendingGuestMessageCount: pendingGuestMessageCount(input.state.thread.guestShare),
    latestVisibleMessage: null,
    latestUserMessageAt: input.state.latestUserMessageAt,
    latestUserAuthoredMessageAt: input.state.latestUserAuthoredMessageAt,
    hasActionableProposedPlan: input.state.hasActionableProposedPlan,
    pendingBackgroundTasks: input.state.pendingBackgroundTasks,
    nativeSubagents: input.state.nativeSubagents,
    providerInstanceHistory: input.state.providerInstanceHistory,
    goal: input.state.goal,
    itemCount: input.state.itemCount,
    visibleItemCount: input.visibleItemCount,
    createdAt: input.state.thread.createdAt,
    updatedAt: input.state.updatedAt,
    archivedAt: input.state.thread.archivedAt,
    settledOverride: input.state.thread.settledOverride,
    settledAt: input.state.thread.settledAt,
    unsettledAt: input.state.thread.unsettledAt ?? null,
    snoozedUntil: input.state.thread.snoozedUntil ?? null,
    snoozedAt: input.state.thread.snoozedAt ?? null,
    pinnedAt: input.state.thread.pinnedAt ?? null,

    autoSettleDisabledAt: input.state.thread.autoSettleDisabledAt ?? null,
    pinOrderKey: input.state.thread.pinOrderKey ?? null,
    lastVisitedAt: input.state.thread.lastVisitedAt,
    opens: input.state.thread.opens ?? null,
    titleRegeneration: input.state.thread.titleRegeneration ?? null,
    limitRecovery: input.state.thread.limitRecovery ?? null,
    deletedAt: input.state.thread.deletedAt,
  };
}
