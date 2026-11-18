import * as KeyedLock from "@goat/shared/KeyedLock";
import type { OrchestrationV2StoredEvent, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { runResumableReactor } from "../backgroundSupervision.ts";

type EventType = "run.updated" | "provider-thread.updated" | "subagent.updated";

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
        (stored) =>
          reactions.run(
            stored.event.threadId,
            (eventType === "run.updated" ? input.handleRun : input.handleChild)(stored),
          ),
      ),
    ),
    { concurrency: "unbounded", discard: true },
  );
});
