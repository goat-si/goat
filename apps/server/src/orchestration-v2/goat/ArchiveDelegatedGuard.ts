import { isOrchestrationV2WorkActive, type OrchestrationV2ServerCommand } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as Orchestrator from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";

export const guardArchiveDelegates = Effect.fn("Orchestrator.guardArchiveDelegates")(
  function* (input: {
    readonly command: OrchestrationV2ServerCommand;
    readonly projections: ProjectionStoreV2Shape;
    readonly DispatchError: typeof Orchestrator.OrchestratorDispatchError;
  }) {
    const { command, projections, DispatchError } = input;
    if (command.type !== "thread.archive") return;
    const records = yield* projections
      .getThreadRecords(command.threadId, ["subagents"])
      .pipe(
        Effect.mapError(
          (cause) =>
            new DispatchError({ commandId: command.commandId, commandType: command.type, cause }),
        ),
      );
    if (
      records.subagents.some(
        (task) =>
          task.origin === "app_owned" &&
          task.childThreadId !== null &&
          isOrchestrationV2WorkActive(task.status),
      )
    ) {
      return yield* new DispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} has running delegated tasks. Wait for them or cancel them before archiving.`,
      });
    }
  },
);
