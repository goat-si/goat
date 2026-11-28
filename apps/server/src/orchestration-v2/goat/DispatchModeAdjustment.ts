import {
  latestProviderTurnForAttempt,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { isBlockingRun } from "./OrchestratorRunState.ts";
import { agentQueuePrecedesSend } from "./AgentQueueOrder.ts";

type MessageCommand = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
type DispatchMode = MessageCommand["dispatchMode"];

export function afterLateSteer(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
  dispatchMode: DispatchMode,
): DispatchMode {
  if (dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active") {
    const targetRunId = dispatchMode.targetRunId;
    const target = projection.runs.find((run) => run.id === targetRunId);
    const turn = latestProviderTurnForAttempt(
      projection.providerTurns.filter((candidate) => candidate.nodeId === target?.rootNodeId),
      target?.activeAttemptId,
    );
    // The client may still show a running turn while its completion is being
    // projected. Preserve the submission as a new turn when steering is too late.
    if (
      target !== undefined &&
      (target.status === "completed" ||
        (dispatchMode.type === "restart_active" && !isBlockingRun(target)) ||
        ((target.status === "running" || target.status === "waiting") &&
          turn !== undefined &&
          (turn.status === "completed" ||
            (dispatchMode.type === "restart_active" &&
              turn.status !== "pending" &&
              turn.status !== "running"))))
    ) {
      dispatchMode = { type: "start_immediately" };
    }
  }
  return dispatchMode;
}

// Every message passes this check; the queue lookup already has its own span.
export const forAgentQueue = Effect.fnUntraced(function* (
  store: ProjectionStoreV2Shape,
  runs: OrchestrationV2ThreadProjection["runs"],
  command: MessageCommand,
  dispatchMode: DispatchMode,
) {
  if (
    command.deliveryIntent === "auto" &&
    command.createdBy === "agent" &&
    (dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active") &&
    (yield* agentQueuePrecedesSend(store, command.threadId, runs))
  ) {
    return { type: "queue_after_active" } as const;
  }
  return dispatchMode;
});

export function forFreshContext(dispatchMode: DispatchMode, freshContext: boolean): DispatchMode {
  if (
    freshContext &&
    (dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active")
  ) {
    return { type: "queue_after_active" };
  }
  return dispatchMode;
}
