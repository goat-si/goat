import type {
  OrchestrationV2CloudTask,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestratorMcpCloudTask,
} from "@goat/contracts";

export function cloudTaskView(
  task: OrchestrationV2CloudTask | OrchestratorMcpCloudTask | undefined,
): OrchestratorMcpCloudTask | undefined {
  if (task === undefined) return undefined;
  const url = (value: string | undefined) => {
    if (value === undefined || value.length > 2048) return undefined;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password
        ? parsed.href.length <= 2048
          ? parsed.href
          : undefined
        : undefined;
    } catch {
      return undefined;
    }
  };
  const taskUrl = url(task.url);
  const prUrl = url(task.prUrl);
  return {
    taskId: task.taskId.slice(0, 512),
    status: task.status,
    tracking: task.tracking,
    ...(taskUrl === undefined ? {} : { url: taskUrl }),
    ...(prUrl === undefined ? {} : { prUrl }),
    ...(task.branch === undefined ? {} : { branch: task.branch.slice(0, 512) }),
    ...(task.progress === undefined ? {} : { progress: task.progress.slice(0, 1000) }),
    ...(task.summary === undefined ? {} : { summary: task.summary.slice(0, 4000) }),
    localChangesExcluded: task.localChangesExcluded,
    ...(task.localChangesIncluded === undefined
      ? {}
      : { localChangesIncluded: task.localChangesIncluded }),
    ...(task.error === undefined ? {} : { error: task.error.slice(0, 1000) }),
    updatedAt: task.updatedAt,
  };
}

export function cloudTaskForRun(
  threads: ReadonlyArray<OrchestrationV2ProviderThread>,
  run: Pick<OrchestrationV2Run, "providerThreadId"> | null | undefined,
) {
  return cloudTaskView(threads.find((thread) => thread.id === run?.providerThreadId)?.cloudTask);
}
