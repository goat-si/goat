import {
  HandoffError,
  isHandoffPending,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import type { IdAllocatorV2Derive } from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";

import { itemHandoff } from "../handoffState.ts";
import { providerTurnForRun } from "../ProviderContextBoundaries.ts";
import type { HumanHandoffDeps } from "./HumanHandoffs.ts";
import { secretRequestOptionalFields } from "./secretRequestFields.ts";

/** The thread-created and secret-request turn items a parent or agent thread records. */
export const makeThreadRecordDispatches = (
  deps: HumanHandoffDeps & { readonly idAllocator: { readonly derive: IdAllocatorV2Derive } },
) => {
  const {
    projectionStore,
    emit,
    nextTurnItemOrdinal,
    idAllocator,
    OrchestratorDispatchError,
    OrchestratorProjectionError,
  } = deps;

  const dispatchCreatedThreadRecord = Effect.fn("orchestrationV2.dispatch.createdThreadRecord")(
    function* (
      command: Extract<OrchestrationV2Command, { readonly type: "thread.created.record" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      const parentProjection = yield* projectionStore
        .getThreadRecords(
          command.parentThreadId,
          ["runs", "nodes", "turnItems", "attempts", "providerTurns"],
          { turnItemTypes: [], messageRoles: ["user"] },
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
      const targetProjection = yield* projectionStore
        .getThreadRecords(
          command.targetThreadId,
          ["runs", "nodes", "turnItems", "attempts", "providerTurns"],
          { turnItemTypes: [], messageRoles: ["user"] },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProjectionError({
                threadId: command.targetThreadId,
                cause,
              }),
          ),
        );
      const parentRun = parentProjection.runs.find(
        (candidate) => candidate.id === command.parentRunId,
      );
      const parentNode = parentProjection.nodes.find(
        (candidate) => candidate.id === command.parentNodeId,
      );
      if (
        parentRun === undefined ||
        parentNode === undefined ||
        parentNode.runId !== command.parentRunId ||
        parentRun.rootNodeId !== command.parentNodeId
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Parent node ${command.parentNodeId} is not the root of run ${command.parentRunId}.`,
        });
      }
      if (parentProjection.thread.projectId !== targetProjection.thread.projectId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Target thread ${command.targetThreadId} belongs to another project.`,
        });
      }
      if (
        command.targetRunId !== null &&
        !targetProjection.runs.some((candidate) => candidate.id === command.targetRunId)
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Target run ${command.targetRunId} does not belong to thread ${command.targetThreadId}.`,
        });
      }

      const now = yield* DateTime.now;
      const parentProviderTurn = providerTurnForRun(parentProjection, parentRun);
      const turnItem: OrchestrationV2TurnItem = {
        id: idAllocator.derive.createdThreadTurnItem({ commandId: command.commandId }),
        threadId: command.parentThreadId,
        runId: command.parentRunId,
        nodeId: command.parentNodeId,
        providerThreadId: parentRun.providerThreadId,
        providerTurnId: parentProviderTurn?.id ?? null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal(parentProjection),
        status: "completed",
        title: targetProjection.thread.title,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "thread_created",
        targetThreadId: command.targetThreadId,
        targetRunId: command.targetRunId,
        targetProviderInstanceId: targetProjection.thread.modelSelection.instanceId,
        targetModel: targetProjection.thread.modelSelection.model,
      };

      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: command.parentThreadId,
        runId: command.parentRunId,
        nodeId: command.parentNodeId,
        providerInstanceId: parentRun.providerInstanceId,
        occurredAt: now,
        payload: turnItem,
      });
    },
  );

  const dispatchSecretRequestRecord = Effect.fn("orchestrationV2.dispatch.secretRequestRecord")(
    function* (
      command: Extract<OrchestrationV2InternalCommand, { readonly type: "secret_request.record" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      const projection = yield* projectionStore
        .getThreadRecords(
          command.threadId,
          ["runs", "nodes", "turnItems", "attempts", "providerTurns"],
          { turnItemTypes: ["secret_request", "human_handoff"], messageRoles: [] },
        )
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      const run = projection.runs.find((candidate) => candidate.id === command.runId);
      if (run === undefined || run.rootNodeId !== command.nodeId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Node ${command.nodeId} is not the root of run ${command.runId}.`,
        });
      }
      // Each blocking caller owns its one-use ref; only the stable request item ID deduplicates.
      const existing = projection.turnItems.find((item) => item.id === command.turnItemId);
      if (existing !== undefined && existing.type !== "secret_request") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Turn item ${command.turnItemId} is not a secret request.`,
        });
      }
      if (existing !== undefined && existing.runId !== command.runId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Secret request ${command.turnItemId} belongs to another run.`,
        });
      }
      const now = yield* DateTime.now;
      if (!existing && command.secretStatus === "pending") {
        const outstanding = projection.turnItems.filter((item) => {
          const handoff = itemHandoff(item);
          return handoff
            ? isHandoffPending(handoff.state)
            : item.type === "secret_request" && item.secretStatus === "pending";
        });
        if (outstanding.length >= 3)
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: new HandoffError({ reason: "limit_reached" }),
          });
      }
      const unchanged =
        existing !== undefined &&
        (existing.secretStatus !== "pending" || command.secretStatus === "pending");
      const pending = command.secretStatus === "pending";
      const previousHandoff = existing?.handoff;
      const expired =
        previousHandoff?.expiresAt != null &&
        DateTime.toEpochMillis(previousHandoff.expiresAt) <= DateTime.toEpochMillis(now);
      const handoff =
        previousHandoff ??
        (command.environmentId === undefined
          ? undefined
          : {
              handoffId: command.turnItemId,
              kind: "secret" as const,
              title: command.label,
              reason: command.reason,
              requestedBy: {
                threadId: command.threadId,
                providerInstanceId: run.providerInstanceId,
                path: "handoff.create",
              },
              target: { environmentId: command.environmentId, path: "secret.consume" },
              dedupeKey: command.label,
              state: "pending" as const,
              expiresAt: DateTime.add(now, { hours: 1 }),
              createdAt: now,
              actor: { type: "agent" as const, threadId: command.threadId },
            });
      const runEnded = ["completed", "failed", "cancelled", "interrupted"].includes(run.status);
      const closed = expired || runEnded;
      const handoffState = expired
        ? ("expired" as const)
        : runEnded
          ? ("cancelled" as const)
          : command.secretStatus === "saved"
            ? ("completed" as const)
            : command.secretStatus;

      const turnItem: OrchestrationV2TurnItem = unchanged
        ? existing
        : {
            id: command.turnItemId,
            threadId: command.threadId,
            runId: command.runId,
            nodeId: command.nodeId,
            providerThreadId: run.providerThreadId,
            providerTurnId: providerTurnForRun(projection, run)?.id ?? null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: existing?.ordinal ?? (yield* nextTurnItemOrdinal(projection)),
            status:
              pending && !closed
                ? "waiting"
                : command.secretStatus === "saved" && !closed
                  ? "completed"
                  : "cancelled",
            title: command.label,
            startedAt: existing?.startedAt ?? now,
            completedAt: pending && !closed ? null : now,
            updatedAt: now,
            type: "secret_request",
            label: command.label,
            reason: command.reason,
            ...secretRequestOptionalFields(command, existing),
            secretStatus: closed ? "cancelled" : command.secretStatus,
            ...(handoff === undefined
              ? {}
              : {
                  handoff: {
                    ...handoff,
                    state: handoffState,
                    actor: closed
                      ? { type: "server" as const }
                      : (command.actor ??
                        (command.secretStatus === "cancelled"
                          ? { type: "agent" as const, threadId: command.threadId }
                          : pending
                            ? handoff.actor
                            : { type: "server" as const })),
                    ...(!pending || closed
                      ? {
                          resolvedAt: now,
                          ...(!closed && command.actor?.type === "client"
                            ? { resolvedBy: command.actor.label }
                            : {}),
                        }
                      : {}),
                  },
                }),
          };
      if (
        !unchanged &&
        !closed &&
        command.secretStatus === "saved" &&
        projection.thread.snoozedUntil != null
      ) {
        yield* emit(
          events,
          command,
        )({
          type: "thread.unsnoozed",
          threadId: command.threadId,
          providerInstanceId: projection.thread.providerInstanceId,
          occurredAt: now,
          payload: { ...projection.thread, snoozedUntil: null, snoozedAt: null, updatedAt: now },
        });
      }
      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: command.runId,
        nodeId: command.nodeId,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: turnItem,
      });
    },
  );

  return { dispatchCreatedThreadRecord, dispatchSecretRequestRecord };
};
