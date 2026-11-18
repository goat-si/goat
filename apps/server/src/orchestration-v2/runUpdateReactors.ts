import * as KeyedLock from "@goat/shared/KeyedLock";
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2StoredEvent,
  type ProviderThreadId,
  type ThreadId,
} from "@goat/contracts";
import { backgroundWorkHoldsCompletion } from "@goat/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { runResumableReactor } from "../backgroundSupervision.ts";

type EventType = "run.updated" | "provider-thread.updated" | "subagent.updated";

const MAX_TRACKED_ROSTERS = 1_024;
const MAX_TRACKED_TASKS_PER_ROSTER = 256;

function makeChildWorkSettlementFilter() {
  const rosters = new Map<ProviderThreadId, ReadonlySet<string>>();
  let incompleteHistory = false;
  return ({ event }: OrchestrationV2StoredEvent): boolean => {
    if (event.type === "subagent.updated")
      return !isOrchestrationV2WorkActive(event.payload.status);
    if (event.type !== "provider-thread.updated") return false;
    const { id, pendingBackgroundTasks } = event.payload;
    const previous = rosters.get(id);
    const holding = new Set<string>();
    for (const task of pendingBackgroundTasks ?? []) {
      if (backgroundWorkHoldsCompletion([task])) holding.add(task.taskId);
      if (holding.size > MAX_TRACKED_TASKS_PER_ROSTER) break;
    }
    rosters.delete(id);
    if (holding.size > MAX_TRACKED_TASKS_PER_ROSTER) incompleteHistory = true;
    else if (holding.size > 0) rosters.set(id, holding);
    if (rosters.size > MAX_TRACKED_ROSTERS) {
      const oldest = rosters.keys().next().value;
      if (oldest !== undefined) rosters.delete(oldest);
      incompleteHistory = true;
    }
    // After eviction the projection decides whether a task is ready.
    return previous === undefined
      ? incompleteHistory
      : [...previous].some((taskId) => !holding.has(taskId));
  };
}

export const runUpdateReactors = Effect.fn("Orchestrator.runUpdateReactors")(function* <
  E,
  R,
  R2,
>(input: {
  readonly afterSequence: number;
  readonly stream: (options: {
    readonly afterSequence: number;
    readonly eventType: EventType;
  }) => Stream.Stream<OrchestrationV2StoredEvent, E, R>;
  readonly handleRun: (event: OrchestrationV2StoredEvent) => Effect.Effect<unknown, never, R2>;
  readonly handleChild: (event: OrchestrationV2StoredEvent) => Effect.Effect<unknown, never, R2>;
}) {
  const reactions = yield* KeyedLock.makeRunner<ThreadId>();
  const settlesChildWork = makeChildWorkSettlementFilter();
  yield* Effect.all(
    (["run.updated", "provider-thread.updated", "subagent.updated"] as const).map((eventType) =>
      runResumableReactor(
        `Orchestrator.${eventType}`,
        input.afterSequence,
        (afterSequence) =>
          input
            .stream({ afterSequence, eventType })
            .pipe(
              Stream.filter(
                (stored) =>
                  eventType !== "run.updated" ||
                  (stored.event.type === "run.updated" &&
                    (!String(stored.commandId).startsWith("command:runtime-reconcile:") ||
                      (stored.event.payload.delegatedTaskId !== undefined &&
                        stored.event.payload.status === "queued" &&
                        stored.event.payload.queueHeld === true)) &&
                    ((stored.event.payload.delegatedTaskId !== undefined &&
                      (stored.event.payload.status === "queued" ||
                        stored.event.payload.status === "starting")) ||
                      stored.event.payload.status === "completed" ||
                      stored.event.payload.status === "interrupted" ||
                      stored.event.payload.status === "failed" ||
                      stored.event.payload.status === "cancelled" ||
                      stored.event.payload.status === "rolled_back")),
              ),
            ),
        (stored) => {
          if (eventType === "run.updated")
            return reactions.run(stored.event.threadId, input.handleRun(stored));
          return settlesChildWork(stored)
            ? reactions.run(stored.event.threadId, input.handleChild(stored))
            : Effect.void;
        },
      ),
    ),
    { concurrency: "unbounded", discard: true },
  );
});
