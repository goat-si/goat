import { recoveryParkMarkerId } from "./goat/RecoveryParkMarker.ts";
import type {
  EventId,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import type { RunId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ProjectionRuntimeRecoveryState, ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import type { ProviderRuntimeRecoveryError } from "./ProviderRuntimeRecoveryService.ts";
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
    acceptedRunIds?: ReadonlySet<RunId>;
  }) {
    const { projection, projections, now, allocateEventId, readError } = input;
    let { runs } = input;
    const events: Array<OrchestrationV2DomainEvent> = [];
    const unstartedRuns = runs.filter(
      (run) =>
        (run.status === "starting" || run.status === "running") &&
        input.acceptedRunIds?.has(run.id) !== true &&
        !projection.attempts.some(
          (attempt) => attempt.runId === run.id && attempt.inputDelivery === "accepted",
        ) &&
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
        : [
            ...(yield* projections
              .getMessagesById(
                projection.thread.id,
                pendingRuns.map((run) => run.userMessageId),
              )
              .pipe(Effect.mapError(readError))).values(),
          ];
    const bufferedMessageIds = new Set(
      queuedMessages.filter(isBufferedProviderNotification).map((message) => message.id),
    );
    const isUnattended = (message: (typeof queuedMessages)[number] | undefined) =>
      message !== undefined &&
      message.notification === undefined &&
      message.delegatedCompletion === undefined &&
      (message.scheduledTaskId !== undefined ||
        (message.createdBy === "agent" && message.creationSource === "mcp"));
    const retryableMessageIds = new Set(
      queuedMessages
        .filter(
          (message) =>
            ((message.createdBy === "user" && message.scheduledTaskId === undefined) ||
              isUnattended(message)) &&
            message.notification === undefined &&
            message.delegatedCompletion === undefined,
        )
        .map((message) => message.id),
    );
    // A saved user message the provider never accepted stays available through the held queue.
    const retryableRuns = unstartedRuns.filter((run) => retryableMessageIds.has(run.userMessageId));
    const retryableRunIds = new Set(retryableRuns.map((run) => run.id));
    const heldMessageIds = new Set(retryableRuns.map((run) => run.userMessageId));
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
      if (item.type !== "user_message" || !heldMessageIds.has(item.messageId)) continue;
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
          ...(retryableRunIds.has(run.id) ? { startedAt: null } : {}),
          queueHeld: true,
          ...(retryableRuns.length === 0 ? {} : { queuePosition: index + 1 }),
        },
      });
    }

    let noticeOrdinal: number | undefined;
    for (const run of retryableRuns) {
      if (isUnattended(queuedMessages.find((message) => message.id === run.userMessageId))) {
        noticeOrdinal ??= yield* projections
          .getNextTurnItemOrdinal(projection.thread.id)
          .pipe(Effect.mapError(readError));
        const ordinal = noticeOrdinal++;
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            id: recoveryParkMarkerId(run.id),
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "system_notice",
            severity: "warning",
            message: "Recovery needs your decision before this message can be sent again.",
          },
        });
      }
      for (const attempt of projection.attempts.filter(
        (candidate) => candidate.id === run.activeAttemptId && candidate.status === "running",
      )) {
        events.push({
          id: yield* allocateEventId(),
          type: "run-attempt.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: attempt.rootNodeId,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...attempt, status: "pending", startedAt: null },
        });
      }
      for (const node of projection.nodes.filter(
        (candidate) => candidate.id === run.rootNodeId && candidate.status === "running",
      )) {
        events.push({
          id: yield* allocateEventId(),
          type: "node.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: node.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...node, status: "pending", startedAt: null },
        });
      }
    }

    return { runs, events };
  },
);
