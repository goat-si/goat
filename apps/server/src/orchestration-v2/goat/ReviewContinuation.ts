import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ReviewContinueCommand,
  OrchestrationV2Run,
  OrchestrationV2ServerCommand,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import type { ProviderAdapterV2 } from "@goat/provider-core/server/ProviderAdapter";
import type { IdAllocatorV2Derive } from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import type {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorV2Error,
} from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { isSlashPrompt, reviewContinuationRefusal } from "./ReviewRoundEvidence.ts";

type Events = Ref.Ref<Array<OrchestrationV2DomainEvent>>;
type Effects = Ref.Ref<Array<PendingOrchestrationEffectV2>>;
type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

/**
 * The Orchestrator closures continuing a review needs. The Orchestrator passes its error classes
 * in so this module never imports it at runtime; closures declared later arrive arrow-wrapped.
 */
export interface ReviewContinuationDeps {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly idAllocator: { readonly derive: IdAllocatorV2Derive };
  readonly getAdapter: (
    command: OrchestrationV2ServerCommand,
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterV2["Service"], OrchestratorV2Error>;
  readonly emit: (
    events: Events,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
  readonly dispatchMessage: (
    command: MessageDispatch,
    events: Events,
    effects: Effects,
  ) => Effect.Effect<unknown, OrchestratorV2Error>;
  readonly nextTurnItemOrdinal: (
    projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
  ) => Effect.Effect<number, OrchestratorV2Error>;
  readonly stopReachedRun: (
    command: OrchestrationV2ServerCommand,
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<boolean, OrchestratorV2Error>;
  readonly refuseAboveDispatchModeLimit: (
    command: OrchestrationV2ServerCommand,
    threadId: ThreadId,
    modes: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
  ) => Effect.Effect<void, OrchestratorV2Error>;
  readonly withThreadLock: <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly isBlockingRun: (run: OrchestrationV2Run) => boolean;
  readonly providerTurnForRun: (
    projection: Pick<OrchestrationV2ThreadProjection, "providerTurns" | "attempts">,
    run: OrchestrationV2Run,
  ) => OrchestrationV2ProviderTurn | undefined;
  readonly OrchestratorDispatchError: typeof OrchestratorDispatchError;
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
}

const TERMINAL_TASK_STATUSES = new Set<OrchestrationV2Subagent["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** delegated_task.review-continue: a new review task in an earlier review task's conversation. */
export const makeReviewContinuation = (deps: ReviewContinuationDeps) => {
  const { projectionStore, idAllocator, emit, OrchestratorDispatchError } = deps;

  /** The parent is the command's thread; the child lock nests inside it, as follow-up intake does. */
  const withReviewChildLock = <A, E, R>(
    command: OrchestrationV2ServerCommand,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | OrchestratorDispatchError, R> => {
    if (command.type !== "delegated_task.review-continue") return effect;
    if (command.childThreadId === command.threadId)
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "A review cannot continue in its parent thread.",
        }),
      );
    return deps.withThreadLock(command.childThreadId, effect);
  };

  const dispatchReviewContinue = Effect.fn("orchestrationV2.dispatch.reviewContinue")(function* (
    command: OrchestrationV2ReviewContinueCommand,
    events: Events,
    effects: Effects,
  ) {
    const refuse = (cause: string) =>
      new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause,
      });
    const load = (
      threadId: ThreadId,
      fields: Parameters<typeof projectionStore.getThreadRecords>[1],
    ) =>
      projectionStore
        .getThreadRecords(threadId, fields, { messageRoles: ["user"] })
        .pipe(
          Effect.mapError((cause) => new deps.OrchestratorProjectionError({ threadId, cause })),
        );
    if (isSlashPrompt(command.task))
      return yield* refuse("A continued review round needs a written brief, not a slash command.");
    const parent = yield* load(command.threadId, [
      "runs",
      "nodes",
      "subagents",
      "providerTurns",
      "attempts",
    ]);
    const parentRun = parent.runs.find((run) => run.id === command.parentRunId);
    if (parentRun === undefined || !deps.isBlockingRun(parentRun))
      return yield* refuse("Parent run " + command.parentRunId + " is not active.");
    if (yield* deps.stopReachedRun(command, command.threadId, parentRun.id))
      return yield* refuse("Parent run " + command.parentRunId + " is stopping.");
    const parentNode = parent.nodes.find((node) => node.id === command.parentNodeId);
    if (parentNode?.runId !== parentRun.id || parentRun.rootNodeId === null)
      return yield* refuse(
        "Parent node " + command.parentNodeId + " is not part of active run " + parentRun.id + ".",
      );
    const earlier = parent.subagents.find(
      (task) =>
        task.id === command.continueFrom &&
        task.origin === "app_owned" &&
        task.threadId === command.threadId,
    );
    if (earlier === undefined)
      return yield* refuse("Task " + command.continueFrom + " is not a task of this thread.");
    if (earlier.role !== "review") return yield* refuse("continueFrom must name a review task.");
    if (!TERMINAL_TASK_STATUSES.has(earlier.status))
      return yield* refuse("The earlier review round has not finished.");
    if (earlier.remote !== undefined || earlier.promotedAt !== undefined)
      return yield* refuse("The earlier review round no longer has a local reviewer thread here.");
    if (earlier.childThreadId !== command.childThreadId)
      return yield* refuse("childThreadId does not match the earlier review round.");
    const earlierSelection = earlier.modelSelection ?? {
      instanceId: earlier.providerInstanceId,
      model: earlier.model ?? "",
    };
    if (
      earlierSelection.instanceId !== command.modelSelection.instanceId ||
      earlierSelection.model !== command.modelSelection.model
    )
      return yield* refuse(
        "A continued review keeps the reviewer's provider and model (" +
          earlierSelection.instanceId +
          "/" +
          earlierSelection.model +
          ").",
      );
    const child = yield* load(command.childThreadId, [
      "runs",
      "attempts",
      "providerTurns",
      "providerThreads",
      "messages",
      "contextTransfers",
    ]);
    if (
      child.thread.lineage.parentThreadId !== command.threadId ||
      child.thread.lineage.relationshipToParent !== "subagent" ||
      child.thread.archivedAt !== null ||
      child.thread.deletedAt !== null
    )
      return yield* refuse("The earlier reviewer's thread is no longer an active child here.");
    const refusal = reviewContinuationRefusal({
      child: {
        ...child,
        providerThreads: child.providerThreads,
        activeProviderThreadId: child.thread.activeProviderThreadId,
      },
      earlier,
      isOriginal:
        child.thread.forkedFrom?.type === "node" && child.thread.forkedFrom.nodeId === earlier.id,
    });
    if (refusal !== undefined) return yield* refuse(refusal);
    const adapter = yield* deps.getAdapter(command, command.modelSelection.instanceId);
    const capabilities = yield* adapter
      .getCapabilities()
      .pipe(Effect.mapError((cause) => refuse(String(cause))));
    if (
      capabilities.sessions.executionLocation === "cloud" ||
      capabilities.sessions.followUp?.supported === false
    )
      return yield* refuse("This provider cannot continue a review in the same conversation.");
    yield* deps.refuseAboveDispatchModeLimit(command, child.thread.id, child.thread);

    const messageId = idAllocator.derive.delegatedTaskMessage({ commandId: command.commandId });
    yield* deps.dispatchMessage(
      {
        type: "message.dispatch",
        memoryGrantCeiling: command.memoryGrantCeiling ?? "none",
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        commandId: command.commandId,
        threadId: child.thread.id,
        senderThreadId: command.threadId,
        messageId,
        text: command.task,
        attachments: [],
        modelSelection: command.modelSelection,
        dispatchMode: { type: "start_immediately" },
      },
      events,
      effects,
    );
    const pending = yield* Ref.get(events);
    const run = pending
      .flatMap((event) =>
        (event.type === "run.created" || event.type === "run.updated") &&
        event.threadId === child.thread.id &&
        event.payload.userMessageId === messageId
          ? [event.payload]
          : [],
      )
      .at(-1);
    if (run === undefined) return yield* refuse("The continued review round did not start a run.");
    const now = yield* DateTime.now;
    const taskId = idAllocator.derive.delegatedTaskNode({ commandId: command.commandId });
    const status: OrchestrationV2Subagent["status"] =
      run.status === "queued" ? (run.queueHeld === true ? "idle" : "pending") : "running";
    const task: OrchestrationV2Subagent = {
      ...earlier,
      id: taskId,
      continuedFrom: earlier.id,
      runId: parentRun.id,
      parentNodeId: command.parentNodeId,
      parentModelSelection: parentRun.modelSelection,
      memoryGrantCeiling: command.memoryGrantCeiling ?? "none",
      createdBy: command.createdBy,
      driver: adapter.driver,
      providerInstanceId: run.providerInstanceId,
      providerThreadId: run.providerThreadId,
      model: run.modelSelection.model,
      modelSelection: run.modelSelection,
      prompt: command.task,
      title: command.title ?? earlier.title,
      reviewLedger: undefined,
      completionWake: command.completionWake,
      completionDelivery: { state: "pending", observedByRunId: null },
      promotedAt: undefined,
      workflow: undefined,
      progress: undefined,
      status,
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: taskId,
      threadId: command.threadId,
      runId: parentRun.id,
      parentNodeId: command.parentNodeId,
      rootNodeId: parentRun.rootNodeId,
      kind: "subagent",
      status,
      countsForRun: false,
      providerThreadId: run.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    const turnItem: OrchestrationV2TurnItem = {
      id: idAllocator.derive.delegatedTaskTurnItem({ commandId: command.commandId }),
      threadId: command.threadId,
      runId: parentRun.id,
      nodeId: taskId,
      providerThreadId: parentRun.providerThreadId,
      providerTurnId: deps.providerTurnForRun(parent, parentRun)?.id ?? null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: yield* deps.nextTurnItemOrdinal(parent),
      status,
      title: task.title ?? child.thread.title,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "subagent",
      subagentId: taskId,
      origin: "app_owned",
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      childThreadId: child.thread.id,
      prompt: command.task,
      result: null,
    };
    const emitEvent = emit(events, command);
    yield* emitEvent({
      type: "run.updated",
      threadId: child.thread.id,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, delegatedTaskId: taskId },
    });
    yield* emitEvent({
      type: "node.updated",
      threadId: command.threadId,
      runId: parentRun.id,
      nodeId: taskId,
      occurredAt: now,
      payload: node,
    });
    yield* emitEvent({
      type: "subagent.updated",
      threadId: command.threadId,
      runId: parentRun.id,
      nodeId: taskId,
      occurredAt: now,
      payload: task,
    });
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId: parentRun.id,
      nodeId: taskId,
      occurredAt: now,
      payload: turnItem,
    });
  });

  return { withReviewChildLock, dispatchReviewContinue };
};
