import type {
  BotId,
  BotRemoteWork,
  BotThreadRow,
  ChannelListBotThreadsInput,
  ChannelListBotThreadsResult,
  ChannelTaskId,
  ExecutionEnvironmentCapabilities,
} from "@goat/contracts";

import { botThreadsHistoryInput, mergeBotThreadHistory } from "./botThreadHistory.ts";
import type { BotThreadHistoryPage } from "./botThreadHistory.ts";
import { botThreadKey } from "./taskVisibility.ts";

type TaskRow = Extract<BotThreadRow, { kind: "task" }>;
type Entry = {
  task: TaskRow;
  rows: readonly BotThreadRow[];
  remoteWork: readonly BotRemoteWork[];
  truncated: boolean;
};
const HISTORY_LIMIT = 500;
/** A Home's walk through a bot's older work; each client holds it in its Home's own state. */
export const EMPTY_WALK = {
  entries: [] as readonly Entry[],
  cursor: undefined as string | undefined,
  started: false,
  partial: false,
  endedEarly: false,
  unsupported: false,
  loading: false,
  failed: false,
};
type BotWorkHistoryWalk = typeof EMPTY_WALK;
type SnoozeCheck = {
  readonly taskIds: ReadonlyArray<ChannelTaskId>;
  readonly active: NonNullable<ChannelListBotThreadsResult["activeSnoozes"]>;
};
const time = (value: string | null) => (value === null ? NaN : Date.parse(value));
const taskRows = (rows: readonly BotThreadRow[]) =>
  new Map(rows.flatMap((row) => (row.kind === "task" ? [[row.task.taskId, row] as const] : [])));
const activeSnoozes = (check: SnoozeCheck | undefined) => {
  const byTask = new Map(check?.taskIds.map((id) => [id, undefined as string | undefined]));
  for (const { taskId, until } of check?.active ?? []) byTask.set(taskId, until);
  return byTask;
};

export function botWorkHistorySnoozeInput(
  walk: BotWorkHistoryWalk,
  current: ChannelListBotThreadsResult,
  capabilities: ExecutionEnvironmentCapabilities | undefined,
  botId: BotId | null,
) {
  if (capabilities?.goatBotTaskSnooze !== true || walk.entries.length === 0) return null;
  const listed = taskRows(current.rows);
  const checkSnoozes = walk.entries
    .map((entry) => entry.task.task.taskId)
    .filter((id) => !listed.has(id));
  return checkSnoozes.length === 0
    ? null
    : ({ ...(botId === null ? {} : { botId }), checkSnoozes } satisfies ChannelListBotThreadsInput);
}
// The current list's items win by key, and the entry's other items are kept.
const union = <T>(mine: readonly T[], theirs: readonly T[], key: (item: T) => string) => {
  const keys = new Set(theirs.map(key));
  return [...theirs, ...mine.filter((item) => !keys.has(key(item)))];
};

// The server's current list is the authority for any task it holds: its task row replaces the
// entry's, so the entry keeps the last reported state after the task leaves that list. The pin is
// not carried: the server lists every pinned task, so one that left the list was unpinned, apart
// from pinned tasks its 100-row cut still drops.
export function writeThrough(
  walk: BotWorkHistoryWalk,
  current: ChannelListBotThreadsResult,
  check?: SnoozeCheck,
) {
  const listed = taskRows(current.rows);
  const folded = taskRows(current.snoozed ?? []);
  const snoozes = activeSnoozes(check);
  if (listed.size === 0 && folded.size === 0 && snoozes.size === 0) return walk;
  return {
    ...walk,
    entries: walk.entries.map((item) => {
      const id = item.task.task.taskId;
      const row = listed.get(id);
      if (row === undefined) {
        const foldedRow = folded.get(id);
        const until = foldedRow?.view.snoozedUntil ?? snoozes.get(id);
        if (foldedRow === undefined && (!snoozes.has(id) || item.task.view.snoozedUntil === until))
          return item;
        const { snoozedUntil: _stored, ...view } = foldedRow?.view ?? item.task.view;
        const task = {
          ...(foldedRow ?? item.task),
          view: {
            ...view,
            pinnedAt: null,
            ...(until === undefined ? {} : { snoozedUntil: until }),
          },
        };
        return { ...item, task, rows: item.rows.map((row) => (row.kind === "task" ? task : row)) };
      }
      const task = { ...row, view: { ...row.view, pinnedAt: null } };
      const coding = (rows: readonly BotThreadRow[]) =>
        rows.filter((other) => other.kind === "coding" && other.taskId === id);
      // A listed task's local launches never leave the current list, so a union loses nothing;
      // of its remote launches the current list reports every one except released ones.
      return {
        ...item,
        task,
        rows: [task, ...union(coding(item.rows), coding(current.rows), botThreadKey)],
        remoteWork: union(
          item.remoteWork.filter((other) => other.state === "released"),
          (current.remoteWork ?? []).filter((other) => other.taskId === id),
          (other) => other.childWorkId,
        ),
      };
    }),
  };
}

