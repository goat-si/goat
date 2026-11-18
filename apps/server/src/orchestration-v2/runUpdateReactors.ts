import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2StoredEvent,
  type ProviderThreadId,
  type ThreadId,
} from "@goat/contracts";
import { backgroundWorkHoldsCompletion } from "@goat/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeKeyedCursorReactor } from "./keyedCursorReactor.ts";
import { runResumableReactor } from "../backgroundSupervision.ts";

type EventType = "run.updated" | "provider-thread.updated" | "subagent.updated";

const MAX_TRACKED_ROSTERS = 1_024;
const MAX_TRACKED_TASKS_PER_ROSTER = 256;

export function makeChildWorkSettlementFilter() {
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
    readonly threadId?: ThreadId;
    readonly throughSequence?: number;
  }) => Stream.Stream<OrchestrationV2StoredEvent, E, R>;
  readonly handleRun: (event: OrchestrationV2StoredEvent) => Effect.Effect<unknown, never, R2>;
  readonly handleChild: (
    event: OrchestrationV2StoredEvent,
  ) => Effect.Effect<unknown, never, R2> | undefined;
}) {
  const relevant = ({ event, commandId }: OrchestrationV2StoredEvent) =>
    event.type !== "run.updated" ||
    ((!String(commandId).startsWith("command:runtime-reconcile:") ||
      (event.payload.delegatedTaskId !== undefined &&
        event.payload.status === "queued" &&
        event.payload.queueHeld === true)) &&
      ((event.payload.delegatedTaskId !== undefined &&
        (event.payload.status === "queued" || event.payload.status === "starting")) ||
        event.payload.status === "completed" ||
        event.payload.status === "interrupted" ||
        event.payload.status === "failed" ||
        event.payload.status === "cancelled" ||
        event.payload.status === "rolled_back"));
  const react = (event: OrchestrationV2StoredEvent) =>
    Effect.suspend(
      () =>
        (event.event.type === "run.updated" ? input.handleRun(event) : input.handleChild(event)) ??
        Effect.void,
    );
  const reactions = yield* makeKeyedCursorReactor({
    name: "Orchestrator.replayDeferredUpdates",
    replay: (threadId: ThreadId, eventType: EventType, range) =>
      input
        .stream({ ...range, threadId, eventType })
        .pipe(Stream.filter(relevant), Stream.runForEach(react)),
  });
  yield* Effect.all(
    (["run.updated", "provider-thread.updated", "subagent.updated"] as const).map((eventType) =>
      runResumableReactor(
        `Orchestrator.${eventType}`,
        input.afterSequence,
        (afterSequence) => input.stream({ afterSequence, eventType }).pipe(Stream.filter(relevant)),
        (stored) =>
          reactions.enqueue(stored.event.threadId, eventType, stored.sequence, react(stored)),
      ),
    ),
    { concurrency: "unbounded", discard: true },
  );
});
