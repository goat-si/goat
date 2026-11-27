import type { OrchestrationV2PendingBackgroundTask } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Ref from "effect/Ref";

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
        readonly toolName: string;
        readonly classification: { readonly itemType: string };
        readonly input: { readonly type: string; readonly value: unknown };
        readonly startedAt: DateTime.Utc;
      }
    | undefined,
) {
  if (
    (launch?.classification.itemType !== "command_execution" && launch?.toolName !== "Monitor") ||
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
  launches: ClaudeTaskLaunches,
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
  return {
    ...claudePendingBackgroundTask({
      taskId,
      taskType,
      startedByMonitor: monitorTasks.has(taskId),
      description: typeof description === "string" ? description : undefined,
      parentTaskId: Reflect.get(entry, "parent_task_id"),
    }),
    ...launches.get(taskId),
  };
}

/** The call that started a task, which a roster entry naming only the task id leaves out. */
interface ClaudeTaskLaunch {
  readonly nativeItemId: string;
  readonly command?: string;
  readonly startedAt?: string;
}

const MAX_REMEMBERED_LAUNCHES = 64;

export type ClaudeTaskLaunches = ReturnType<typeof makeClaudeTaskLaunches>;

/**
 * One session's task launches. A foreground command can move to the background later, so every
 * launch is kept, the oldest dropped first; a task on the roster keeps its fields through the merge.
 */
export function makeClaudeTaskLaunches() {
  const launches = new Map<string, ClaudeTaskLaunch>();
  return {
    get: (taskId: string) => launches.get(taskId),
    remember(
      taskId: string,
      toolUseId: string | undefined,
      call: Parameters<typeof claudeBackgroundDetails>[0],
    ): ClaudeTaskLaunch | undefined {
      const nativeItemId = toolUseId?.trim();
      if (!nativeItemId) return undefined;
      const launch = { nativeItemId, ...claudeBackgroundDetails(call) };
      launches.delete(taskId);
      launches.set(taskId, launch);
      for (const oldest of launches.keys()) {
        if (launches.size <= MAX_REMEMBERED_LAUNCHES) break;
        launches.delete(oldest);
      }
      return launch;
    },
    forget: (taskId: string) => launches.delete(taskId),
  };
}

const CLAUDE_SLEEP_DURATION = String.raw`(?:\d[\w.]*|\$\(\([\d\s+*/%-]+\)\)|\$\{\w+(?::?[-=]\d[\w.]*)?\}|\$\w+)`;
const CLAUDE_SLEEP_TIMER_START = new RegExp(
  String.raw`^[ \t\n]*sleep[ \t]+(?:${CLAUDE_SLEEP_DURATION}|"${CLAUDE_SLEEP_DURATION}"|'\d[\w.]*')[ \t]*(?:$|;|&&|\n)`,
);
// Bash separates words only with spaces and tabs, so `\s` would read `true\rnpm` as `true`.
const CLAUDE_SLEEP_TIMER_REPORT = /^[ \t]*(?:$|(?:date|echo|printf|true|:)(?:[ \t]|$))/;

// Splits at unquoted `;`, `&&` and newlines. Gives up on anything a report never needs that could
// run or hide another command: pipes, `||`, a lone `&`, subshells, heredocs, substitutions, `${…}`,
// `$'…'`, comments, and unbalanced quotes or escapes.
function splitClaudeSleepTimerSteps(tail: string): string[] | undefined {
  const steps: string[] = [];
  let step = "";
  let quote: string | undefined;
  for (let index = 0; index < tail.length; index++) {
    const char = tail[index] ?? "";
    const next = tail[index + 1] ?? "";
    if (quote === "'") {
      if (char === "'") quote = undefined;
      step += char;
      continue;
    }
    if (char === "\\") {
      if (next === "") return undefined;
      step += char + next;
      index++;
      continue;
    }
    if (char === "`" || (char === "$" && "({'\"".includes(next) && next !== "")) return undefined;
    if (quote === '"') {
      if (char === '"') quote = undefined;
      step += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === ";" || char === "\n" || (char === "&" && next === "&")) {
      steps.push(step);
      step = "";
      if (char === "&") index++;
      continue;
    } else if (char === "&" ? next !== ">" && tail[index - 1] !== ">" : "|()<#".includes(char)) {
      return undefined;
    }
    step += char;
  }
  if (quote !== undefined) return undefined;
  steps.push(step);
  return steps;
}

// A background command that only sleeps for a finite time, then at most prints the time or a
// note, is a timer the agent set to check back, which Claude wakes it for when it ends. Any other
// step (`sleep 5 && npm run dev`) may never end, so that command is not a timer.
export function isClaudeSleepTimer(command: string | undefined): boolean {
  const start = command === undefined ? null : CLAUDE_SLEEP_TIMER_START.exec(command);
  if (command === undefined || start === null) return false;
  const steps = splitClaudeSleepTimerSteps(command.slice(start[0].length));
  return steps !== undefined && steps.every((step) => CLAUDE_SLEEP_TIMER_REPORT.test(step));
}

export function startsAwaitedClaudeBackgroundTask(
  task: OrchestrationV2PendingBackgroundTask,
  previous: OrchestrationV2PendingBackgroundTask | undefined,
): boolean {
  return task.kind === "monitor"
    ? previous?.kind !== "monitor"
    : task.kind === "command" &&
        previous?.command === undefined &&
        isClaudeSleepTimer(task.command);
}

export function upsertClaudeRosterTask(
  current: ReadonlyMap<string, ReadonlyMap<string, OrchestrationV2PendingBackgroundTask>>,
  nativeThreadId: string,
  task: OrchestrationV2PendingBackgroundTask,
) {
  const roster = new Map(current.get(nativeThreadId));
  const startedWait = startsAwaitedClaudeBackgroundTask(task, roster.get(task.taskId));
  roster.set(task.taskId, task);
  return [startedWait, new Map(current).set(nativeThreadId, roster)] as const;
}

export const taskIdSetForNativeThread = (
  all: ReadonlyMap<string, Set<string>>,
  nativeThreadId: string,
): Set<string> => all.get(nativeThreadId) ?? new Set<string>();

export const addTaskIdsToNativeThreadSet = (
  ref: Ref.Ref<Map<string, Set<string>>>,
  nativeThreadId: string,
  taskIds: ReadonlyArray<string>,
) =>
  Ref.update(ref, (current) => {
    if (taskIds.length === 0) return current;
    const next = new Set(taskIdSetForNativeThread(current, nativeThreadId));
    let changed = false;
    for (const taskId of taskIds) {
      if (!next.has(taskId)) {
        next.add(taskId);
        changed = true;
      }
    }
    return changed ? new Map(current).set(nativeThreadId, next) : current;
  });

export const clearTaskIdFromNativeThreadSet = (
  ref: Ref.Ref<Map<string, Set<string>>>,
  nativeThreadId: string,
  taskId: string,
) =>
  Ref.update(ref, (current) => {
    const existing = taskIdSetForNativeThread(current, nativeThreadId);
    if (!existing.has(taskId)) return current;
    const next = new Set(existing);
    next.delete(taskId);
    const updated = new Map(current);
    if (next.size === 0) updated.delete(nativeThreadId);
    else updated.set(nativeThreadId, next);
    return updated;
  });

export const clearNativeThreadTaskIdSet = (
  ref: Ref.Ref<Map<string, Set<string>>>,
  nativeThreadId: string,
) =>
  Ref.update(ref, (current) => {
    if (!current.has(nativeThreadId)) return current;
    const updated = new Map(current);
    updated.delete(nativeThreadId);
    return updated;
  });
