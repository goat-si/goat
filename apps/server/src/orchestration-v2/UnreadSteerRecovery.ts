import {
  CommandId,
  type RunId,
  type ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
} from "@goat/contracts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as ProjectionStore from "./ProjectionStore.ts";
import type * as EffectOutbox from "./EffectOutbox.ts";

export function makeUnreadSteerRecovery<EWrite, EDispatch>(input: {
  projectionStore: ProjectionStore.ProjectionStoreV2["Service"];
  effectOutbox: EffectOutbox.EffectOutboxV2["Service"];
  idAllocator: IdAllocator.IdAllocatorV2["Service"];
  isBlockingRun: (run: OrchestrationV2Run) => boolean;
  writeSystemEvents: (
    events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>,
  ) => Effect.Effect<void, EWrite>;
  dispatch: (command: OrchestrationV2ServerCommand) => Effect.Effect<unknown, EDispatch>;
}) {
  const { projectionStore, effectOutbox, idAllocator, isBlockingRun, writeSystemEvents, dispatch } =
    input;
  // A steer still pending after its run ended was never read: the provider marks one it read
  // completed, and one Stop dropped cancelled. It runs next, in its place among waiting messages.
  return Effect.fn("Orchestrator.requeueUnreadSteers")(function* (
    threadId: ThreadId,
    runIds?: ReadonlyArray<RunId>,
  ) {
    const { turnItems } = yield* projectionStore.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["user_message"],
      turnItemStatuses: ["pending"],
      ...(runIds === undefined ? {} : { turnItemRunIds: runIds }),
    });
    const unread = turnItems.filter(
      (item) =>
        item.type === "user_message" &&
        (item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer"),
    );
    if (unread.length === 0) return;
    const projection = yield* projectionStore.getThreadRecords(threadId, ["runs", "messages"], {
      messageIds: unread.flatMap((item) => (item.type === "user_message" ? [item.messageId] : [])),
    });
    const placed = [];
    for (const item of unread) {
      const run = projection.runs.find((candidate) => candidate.id === item.runId);
      const message = projection.messages.find(
        (candidate) =>
          item.type === "user_message" &&
          candidate.id === item.messageId &&
          candidate.runId === item.runId,
      );
      if (run === undefined || message === undefined || isBlockingRun(run)) continue;
      // Stop drops a steer it reached; say so, as the adapter does for steers it still held.
      const { turnItems: interrupts } = yield* projectionStore.getThreadRecords(
        threadId,
        ["turnItems"],
        { turnItemTypes: ["run_interrupt_request"], turnItemRunIds: [run.id] },
      );
      if (interrupts.length > 0) {
        const now = yield* DateTime.now;
        yield* writeSystemEvents([
          {
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...item, status: "cancelled" as const, completedAt: now, updatedAt: now },
          },
          {
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: {
              id: idAllocator.derive.runSignalTurnItem({
                runId: run.id,
                signal: `unread-steer:${message.id}`,
              }),
              threadId,
              runId: run.id,
              nodeId: item.nodeId,
              providerThreadId: item.providerThreadId ?? null,
              providerTurnId: item.providerTurnId ?? null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: item.ordinal,
              type: "system_notice" as const,
              status: "completed" as const,
              title: "Steer delivery not confirmed",
              message: `The agent did not confirm reading your steer before Stop. It may not have been delivered. Resend it if needed: "${message.text}"`,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          },
        ]);
        continue;
      }
      // The message's first steer effect recorded which runs were queued before it was sent; a
      // queued message that was promoted also stays behind only the runs queued before its own.
      const firstSteer = Option.getOrUndefined(
        yield* effectOutbox.firstSteer(threadId, message.id),
      )?.request;
      const steer = firstSteer?.type === "provider-turn.steer" ? firstSteer : undefined;
      const afterRunOrdinal = Math.max(
        0,
        Math.min(
          steer?.steerFollowUpAfterRunOrdinal ??
            Math.max(...projection.runs.map((candidate) => candidate.ordinal)),
          ...projection.runs.flatMap((candidate) =>
            candidate.userMessageId === message.id ? [candidate.ordinal - 1] : [],
          ),
        ),
      );
      placed.push({ item, run, message, steer, afterRunOrdinal });
    }
    // Each requeue starts the queue once it commits, so earlier places go first.
    placed.sort(
      (left, right) =>
        left.afterRunOrdinal - right.afterRunOrdinal || left.item.ordinal - right.item.ordinal,
    );
    for (const { run, message, steer, afterRunOrdinal } of placed) {
      yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:unread-steer:${run.id}:${message.id}`),
        threadId,
        messageId: message.id,
        memoryGrantCeiling: run.memoryGrantCeiling ?? "none",
        ...(message.ingress === undefined ? {} : { ingress: message.ingress }),
        steerFollowUpOfRunId: run.id,
        steerFollowUpAfterRunOrdinal: afterRunOrdinal,
        modelSelection: steer?.modelSelection ?? run.modelSelection,
        text: message.text,
        ...(message.context ? { context: message.context } : {}),
        attachments: message.attachments,
        ...(message.delegatedCompletion === undefined
          ? {}
          : { delegatedCompletion: message.delegatedCompletion }),
        ...(message.notification === undefined ? {} : { notification: message.notification }),
        dispatchMode: { type: "queue_after_active" },
        createdBy: message.createdBy,
        creationSource: message.creationSource,
        ...(message.scheduledTaskId === undefined
          ? {}
          : { scheduledTaskId: message.scheduledTaskId }),
        ...(message.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to requeue an unread steer", {
            threadId,
            messageId: message.id,
            cause,
          }),
        ),
      );
    }
  });
}

export const recoverUnreadSteerThreads = Effect.fn("Orchestrator.recoverUnreadSteers")(function* <
  E,
>(
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  lock: import("./ThreadCommandExecutor.ts").ThreadCommandExecutor["Service"],
  requeue: (threadId: ThreadId) => Effect.Effect<void, E>,
) {
  yield* projections.getRecoveryThreadIds("unread-steers").pipe(
    Effect.flatMap((threadIds) =>
      Effect.forEach(
        threadIds,
        (threadId) =>
          lock.withLock(threadId, requeue(threadId)).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to requeue an unread steer during recovery", {
                threadId,
                cause,
              }),
            ),
          ),
        { discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to inspect unread steers during recovery", { cause }),
    ),
  );
});

export const prepareUnreadSteerDispatch = <E1, E2>(
  command: OrchestrationV2ServerCommand,
  requeue: (threadId: ThreadId) => Effect.Effect<void, E1>,
  start: (threadId: ThreadId) => Effect.Effect<unknown, E2>,
) =>
  command.type === "message.dispatch" &&
  command.restartContinuationOfRunId === undefined &&
  command.steerFollowUpOfRunId === undefined &&
  ["start_immediately", "queue_after_active", "defer_start"].includes(command.dispatchMode.type)
    ? requeue(command.threadId).pipe(Effect.andThen(start(command.threadId)), Effect.asVoid)
    : Effect.void;

export const requeueEndedSteers = <E>(
  requeue: (threadId: ThreadId, runIds?: ReadonlyArray<RunId>) => Effect.Effect<void, E>,
  threadId: ThreadId,
  runId: RunId,
) =>
  requeue(threadId, [runId]).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to read unread steers", { threadId, cause }),
    ),
  );

export const startQueuedAfterUnreadSteer = Effect.fn("Orchestrator.startQueuedAfterUnreadSteer")(
  function* <E>(
    command: OrchestrationV2ServerCommand,
    projections: ProjectionStore.ProjectionStoreV2["Service"],
    start: (
      threadId: ThreadId,
      options: { endedRunId: RunId; failedRunId?: RunId },
    ) => Effect.Effect<unknown, E>,
  ) {
    if (command.type !== "message.dispatch" || command.steerFollowUpOfRunId === undefined) return;
    const sourceId = command.steerFollowUpOfRunId;
    const { runs } = yield* projections.getThreadRecords(command.threadId, ["runs"], {
      runIds: [sourceId],
    });
    const source = runs[0];
    yield* start(command.threadId, {
      endedRunId: sourceId,
      ...(source?.status === "failed" ? { failedRunId: sourceId } : {}),
    });
  },
);
