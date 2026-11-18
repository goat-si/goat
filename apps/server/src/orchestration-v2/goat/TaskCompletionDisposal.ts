import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
  OrchestrationV2Subagent,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";

import type { OrchestratorV2Error } from "../Orchestrator.ts";

export interface TaskCompletionDisposalDeps {
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
}

export const makeTaskCompletionDisposal = ({ emit }: TaskCompletionDisposalDeps) => {
  /** Drops the wakes these delegated tasks still owe their parent; settled deliveries stay. */
  const disposeTaskCompletionDeliveries = (input: {
    readonly command: OrchestrationV2ServerCommand;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly tasks: ReadonlyArray<OrchestrationV2Subagent>;
    readonly now: DateTime.Utc;
  }) =>
    Effect.forEach(
      input.tasks.filter(
        (task) =>
          task.completionDelivery?.state !== "acknowledged" &&
          task.completionDelivery?.state !== "delivered" &&
          task.completionDelivery?.state !== "disposed",
      ),
      (task) =>
        emit(
          input.events,
          input.command,
        )({
          type: "subagent.updated",
          threadId: task.threadId,
          ...(task.runId === null ? {} : { runId: task.runId }),
          nodeId: task.id,
          driver: task.driver,
          providerInstanceId: task.providerInstanceId,
          occurredAt: input.now,
          payload: {
            ...task,
            completionDelivery: {
              state: "disposed",
              observedByRunId: null,
            },
            updatedAt: input.now,
          },
        }),
      { discard: true },
    );

  return { disposeTaskCompletionDeliveries };
};
