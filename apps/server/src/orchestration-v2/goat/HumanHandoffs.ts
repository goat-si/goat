import {
  HandoffError,
  isHandoffPending,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";

import { itemHandoff, transitionHandoff } from "../handoffState.ts";
import type {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorV2Error,
} from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";

/**
 * The Orchestrator closures that human handoffs need. The Orchestrator passes its
 * error classes in so this module never imports it at runtime.
 */
export interface HumanHandoffDeps {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
  readonly nextTurnItemOrdinal: (
    projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
  ) => Effect.Effect<number, OrchestratorV2Error>;
  readonly OrchestratorDispatchError: typeof OrchestratorDispatchError;
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
}

/** Creating and resolving the human handoff cards an agent asks a person to act on. */
export const makeHumanHandoffs = (deps: HumanHandoffDeps) => {
  const {
    projectionStore,
    emit,
    nextTurnItemOrdinal,
    OrchestratorDispatchError,
    OrchestratorProjectionError,
  } = deps;

  const dispatchHandoff = Effect.fn("orchestrationV2.dispatch.handoff")(function* (
    command: Extract<
      OrchestrationV2InternalCommand,
      { readonly type: "handoff.create" | "handoff.transition" }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const projection = yield* Effect.gen(function* () {
      if (command.type === "handoff.create")
        return yield* projectionStore.getThreadRecords(command.threadId, ["runs", "turnItems"], {
          turnItemTypes: ["human_handoff", "secret_request"],
          messageRoles: [],
        });
      const item = yield* projectionStore.getTurnItem({
        threadId: command.threadId,
        itemId: command.handoffId,
      });
      const records = yield* projectionStore.getThreadRecords(command.threadId, ["runs"], {
        runIds: item?.runId == null ? [] : [item.runId],
      });
      return { ...records, turnItems: item === null ? [] : [item] };
    }).pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
      ),
    );
    const now = yield* DateTime.now;
    const decide = Effect.gen(function* () {
      if (command.type === "handoff.create") {
        const existing = projection.turnItems.find((item) => item.id === command.handoff.handoffId);
        if (existing) return existing;
        const run = projection.runs.find((run) => run.id === command.runId);
        if (
          !run ||
          run.rootNodeId !== command.nodeId ||
          command.handoff.requestedBy.threadId !== command.threadId ||
          run.providerInstanceId !== command.handoff.requestedBy.providerInstanceId ||
          command.handoff.state !== "pending"
        )
          return yield* new HandoffError({ reason: "invalid_request" });
        const pending = projection.turnItems.flatMap((item) => {
          const handoff = itemHandoff(item);
          return handoff && isHandoffPending(handoff.state) ? [handoff] : [];
        });
        if (
          pending.some(
            (handoff) =>
              handoff.kind === command.handoff.kind &&
              handoff.target.environmentId === command.handoff.target.environmentId &&
              handoff.target.path === command.handoff.target.path &&
              handoff.dedupeKey === command.handoff.dedupeKey,
          )
        )
          return yield* new HandoffError({ reason: "conflict" });
        if (pending.length >= 3) return yield* new HandoffError({ reason: "limit_reached" });
        return {
          id: command.handoff.handoffId,
          threadId: command.threadId,
          runId: run.id,
          nodeId: command.nodeId,
          providerThreadId: run.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: yield* nextTurnItemOrdinal(projection),
          status: "waiting" as const,
          title: command.handoff.title,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "human_handoff" as const,
          handoff: command.handoff,
        };
      }
      const existing = projection.turnItems.find((item) => item.id === command.handoffId);
      const record = existing && itemHandoff(existing);
      if (!existing || !record) return yield* new HandoffError({ reason: "not_found" });
      const run = projection.runs.find((run) => run.id === existing.runId);
      const ended =
        run === undefined ||
        ["completed", "failed", "cancelled", "interrupted"].includes(run.status);
      const handoff = yield* transitionHandoff(record, command.state, command.actor, now, ended);
      // Secret completion is only recorded after SecretRequests stores the value.
      if (existing.type === "secret_request" && handoff.state === "completed")
        return yield* new HandoffError({ reason: "conflict" });
      const pending = isHandoffPending(handoff.state);
      return {
        ...existing,
        handoff,
        status: pending
          ? ("waiting" as const)
          : handoff.state === "completed"
            ? ("completed" as const)
            : ("cancelled" as const),
        completedAt: pending ? null : now,
        updatedAt: now,
        ...(existing.type === "secret_request"
          ? {
              secretStatus: pending
                ? ("pending" as const)
                : handoff.state === "declined"
                  ? ("declined" as const)
                  : ("cancelled" as const),
            }
          : {}),
      };
    });
    const item = yield* decide.pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );
    const existing = projection.turnItems.find((candidate) => candidate.id === item.id);
    // decide only returns handoff and secret request items, so this is a defect if it fails.
    const handoff = itemHandoff(item);
    if (handoff === undefined) return yield* Effect.die(new Error("Handoff item has no handoff."));
    if (existing && itemHandoff(existing)?.state === handoff.state) return;
    yield* emit(
      events,
      command,
    )({
      type: "turn-item.updated",
      threadId: command.threadId,
      ...(item.runId === null ? {} : { runId: item.runId }),
      ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
      providerInstanceId: handoff.requestedBy.providerInstanceId,
      occurredAt: now,
      payload: item,
    });
  });

  return { dispatchHandoff };
};
