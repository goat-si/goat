import {
  CommandId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { OrchestratorProjectionError, OrchestratorV2Error } from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";

export interface StaleQuestionWakeDeps<WriteError> {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly emitQueuedRunCancellation: (input: {
    readonly command: OrchestrationV2ServerCommand;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<OrchestrationV2ThreadProjection, "nodes" | "attempts">;
    readonly run: OrchestrationV2Run;
    readonly now: DateTime.Utc;
    readonly cause: "queued_cancelled";
  }) => Effect.Effect<void, OrchestratorV2Error>;
  readonly writeSystemEvents: (
    events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>,
  ) => Effect.Effect<void, WriteError>;
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
}

/** A launcher's wake for a local question that is no longer pending can only waste a turn. */
export const makeStaleQuestionWakes = <WriteError>(deps: StaleQuestionWakeDeps<WriteError>) => {
  const { projectionStore, OrchestratorProjectionError } = deps;

  const isStaleQuestionWake = Effect.fn("Orchestrator.isStaleQuestionWake")(function* (
    notification: OrchestrationV2ConversationMessage["notification"],
  ) {
    const source = notification?.source;
    if (source?.kind !== "question" || notification?.outcome !== "updated") return false;
    const request = yield* projectionStore
      .getRuntimeRequest(source.threadId, source.requestId)
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: source.threadId, cause }),
        ),
      );
    // A remote or unknown question gives no evidence that the wake is obsolete.
    return request !== undefined && request.status !== "pending";
  });

  /** Cancels the thread's queued wakes for questions already answered, dismissed or closed. */
  const cancelStaleQuestionWakes = Effect.fn("Orchestrator.cancelStaleQuestionWakes")(function* (
    projection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "messages" | "nodes" | "attempts"
    >,
  ) {
    const events = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
    for (const run of projection.runs) {
      if (run.status !== "queued") continue;
      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      if (message?.notification?.source.kind !== "question") continue;
      const stale = yield* isStaleQuestionWake(message.notification).pipe(
        // A question read must not fail the thread's unrelated next queued run.
        Effect.catchTags({
          OrchestratorProjectionError: (cause) =>
            Effect.logWarning("Failed to check a queued question wake", {
              runId: run.id,
              cause,
            }).pipe(Effect.as(false)),
        }),
      );
      if (!stale) continue;
      yield* deps.emitQueuedRunCancellation({
        command: {
          type: "queued-run.cancel",
          commandId: CommandId.make(`command:system:stale-question:${run.id}`),
          threadId: projection.thread.id,
          runId: run.id,
        },
        events,
        projection,
        run,
        now: yield* DateTime.now,
        cause: "queued_cancelled",
      });
    }
    const cancellations = yield* Ref.get(events);
    if (cancellations.length === 0) return false;
    yield* deps.writeSystemEvents(cancellations);
    return true;
  });

  return { cancelStaleQuestionWakes };
};
