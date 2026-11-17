import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
  RunId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { ProjectionStoreV2 } from "../ProjectionStore.ts";

type TurnItemUpdated = Extract<OrchestrationV2DomainEvent, { readonly type: "turn-item.updated" }>;

/**
 * The runs whose Stop hold this command ends: Resume ends every hold on its thread, and
 * a continuation ends the continued run's hold once this command has started it.
 */
function releasedRuns(
  command: OrchestrationV2ServerCommand,
  pending: ReadonlyArray<OrchestrationV2DomainEvent>,
): ReadonlyArray<RunId> | "thread" | undefined {
  if (command.type === "queue.resume") return "thread";
  if (command.type !== "message.dispatch" || command.manualContinuationOfRunId === undefined) {
    return undefined;
  }
  const started = pending.some(
    (event) => event.type === "run.created" && event.payload.userMessageId === command.messageId,
  );
  return started ? [command.manualContinuationOfRunId] : undefined;
}

/**
 * Rewrites those runs' holding interrupt requests without holdsQueue, so a steer the provider
 * declines later is queued unheld. The request stays: late tool calls of a stopped run still stop.
 */
export const releaseStopHolds = Effect.fn("Orchestrator.releaseStopHolds")(function* <E>(input: {
  readonly projectionStore: ProjectionStoreV2["Service"];
  readonly command: OrchestrationV2ServerCommand;
  readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  readonly emit: (event: Omit<TurnItemUpdated, "id">) => Effect.Effect<unknown, E>;
}) {
  const runIds = releasedRuns(input.command, yield* Ref.get(input.events));
  if (runIds === undefined || !("threadId" in input.command)) return;
  const { runs, turnItems } = yield* input.projectionStore.getThreadRecords(
    input.command.threadId,
    ["runs", "turnItems"],
    {
      turnItemTypes: ["run_interrupt_request"],
      ...(runIds === "thread" ? {} : { turnItemRunIds: runIds }),
    },
  );
  const now = yield* DateTime.now;
  for (const item of turnItems) {
    if (item.type !== "run_interrupt_request" || item.holdsQueue !== true) continue;
    const run = runs.find((candidate) => candidate.id === item.runId);
    if (run === undefined) continue;
    const { holdsQueue: _released, ...request } = item;
    yield* input.emit({
      type: "turn-item.updated",
      threadId: input.command.threadId,
      runId: run.id,
      ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...request, updatedAt: now },
    });
  }
});
