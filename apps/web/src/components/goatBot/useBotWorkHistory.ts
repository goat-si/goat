import { useRef, useState } from "react";
import {
  botThreadKey,
  botThreadsHistoryInput,
  mergeBotThreadHistory,
  readBotThreadHistory,
} from "@goat/client-runtime/goatBot";
import type {
  BotId,
  BotRemoteWork,
  BotThreadRow,
  ChannelListBotThreadsResult,
  ChannelTaskId,
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
} from "@goat/contracts";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";

type TaskRow = Extract<BotThreadRow, { kind: "task" }>;
type Entry = {
  task: TaskRow;
  rows: readonly BotThreadRow[];
  remoteWork: readonly BotRemoteWork[];
  truncated: boolean;
};
const HISTORY_LIMIT = 500;
const EMPTY_WALK = {
  entries: [] as readonly Entry[],
  cursor: undefined as string | undefined,
  started: false,
  partial: false,
  endedEarly: false,
  unsupported: false,
  loading: false,
  failed: false,
};
const time = (value: string | null) => (value === null ? NaN : Date.parse(value));
const taskRows = (rows: readonly BotThreadRow[]) =>
  new Map(rows.flatMap((row) => (row.kind === "task" ? [[row.task.taskId, row] as const] : [])));
// The current list's items win by key; the entry's history-only items, such as released remote
// launches that only history lists, are kept.
const union = <T>(mine: readonly T[], theirs: readonly T[], key: (item: T) => string) => {
  const keys = new Set(theirs.map(key));
  return [...theirs, ...mine.filter((item) => !keys.has(key(item)))];
};

// The server's current list is the authority for any task it holds: its task row replaces the
// entry's, so the entry keeps the last reported state after the task leaves that list. The pin is
// not carried: the server lists every pinned task, so one that left the list was unpinned, apart
// from pinned tasks its 100-row cut still drops.
function writeThrough(walk: typeof EMPTY_WALK, current: ChannelListBotThreadsResult) {
  const listed = taskRows(current.rows);
  if (!walk.entries.some((entry) => listed.has(entry.task.task.taskId))) return walk;
  return {
    ...walk,
    entries: walk.entries.map((item) => {
      const row = listed.get(item.task.task.taskId);
      if (!row) return item;
      const id = row.task.taskId;
      const task = { ...row, view: { ...row.view, pinnedAt: null } };
      const coding = (rows: readonly BotThreadRow[]) =>
        rows.filter((other) => other.kind === "coding" && other.taskId === id);
      return {
        ...item,
        task,
        rows: [task, ...union(coding(item.rows), coding(current.rows), botThreadKey)],
        remoteWork: union(
          item.remoteWork,
          (current.remoteWork ?? []).filter((other) => other.taskId === id),
          (other) => other.childWorkId,
        ),
      };
    }),
  };
}

/**
 * A bot's older work, read page by page while its Home panel is open. The panel is keyed by
 * environment and bot, so a switch starts a new walk and late answers reach an unmounted one.
 * Pages only add tasks; current-list rows win by id, so nothing a page says undoes an action.
 */
export function useBotWorkHistory(
  environmentId: EnvironmentId,
  botId: BotId | null,
  capabilities: ExecutionEnvironmentCapabilities | undefined,
  current: ChannelListBotThreadsResult,
  loaded: boolean,
) {
  const read = useAtomCommand(channelEnvironment.listBotThreadsPage, { reportFailure: false });
  const [walk, setWalk] = useState(EMPTY_WALK);
  const busy = useRef(false);
  const listed = taskRows(current.rows);
  // What the current list says about tasks the walk holds; a change writes it through once.
  const held = walk.entries.flatMap((entry) => listed.get(entry.task.task.taskId) ?? []);
  const heldIds = new Set(held.map((row) => row.task.taskId));
  const reported = JSON.stringify([
    held.map((row) => [row.task, row.view, row.unread]),
    current.rows.filter((row) => row.kind === "coding" && heldIds.has(row.taskId)),
    (current.remoteWork ?? []).filter((item) => heldIds.has(item.taskId)),
  ]);
  const [written, setWritten] = useState("[[],[],[]]");
  if (reported !== written) {
    setWritten(reported);
    setWalk((state) => writeThrough(state, current));
  }
  const supported = botThreadsHistoryInput(capabilities, botId) !== null && !walk.unsupported;
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
  // Only older tasks count: the walk stops reading once it holds 500 of them, and a task that
  // returns to the current list lets it continue.
  const older = walk.entries.filter((entry) => !listed.has(entry.task.task.taskId)).length;
  const full = older >= HISTORY_LIMIT;
  const hasMore = loaded && supported && !full && (!walk.started || walk.cursor !== undefined);
  // Opening an older row's peek acknowledges it; its read-through only moves forward.
  function markRead(taskId: ChannelTaskId, through: string) {
    if (!Number.isFinite(time(through))) return;
    setWalk((state) => ({
      ...state,
      entries: state.entries.map((entry) => {
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
    }));
  }
  async function loadMore() {
    if (!hasMore || busy.current) return;
    busy.current = true;
    setWalk((state) => ({ ...state, loading: true, failed: false }));
    try {
      const result = await readBotThreadHistory({
        from: walk.cursor,
        listed: new Set((merged.supported ? merged.rows : current.rows).map(botThreadKey)),
        wanted: 5,
        read: async (cursor) => {
          const input = botThreadsHistoryInput(capabilities, botId, cursor);
          if (input === null) throw new Error("History is unavailable");
          const answer = await read({ environmentId, input });
          if (answer._tag !== "Success") throw new Error("History could not be read");
          return answer.value;
        },
      });
      setWalk((state) => {
        if (!result.supported) return { ...state, unsupported: true, loading: false };
        const entries = [...state.entries];
        const ids = new Set(entries.map((entry) => entry.task.task.taskId));
        let { partial, endedEarly, cursor } = state;
        for (const { result: page } of result.pages) {
          for (const row of page.rows) {
            if (row.kind !== "task" || ids.has(row.task.taskId)) continue;
            const id = row.task.taskId;
            ids.add(id);
            entries.push({
              task: row,
              rows: [
                row,
                ...page.rows.filter((item) => item.kind === "coding" && item.taskId === id),
              ],
              remoteWork: (page.remoteWork ?? []).filter((item) => item.taskId === id),
              truncated: page.history?.launchesTruncated?.includes(id) === true,
            });
          }
          partial = partial || page.history?.partial === true;
          endedEarly = endedEarly || page.history?.endedEarly === true;
          cursor = page.history?.nextCursor;
        }
        return {
          ...state,
          entries,
          partial,
          endedEarly,
          cursor,
          started: true,
          loading: false,
        };
      });
    } catch {
      setWalk((state) => ({ ...state, loading: false, failed: true }));
    }
    busy.current = false;
  }
  const useMerged = merged.supported && supported;
  return {
    supported,
    markRead,
    currentTaskIds: new Set(listed.keys()),
    rows: useMerged ? merged.rows : current.rows,
    remoteWork: useMerged ? merged.remoteWork : (current.remoteWork ?? []),
    launchesTruncated: useMerged ? merged.launchesTruncated : new Set<ChannelTaskId>(),
    incomplete:
      supported && (walk.partial || walk.endedEarly || (full && walk.cursor !== undefined)),
    hasMore,
    loading: walk.loading,
    failed: walk.failed,
    loadMore,
  };
}
