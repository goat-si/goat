import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";

import type { OrchestratorDispatchError, OrchestratorV2Error } from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { hasLiveRun, isTerminalDelegatedTaskStatus } from "./OrchestratorRunState.ts";

export interface DelegatedCompletionAcceptanceDeps {
  readonly projectionStore: Pick<ProjectionStoreV2Shape, "getMessageCount">;
  readonly idAllocator: {
    readonly allocate: {
      readonly message: (input: {
        readonly threadId: OrchestrationV2ThreadProjection["thread"]["id"];
        readonly ordinal: number;
      }) => Effect.Effect<OrchestrationV2ConversationMessage["id"], unknown>;
    };
  };
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
  readonly mapDelegatedCompletionError: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, OrchestratorDispatchError, R>;
}

/**
 * Marks a wake the provider received delivered and reserves the next one for pending siblings.
 * A steer that restarts a wake's run settles the wake here, since that run's terminal never does.
 */
export const makeDelegatedCompletionAcceptance = (deps: DelegatedCompletionAcceptanceDeps) => {
  const { projectionStore, idAllocator, emit, mapDelegatedCompletionError } = deps;

  return Effect.fn("Orchestrator.acceptDelegatedCompletionDelivery")(function* (input: {
    readonly command: OrchestrationV2ServerCommand;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "messages" | "subagents"
    >;
    readonly messageId: OrchestrationV2ConversationMessage["id"];
    readonly now: DateTime.Utc;
  }) {
    const { projection, now } = input;
    const message = projection.messages.find((row) => row.id === input.messageId);
    const ownership = message?.delegatedCompletion;
    const parentRun = projection.runs.find((run) => run.id === ownership?.parentRunId);
    const cohort = parentRun?.delegatedCompletion;
    const delivery = cohort?.delivery;
    if (
      parentRun === undefined ||
      cohort === undefined ||
      cohort.disposition !== "open" ||
      delivery == null ||
      delivery.messageId !== input.messageId ||
      delivery.generation !== ownership?.generation
    ) {
      return undefined;
    }
    const threadId = projection.thread.id;
    const parentIsLive = hasLiveRun({ runs: [parentRun] });
    const pendingTaskIds =
      projection.thread.archivedAt === null && projection.thread.deletedAt === null
        ? projection.subagents
            .filter(
              (task) =>
                task.origin === "app_owned" &&
                task.runId === parentRun.id &&
                task.completionDelivery?.state === "pending" &&
                isTerminalDelegatedTaskStatus(task.status) &&
                (!parentIsLive || task.completionWake === "always"),
            )
            .map((task) => task.id)
        : [];
    const nextDelivery =
      pendingTaskIds.length === 0
        ? null
        : {
            generation: cohort.nextGeneration,
            messageId: yield* mapDelegatedCompletionError(
              idAllocator.allocate.message({
                threadId,
                ordinal:
                  (yield* mapDelegatedCompletionError(projectionStore.getMessageCount(threadId))) +
                  1,
              }),
            ),
            taskIds: pendingTaskIds,
          };
    const emitEvent = emit(input.events, input.command);
    const acceptedIds = new Set(delivery.taskIds);
    const pendingIds = new Set(pendingTaskIds);
    for (const task of projection.subagents) {
      const state = pendingIds.has(task.id)
        ? "claimed"
        : acceptedIds.has(task.id) && task.completionDelivery?.state === "claimed"
          ? "delivered"
          : undefined;
      if (state === undefined) continue;
      yield* emitEvent({
        type: "subagent.updated",
        threadId,
        runId: parentRun.id,
        nodeId: task.id,
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        occurredAt: now,
        payload: { ...task, completionDelivery: { state, observedByRunId: null }, updatedAt: now },
      });
    }
    yield* emitEvent({
      type: "run.updated",
      threadId,
      runId: parentRun.id,
      providerInstanceId: parentRun.providerInstanceId,
      occurredAt: now,
      payload: {
        ...parentRun,
        delegatedCompletion: {
          ...cohort,
          nextGeneration: cohort.nextGeneration + (nextDelivery === null ? 0 : 1),
          delivery: nextDelivery,
        },
      },
    });
    return parentRun.id;
  });
};
