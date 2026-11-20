import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@goat/contracts";
import type { IdAllocatorV2 } from "@goat/provider-core/server/IdAllocator";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { EventSinkV2 } from "./EventSink.ts";
import { settledBeforeStartRun } from "./runTerminationCause.ts";

export function makeSettleRunBeforeStart({
  eventSink,
  idAllocator,
  projection,
  run,
  rootNode,
  attempt,
  expectedStartStatus,
}: {
  readonly eventSink: EventSinkV2["Service"];
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly projection: Pick<OrchestrationV2ThreadProjection, "thread" | "turnItems">;
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly attempt: OrchestrationV2RunAttempt;
  readonly expectedStartStatus: "starting" | "running";
}) {
  const runId = run.id;
  return Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(function* (input: {
    readonly signal: string;
    readonly status: "completed" | "failed";
    readonly now: DateTime.Utc;
    readonly startedAt?: DateTime.Utc;
    readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
    readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"] | null;
    readonly item:
      | Pick<Extract<OrchestrationV2TurnItem, { type: "error" }>, "type" | "title" | "failure">
      | Pick<
          Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
          "type" | "title" | "input" | "output" | "exitCode"
        >;
    readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
  }) {
    const { now, status } = input;
    const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
    const item: OrchestrationV2TurnItem = {
      id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
      threadId: projection.thread.id,
      runId,
      nodeId: rootNode.id,
      providerThreadId: input.itemProviderThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal:
        Math.max(
          0,
          ...projection.turnItems
            .filter((item) => item.runId === runId)
            .map((item) => item.ordinal),
        ) + 1,
      status,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      ...input.item,
    };
    const eventPayloads = [
      { type: "turn-item.updated", payload: item },
      { type: "run.updated", payload: settledBeforeStartRun(run, input, started) },
      {
        type: "run-attempt.updated",
        payload: { ...attempt, status, ...started, completedAt: now },
      },
      {
        type: "node.updated",
        payload: { ...rootNode, status, ...started, completedAt: now },
      },
      ...(input.providerThreadUpdate === undefined
        ? []
        : [
            {
              type: "provider-thread.updated" as const,
              payload: input.providerThreadUpdate,
            },
          ]),
    ] as const;
    const events = yield* Effect.forEach(eventPayloads, (event) =>
      Effect.gen(function* () {
        return {
          ...event,
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          threadId: projection.thread.id,
          runId,
          nodeId: rootNode.id,
          providerInstanceId: input.providerInstanceId,
          occurredAt: now,
        } satisfies OrchestrationV2DomainEvent;
      }),
    );
    yield* eventSink.writeIfRunCurrent({
      threadId: projection.thread.id,
      runId,
      activeAttemptId: attempt.id,
      expectedStatus: expectedStartStatus,
      events,
    });
  });
}
