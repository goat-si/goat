import type {
  BotId,
  BotRemoteWork,
  BotThreadRow,
  ChannelListBotThreadsResult,
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
  readonly viewSequence: number;
}
interface Scope {
  readonly environmentId: EnvironmentId;
  readonly entries: Map<ChannelTaskId, HistoryWork>;
  readonly ids: ChannelTaskId[];
  readonly seen: Set<ChannelTaskId>;
  cursor: string | undefined;
  started: boolean;
  partial: boolean;
  endedEarly: boolean;
  capped: boolean;
  unsupported: boolean;
  loading: boolean;
  failed: boolean;
  revision: number | undefined;
  walkVersion: number;
  truncated: Set<ChannelTaskId>;
}
interface ReadToken {
  readonly generation: number;
  readonly sequence: number;
  readonly walkVersion: number;
}
// Bound each live walk without evicting tasks the person can still open.
export const BOT_WORK_HISTORY_LIMIT = 500;
const scopes = new Map<string, Scope>();
const generations = new Map<EnvironmentId, number>();
const listeners = new Set<() => void>();
let sequence = 0;
const key = (environmentId: EnvironmentId, botId: BotId | null) =>
  JSON.stringify([environmentId, botId]);
const notify = () => {
  for (const [id, scope] of scopes) scopes.set(id, { ...scope });
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const time = (value: string | null) => (value === null ? NaN : Date.parse(value));
const later = (a: string | null, b: string | null) =>
  Number.isFinite(time(b)) && (!Number.isFinite(time(a)) || time(b) > time(a)) ? b : a;
const readTask = (task: TaskRow, through: string | null) => ({
  ...task,
  unread:
    task.unread &&
    !(
      Number.isFinite(time(through)) &&
      Number.isFinite(time(task.lastActivityAt)) &&
      time(task.lastActivityAt) <= time(through)
    ),
  view: { ...task.view, readThrough: through },
});
function applyTaskView(
  entry: HistoryWork,
  view: ChannelTaskView,
  source: TaskRow = entry.task,
): HistoryWork {
  const task = readTask({ ...source, view }, later(entry.task.view.readThrough, view.readThrough));
  return {
    ...entry,
    task,
    rows: entry.rows.map((item) => (item.kind === "task" ? task : item)),
    viewSequence: ++sequence,
  };
}
function scopeFor(environmentId: EnvironmentId, botId: BotId | null): Scope {
  const id = key(environmentId, botId);
  let scope = scopes.get(id);
  if (!scope) {
    scope = {
      environmentId,
      entries: new Map(),
      ids: [],
      seen: new Set(),
      cursor: undefined,
      started: false,
      partial: false,
      endedEarly: false,
      capped: false,
      unsupported: false,
      loading: false,
      failed: false,
      revision: undefined,
      walkVersion: 0,
      truncated: new Set(),
    };
    scopes.set(id, scope);
  }
  return scope;
}
export function historyScope(environmentId: EnvironmentId, botId: BotId | null) {
  return scopes.get(key(environmentId, botId));
}
export function useHistoryScope(environmentId: EnvironmentId, botId: BotId | null) {
  return useSyncExternalStore(subscribe, () => historyScope(environmentId, botId));
}
export function historyResult(scope: Scope): ChannelListBotThreadsResult {
  const work = scope.ids.flatMap((id) => {
    const entry = scope.entries.get(id);
    return entry ? [entry] : [];
  });
  return {
    rows: work.flatMap((entry) => entry.rows),
    remoteWork: work.flatMap((entry) => entry.remoteWork),
    mainMessageCount: 0,
    history: {
      ...(scope.cursor === undefined ? {} : { nextCursor: scope.cursor }),
      ...(scope.partial ? { partial: true } : {}),
      ...(scope.endedEarly || scope.capped ? { endedEarly: true } : {}),
      launchesTruncated: [...scope.truncated],
    },
  };
}
export function syncHistoryCurrent(
  environmentId: EnvironmentId,
  botId: BotId | null,
  revision: number,
  rows: readonly BotThreadRow[],
) {
  const scope = scopeFor(environmentId, botId);
  let dirty = false;
  if (scope.revision !== revision) {
    scope.revision = revision;
    scope.walkVersion += 1;
    scope.loading = false;
    scope.cursor = undefined;
    scope.started = false;
    scope.capped = false;
    scope.partial = false;
    scope.endedEarly = false;
    scope.unsupported = false;
    scope.seen.clear();
    dirty = true;
  }
  for (const row of rows) {
    if (row.kind !== "task") continue;
    for (const candidate of scopes.values()) {
      if (candidate.environmentId !== environmentId) continue;
      const old = candidate.entries.get(row.task.taskId);
      if (!old) continue;
      const task = readTask(row, later(old.task.view.readThrough, row.view.readThrough));
      if (JSON.stringify(old.task) === JSON.stringify(task)) continue;
      candidate.entries.set(row.task.taskId, applyTaskView(old, row.view, row));
      dirty = true;
    }
  }
  if (dirty) notify();
}
export function beginHistoryRead(
  environmentId: EnvironmentId,
  botId: BotId | null,
): ReadToken | null {
  const scope = scopeFor(environmentId, botId);
  if (scope.loading || scope.capped || scope.unsupported) return null;
  scope.loading = true;
  scope.failed = false;
  notify();
  return {
    generation: generations.get(environmentId) ?? 0,
    sequence,
    walkVersion: scope.walkVersion,
  };
}
export function finishHistoryRead(
  environmentId: EnvironmentId,
  botId: BotId | null,
  token: ReadToken,
  pages: readonly ChannelListBotThreadsResult[],
  supported: boolean,
) {
  if ((generations.get(environmentId) ?? 0) !== token.generation) return;
  const scope = historyScope(environmentId, botId);
  if (!scope || scope.walkVersion !== token.walkVersion) return;
  if (!supported) {
    scope.unsupported = true;
    scope.loading = false;
    notify();
    return;
  }
  const entries = new Map(scope.entries);
  const ids = [...scope.ids];
  const seen = new Set(scope.seen);
  const truncated = new Set(scope.truncated);
  let capped = scope.capped;
  for (const page of pages) {
    for (const row of page.rows) {
      if (row.kind !== "task") continue;
      const id = row.task.taskId;
      const old = entries.get(id);
      if (!old && ids.length >= BOT_WORK_HISTORY_LIMIT) {
        capped = true;
        continue;
      }
      const view = old && old.viewSequence > token.sequence ? old.task.view : row.view;
      const task = readTask(
        { ...row, view },
        later(old?.task.view.readThrough ?? null, view.readThrough),
      );
      entries.set(id, {
        task,
        rows: [task, ...page.rows.filter((item) => item.kind === "coding" && item.taskId === id)],
        remoteWork: (page.remoteWork ?? []).filter((item) => item.taskId === id),
        viewSequence: old?.viewSequence ?? 0,
      });
      if (!seen.has(id)) {
        const index = ids.indexOf(id);
        if (index !== -1) ids.splice(index, 1);
        ids.splice(seen.size, 0, id);
      }
      seen.add(id);
      if (page.history?.launchesTruncated?.includes(id)) truncated.add(id);
      else truncated.delete(id);
    }
    scope.partial ||= page.history?.partial === true;
    scope.endedEarly ||= page.history?.endedEarly === true;
    scope.cursor = page.history?.nextCursor;
  }
  if (ids.length >= BOT_WORK_HISTORY_LIMIT && scope.cursor !== undefined) capped = true;
  if (scope.cursor === undefined && !scope.partial && !scope.endedEarly && !capped) {
    for (let index = ids.length - 1; index >= 0; index -= 1) {
      const id = ids[index];
      if (id !== undefined && !seen.has(id)) {
        ids.splice(index, 1);
        entries.delete(id);
        truncated.delete(id);
      }
    }
  }
  scope.entries.clear();
  for (const [id, entry] of entries) scope.entries.set(id, entry);
  scope.ids.splice(0, scope.ids.length, ...ids);
  scope.seen.clear();
  for (const id of seen) scope.seen.add(id);
  scope.truncated = truncated;
  scope.capped = capped;
  scope.started = true;
  scope.loading = false;
  notify();
}
export function failHistoryRead(
  environmentId: EnvironmentId,
  botId: BotId | null,
  token: ReadToken,
) {
  if ((generations.get(environmentId) ?? 0) !== token.generation) return;
  const scope = historyScope(environmentId, botId);
  if (scope && scope.walkVersion === token.walkVersion) {
    scope.loading = false;
    scope.failed = true;
    notify();
  }
}
// An item changed by another client remains as read until the current list or a new walk returns it.
export function historyTask(environmentId: EnvironmentId, taskId: ChannelTaskId) {
  for (const scope of scopes.values())
    if (scope.environmentId === environmentId && scope.entries.has(taskId))
      return scope.entries.get(taskId)?.task;
  return undefined;
}
function historyWork(environmentId: EnvironmentId, taskId: ChannelTaskId) {
  for (const scope of scopes.values())
    if (scope.environmentId === environmentId && scope.entries.has(taskId))
      return scope.entries.get(taskId);
  return undefined;
}
export function useHistoryWork(environmentId: EnvironmentId, taskId: ChannelTaskId) {
  return useSyncExternalStore(subscribe, () => historyWork(environmentId, taskId));
}
export function updateHistoryView(
  environmentId: EnvironmentId,
  taskId: ChannelTaskId,
  view: ChannelTaskView,
) {
  let dirty = false;
  for (const scope of scopes.values()) {
    if (scope.environmentId !== environmentId) continue;
    const entry = scope.entries.get(taskId);
    if (!entry) continue;
    scope.entries.set(taskId, applyTaskView(entry, view));
    dirty = true;
  }
  if (dirty) notify();
}
export function acknowledgeHistoryRow(
  environmentId: EnvironmentId,
  taskId: ChannelTaskId,
  through: string,
) {
  const task = historyTask(environmentId, taskId);
  if (task) updateHistoryView(environmentId, taskId, { ...task.view, readThrough: through });
}
export function clearHistoryEnvironment(environmentId: EnvironmentId) {
  generations.set(environmentId, (generations.get(environmentId) ?? 0) + 1);
  for (const [id, scope] of scopes) if (scope.environmentId === environmentId) scopes.delete(id);
  notify();
}
export function resetHistoryTasksForTests() {
  for (const scope of scopes.values())
    generations.set(scope.environmentId, (generations.get(scope.environmentId) ?? 0) + 1);
  scopes.clear();
  notify();
}
