import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2CloudTask,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import type { ThreadStructure } from "./models.ts";

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

const CLOUD_PROVIDER_LABELS: Record<string, string> = {
  claudeCloud: "Claude Cloud",
  cursorCloud: "Cursor Cloud",
  devinCloud: "Devin Cloud",
};

type CloudRunProjection = Pick<ThreadStructure, "runs" | "providerThreads" | "turnItems">;
type CloudRunPhase = "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export type CloudRunStageStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface CloudRunStage {
  readonly id: "prepare" | "submit" | "run" | "result";
  readonly label: string;
  readonly status: CloudRunStageStatus;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly detail: string | null;
}

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

// Server-side input of the item that tracks workspace preparation before a run starts.
const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";

const iso = (value: DateTime.DateTime | null | undefined) =>
  value == null ? null : DateTime.formatIso(value);

function resultStageLabel(phase: CloudRunPhase, task: OrchestrationV2CloudTask | undefined) {
  switch (phase) {
    case "succeeded":
      return task?.prUrl ? "Pull request ready" : "Finished";
    case "failed":
      return "Stopped with an error";
    case "cancelled":
      return "Cancelled";
    case "unknown":
      return "Outcome unknown";
    case "running":
      return "Return result";
  }
}

function headline(provider: string, phase: CloudRunPhase) {
  switch (phase) {
    case "running":
      return provider + " is working";
    case "succeeded":
      return provider + " finished";
    case "failed":
      return provider + " stopped with an error";
    case "cancelled":
      return provider + " run cancelled";
    case "unknown":
      return provider + " status unknown";
  }
}

function taskMessage(task: OrchestrationV2CloudTask): string | null {
  switch (task.status) {
    case "unknown":
      return task.error ?? "Cloud submission outcome is unknown. Open the task before continuing.";
    case "failed":
    case "cancelled":
      return task.error ?? task.summary?.trim() ?? null;
    default:
      return null;
  }
}

/**
 * The thread's latest run when it ran on a cloud provider, as one staged card. Cloud tasks
 * carry no per-stage timestamps, so stage timing comes from the run: Prepare spans
 * requested to started, and Run in the cloud spans started to completed (it includes the
 * vendor submission). The task snapshot belongs to the provider thread and is rewritten on
 * every submission, so it is read only once this run has started.
 */
