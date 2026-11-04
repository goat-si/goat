import {
  isPersonRunEnd,
  type EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

/** Runs GOAT has ended; a provider turn of one that still reads running is stopped before a new start. */
const ENDED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

export const STOPPED_EARLIER_TURN_MESSAGE =
  "A turn from an earlier run was still marked as running, so GOAT ended it before this message.";

/** The notice a run shows when GOAT stopped a turn the person had not stopped before it started. */
function stoppedEarlierTurnNotice(input: {
  readonly id: OrchestrationV2TurnItem["id"];
  readonly projection: Pick<OrchestrationV2ThreadProjection, "turnItems">;
  readonly run: Pick<OrchestrationV2Run, "id" | "threadId">;
  readonly rootNode: Pick<OrchestrationV2ExecutionNode, "id">;
  readonly providerThreadId: OrchestrationV2ProviderThread["id"];
  readonly at: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "system_notice" }> {
  return {
    id: input.id,
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal:
      Math.max(
        0,
        ...input.projection.turnItems
          .filter((item) => item.runId === input.run.id)
          .map((item) => item.ordinal),
      ) + 1,
    status: "completed",
    title: "Stopped an earlier turn",
    startedAt: input.at,
    completedAt: input.at,
    updatedAt: input.at,
    type: "system_notice",
    message: STOPPED_EARLIER_TURN_MESSAGE,
  };
}
/**
 * Earlier runs on this provider thread GOAT has ended, by attempt: a failed run, or a goal or restart
 * path that settled its run while the provider kept working. A restart continuation adopts the turn
 * its source run left running, so that source is not among them.
 */
export const endedRunsByAttempt = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: Pick<OrchestrationV2Run, "ordinal" | "restartContinuationOfRunId">,
  providerThreadId: OrchestrationV2ProviderThread["id"],
) =>
  new Map(
    runs
      .filter(
        (previous) =>
          previous.ordinal < run.ordinal &&
          previous.providerThreadId === providerThreadId &&
          ENDED_RUN_STATUSES.has(previous.status) &&
          previous.id !== run.restartContinuationOfRunId,
      )
      .map((previous) => [previous.activeAttemptId, previous] as const),
  );

/**
 * Marks the turns ended runs left running interrupted. When the stop went through a live session and
 * a person had not ended that run, the run that replaces it also shows the notice.
 */
export const abandonedTurnRepairEvents = Effect.fn("StoppedEarlierTurn.repairEvents")(function* <
  E,
  R,
>(input: {
  readonly abandoned: ReadonlyArray<{
    readonly turn: OrchestrationV2ProviderTurn;
    readonly run: OrchestrationV2Run;
  }>;
  readonly stoppedLive: boolean;
  readonly projection: Pick<OrchestrationV2ThreadProjection, "turnItems">;
  readonly run: OrchestrationV2Run;
  readonly rootNode: Pick<OrchestrationV2ExecutionNode, "id">;
  readonly providerThreadId: OrchestrationV2ProviderThread["id"];
  readonly noticeId: OrchestrationV2TurnItem["id"];
  readonly allocateEventId: Effect.Effect<EventId, E, R>;
  readonly at: DateTime.Utc;
}) {
  const events: Array<OrchestrationV2DomainEvent> = [];
  for (const { turn, run } of input.abandoned)
    events.push({
      id: yield* input.allocateEventId,
      type: "provider-turn.updated",
      threadId: run.threadId,
      runId: run.id,
      nodeId: turn.nodeId,
      providerInstanceId: run.providerInstanceId,
      occurredAt: input.at,
      payload: { ...turn, status: "interrupted", completedAt: input.at },
    });
  if (
    input.stoppedLive &&
    input.abandoned.some(({ run }) => !isPersonRunEnd(run.terminationCause?.kind))
  )
    events.push({
      id: yield* input.allocateEventId,
      type: "turn-item.updated",
      threadId: input.run.threadId,
      runId: input.run.id,
      nodeId: input.rootNode.id,
      providerInstanceId: input.run.providerInstanceId,
      occurredAt: input.at,
      payload: stoppedEarlierTurnNotice({ ...input, id: input.noticeId }),
    });
  return events;
});
