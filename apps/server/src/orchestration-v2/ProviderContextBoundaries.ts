import {
  latestProviderTurnForAttempt,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ContextSourcePoint,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { cancelledBeforeStart } from "./RestartBackgroundNote.ts";

function latestStableRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | null {
  return (
    projection.runs
      .filter((run) => run.status === "completed" && run.checkpointId !== null)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null
  );
}

export function runForSourcePoint(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "checkpoints">,
  sourcePoint: Extract<
    OrchestrationV2Command,
    { readonly type: "thread.fork" | "thread.merge_back" }
  >["sourcePoint"],
): OrchestrationV2Run | null {
  switch (sourcePoint.type) {
    case "latest_stable":
      return latestStableRun(projection);
    case "run":
      return projection.runs.find((run) => run.id === sourcePoint.runId) ?? null;
    case "checkpoint": {
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.id === sourcePoint.checkpointId,
      );
      return checkpoint?.runId === null || checkpoint === undefined
        ? null
        : (projection.runs.find((run) => run.id === checkpoint.runId) ?? null);
    }
  }
}

export function providerThreadForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "providerThreads">,
  run: OrchestrationV2Run,
): OrchestrationV2ProviderThread | undefined {
  return run.providerThreadId === null
    ? undefined
    : projection.providerThreads.find((candidate) => candidate.id === run.providerThreadId);
}

export function providerTurnForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "providerTurns" | "attempts">,
  run: OrchestrationV2Run,
): OrchestrationV2ProviderTurn | undefined {
  if (run.activeAttemptId === null) {
    return undefined;
  }

  return (
    latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId) ??
    projection.providerTurns.find((turn) => {
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      return attempt?.providerTurnId === turn.id;
    })
  );
}

export function contextSourcePointForRun(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerThreads" | "providerTurns" | "attempts"
  >,
  run: OrchestrationV2Run,
): OrchestrationV2ContextSourcePoint {
  const providerThread = providerThreadForRun(projection, run);
  const providerTurn = providerTurnForRun(projection, run);
  return {
    threadId: projection.thread.id,
    runId: run.id,
    ...(run.checkpointId === null ? {} : { checkpointId: run.checkpointId }),
    ...(providerThread?.nativeThreadRef === null || providerThread?.nativeThreadRef === undefined
      ? {}
      : { providerThreadRef: providerThread.nativeThreadRef }),
    ...(providerTurn?.nativeTurnRef === null || providerTurn?.nativeTurnRef === undefined
      ? {}
      : { providerTurnRef: providerTurn.nativeTurnRef }),
  };
}

export function pendingForkTransferForThread(
  projection: Pick<OrchestrationV2ThreadProjection, "contextTransfers" | "thread">,
): OrchestrationV2ContextTransfer | undefined {
  return projection.contextTransfers.find(
    (transfer) =>
      transfer.type === "fork" &&
      transfer.targetThreadId === projection.thread.id &&
      transfer.status === "pending",
  );
}

export function pendingMergeBackTransfersForThread(
  projection: Pick<OrchestrationV2ThreadProjection, "contextTransfers" | "thread">,
): ReadonlyArray<OrchestrationV2ContextTransfer> {
  return projection.contextTransfers.filter(
    (transfer) =>
      transfer.type === "merge_back" &&
      transfer.targetThreadId === projection.thread.id &&
      transfer.status === "pending",
  );
}

export function latestContextTransfer(
  transfers: ReadonlyArray<OrchestrationV2ContextTransfer>,
): OrchestrationV2ContextTransfer | undefined {
  return transfers.reduce<OrchestrationV2ContextTransfer | undefined>((latest, transfer) => {
    if (latest === undefined) {
      return transfer;
    }
    return DateTime.toEpochMillis(transfer.updatedAt) >= DateTime.toEpochMillis(latest.updatedAt)
      ? transfer
      : latest;
  }, undefined);
}