export function presentCloudRun(projection: CloudRunProjection | null | undefined) {
  if (!projection) return null;
  const run = projection.runs.reduce<(typeof projection.runs)[number] | undefined>(
    (latest, candidate) =>
      latest === undefined || candidate.ordinal > latest.ordinal ? candidate : latest,
    undefined,
  );
  if (!run || run.providerThreadId === null) return null;
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  if (
    !providerThread ||
    (CLOUD_PROVIDER_LABELS[providerThread.driver] === undefined &&
      providerThread.cloudTask === undefined)
  ) {
    return null;
  }
  const provider = CLOUD_PROVIDER_LABELS[providerThread.driver] ?? "Cloud agent";
  const started = run.startedAt !== null;
  const task = started ? providerThread.cloudTask : undefined;
  const runItems = projection.turnItems.filter((item) => item.runId === run.id);
  const rootError = runItems.findLast(
    (item): item is Extract<(typeof runItems)[number], { readonly type: "error" }> =>
      item.type === "error" && item.parentItemId === null && item.status === "failed",
  );
  const runEnded = run.completedAt !== null || !ACTIVE_RUN_STATUSES.has(run.status);
  const phase: CloudRunPhase = (() => {
    if (task?.status === "unknown") return "unknown";
    if (task?.status === "succeeded") return "succeeded";
    if (task?.status === "failed") return "failed";
    if (task?.status === "cancelled") return "cancelled";
    if (!runEnded) return "running";
    if (run.status === "completed") return "succeeded";
    if (run.status === "failed") return "failed";
    return "cancelled";
  })();

  const requestedAt = iso(run.requestedAt);
  const startedAt = iso(run.startedAt);
  const completedAt = iso(run.completedAt);
  const endedAt = phase === "running" ? null : completedAt;
  const submitting = task?.status === "submitting";
  // A provider marks acceptance with acceptedAppRunId (Cursor) or by replacing the app run id
  // with its own task id (Claude, Devin). A task still named after this run was never accepted.
  const neverAccepted =
    task !== undefined && task.acceptedAppRunId !== run.id && task.taskId === run.id;
  const notSent = submitting || (neverAccepted && phase !== "running");
  const stages: CloudRunStage[] = [
    {
      id: "prepare",
      label: "Prepare launch",
      status: started ? "done" : runEnded ? (phase === "failed" ? "failed" : "skipped") : "running",
      startedAt: requestedAt,
      endedAt: startedAt ?? (runEnded ? completedAt : null),
      detail: null,
    },
    {
      id: "submit",
      label: "Submit to " + provider,
      status: !started
        ? "pending"
        : notSent
          ? runEnded || phase !== "running"
            ? "failed"
            : "running"
          : "done",
      startedAt: null,
      endedAt: null,
      detail: null,
    },
    {
      id: "run",
      label: "Run in the cloud",
      status:
        !started || notSent
          ? runEnded && started
            ? "skipped"
            : "pending"
          : phase === "running"
            ? "running"
            : phase === "succeeded"
              ? "done"
              : phase === "cancelled"
                ? "skipped"
                : "failed",
      startedAt: started && !notSent ? startedAt : null,
      endedAt: started && !notSent ? endedAt : null,
      detail: phase === "running" ? task?.progress?.trim() || null : null,
    },
    {
      id: "result",
      label: resultStageLabel(phase, task),
      status:
        phase === "running"
          ? "pending"
          : phase === "succeeded"
            ? "done"
            : phase === "cancelled"
              ? "skipped"
              : "failed",
      startedAt: null,
      endedAt: null,
      detail: null,
    },
  ];

  const message =
    phase === "running" || phase === "succeeded"
      ? null
      : ((task ? taskMessage(task) : null) ??
        (rootError?.failure.message.trim() || null) ??
        (started
          ? null
          : phase === "cancelled"
            ? "Stopped before it was sent."
            : "The cloud run could not start."));

  const hiddenItemIds = new Set<string>();
  const hiddenMessageIds = new Set<string>();
  for (const item of runItems) {
    if (
      item.type === "error" &&
      item.parentItemId === null &&
      item.failure.code !== ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE
    ) {
      hiddenItemIds.add(item.id);
    }
    if (item.type === "command_execution" && item.input === WORKSPACE_PREPARATION_INPUT) {
      hiddenItemIds.add(item.id);
    }
  }
  const resultItemId = "turn-item:cloud-result:" + run.id;
  const resultMessageId = "message:cloud-result:" + run.id;
  if (phase !== "succeeded") {
    hiddenItemIds.add(resultItemId);
    hiddenMessageIds.add(resultMessageId);
  }

  const userMessage = projection.turnItems.find(
    (item): item is Extract<(typeof runItems)[number], { readonly type: "user_message" }> =>
      item.type === "user_message" && item.messageId === run.userMessageId,
  );
  const retry =
    (phase === "failed" || phase === "cancelled") &&
    userMessage !== undefined &&
    userMessage.text.trim().length > 0 &&
    !projection.runs.some(
      (candidate) => candidate.id !== run.id && ACTIVE_RUN_STATUSES.has(candidate.status),
    )
      ? {
          runId: run.id,
          text: userMessage.text,
          attachments: userMessage.attachments,
          modelSelection: run.modelSelection,
        }
      : null;

  const view = task ? presentCloudTask(task) : null;
  return {
    runId: run.id,
    provider,
    phase,
    title: headline(provider, phase),
    message,
    stages,
    startedAt: requestedAt,
    endedAt,
    taskUrl: view?.taskUrl ?? null,
    prUrl: view?.prUrl ?? null,
    branch: task?.branch ?? null,
    source: task?.source ?? null,
    localChangesNotice: view?.localChangesNotice ?? null,
    hiddenItemIds: hiddenItemIds as ReadonlySet<string>,
    hiddenMessageIds: hiddenMessageIds as ReadonlySet<string>,
    resultMessageId,
    retry,
  };
}

export type CloudRunCard = NonNullable<ReturnType<typeof presentCloudRun>>;
