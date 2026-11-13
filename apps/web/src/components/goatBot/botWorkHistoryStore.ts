import type {
  BotRemoteWork,
  BotThreadRow,
  ChannelTaskId,
  ChannelTaskView,
  EnvironmentId,
} from "@goat/contracts";
import { useSyncExternalStore } from "react";

type TaskRow = Extract<BotThreadRow, { kind: "task" }>;
interface HistoryWork {
  readonly task: TaskRow;
  readonly rows: readonly BotThreadRow[];
  readonly remoteWork: readonly BotRemoteWork[];
  readonly acknowledgedThrough: string | null;
}
const LIMIT = 500;
const entries = new Map<string, HistoryWork>();
const listeners = new Set<() => void>();
const key = (environmentId: EnvironmentId, taskId: ChannelTaskId) =>
  JSON.stringify([environmentId, taskId]);
let revision = 0;
const notify = () => {
  revision += 1;
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useHistoryRevision() {
  return useSyncExternalStore(subscribe, () => revision);
}
const atOrBefore = (activity: string, through: string) => {
  const a = Date.parse(activity);
  const b = Date.parse(through);
  return Number.isFinite(a) && Number.isFinite(b) && a <= b;
};

export function rememberHistoryRows(
  environmentId: EnvironmentId,
  incoming: readonly BotThreadRow[],
  remoteWork: readonly BotRemoteWork[] = [],
) {
  for (const row of incoming) {
    if (row.kind !== "task") continue;
    const id = key(environmentId, row.task.taskId);
    const previous = entries.get(id);
    const through = previous?.acknowledgedThrough ?? null;
    const task =
      through !== null && atOrBefore(row.lastActivityAt, through)
        ? { ...row, unread: false, view: { ...row.view, readThrough: through } }
        : row;
    entries.delete(id);
    entries.set(id, {
      task,
      rows: [
        task,
        ...incoming.filter((item) => item.kind === "coding" && item.taskId === row.task.taskId),
      ],
      remoteWork: remoteWork.filter((item) => item.taskId === row.task.taskId),
      acknowledgedThrough: through,
    });
    if (entries.size > LIMIT) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
  }
  notify();
}

export function historyTask(environmentId: EnvironmentId, taskId: ChannelTaskId) {
  return entries.get(key(environmentId, taskId))?.task;
}

export function useHistoryWork(environmentId: EnvironmentId, taskId: ChannelTaskId) {
  return useSyncExternalStore(subscribe, () => entries.get(key(environmentId, taskId)));
}

export function resetHistoryTasksForTests() {
  entries.clear();
  notify();
}

export function acknowledgeHistoryRow(
  environmentId: EnvironmentId,
  taskId: ChannelTaskId,
  through: string,
) {
  const id = key(environmentId, taskId);
  const entry = entries.get(id);
  if (!entry) return;
  const previous = entry.acknowledgedThrough;
  const acknowledgedThrough =
    previous !== null && atOrBefore(through, previous) ? previous : through;
  const task = atOrBefore(entry.task.lastActivityAt, acknowledgedThrough)
    ? {
        ...entry.task,
        unread: false,
        view: { ...entry.task.view, readThrough: acknowledgedThrough },
      }
    : entry.task;
  entries.set(id, {
    ...entry,
    task,
    rows: entry.rows.map((row) => (row.kind === "task" ? task : row)),
    acknowledgedThrough,
  });
  notify();
}

export function updateHistoryView(
  environmentId: EnvironmentId,
  taskId: ChannelTaskId,
  view: ChannelTaskView,
) {
  const id = key(environmentId, taskId);
  const entry = entries.get(id);
  if (!entry) return;
  const task = { ...entry.task, view };
  entries.set(id, {
    ...entry,
    task,
    rows: entry.rows.map((row) => (row.kind === "task" ? task : row)),
  });
  notify();
}
