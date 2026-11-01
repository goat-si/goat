import type {
  OrchestrationV2CloudTask,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  RunId,
} from "@goat/contracts";

/** A refused message delivery leaves an already accepted cloud task intact. */
export const CLOUD_DELIVERY_REJECTED_CODE = "cloud_delivery_rejected";

export function isCloudExecution(capabilities: OrchestrationV2ProviderCapabilities) {
  return capabilities.sessions.executionLocation === "cloud";
}

export function canCheckpoint(capabilities: OrchestrationV2ProviderCapabilities) {
  return !isCloudExecution(capabilities);
}

export function cloudFollowUpReason(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerThreads">,
  instanceId: ProviderInstanceId,
  capabilities: OrchestrationV2ProviderCapabilities,
  excludingRunId?: RunId,
) {
  const thread = projection.providerThreads.findLast(
    (candidate) => candidate.ownerNodeId === null && candidate.providerInstanceId === instanceId,
  );
  if (thread?.cloudTask?.status === "unknown") {
    return (
      thread.cloudTask.error ??
      "Cloud submission outcome is unknown. Open the task before continuing."
    );
  }
  if (capabilities.sessions.followUp?.supported !== false) return null;
  const reserved = projection.runs.some(
    (run) =>
      run.id !== excludingRunId &&
      run.providerInstanceId === instanceId &&
      run.status !== "rolled_back" &&
      (run.startedAt != null ||
        ["queued", "preparing", "starting", "running", "waiting"].includes(run.status)),
  );
  return reserved || thread?.cloudTask !== undefined
    ? (capabilities.sessions.followUp.reason ??
        "This cloud provider does not support follow-up messages.")
    : null;
}

export function cloudTaskResultText(
  task: OrchestrationV2CloudTask,
  terminal?: { readonly status: string; readonly resultText?: string | undefined },
) {
  const title =
    task.tracking === "link-only" && task.status === "running"
      ? "Running in the cloud"
      : `Cloud task ${task.status}`;
  const summary = terminal?.resultText?.trim() || task.summary?.trim() || title;
  // Rendered as markdown: one link per list item so URLs never run into the next label.
  // The canonical links are always listed, even when the provider's summary mentions them.
  const links = [
    task.prUrl ? `- Pull request: ${task.prUrl}` : undefined,
    task.branch ? `- Branch: \`${task.branch}\`` : undefined,
    task.url ? `- Cloud task: ${task.url}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return links.length === 0 ? summary : `${summary}\n\n${links.join("\n")}`;
}
