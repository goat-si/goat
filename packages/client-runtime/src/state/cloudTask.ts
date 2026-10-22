import type {
  OrchestrationV2CloudTask,
  OrchestrationV2ThreadProjection,
  ServerProvider,
} from "@goat/contracts";

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "providerThreads" | "providerSessions"
> & {
  readonly thread: Pick<
    OrchestrationV2ThreadProjection["thread"],
    "providerInstanceId" | "activeProviderThreadId"
  >;
};

export function deriveCloudTaskState(
  projection: Projection | null | undefined,
  selectedProvider?: Pick<ServerProvider, "instanceId" | "executionLocation" | "driver"> | null,
) {
  const instanceId = selectedProvider?.instanceId ?? projection?.thread.providerInstanceId;
  const targetThread = projection?.providerThreads.findLast(
    (thread) => thread.ownerNodeId === null && thread.providerInstanceId === instanceId,
  );
  const conversationThread =
    projection?.providerThreads.find(
      (thread) => thread.id === projection.thread.activeProviderThreadId,
    ) ??
    projection?.providerThreads.findLast(
      (thread) =>
        thread.ownerNodeId === null &&
        thread.providerInstanceId === projection.thread.providerInstanceId,
    ) ??
    targetThread;
  const session = projection?.providerSessions.find(
    (candidate) => candidate.id === conversationThread?.providerSessionId,
  );
  const targetSession = projection?.providerSessions.find(
    (candidate) => candidate.id === targetThread?.providerSessionId,
  );
  const cloudTask = conversationThread?.cloudTask ?? null;
  const executionLocation =
    session?.capabilities.sessions.executionLocation ??
    (cloudTask !== null ? "cloud" : (selectedProvider?.executionLocation ?? "local"));
  const reserved =
    projection?.runs.some(
      (run) =>
        run.providerInstanceId === instanceId &&
        run.status !== "rolled_back" &&
        (run.startedAt != null ||
          ["queued", "preparing", "starting", "running", "waiting"].includes(run.status)),
    ) === true;
  const followUp = targetSession?.capabilities.sessions.followUp;
  const launchSourceNotice = (
    selectedProvider
      ? selectedProvider.driver === "claudeCloud"
      : targetSession?.capabilities.sessions.sourceRestriction === "project-folder"
  )
    ? "Claude Cloud starts tasks from the project folder. Local changes may be included."
    : null;
  const composerBlockReason =
    targetThread?.cloudTask?.status === "unknown"
      ? (targetThread.cloudTask.error ??
        "Cloud submission outcome is unknown. Open the task before continuing.")
      : followUp?.supported === false && (reserved || targetThread?.cloudTask !== undefined)
        ? (followUp.reason ?? "This cloud provider does not support follow-up messages.")
        : null;
  return {
    cloudTask,
    executionLocation,
    launchSourceNotice,
    composerBlockReason,
    showLocalWorkspace: executionLocation !== "cloud",
  };
}

export function presentCloudTask(task: OrchestrationV2CloudTask) {
  const label = {
    submitting: "Submitting cloud task",
    running: "Running in the cloud",
    succeeded: "Cloud task completed",
    failed: "Cloud task failed",
    cancelled: "Cloud task cancelled",
    unknown: "Cloud task status unknown",
  }[task.status];
  const safeUrl = (value: string | undefined) => {
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
    } catch {
      return null;
    }
  };
  return {
    label: task.status === "succeeded" && task.prUrl ? "Result PR found" : label,
    taskUrl: safeUrl(task.url),
    prUrl: safeUrl(task.prUrl),
    localChangesNotice: task.localChangesIncluded
      ? "local changes may be included"
      : task.localChangesExcluded
        ? "local changes are not included"
        : null,
  };
}

export type CloudTaskState = ReturnType<typeof deriveCloudTaskState>;
