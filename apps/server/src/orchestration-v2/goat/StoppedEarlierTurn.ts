import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";

/** Runs GOAT has ended; a provider turn of one that still reads running is stopped before a new start. */
export const ENDED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

export const STOPPED_EARLIER_TURN_MESSAGE =
  "A turn from an earlier run was still running, so GOAT stopped it and started this message.";

/** The notice a run shows when GOAT stopped a turn the person had not stopped before it started. */
export function stoppedEarlierTurnNotice(input: {
  readonly id: OrchestrationV2TurnItem["id"];
  readonly projection: Pick<OrchestrationV2ThreadProjection, "turnItems">;
  readonly run: Pick<OrchestrationV2Run, "id" | "threadId">;
  readonly rootNode: Pick<OrchestrationV2ExecutionNode, "id">;
  readonly providerThreadId: OrchestrationV2ProviderThread["id"];
  readonly at: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "system_notice" }> {
  return {
    id: input.id,
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal:
      Math.max(
        0,
        ...input.projection.turnItems
          .filter((item) => item.runId === input.run.id)
          .map((item) => item.ordinal),
      ) + 1,
    status: "completed",
    title: "Stopped an earlier turn",
    startedAt: input.at,
    completedAt: input.at,
    updatedAt: input.at,
    type: "system_notice",
    message: STOPPED_EARLIER_TURN_MESSAGE,
  };
}
