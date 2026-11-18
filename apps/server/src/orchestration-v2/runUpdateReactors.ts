import type { OrchestrationV2StoredEvent } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import { runResumableReactor } from "../backgroundSupervision.ts";

export function relevantRunUpdate({ event, commandId }: OrchestrationV2StoredEvent): boolean {
  if (event.type !== "run.updated") return true;
  const { delegatedTaskId, status } = event.payload;
  return (
    !String(commandId).startsWith("command:runtime-reconcile:") &&
    ((delegatedTaskId !== undefined && (status === "queued" || status === "starting")) ||
      status === "completed" ||
      status === "interrupted" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "rolled_back")
  );
}

type EventType = "run.updated" | "provider-thread.updated" | "subagent.updated";

export const runUpdateReactors = Effect.fn("Orchestrator.runUpdateReactors")(function* <
  E,
  R,
  E2,
  R2,
>(input: {
  readonly afterSequence: number;
  readonly stream: (options: {
    readonly afterSequence: number;
    readonly eventType: EventType;
  }) => Stream.Stream<OrchestrationV2StoredEvent, E, R>;
  readonly handleRun: (event: OrchestrationV2StoredEvent) => Effect.Effect<unknown, E2, R2>;
  readonly handleChild: (event: OrchestrationV2StoredEvent) => Effect.Effect<unknown, E2, R2>;
}) {
  yield* Effect.all(
    (["run.updated", "provider-thread.updated", "subagent.updated"] as const).map((eventType) =>
      runResumableReactor(
        `Orchestrator.${eventType}`,
        input.afterSequence,
        (afterSequence) => input.stream({ afterSequence, eventType }),
        eventType === "run.updated" ? input.handleRun : input.handleChild,
      ),
    ),
    { concurrency: "unbounded", discard: true },
  );
});
