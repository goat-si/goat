import { OrchestratorMcpFailure, type ProjectId, type ScheduledTaskId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export function scheduledTaskReads<
  Caller extends {
    readonly parent: { readonly thread: { readonly projectId: ProjectId } } | undefined;
  },
>(
  scheduledTasks: ScheduledTaskService["Service"],
  loadCaller: (scope: McpInvocationScope) => Effect.Effect<Caller, OrchestratorMcpFailure>,
) {
  const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
    new OrchestratorMcpFailure({ code, message });

  const readScheduledTasks = Effect.fn("OrchestratorMcpService.readScheduledTasks")(function* (
    scope: McpInvocationScope,
    requestedProjectId?: ProjectId,
  ) {
    const caller = yield* loadCaller(scope);
    if (scope.reauthorize !== undefined) {
      yield* scope
        .reauthorize([])
        .pipe(
          Effect.mapError(() =>
            failure("capability_denied", "The calling MCP credential is no longer active."),
          ),
        );
    }
    const projectId = requestedProjectId ?? caller.parent?.thread.projectId;
    const { tasks } = yield* scheduledTasks
      .list()
      .pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Could not list scheduled tasks: ${error.message}`),
        ),
      );
    return {
      ...caller,
      tasks: tasks.filter((task) => projectId === undefined || task.projectId === projectId),
    };
  });

  const listScheduledTaskDeliveries = Effect.fn(
    "OrchestratorMcpService.listScheduledTaskDeliveries",
  )(function* (scope: McpInvocationScope, id: ScheduledTaskId) {
    const { tasks, parent } = yield* readScheduledTasks(scope);
    if (!tasks.some((task) => task.id === id)) {
      return yield* failure("task_not_found", `Scheduled task ${id} was not found.`);
    }
    return yield* scheduledTasks
      .listWebhookDeliveries({ id, acceptAnyOutcome: true }, parent?.thread.projectId)
      .pipe(
        Effect.mapError(() => failure("orchestration_error", "Could not list webhook deliveries.")),
      );
  });

  return { readScheduledTasks, listScheduledTaskDeliveries };
}
