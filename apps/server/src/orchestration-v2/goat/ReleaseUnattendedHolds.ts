import type { OrchestrationV2DomainEvent, RunId, ThreadId } from "@goat/contracts";
import { latestExecutedRun } from "@goat/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { isBufferedProviderNotification } from "../NotificationMailbox.ts";
import type { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { worktreeSetupPending } from "./OrchestratorRunState.ts";

export function makeReleaseUnattendedHolds<E, R>(input: {
  readonly projectionStore: ProjectionStoreV2["Service"];
  readonly writeSystemEvents: (
    events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>,
  ) => Effect.Effect<void, E, R>;
}) {
  const { projectionStore, writeSystemEvents } = input;
  // A hold waits for a person to review what they queued. Nobody reviews messages from agents,
  // the server or scheduled tasks, so a later completed run releases those unless it was stopped.
  return Effect.fn("Orchestrator.releaseUnattendedHolds")(function* (
    threadId: ThreadId,
    completedRunId: RunId,
  ) {
    const held = yield* projectionStore.getHeldQueuedRuns(threadId);
    if (held.length === 0) return;
    const completedMessage = yield* projectionStore.getRunMessage(threadId, completedRunId);
    if (completedMessage !== undefined && isBufferedProviderNotification(completedMessage)) return;
    const projection = yield* projectionStore.getThreadRecords(
      threadId,
      ["runs", "messages", "turnItems"],
      {
        messageIds: held.map((run) => run.userMessageId),
        turnItemTypes: ["run_interrupt_request"],
        turnItemRunIds: [completedRunId],
      },
    );
    // Only the newest run completing shows the thread moved past the hold; a late or
    // bookkeeping update to an older run, overtaken by a failure or Stop, does not.
    if (
      latestExecutedRun(projection.runs)?.id !== completedRunId ||
      projection.turnItems.length > 0 ||
      worktreeSetupPending(projection)
    )
      return;
    const { messages } = projection;
    const unattended = new Set(
      messages
        .filter((message) => message.createdBy !== "user" || message.scheduledTaskId !== undefined)
        .map((message) => message.id),
    );
    const now = yield* DateTime.now;
    const released = held.filter((run) => unattended.has(run.userMessageId));
    if (released.length === 0) return;
    yield* writeSystemEvents(
      released.map((run) => ({
        type: "run.updated" as const,
        threadId,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...run, queueHeld: false },
      })),
    );
  });
}
