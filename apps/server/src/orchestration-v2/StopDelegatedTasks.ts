import { CommandId, isOrchestrationV2WorkActive, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as Orchestrator from "./Orchestrator.ts";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";
import type {
  ThreadManagementProviderInstanceDisabledError,
  ThreadManagementWorktreeUnrestorableError,
} from "./ThreadManagementErrors.ts";
import { childNeedsStop } from "./ChildNeedsStop.ts";

/** The `stopDelegatedTasks` walk over the given dispatcher, shared with test harnesses. */
export function makeStopDelegatedTasks(deps: {
  readonly dispatch: ThreadManagementServiceShape["dispatch"];
  readonly getThreadRecords: Orchestrator.OrchestratorV2Shape["getThreadRecords"];
}): ThreadManagementServiceShape["stopDelegatedTasks"] {
  const stopDelegatedTasks: ThreadManagementServiceShape["stopDelegatedTasks"] = Effect.fn(
    "ThreadManagementService.stopDelegatedTasks",
  )(function* (input) {
    const { subagents } = yield* deps.getThreadRecords(input.threadId, ["subagents"]);
    const failures: Array<
      | Orchestrator.OrchestratorV2Error
      | ThreadManagementProviderInstanceDisabledError
      | ThreadManagementWorktreeUnrestorableError
    > = [];
    const stopCascadeFrom = input.stopCascadeFrom ?? input.threadId;
    const activeChildThreadIds = new Set(
      subagents.flatMap((task) =>
        task.origin === "app_owned" &&
        task.childThreadId !== null &&
        isOrchestrationV2WorkActive(task.status)
          ? [task.childThreadId]
          : [],
      ),
    );
    const stoppedChildThreadIds = new Set<ThreadId>();
    for (const task of subagents) {
      if (
        task.origin !== "app_owned" ||
        task.childThreadId === null ||
        task.promotedAt !== undefined
      )
        continue;
      const threadId = task.childThreadId;
      if (input.childThreadIds !== undefined && !input.childThreadIds.includes(threadId)) continue;
      if (stoppedChildThreadIds.has(threadId)) continue;
      stoppedChildThreadIds.add(threadId);
      const recordFailure = (
        error:
          | Orchestrator.OrchestratorV2Error
          | ThreadManagementProviderInstanceDisabledError
          | ThreadManagementWorktreeUnrestorableError,
      ) =>
        Effect.logWarning("Unable to stop a delegated task", {
          parentThreadId: input.threadId,
          threadId,
          error,
        }).pipe(Effect.andThen(Effect.sync(() => failures.push(error))));
      yield* Effect.gen(function* () {
        let shouldStop = activeChildThreadIds.has(threadId);
        let hasAppOwnedChildren = true;
        if (!shouldStop) {
          const child = yield* deps.getThreadRecords(
            threadId,
            ["runs", "providerThreads", "turnItems", "subagents"],
            {
              turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
              turnItemStatuses: ["pending", "running", "waiting"],
            },
          );
          shouldStop = childNeedsStop(child);
          hasAppOwnedChildren = child.subagents.some(
            (childTask) => childTask.origin === "app_owned" && childTask.promotedAt === undefined,
          );
        }
        if (shouldStop)
          yield* deps
            .dispatch({
              type: "thread.stop",
              commandId: CommandId.make(`${input.commandId}:stop:${threadId}`),
              threadId,
              stopDelegatedTasks: false,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
              stopCascadeFrom,
            })
            .pipe(Effect.catch(recordFailure));
        if (hasAppOwnedChildren)
          yield* stopDelegatedTasks({
            ...input,
            threadId,
            childThreadIds: undefined,
            stopCascadeFrom,
          });
      }).pipe(Effect.catch(recordFailure));
    }
    if (failures[0] !== undefined) return yield* failures[0];
  });
  return stopDelegatedTasks;
}
