import type { OrchestrationV2Command, OrchestrationV2DomainEvent } from "@goat/contracts";
import { recordThreadOpen } from "@goat/shared/paletteSearch";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Ref from "effect/Ref";
import type { OrchestratorDispatchError, OrchestratorProjectionError } from "./Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

type VisitCommand = Extract<OrchestrationV2Command, { readonly type: "thread.visit" }>;
type VisitEvent = Extract<OrchestrationV2DomainEvent, { readonly type: "thread.visit-recorded" }>;

export function makeDispatchThreadVisit({
  projectionStore,
  OrchestratorDispatchError: DispatchError,
  OrchestratorProjectionError: ProjectionError,
  emit,
}: {
  readonly projectionStore: Pick<ProjectionStoreV2Shape, "getThread">;
  readonly OrchestratorDispatchError: typeof OrchestratorDispatchError;
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: VisitCommand,
  ) => (
    event: Omit<VisitEvent, "id">,
  ) => Effect.Effect<OrchestrationV2DomainEvent, OrchestratorDispatchError>;
}) {
  return Effect.fn("orchestrationV2.dispatch.threadVisit")(function* (
    command: VisitCommand,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const thread = yield* projectionStore
      .getThread(command.threadId)
      .pipe(Effect.mapError((cause) => new ProjectionError({ threadId: command.threadId, cause })));
    if (thread.deletedAt !== null) {
      return yield* new DispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is deleted.`,
      });
    }
    const visitedAt = DateTime.make(command.visitedAt);
    if (Option.isNone(visitedAt)) {
      return yield* new DispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} visit time ${command.visitedAt} is not a valid timestamp.`,
      });
    }
    const movesForward =
      thread.lastVisitedAt === null ||
      DateTime.toEpochMillis(visitedAt.value) > DateTime.toEpochMillis(thread.lastVisitedAt);
    const occurredAt = yield* DateTime.now;
    // Opens are timed by the server clock so devices with skewed clocks agree.
    if (!movesForward && !command.opened) return;
    const opens = command.opened
      ? recordThreadOpen(
          thread.opens ?? null,
          DateTime.toEpochMillis(occurredAt),
          command.searchQuery,
        )
      : thread.opens;
    yield* emit(
      events,
      command,
    )({
      type: "thread.visit-recorded",
      threadId: command.threadId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt,
      payload: {
        lastVisitedAt: movesForward ? visitedAt.value : thread.lastVisitedAt,
        ...(opens === undefined ? {} : { opens }),
      },
    });
  });
}
