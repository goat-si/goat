import type {
  OrchestrationV2Command,
  OrchestrationV2Subagent,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";

/** Stop ended this task, so its result is not delivered to the parent agent. */
export function cancelledAppOwnedTask(
  task: OrchestrationV2Subagent,
  now: DateTime.Utc,
): OrchestrationV2Subagent {
  return {
    ...task,
    status: "cancelled",
    completedAt: now,
    updatedAt: now,
    completionDelivery: { state: "disposed", observedByRunId: null },
  };
}

// Provider wakes can start follow-up work; monitor updates only report progress.
// Dispatch takes the parent's lock for follow-ups because intake writes the parent.
export function mayStartSubagentFollowup(
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
): boolean {
  if (command.scheduledTaskId !== undefined || command.restartContinuationOfRunId !== undefined)
    return false;
  if (command.notification !== undefined) return command.notification.source.kind !== "monitor";
  return (
    command.createdBy === "user" ||
    command.creationSource === "mcp" ||
    command.usageLimitContinuationOfRunId !== undefined
  );
}

export function isBlockingRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === "preparing" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

/** Waiting runs only drain post-terminal output; their agent turn is over and still needs a wake. */
export function isLiveRun(run: OrchestrationV2Run): boolean {
  return run.status === "preparing" || run.status === "starting" || run.status === "running";
}

export function hasLiveRun(projection: Pick<OrchestrationV2ThreadProjection, "runs">): boolean {
  return projection.runs.some(isLiveRun);
}
