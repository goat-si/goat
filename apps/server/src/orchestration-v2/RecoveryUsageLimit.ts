import {
  type CommandId,
  type EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ProjectionRuntimeRecoveryState, ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import type { ProviderRuntimeRecoveryError } from "./ProviderRuntimeRecoveryErrors.ts";

export const recoverUsageLimit = Effect.fn("ProviderRuntimeRecovery.recoverUsageLimit")(
  function* (input: {
    readonly projection: ProjectionRuntimeRecoveryState;
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly projections: ProjectionStoreV2Shape;
    readonly now: DateTime.Utc;
    readonly commandId: CommandId;
    readonly allocateEventId: () => Effect.Effect<EventId, ProviderRuntimeRecoveryError>;
    readonly readError: (cause: unknown) => ProviderRuntimeRecoveryError;
  }) {
    const { projection, now } = input;
    const unsent = input.runs.filter(
      (run) => run.startedAt === null && run.usageLimitContinuationOfRunId !== undefined,
    );
    const events: Array<OrchestrationV2DomainEvent> = [];
    const recovery = projection.thread.limitRecovery;
    if (
      recovery?.autoResume === true &&
      unsent.some((run) => run.usageLimitContinuationOfRunId === recovery.runId)
    ) {
      events.push({
        id: yield* input.allocateEventId(),
        type: "thread.metadata-updated",
        threadId: projection.thread.id,
        occurredAt: now,
        payload: {
          ...projection.thread,
          limitRecovery: { ...recovery, requestId: input.commandId },
          updatedAt: now,
        },
      });
    }
    const items =
      unsent.length === 0
        ? []
        : (yield* input.projections
            .getThreadRecords(projection.thread.id, ["turnItems"], {
              turnItemTypes: ["user_message"],
              turnItemRunIds: unsent.map((run) => run.id),
            })
            .pipe(Effect.mapError(input.readError))).turnItems;
    for (const item of items) {
      if (item.type !== "user_message") continue;
      const active =
        item.status === "pending" || item.status === "running" || item.status === "waiting";
      events.push({
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        threadId: projection.thread.id,
        ...(item.runId === null ? {} : { runId: item.runId }),
        occurredAt: now,
        payload: {
          ...item,
          ...(active ? { status: "cancelled", completedAt: now } : {}),
          inputIntent: "queued_turn",
          updatedAt: now,
        },
      });
    }
    return { events, itemIds: new Set(items.map((item) => item.id)) };
  },
);
