import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
  ThreadPullRequestKey,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";

import type { OrchestratorProjectionError, OrchestratorV2Error } from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { dropQueuedPullRequestWakes as dropQueuedWakes } from "./PullRequestDigest.ts";

export interface PullRequestWakeDropsDeps {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
  readonly dispatchQueuedRunCancel: (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-run.cancel" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) => Effect.Effect<unknown, OrchestratorV2Error>;
  /** Passed in so this module never imports the Orchestrator at runtime. */
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
}

export const makePullRequestWakeDrops = ({
  projectionStore,
  emit,
  dispatchQueuedRunCancel,
  OrchestratorProjectionError,
}: PullRequestWakeDropsDeps) => {
  // A stopped watch, or one whose pull request merged or closed, drops the wakes it queued;
  // a push drops only the check results of earlier heads.
  const dropQueuedPullRequestWakes = (
    command: Extract<OrchestrationV2ServerCommand, ThreadPullRequestKey>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    headSha?: string,
  ) => {
    const read = Effect.mapError(
      (cause: unknown) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
    );
    return dropQueuedWakes(
      command,
      read(projectionStore.getThreadRecords(command.threadId, ["runs"])),
      (runId) => read(projectionStore.getRunMessage(command.threadId, runId)),
      (change) =>
        "update" in change
          ? emit(events, command)(change.update).pipe(Effect.asVoid)
          : dispatchQueuedRunCancel(
              {
                type: "queued-run.cancel",
                commandId: command.commandId,
                threadId: command.threadId,
                runId: change.cancel,
              },
              events,
            ),
      headSha,
    );
  };

  return { dropQueuedPullRequestWakes };
};
