import type {
  NodeId,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";

/**
 * A steer that fell back to the queue keeps its user item, hidden while the run is queued.
 * Republish it, failed, before the run's failure, so clients whose bounded snapshot omitted it
 * can show the prompt beside the error.
 */
export const retainedUserItemFailures = (
  threadId: ThreadId,
  queuedRun: OrchestrationV2Run,
  rootNodeId: NodeId | undefined,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  now: DateTime.Utc,
) =>
  turnItems
    .filter((item) => item.type === "user_message" && item.runId === queuedRun.id)
    .map((item) => ({
      type: "turn-item.updated" as const,
      threadId,
      runId: queuedRun.id,
      ...(rootNodeId === undefined ? {} : { nodeId: rootNodeId }),
      providerInstanceId: queuedRun.providerInstanceId,
      occurredAt: now,
      payload: { ...item, status: "failed" as const, completedAt: now, updatedAt: now },
    }));
