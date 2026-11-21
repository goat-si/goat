import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
  RunId,
  ThreadId,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";
import type { ProjectionStoreV2 } from "../ProjectionStore.ts";
import type { OrchestratorProjectionError } from "../Orchestrator.ts";
import { recoveryParkMarkerId } from "./RecoveryParkMarker.ts";

export function makeSettleRecoveryParkNotice<E, R>(input: {
  readonly projectionStore: ProjectionStoreV2["Service"];
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, E, R>;
}) {
  const { projectionStore, OrchestratorProjectionError, emit } = input;
  return Effect.fn("Orchestrator.settleRecoveryParkNotice")(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly threadId: ThreadId }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    runId: RunId,
    now: DateTime.Utc,
    outcome: "sent" | "discarded",
  ) {
    const marker = yield* projectionStore
      .getTurnItem({
        threadId: command.threadId,
        itemId: recoveryParkMarkerId(runId),
      })
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    if (marker?.type !== "system_notice" || marker.status !== "waiting") return;
    yield* emit(
      events,
      command,
    )({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId,
      occurredAt: now,
      payload: {
        ...marker,
        status: "completed",
        completedAt: now,
        updatedAt: now,
        message:
          outcome === "sent"
            ? "Recovery message released by your request."
            : "Recovery message discarded.",
      },
    });
  });
}
