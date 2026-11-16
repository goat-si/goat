import {
  type OrchestratorMcpScheduledTask,
  type OrchestratorMcpUpdateScheduledTaskInput,
  type ScheduledTask,
  type ScheduledTaskThreadMode,
  type ThreadId,
  scheduledTaskThreadMode,
} from "@goat/contracts";
import { webhookUrlFields } from "./scheduledTaskWebhookUrl.ts";

export function scheduledTaskSummary(
  task: ScheduledTask,
  mayRun: boolean,
): OrchestratorMcpScheduledTask {
  return {
    scheduledTaskId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    projectId: task.projectId,
    boundThreadId: task.threadId,
    freshSession: scheduledTaskThreadMode(task) === "fresh_session",
    schedule: task.schedule,
    notificationPolicy: task.notificationPolicy ?? "all_runs",
    nextRunAt: task.nextRunAt,
    lastRunStatus: task.lastRunStatus,
    ...(task.lastRun === undefined ? {} : { lastRun: task.lastRun }),
    ...(task.lastRunError === null ? {} : { lastRunError: task.lastRunError }),
    runCount: task.runCount,
    lastRunAt: task.lastRunAt,
    ...webhookUrlFields(task.webhook, mayRun),
    ...(task.webhook === undefined
      ? {}
      : { webhookSignature: task.webhook.hasSecret ? "set" : "none" }),
    ...(task.webhook?.secretRef === undefined
      ? {}
      : { webhookSignatureSecretRef: task.webhook.secretRef }),
  };
}

/** The mode an update saves; a save that names neither choice keeps the stored mode. */
export const updatedThreadMode = (
  input: Pick<OrchestratorMcpUpdateScheduledTaskInput, "freshSession" | "bindToCurrentThread">,
  existing: ScheduledTask,
  threadId: ThreadId | null,
): ScheduledTaskThreadMode =>
  input.freshSession === undefined && input.bindToCurrentThread === undefined
    ? scheduledTaskThreadMode(existing)
    : (input.freshSession ??
        (input.bindToCurrentThread !== false &&
          scheduledTaskThreadMode(existing) === "fresh_session"))
      ? "fresh_session"
      : threadId === null &&
          (input.bindToCurrentThread === false ||
            scheduledTaskThreadMode(existing) === "new_thread")
        ? "new_thread"
        : "continue";
