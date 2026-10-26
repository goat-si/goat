import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import { modelSelectionsEqual } from "@goat/shared/model";
import { latestExecutedRun } from "@goat/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";

import type { OrchestratorDispatchError, OrchestratorV2Error } from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";

/** Server-only precondition checked under the command lock before fallback changes a selection. */
export const FallbackSelectionSource = Context.Reference<
  | {
      readonly runId: RunId;
      readonly modelSelection: ModelSelection;
    }
  | undefined
>("goat/orchestration-v2/Orchestrator/FallbackSelectionSource", {
  defaultValue: () => undefined,
});

export interface FallbackSelectionDeps {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
  readonly stopReachedRun: (
    command: OrchestrationV2ServerCommand,
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<boolean, OrchestratorV2Error>;
  readonly mapDispatchError: (
    command: OrchestrationV2ServerCommand,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, OrchestratorDispatchError, R>;
  readonly OrchestratorDispatchError: typeof OrchestratorDispatchError;
}

/**
 * Fleet fallback's preconditions: a selection change or automated continuation only applies
 * while the failed run it answers is still the latest and nothing else claimed the thread.
 * Both run inside their dispatch span and have none of their own.
 */
export const makeFallbackSelection = (deps: FallbackSelectionDeps) => {
  const { projectionStore, emit, stopReachedRun, mapDispatchError, OrchestratorDispatchError } =
    deps;

  const refuseStaleFallbackSelection = Effect.fnUntraced(function* (
    command: OrchestrationV2ServerCommand,
    thread: OrchestrationV2AppThread,
  ) {
    if (command.type !== "thread.model-selection.set" && command.type !== "provider.switch") return;
    const source = yield* FallbackSelectionSource;
    if (source !== undefined) {
      const { runs, runtimeRequests } = yield* projectionStore
        .getThreadRecords(command.threadId, ["runs", "runtimeRequests"])
        .pipe(mapDispatchError(command));
      const latest = latestExecutedRun(runs);
      const now = yield* DateTime.now;
      if (
        latest?.id !== source.runId ||
        latest.status !== "failed" ||
        !modelSelectionsEqual(thread.modelSelection, source.modelSelection) ||
        (yield* stopReachedRun(command, command.threadId, source.runId)) ||
        runs.some((run) => run.status === "queued") ||
        runtimeRequests.some((request) => request.status === "pending") ||
        thread.archivedAt !== null ||
        thread.settledOverride === "settled" ||
        (thread.snoozedUntil != null &&
          DateTime.toEpochMillis(thread.snoozedUntil) > DateTime.toEpochMillis(now))
      )
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "The fallback source changed before model selection.",
        });
    }
  });

  /** True when the continuation is stale: it was recorded unchanged and must start nothing. */
  const acceptStaleAutomatedContinuation = Effect.fnUntraced(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
    projection: OrchestrationV2ThreadProjection,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    if (command.automatedContinuationOfRunId === undefined) return false;
    const now = yield* DateTime.now;
    const latest = latestExecutedRun(projection.runs);
    if (
      latest?.id !== command.automatedContinuationOfRunId ||
      (yield* stopReachedRun(command, command.threadId, latest.id)) ||
      (command.modelSelection !== undefined &&
        !modelSelectionsEqual(command.modelSelection, projection.thread.modelSelection)) ||
      latest.status !== "failed" ||
      projection.runs.some((run) => run.status === "queued") ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      projection.thread.settledOverride === "settled" ||
      projection.runtimeRequests.some((request) => request.status === "pending") ||
      (projection.thread.snoozedUntil != null &&
        DateTime.toEpochMillis(projection.thread.snoozedUntil) > DateTime.toEpochMillis(now))
    ) {
      // Accepted without change, so a replayed delivery does not retry.
      yield* emit(
        events,
        command,
      )({
        type: "thread.metadata-updated",
        threadId: command.threadId,
        occurredAt: now,
        payload: projection.thread,
      });
      return true;
    }
    return false;
  });

  return { refuseStaleFallbackSelection, acceptStaleAutomatedContinuation };
};
