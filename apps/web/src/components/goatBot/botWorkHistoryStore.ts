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
const inUse = new Map<string, number>();
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
    if (!entries.has(id) && entries.size >= LIMIT) {
      const evict = [...entries.keys()].find((candidate) => !inUse.has(candidate));
      if (evict === undefined) throw new Error("History cache is full of open tasks.");
      entries.delete(evict);
    }
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
  }
  notify();
}

export function historyTask(environmentId: EnvironmentId, taskId: ChannelTaskId) {
  return entries.get(key(environmentId, taskId))?.task;
}

export function useHistoryWork(environmentId: EnvironmentId, taskId: ChannelTaskId) {
  const id = key(environmentId, taskId);
  return useSyncExternalStore(
    (listener) => {
      inUse.set(id, (inUse.get(id) ?? 0) + 1);
      const unsubscribe = subscribe(listener);
      return () => {
        unsubscribe();
        const count = (inUse.get(id) ?? 1) - 1;
        if (count === 0) inUse.delete(id);
        else inUse.set(id, count);
      };
    },
    () => entries.get(id),
  );
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
  const entry = entries.get(key(environmentId, taskId));
  if (entry) updateHistoryView(environmentId, taskId, { ...entry.task.view, readThrough: through });
}

export function updateHistoryView(
  environmentId: EnvironmentId,
  taskId: ChannelTaskId,
  view: ChannelTaskView,
) {
  const id = key(environmentId, taskId);
  const entry = entries.get(id);
  if (!entry) return;
  const previous = entry.acknowledgedThrough;
  const incoming = view.readThrough;
  const through =
    incoming !== null &&
    Number.isFinite(Date.parse(incoming)) &&
    (previous === null || !Number.isFinite(Date.parse(previous)) || !atOrBefore(incoming, previous))
      ? incoming
      : previous;
  const task = {
    ...entry.task,
    unread:
      entry.task.unread && !(through !== null && atOrBefore(entry.task.lastActivityAt, through)),
    view: { ...view, readThrough: through },
  };
  entries.set(id, {
    ...entry,
    task,
    rows: entry.rows.map((row) => (row.kind === "task" ? task : row)),
    acknowledgedThrough: through,
  });
  notify();
}

export function clearHistoryEnvironment(environmentId: EnvironmentId) {
  for (const id of entries.keys()) {
    const [environment] = JSON.parse(id) as [string, string];
    if (environment === environmentId) entries.delete(id);
  }
  notify();
}