/** Opening an older row's peek acknowledges it; its read-through only moves forward. */
export function markWalkRead(
  walk: BotWorkHistoryWalk,
  taskId: ChannelTaskId,
  through: string,
): BotWorkHistoryWalk {
  if (!Number.isFinite(time(through))) return walk;
  return {
    ...walk,
    entries: walk.entries.map((entry) => {
      if (entry.task.task.taskId !== taskId) return entry;
      const old = entry.task.view.readThrough;
      const readThrough = time(old) >= time(through) ? old : through;
      const task = {
        ...entry.task,
        view: { ...entry.task.view, readThrough },
        unread: entry.task.unread && !(time(entry.task.lastActivityAt) <= time(readThrough)),
      };
      return {
        ...entry,
        task,
        rows: entry.rows.map((row) => (row.kind === "task" ? task : row)),
      };
    }),
  };
}

/** A press's pages, applied together: they only add tasks the walk does not hold. */
export function applyHistoryPress(
  walk: BotWorkHistoryWalk,
  result: { readonly pages: ReadonlyArray<BotThreadHistoryPage>; readonly supported: boolean },
): BotWorkHistoryWalk {
  if (!result.supported) return { ...walk, unsupported: true, loading: false };
  const entries = [...walk.entries];
  const ids = new Set(entries.map((entry) => entry.task.task.taskId));
  let { partial, endedEarly, cursor } = walk;
  for (const { result: page } of result.pages) {
    for (const row of page.rows) {
      if (row.kind !== "task" || ids.has(row.task.taskId)) continue;
      const id = row.task.taskId;
      ids.add(id);
      entries.push({
        task: row,
        rows: [row, ...page.rows.filter((item) => item.kind === "coding" && item.taskId === id)],
        remoteWork: (page.remoteWork ?? []).filter((item) => item.taskId === id),
        truncated: page.history?.launchesTruncated?.includes(id) === true,
      });
    }
    partial = partial || page.history?.partial === true;
    endedEarly = endedEarly || page.history?.endedEarly === true;
    cursor = page.history?.nextCursor;
  }
  return { ...walk, entries, partial, endedEarly, cursor, started: true, loading: false };
}

/**
 * What Home shows from the current list and the walk. Only older tasks count: the walk stops
 * reading once it holds 500 of them, and a task that returns to the current list lets it continue.
 */
export function botWorkHistoryView(input: {
  readonly walk: BotWorkHistoryWalk;
  readonly current: ChannelListBotThreadsResult;
  readonly capabilities: ExecutionEnvironmentCapabilities | undefined;
  readonly botId: BotId | null;
  readonly loaded: boolean;
  readonly snoozeCheck?: SnoozeCheck | undefined;
}) {
  const { walk, current, snoozeCheck } = input;
  const listed = taskRows(current.rows);
  // What the current list says about tasks the walk holds; a change is written through once.
  const held = walk.entries.flatMap((entry) => listed.get(entry.task.task.taskId) ?? []);
  const heldIds = new Set(held.map((row) => row.task.taskId));
  const cached = new Set(walk.entries.map((entry) => entry.task.task.taskId));
  const reported = JSON.stringify([
    held.map((row) => [row.task, row.view, row.unread, row.pullRequests, row.pullRequestsOmitted]),
    current.rows.filter((row) => row.kind === "coding" && heldIds.has(row.taskId)),
    (current.remoteWork ?? []).filter((item) => heldIds.has(item.taskId)),
    ...(snoozeCheck === undefined && current.snoozed === undefined
      ? []
      : [snoozeCheck, current.snoozed?.filter((row) => cached.has(row.task.taskId))]),
  ]);
  const supported =
    botThreadsHistoryInput(input.capabilities, input.botId) !== null && !walk.unsupported;
  const history: ChannelListBotThreadsResult = {
    rows: walk.entries.flatMap((entry) => entry.rows),
    remoteWork: walk.entries.flatMap((entry) => entry.remoteWork),
    mainMessageCount: 0,
    history: {
      launchesTruncated: walk.entries
        .filter((entry) => entry.truncated)
        .map((entry) => entry.task.task.taskId),
    },
  };
  const merged = mergeBotThreadHistory(current, supported ? [history] : []);
  const older = walk.entries.filter((entry) => !listed.has(entry.task.task.taskId)).length;
  const full = older >= HISTORY_LIMIT;
  const hasMore =
    input.loaded && supported && !full && (!walk.started || walk.cursor !== undefined);
  const useMerged = merged.supported && supported;
  return {
    supported,
    reported,
    /** The rows a press already holds, so its pages count only new tasks. */
    pressRows: merged.supported ? merged.rows : current.rows,
    currentTaskIds: new Set(listed.keys()),
    rows: useMerged ? merged.rows : current.rows,
    remoteWork: useMerged ? merged.remoteWork : (current.remoteWork ?? []),
    launchesTruncated: useMerged ? merged.launchesTruncated : new Set<ChannelTaskId>(),
    incomplete:
      supported && (walk.partial || walk.endedEarly || (full && walk.cursor !== undefined)),
    hasMore,
  };
}