export function visibleDeltaRunOrdinals(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ContextHandoff["coveredRunOrdinals"] {
  const ordinals = items.flatMap((item) => {
    if (item.runId === null) {
      return [];
    }
    const run = projection.runs.find((candidate) => candidate.id === item.runId);
    return run === undefined ? [] : [run.ordinal];
  });
  if (ordinals.length === 0) {
    return { from: 1, to: 1 };
  }
  return {
    from: Math.min(...ordinals),
    to: Math.max(...ordinals),
  };
}

export function shouldPrepareLegacyImportHandoff(input: {
  readonly hasCompletedRun: boolean;
  readonly historyOrigin: OrchestrationV2AppThread["historyOrigin"];
  readonly legacyImportItemCount: number;
}): boolean {
  return (
    input.historyOrigin === "v1_import" && !input.hasCompletedRun && input.legacyImportItemCount > 0
  );
}

export function appendContextHandoffId(
  handoffIds: OrchestrationV2ProviderThread["handoffIds"],
  handoffId: OrchestrationV2ContextHandoff["id"] | null,
): OrchestrationV2ProviderThread["handoffIds"] {
  return handoffId === null ? handoffIds : Array.from(new Set([...handoffIds, handoffId]));
}

/** Ordinal of the latest started fresh-context run. Runs before it never reach a provider again. */
export function contextBoundaryOrdinal(
  runs: ReadonlyArray<
    Pick<
      OrchestrationV2Run,
      "ordinal" | "freshContext" | "status" | "startedAt" | "restartContinuationOfRunId"
    >
  >,
): number {
  let boundary = 0;
  for (const run of runs) {
    if (
      run.freshContext === true &&
      run.status !== "queued" &&
      !cancelledBeforeStart(run) &&
      run.ordinal > boundary
    ) {
      boundary = run.ordinal;
    }
  }
  return boundary;
}

/** Threads with no started run (imported, or reserved by another queued run) never cross it. */
export function providerThreadPredatesBoundary(
  providerThread: Pick<OrchestrationV2ProviderThread, "firstRunOrdinal">,
  boundary: number,
): boolean {
  return (
    boundary > 0 &&
    (providerThread.firstRunOrdinal === null || providerThread.firstRunOrdinal < boundary)
  );
}

/** A provider that hosts one native thread per session keeps the old conversation alive otherwise. */
export function sessionsReleasedByFreshContext(
  projection: Pick<OrchestrationV2ThreadProjection, "providerSessions">,
  activeProviderThread: OrchestrationV2ProviderThread | undefined,
): ReadonlyArray<OrchestrationV2ProviderSession> {
  const sessionId = activeProviderThread?.providerSessionId ?? null;
  return projection.providerSessions.filter(
    (session) =>
      session.id === sessionId &&
      session.status !== "stopped" &&
      session.status !== "error" &&
      !session.capabilities.sessions.supportsMultipleProviderThreadsPerSession,
  );
}

export const FRESH_CONTEXT_DETACH_REASON = "Started a fresh session.";

export function uniqueSessions(
  sessions: ReadonlyArray<OrchestrationV2ProviderSession>,
): ReadonlyArray<OrchestrationV2ProviderSession> {
  return Array.from(new Map(sessions.map((session) => [session.id, session])).values());
}

export function rootProviderThreadsForProvider(
  projection: Pick<OrchestrationV2ThreadProjection, "providerThreads" | "thread" | "runs">,
  providerInstanceId: ModelSelection["instanceId"],
): ReadonlyArray<OrchestrationV2ProviderThread> {
  const boundary = contextBoundaryOrdinal(projection.runs);
  return projection.providerThreads
    .filter(
      (providerThread) =>
        providerThread.providerInstanceId === providerInstanceId &&
        providerThread.appThreadId === projection.thread.id &&
        providerThread.ownerNodeId === null &&
        !providerThreadPredatesBoundary(providerThread, boundary),
    )
    .toSorted(
      (left, right) =>
        (right.lastRunOrdinal ?? 0) - (left.lastRunOrdinal ?? 0) ||
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
}

export function isHandoffSourceRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "interrupted" ||
    (run.status === "cancelled" && run.startedAt !== null)
  );
}

export function lastDeliveredRunForProviderThread(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
  providerThreadId: OrchestrationV2ProviderThread["id"],
): OrchestrationV2Run | undefined {
  return projection.runs.findLast(
    (run) =>
      isHandoffSourceRun(run) &&
      run.providerThreadId === providerThreadId &&
      (run.status === "completed" ||
        projection.providerTurns.some((turn) => turn.runAttemptId === run.activeAttemptId)),
  );
}
