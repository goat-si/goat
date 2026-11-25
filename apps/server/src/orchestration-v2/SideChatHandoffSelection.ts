import {
  isCompactionCommandMessage,
  isSideChatThread,
  parseGoalCommand,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import { readyHandoffsForRun } from "./providerTurnStartHelpers.ts";
import { isScheduledFreshRun } from "./ProviderContextBoundaries.ts";
import type { IdAllocatorV2Allocate } from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { EventSinkV2Shape } from "./EventSink.ts";

type HandoffProjection = Pick<
  OrchestrationV2ThreadProjection,
  | "thread"
  | "contextHandoffs"
  | "contextTransfers"
  | "runs"
  | "messages"
  | "turnItems"
  | "providerThreads"
>;

export function selectSideChatHandoffs(projection: HandoffProjection, run: OrchestrationV2Run) {
  const isSide = (handoff: OrchestrationV2ThreadProjection["contextHandoffs"][number]) =>
    isSideChatThread(projection.thread) &&
    handoff.strategy === "manual_context" &&
    handoff.transferId != null;
  const carried = projection.contextHandoffs.filter((handoff) => {
    if (!isSide(handoff) || handoff.status !== "ready" || handoff.delivery !== undefined)
      return false;
    if (handoff.targetRunId === run.id) return true;
    return projection.runs.some((source) => {
      if (source.id !== handoff.targetRunId) return false;
      if (["failed", "interrupted", "cancelled"].includes(source.status)) return true;
      return (
        source.status === "completed" &&
        projection.messages.some(
          (message) =>
            message.id === source.userMessageId &&
            (isCompactionCommandMessage(message) || parseGoalCommand(message) !== null),
        )
      );
    });
  });
  const other = readyHandoffsForRun(projection, run).filter((handoff) => !isSide(handoff));
  return {
    handoffs:
      run.freshContext === true || carried[0] === undefined ? other : [...other, carried[0]],
    retire:
      run.freshContext === true && !isScheduledFreshRun(run, projection.turnItems) ? carried : [],
  };
}

const retireSideChatHandoffs = Effect.fn("ProviderTurnStartService.retireSideChatHandoffs")(
  function* (
    eventSink: EventSinkV2Shape,
    allocate: IdAllocatorV2Allocate,
    run: OrchestrationV2Run,
    attemptId: NonNullable<OrchestrationV2Run["activeAttemptId"]>,
    expectedStatus: Parameters<EventSinkV2Shape["writeIfRunCurrent"]>[0]["expectedStatus"],
    handoffs: OrchestrationV2ThreadProjection["contextHandoffs"],
  ) {
    if (handoffs.length === 0) return true;
    const updatedAt = yield* DateTime.now;
    const result = yield* eventSink.writeIfRunCurrent({
      threadId: run.threadId,
      runId: run.id,
      activeAttemptId: attemptId,
      expectedStatus,
      events: yield* Effect.forEach(handoffs, (handoff) =>
        Effect.map(allocate.event({ threadId: run.threadId }), (id) => ({
          id,
          type: "context-handoff.updated" as const,
          threadId: run.threadId,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: updatedAt,
          payload: { ...handoff, status: "superseded" as const, updatedAt },
        })),
      ),
    });
    return result.committed;
  },
);

export const prepareSideChatHandoffs = Effect.fn(
  "ProviderTurnStartService.prepareSideChatHandoffs",
)(function* (
  projection: HandoffProjection,
  run: OrchestrationV2Run,
  eventSink: EventSinkV2Shape,
  allocate: IdAllocatorV2Allocate,
) {
  const selected = selectSideChatHandoffs(projection, run);
  if (run.activeAttemptId === null) return undefined;
  return (yield* retireSideChatHandoffs(
    eventSink,
    allocate,
    run,
    run.activeAttemptId,
    run.status,
    selected.retire,
  ))
    ? selected.handoffs
    : undefined;
});
