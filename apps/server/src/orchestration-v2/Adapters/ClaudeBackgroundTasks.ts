import type { OrchestrationV2PendingBackgroundTask } from "@goat/contracts";
import * as DateTime from "effect/DateTime";

// background_tasks_changed can include subagents already counted by their lifecycle.
const CLAUDE_OPAQUE_BACKGROUND_TASK_KINDS: ReadonlyMap<
  string,
  Exclude<OrchestrationV2PendingBackgroundTask["kind"], "subagent">
> = new Map([["local_bash", "command"]]);

export function isClaudeOpaqueBackgroundTaskType(taskType: string | null | undefined): boolean {
  return typeof taskType === "string" && CLAUDE_OPAQUE_BACKGROUND_TASK_KINDS.has(taskType);
}

export function claudePendingBackgroundTask(input: {
  readonly taskId: string;
  readonly taskType: string | null;
  // Only the launching Monitor tool distinguishes a local_bash Monitor from background Bash.
  readonly startedByMonitor: boolean;
  readonly description: string | undefined;
  // Undeclared SDK field: the subagent whose own background work this is.
  readonly parentTaskId: unknown;
}): OrchestrationV2PendingBackgroundTask {
  return {
    taskId: input.taskId,
    kind: input.startedByMonitor
      ? "monitor"
      : ((input.taskType === null
          ? undefined
          : CLAUDE_OPAQUE_BACKGROUND_TASK_KINDS.get(input.taskType)) ?? "background_task"),
    ...(input.description !== undefined && input.description.trim().length > 0
      ? { description: input.description }
      : {}),
    ...(typeof input.parentTaskId === "string" && input.parentTaskId.trim().length > 0
      ? { parentTaskId: input.parentTaskId }
      : {}),
  };
}

export function mergeClaudeBackgroundTasks(
  previous: ReadonlyMap<string, OrchestrationV2PendingBackgroundTask> | undefined,
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
) {
  return new Map(
    tasks.map((task) => [task.taskId, { ...previous?.get(task.taskId), ...task }] as const),
  );
}

export function claudeBackgroundDetails(
  launch:
    | {
        readonly classification: { readonly itemType: string };
        readonly input: { readonly type: string; readonly value: unknown };
        readonly startedAt: DateTime.Utc;
      }
    | undefined,
) {
  if (
    launch?.classification.itemType !== "command_execution" ||
    launch.input.type !== "record" ||
    launch.input.value === null ||
    typeof launch.input.value !== "object"
  )
    return {};
  const command = Reflect.get(launch.input.value, "command");
  return typeof command === "string" && command.trim()
    ? { command, startedAt: DateTime.formatIso(launch.startedAt) }
    : {};
}

export function parseClaudeBackgroundTaskEntry(
  entry: unknown,
  monitorTasks: ReadonlyMap<string, unknown>,
): OrchestrationV2PendingBackgroundTask | null {
  if (entry === null || typeof entry !== "object") {
    return null;
  }
  const taskId = Reflect.get(entry, "task_id");
  if (typeof taskId !== "string" || taskId.length === 0) {
    return null;
  }
  const rawTaskType = Reflect.get(entry, "task_type");
  const taskType = typeof rawTaskType === "string" ? rawTaskType : null;
  if (!isClaudeOpaqueBackgroundTaskType(taskType)) {
    return null;
  }
  const description = Reflect.get(entry, "description");
  return claudePendingBackgroundTask({
    taskId,
    taskType,
    startedByMonitor: monitorTasks.has(taskId),
    description: typeof description === "string" ? description : undefined,
    parentTaskId: Reflect.get(entry, "parent_task_id"),
  });
}
