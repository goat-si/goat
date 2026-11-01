import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2ServerCommand,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@goat/contracts";
import type { IdAllocatorV2Derive } from "@goat/provider-core/server/IdAllocator";
import { subagentThreadTitle } from "@goat/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";

import type {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorV2Error,
} from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";

type Events = Ref.Ref<Array<OrchestrationV2DomainEvent>>;

/**
 * The Orchestrator closures that remote delegation needs. The Orchestrator
 * passes its error classes in so this module never imports it at runtime.
 */
export interface RemoteDelegatedTaskDeps {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly idAllocator: { readonly derive: IdAllocatorV2Derive };
  readonly emit: (
    events: Events,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
  readonly nextTurnItemOrdinal: (
    projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
  ) => Effect.Effect<number, OrchestratorV2Error>;
  readonly stopReachedRun: (
    command: OrchestrationV2ServerCommand,
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<boolean, OrchestratorV2Error>;
  readonly planDelegatedCompletionDelivery: (input: {
    readonly parentProjection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "messages" | "runs" | "subagents" | "providerTurns"
    >;
    readonly parentRun: OrchestrationV2Run | undefined;
    readonly task: OrchestrationV2Subagent;
    readonly updatedTask: OrchestrationV2Subagent;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<
    {
      readonly task: OrchestrationV2Subagent;
      readonly parentRun: OrchestrationV2Run | undefined;
      readonly message: OrchestrationV2ConversationMessage | undefined;
    },
    OrchestratorV2Error
  >;
  readonly isBlockingRun: (run: OrchestrationV2Run) => boolean;
  readonly isTerminalDelegatedTaskStatus: (status: OrchestrationV2Subagent["status"]) => boolean;
  readonly providerTurnForRun: (
    projection: Pick<OrchestrationV2ThreadProjection, "providerTurns" | "attempts">,
    run: OrchestrationV2Run,
  ) => OrchestrationV2ProviderTurn | undefined;
  readonly OrchestratorDispatchError: typeof OrchestratorDispatchError;
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
}

/** Commands for delegated tasks that run on another GOAT host. */
export const makeRemoteDelegatedTasks = (deps: RemoteDelegatedTaskDeps) => {
  const {
    projectionStore,
    idAllocator,
    emit,
    nextTurnItemOrdinal,
    stopReachedRun,
    planDelegatedCompletionDelivery,
    isBlockingRun,
    isTerminalDelegatedTaskStatus,
    providerTurnForRun,
    OrchestratorDispatchError,
    OrchestratorProjectionError,
  } = deps;

  const dispatchRemoteTaskRegister = Effect.fn("orchestrationV2.dispatch.remoteTaskRegister")(
    function* (
      command: Extract<
        OrchestrationV2ServerCommand,
        { readonly type: "delegated_task.remote.register" }
      >,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      const parent = yield* projectionStore
        .getThreadRecords(command.parentThreadId, [
          "runs",
          "nodes",
          "subagents",
          "providerThreads",
          "providerTurns",
          "attempts",
        ])
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.parentThreadId, cause }),
          ),
        );
      const run = parent.runs.find((value) => value.id === command.parentRunId);
      if (
        run === undefined ||
        !isBlockingRun(run) ||
        (yield* stopReachedRun(command, command.parentThreadId, run.id))
      )
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Remote task parent run is not active.",
        });
      const node = parent.nodes.find((value) => value.id === command.parentNodeId);
      if (node === undefined || node.runId !== run.id || run.rootNodeId === null)
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Remote task parent node does not belong to the active run.",
        });
      const now = command.createdAt ?? (yield* DateTime.now);
      const taskId = idAllocator.derive.delegatedTaskNode({ commandId: command.commandId });
      const title = subagentThreadTitle({
        parentTitle: parent.thread.title,
        prompt: command.task,
        ...(command.title === undefined ? {} : { title: command.title }),
        ordinal: parent.subagents.length + 1,
      });
      const task: OrchestrationV2Subagent = {
        memoryGrantCeiling: command.memoryGrantCeiling ?? "none",
        id: taskId,
        threadId: command.parentThreadId,
        runId: run.id,
        parentNodeId: command.parentNodeId,
        origin: "app_owned",
        createdBy: command.createdBy,
        driver: command.driver,
        providerInstanceId: command.modelSelection.instanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        remote: command.remote,
        prompt: command.task,
        title: command.title ?? null,
        model: command.modelSelection.model,
        modelSelection: command.modelSelection,
        ...(command.role === undefined ? {} : { role: command.role }),
        parentModelSelection: run.modelSelection,
        ...(command.completionWake === undefined ? {} : { completionWake: command.completionWake }),
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const taskNode: OrchestrationV2ExecutionNode = {
        id: taskId,
        threadId: command.parentThreadId,
        runId: run.id,
        parentNodeId: command.parentNodeId,
        rootNodeId: run.rootNodeId,
        kind: "subagent",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const taskItem: OrchestrationV2TurnItem = {
        id: idAllocator.derive.delegatedTaskTurnItem({ commandId: command.commandId }),
        threadId: command.parentThreadId,
        runId: run.id,
        nodeId: taskId,
        providerThreadId: run.providerThreadId,
        providerTurnId: providerTurnForRun(parent, run)?.id ?? null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal(parent),
        status: "running",
        title: command.title ?? title,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent",
        subagentId: taskId,
        origin: "app_owned",
        driver: command.driver,
        providerInstanceId: command.modelSelection.instanceId,
        childThreadId: null,
        prompt: command.task,
        result: null,
      };
      const emitEvent = emit(events, command);
      yield* emitEvent({
        type: "node.updated",
        threadId: command.parentThreadId,
        runId: run.id,
        nodeId: taskId,
        driver: command.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: taskNode,
      });
      yield* emitEvent({
        type: "subagent.updated",
        threadId: command.parentThreadId,
        runId: run.id,
        nodeId: taskId,
        driver: command.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: task,
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.parentThreadId,
        runId: run.id,
        nodeId: taskId,
        driver: command.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: taskItem,
      });
    },
  );

  const dispatchRemoteTaskUpdate = Effect.fn("orchestrationV2.dispatch.remoteTaskUpdate")(
    function* (
      command: Extract<
        OrchestrationV2ServerCommand,
        {
          readonly type: "delegated_task.remote.progress" | "delegated_task.remote.result";
        }
      >,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      const projection = yield* projectionStore
        .getThreadRecords(
          command.parentThreadId,
          ["runs", "messages", "subagents", "providerTurns", "nodes", "turnItems"],
          { turnItemTypes: ["subagent"], messageRoles: ["user"] },
        )
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.parentThreadId, cause }),
          ),
        );
      const task = projection.subagents.find((row) => row.id === command.taskId);
      // A launching row may survive a crash before beforeLaunch registered it.
      // Recovery must commit an empty successful receipt, not a sticky rejection.
      if (task === undefined) return;
      if (
        task?.origin !== "app_owned" ||
        task.remote === undefined ||
        task.remote.correlationId !== command.correlationId ||
        task.childThreadId !== null
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Remote result does not match this parent's delegated task binding.",
        });
      }
      // First terminal wins; replay, late progress and cancel races cannot reopen it.
      if (isTerminalDelegatedTaskStatus(task.status)) return;
      const now = yield* DateTime.now;
      const terminal = command.type === "delegated_task.remote.result";
      const status = command.type === "delegated_task.remote.result" ? command.status : "running";
      const updatedTask: OrchestrationV2Subagent =
        command.type === "delegated_task.remote.result"
          ? {
              ...task,
              status: command.status,
              result: command.summary,
              completedAt: now,
              updatedAt: now,
            }
          : {
              ...task,
              status: "running",
              updatedAt: now,
              ...(command.summary === undefined ? {} : { progress: command.summary }),
              remote: { ...task.remote, threadId: command.remoteThreadId ?? task.remote.threadId },
            };
      if (
        command.type === "delegated_task.remote.progress" &&
        task.remote.threadId !== null &&
        command.remoteThreadId !== null &&
        task.remote.threadId !== command.remoteThreadId
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Remote thread identity changed for an existing delegation.",
        });
      }
      const parentRun = projection.runs.find((run) => run.id === task.runId);
      const plan = terminal
        ? yield* planDelegatedCompletionDelivery({
            parentProjection: projection,
            parentRun,
            task,
            updatedTask,
            now,
          })
        : undefined;
      const emitEvent = emit(events, command);
      yield* emitEvent({
        type: "subagent.updated",
        threadId: command.parentThreadId,
        ...(task.runId === null ? {} : { runId: task.runId }),
        nodeId: task.id,
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        occurredAt: now,
        payload: plan?.task ?? updatedTask,
      });
      const node = projection.nodes.find((row) => row.id === task.id);
      if (node !== undefined)
        yield* emitEvent({
          type: "node.updated",
          threadId: command.parentThreadId,
          nodeId: node.id,
          driver: task.driver,
          ...(node.runId === null ? {} : { runId: node.runId }),
          occurredAt: now,
          payload: { ...node, status, completedAt: terminal ? now : node.completedAt },
        });
      const item = projection.turnItems.find(
        (row) => row.type === "subagent" && row.subagentId === task.id,
      );
      if (item?.type === "subagent")
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.parentThreadId,
          nodeId: task.id,
          driver: task.driver,
          ...(item.runId === null ? {} : { runId: item.runId }),
          occurredAt: now,
          payload: {
            ...item,
            status,
            result: updatedTask.result,
            ...(updatedTask.progress === undefined ? {} : { progress: updatedTask.progress }),
            completedAt: terminal ? now : item.completedAt,
            updatedAt: now,
          },
        });
      if (plan?.parentRun !== undefined)
        yield* emitEvent({
          type: "run.updated",
          threadId: command.parentThreadId,
          runId: plan.parentRun.id,
          ...(plan.parentRun.rootNodeId === null ? {} : { nodeId: plan.parentRun.rootNodeId }),
          providerInstanceId: plan.parentRun.providerInstanceId,
          occurredAt: now,
          payload: plan.parentRun,
        });
      if (plan?.message !== undefined)
        yield* emitEvent({
          type: "message.updated",
          threadId: command.parentThreadId,
          ...(plan.message.runId === null ? {} : { runId: plan.message.runId }),
          ...(plan.message.nodeId === null ? {} : { nodeId: plan.message.nodeId }),
          providerInstanceId:
            plan.parentRun?.providerInstanceId ?? projection.thread.providerInstanceId,
          occurredAt: now,
          payload: plan.message,
        });
    },
  );

  return { dispatchRemoteTaskRegister, dispatchRemoteTaskUpdate };
};
