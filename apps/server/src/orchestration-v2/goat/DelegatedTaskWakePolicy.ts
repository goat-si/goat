import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2Subagent,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";

import { hasLiveRun, isTerminalDelegatedTaskStatus } from "./OrchestratorRunState.ts";
import type { RemoteDelegatedTaskDeps } from "./RemoteDelegatedTasks.ts";

export type DelegatedTaskWakePolicyDeps = Pick<
  RemoteDelegatedTaskDeps,
  | "projectionStore"
  | "emit"
  | "planDelegatedCompletionDelivery"
  | "OrchestratorDispatchError"
  | "OrchestratorProjectionError"
>;

/** Changes when a delegated task's result wakes its parent. */
export const makeDelegatedTaskWakePolicy = (deps: DelegatedTaskWakePolicyDeps) => {
  const {
    projectionStore,
    emit,
    planDelegatedCompletionDelivery,
    OrchestratorDispatchError,
    OrchestratorProjectionError,
  } = deps;

  const dispatchWakePolicy = Effect.fn("orchestrationV2.dispatch.delegatedTaskWakePolicy")(
    function* (
      command: Extract<OrchestrationV2Command, { readonly type: "delegated_task.wake-policy" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      const parentProjection = yield* projectionStore
        .getThreadRecords(
          command.parentThreadId,
          ["subagents", "runs", "messages", "providerTurns"],
          {
            omitSettledSubagents: { except: [command.taskId] },
          },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProjectionError({
                threadId: command.parentThreadId,
                cause,
              }),
          ),
        );
      const task = parentProjection.subagents.find(
        (candidate) => candidate.id === command.taskId && candidate.origin === "app_owned",
      );
      if (task === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Delegated task ${command.taskId} is not an app-owned task of thread ${command.parentThreadId}.`,
        });
      }
      if (task.completionWake === command.completionWake) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Delegated task ${command.taskId} already wakes the parent with completionWake ${command.completionWake}.`,
        });
      }
      const now = yield* DateTime.now;
      const emitEvent = emit(events, command);
      const updatedTask: OrchestrationV2Subagent = {
        ...task,
        completionWake: command.completionWake,
        updatedAt: now,
      };
      // Finalization already offered for ended parent runs; another offer would duplicate the wake.
      const parentRun =
        task.runId === null
          ? undefined
          : parentProjection.runs.find((candidate) => candidate.id === task.runId);
      const completionPlan =
        command.completionWake === "always" &&
        isTerminalDelegatedTaskStatus(task.status) &&
        parentRun !== undefined &&
        hasLiveRun({ runs: [parentRun] })
          ? yield* planDelegatedCompletionDelivery({
              parentProjection,
              parentRun,
              task: updatedTask,
              updatedTask,
              now,
            })
          : undefined;
      yield* emitEvent({
        type: "subagent.updated",
        threadId: command.parentThreadId,
        ...(task.runId === null ? {} : { runId: task.runId }),
        nodeId: task.id,
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        occurredAt: now,
        payload: completionPlan?.task ?? updatedTask,
      });
      if (completionPlan === undefined) {
        return;
      }
      if (completionPlan.parentRun !== undefined) {
        yield* emitEvent({
          type: "run.updated",
          threadId: command.parentThreadId,
          runId: completionPlan.parentRun.id,
          ...(completionPlan.parentRun.rootNodeId === null
            ? {}
            : { nodeId: completionPlan.parentRun.rootNodeId }),
          providerInstanceId: completionPlan.parentRun.providerInstanceId,
          occurredAt: now,
          payload: completionPlan.parentRun,
        });
      }
      if (completionPlan.message !== undefined) {
        yield* emitEvent({
          type: "message.updated",
          threadId: command.parentThreadId,
          ...(completionPlan.message.runId === null ? {} : { runId: completionPlan.message.runId }),
          ...(completionPlan.message.nodeId === null
            ? {}
            : { nodeId: completionPlan.message.nodeId }),
          providerInstanceId:
            completionPlan.parentRun?.providerInstanceId ??
            parentProjection.thread.providerInstanceId,
          occurredAt: now,
          payload: completionPlan.message,
        });
      }
      return completionPlan.parentRun?.id;
    },
  );

  return { dispatchWakePolicy };
};
