import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@goat/contracts";
import { latestExecutedRun } from "@goat/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { OrchestratorDispatchError, OrchestratorProjectionError } from "./Orchestrator.ts";
import type { ProjectionRecords, ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import { isBlockingRun } from "./goat/OrchestratorRunState.ts";
import {
  preparedRunState,
  WORKSPACE_PREPARATION_INPUT,
  withoutPreparationResult,
} from "./preparationItem.ts";

export const dispatchPreparedRunRetry = Effect.fn("Orchestrator.dispatchPreparedRunRetry")(
  function* ({
    command,
    initialProjection,
    projectionStore,
    emitEvent,
    dispatchError,
    discardPreviousDelivery,
  }: {
    readonly command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.retry" }>;
    readonly initialProjection: Effect.Effect<
      ProjectionRecords<"runs" | "attempts" | "nodes" | "providerThreads" | "turnItems">,
      OrchestratorProjectionError
    >;
    readonly projectionStore: ProjectionStoreV2Shape;
    readonly emitEvent: <Event extends OrchestrationV2DomainEvent>(
      event: Omit<Event, "id">,
    ) => Effect.Effect<Event, OrchestratorDispatchError>;
    readonly discardPreviousDelivery: (
      parentThreadId: ThreadId,
      taskId: NodeId,
    ) => Effect.Effect<void, OrchestratorDispatchError | OrchestratorProjectionError>;
    readonly dispatchError: (cause: unknown) => OrchestratorDispatchError;
  }) {
    const projection = yield* initialProjection;
    const state = preparedRunState(command, projection);
    const failureItem = projection.turnItems.find(
      (candidate): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "error" }> =>
        candidate.type === "error" &&
        candidate.status === "failed" &&
        candidate.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
    );
    if (
      state === null ||
      state.run.workspacePreparation === undefined ||
      failureItem === undefined ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null
    ) {
      return yield* dispatchError(
        `Run ${command.runId} has no failed workspace preparation to retry.`,
      );
    }
    if (projection.runs.some((run) => run.id !== state.run.id && isBlockingRun(run))) {
      return yield* dispatchError("Another run is active on this thread.");
    }
    const now = yield* DateTime.now;
    const scope = {
      threadId: command.threadId,
      runId: state.run.id,
      nodeId: state.rootNode.id,
      providerInstanceId: state.run.providerInstanceId,
      occurredAt: now,
    };
    yield* emitEvent({
      ...scope,
      type: "turn-item.updated",
      payload: { ...failureItem, status: "cancelled", updatedAt: now },
    });
    yield* emitEvent({
      ...scope,
      type: "turn-item.updated",
      payload: {
        ...withoutPreparationResult(state.preparationItem),
        status: "running",
        title: WORKSPACE_PREPARATION_INPUT,
        completedAt: null,
        updatedAt: now,
      },
    });
    yield* emitEvent({
      ...scope,
      type: "run-attempt.updated",
      payload: { ...state.attempt, status: "pending", completedAt: null },
    });
    yield* emitEvent({
      ...scope,
      type: "node.updated",
      payload: { ...state.rootNode, status: "pending", completedAt: null },
    });
    yield* emitEvent({
      ...scope,
      type: "run.updated",
      payload: {
        ...state.run,
        status: "preparing",
        terminationCause: undefined,
        completedAt: null,
      },
    });
    const parentThreadId = projection.thread.lineage.parentThreadId;
    const forkedFrom = projection.thread.forkedFrom;
    if (
      parentThreadId !== null &&
      projection.thread.lineage.relationshipToParent === "subagent" &&
      forkedFrom?.type === "node"
    ) {
      const taskId = state.run.delegatedTaskId ?? forkedFrom.nodeId;
      const parent = yield* projectionStore
        .getThreadRecords(parentThreadId, ["subagents", "nodes", "turnItems", "contextTransfers"], {
          subagentIds: [taskId],
          nodeIds: [taskId],
          turnItemNodeIds: [taskId],
          turnItemTypes: ["subagent"],
        })
        .pipe(Effect.mapError(dispatchError));
      const [task] = parent.subagents;
      if (
        task?.origin === "app_owned" &&
        task.childThreadId === command.threadId &&
        task.status === "failed" &&
        task.cancelledRunId === undefined &&
        task.promotedAt === undefined &&
        parent.contextTransfers.some(
          (transfer) =>
            transfer.type === "subagent_result" &&
            transfer.sourceThreadId === command.threadId &&
            transfer.targetThreadId === parentThreadId &&
            (transfer.sourcePoint.runId === state.run.id ||
              transfer.sourcePoint.runId === undefined) &&
            transfer.sourcePoint.turnItemId === failureItem.id,
        )
      ) {
        const taskScope = {
          threadId: parentThreadId,
          ...(task.runId === null ? {} : { runId: task.runId }),
          nodeId: task.id,
          driver: task.driver,
          occurredAt: now,
        };
        if (
          task.completionDelivery?.state === "pending" ||
          task.completionDelivery?.state === "claimed"
        ) {
          yield* discardPreviousDelivery(parentThreadId, task.id);
        }
        // Reopen the task and retry the run in one transaction so recovery can see the missing result.
        yield* emitEvent({
          ...taskScope,
          type: "subagent.updated",
          payload: {
            ...task,
            status: "running",
            completionDelivery:
              task.completionDelivery?.state === "disposed"
                ? task.completionDelivery
                : { state: "pending", observedByRunId: null },
            result: null,
            completedAt: null,
            updatedAt: now,
          },
        });
        const [node] = parent.nodes;
        if (node !== undefined) {
          yield* emitEvent({
            ...taskScope,
            type: "node.updated",
            payload: { ...node, status: "running", completedAt: null },
          });
        }
        const [item] = parent.turnItems;
        if (item?.type === "subagent") {
          yield* emitEvent({
            ...taskScope,
            type: "turn-item.updated",
            payload: {
              ...item,
              status: "running",
              result: null,
              completedAt: null,
              updatedAt: now,
            },
          });
        }
      }
    }
    // Messages held when this preparation failed follow the run again. A hold
    // from a later run (a stop, say) is not this failure's to release.
    const failureOwnsQueue = latestExecutedRun(projection.runs)?.id === state.run.id;
    for (const run of projection.runs) {
      if (!failureOwnsQueue || run.status !== "queued" || run.queueHeld !== true) continue;
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...run, queueHeld: false },
      });
    }
  },
);
