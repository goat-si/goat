import type {
  EventId,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ProjectionRuntimeRecoveryState, ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import type { ProviderRuntimeRecoveryError } from "./ProviderRuntimeRecoveryService.ts";
import { neverStarted } from "./RestartBackgroundNote.ts";
import { isBufferedProviderNotification } from "./NotificationMailbox.ts";
import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

export const recoverUnstartedQueue = Effect.fn("ProviderRuntimeRecovery.recoverUnstartedQueue")(
  function* (input: {
    projection: ProjectionRuntimeRecoveryState;
    runs: Array<OrchestrationV2ThreadProjection["runs"][number]>;
    projections: ProjectionStoreV2Shape;
    now: DateTime.Utc;
    allocateEventId: () => Effect.Effect<EventId, ProviderRuntimeRecoveryError>;
    readError: (cause: unknown) => ProviderRuntimeRecoveryError;
  }) {
    const { projection, projections, now, allocateEventId, readError } = input;
    let { runs } = input;
    const events: Array<OrchestrationV2DomainEvent> = [];
    const unstartedRuns = runs.filter(
      (run) =>
        run.status === "starting" &&
        neverStarted(run) &&
        !projection.providerTurns.some((turn) => turn.runAttemptId === run.activeAttemptId) &&
        !projection.runtimeRequests.some(
          (request) =>
            request.status === "pending" &&
            projection.nodes.some((node) => node.id === request.nodeId && node.runId === run.id),
        ),
    );
    const queuedRuns = projection.runs.filter((run) => run.status === "queued");
    const pendingRuns = [...unstartedRuns, ...queuedRuns];
    const queuedMessages =
      pendingRuns.length === 0
        ? []
        : (yield* projections
            .getThreadRecords(projection.thread.id, ["messages"], {
              messageIds: pendingRuns.map((run) => run.userMessageId),
            })
            .pipe(Effect.mapError((cause) => readError(cause)))).messages;
    const bufferedMessageIds = new Set(
      queuedMessages.filter(isBufferedProviderNotification).map((message) => message.id),
    );
    const retryableMessageIds = new Set(
      queuedMessages
        .filter(
          (message) =>
            message.createdBy === "user" &&
            message.scheduledTaskId === undefined &&
            message.notification === undefined &&
            message.delegatedCompletion === undefined,
        )
        .map((message) => message.id),
    );
    // A saved user message the provider never accepted stays available through the held queue.
    const retryableRuns = unstartedRuns.filter((run) => retryableMessageIds.has(run.userMessageId));
    const retryableRunIds = new Set(retryableRuns.map((run) => run.id));
    const retryableItems =
      retryableRuns.length === 0
        ? []
        : (yield* projections
            .getThreadRecords(projection.thread.id, ["turnItems"], {
              turnItemTypes: ["user_message"],
              turnItemRunIds: retryableRuns.map((run) => run.id),
            })
            .pipe(Effect.mapError((cause) => readError(cause)))).turnItems;
    for (const item of retryableItems) {
      if (item.type !== "user_message" || !retryableMessageIds.has(item.messageId)) continue;
      events.push({
        id: yield* allocateEventId(),
        type: "turn-item.updated",
        threadId: projection.thread.id,
        ...(item.runId === null ? {} : { runId: item.runId }),
        occurredAt: now,
        payload: {
          ...item,
          inputIntent: "queued_turn",
          status: "pending",
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        },
      });
    }
    runs = runs.filter((run) => !retryableRunIds.has(run.id));
    const heldRuns = [
      ...retryableRuns,
      ...queuedRunsInDeliveryOrder({ runs: queuedRuns, messages: queuedMessages }),
    ];
    for (const [index, run] of heldRuns.entries()) {
      if (bufferedMessageIds.has(run.userMessageId)) {
        runs.push(run);
        continue;
      }
      if (run.queueHeld === true && retryableRuns.length === 0) continue;
      events.push({
        id: yield* allocateEventId(),
        type: "run.updated",
        threadId: projection.thread.id,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...run,
          status: "queued",
          queueHeld: true,
          ...(retryableRuns.length === 0 ? {} : { queuePosition: index + 1 }),
        },
      });
    }

    return { runs, events };
  },
);
