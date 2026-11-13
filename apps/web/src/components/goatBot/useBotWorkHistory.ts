import { useLayoutEffect, useRef, useState } from "react";
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
  ChannelTaskView,
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
type Walk = {
  key: string;
  entries: readonly Entry[];
  cursor: string | undefined;
  started: boolean;
  partial: boolean;
  endedEarly: boolean;
  capped: boolean;
  unsupported: boolean;
  loading: boolean;
  failed: boolean;
};
const emptyWalk = (key: string): Walk => ({
  key,
  entries: [],
  cursor: undefined,
  started: false,
  partial: false,
  endedEarly: false,
  capped: false,
  unsupported: false,
  loading: false,
  failed: false,
});

export function useBotWorkHistory(
  environmentId: EnvironmentId,
  botId: BotId | null,
  capabilities: ExecutionEnvironmentCapabilities | undefined,
  current: ChannelListBotThreadsResult,
  loaded: boolean,
) {
  const read = useAtomCommand(channelEnvironment.listBotThreadsPage, { reportFailure: false });
  const key = JSON.stringify([environmentId, botId]);
  const [stored, setStored] = useState(() => emptyWalk(key));
  const identity = useRef<{ key: string } | null>(null);
  const walk = stored.key === key ? stored : emptyWalk(key);
  // Every update starts from this key's walk, so a bot switch never applies to the old one.
  const update = (change: (state: Walk) => Walk) =>
    setStored((state) => change(state.key === key ? state : emptyWalk(key)));
  const active = useRef<object | null>(null);
  // oxlint-disable-next-line goat/react-effect-budget -- Invalidate pending pages when the key changes or the panel unmounts.
  useLayoutEffect(() => {
    const token = { key };
    identity.current = token;
    return () => {
      identity.current = null;
    };
  }, [key]);
  const historySupported =
    botThreadsHistoryInput(capabilities, botId) !== null && !walk.unsupported;
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
  const merged = mergeBotThreadHistory(current, historySupported ? [history] : []);
  const hasMore =
    loaded && historySupported && !walk.capped && (!walk.started || walk.cursor !== undefined);
  // A view from the server replaces the entry's view; a read-through never moves backwards.
  function applyView(taskId: ChannelTaskId, view: Partial<ChannelTaskView>) {
    update((state) => {
      const entries = state.entries.map((entry) => {
        if (entry.task.task.taskId !== taskId) return entry;
        const old = entry.task.view.readThrough;
        const next = view.readThrough ?? null;
        const readThrough =
          next === null || (old !== null && Date.parse(old) >= Date.parse(next)) ? old : next;
        const task = {
          ...entry.task,
          view: { ...entry.task.view, ...view, readThrough },
          unread:
            entry.task.unread &&
            !(
              readThrough !== null &&
              Date.parse(entry.task.lastActivityAt) <= Date.parse(readThrough)
            ),
        };
        return {
          ...entry,
          task,
          rows: entry.rows.map((row) => (row.kind === "task" ? task : row)),
        };
      });
      return { ...state, entries };
    });
  }
  const markRead = (taskId: ChannelTaskId, through: string) => {
    if (Number.isFinite(Date.parse(through))) applyView(taskId, { readThrough: through });
  };
  async function loadMore() {
    const token = identity.current;
    if (!hasMore || token === null || token.key !== key || active.current === token) return;
    active.current = token;
    update((state) => ({ ...state, loading: true, failed: false }));
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
      if (identity.current !== token) return;
      update((state) => {
        if (!result.supported) return { ...state, unsupported: true, loading: false };
        const entries = [...state.entries];
        const ids = new Set(entries.map((entry) => entry.task.task.taskId));
        let { partial, endedEarly, cursor, capped } = state;
        for (const { result: page } of result.pages) {
          for (const row of page.rows) {
            if (row.kind !== "task" || ids.has(row.task.taskId)) continue;
            if (entries.length >= 500) {
              capped = true;
              continue;
            }
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
        if (entries.length >= 500 && cursor !== undefined) capped = true;
        return {
          ...state,
          entries,
          partial,
          endedEarly,
          cursor,
          capped,
          started: true,
          loading: false,
        };
      });
    } catch {
      if (identity.current === token)
        update((state) => ({ ...state, loading: false, failed: true }));
    }
    if (active.current === token) active.current = null;
  }
  return {
    historySupported,
    applyView,
    markRead,
    rows: merged.supported && historySupported ? merged.rows : current.rows,
    remoteWork:
      merged.supported && historySupported ? merged.remoteWork : (current.remoteWork ?? []),
    launchesTruncated:
      merged.supported && historySupported ? merged.launchesTruncated : new Set<ChannelTaskId>(),
    incomplete: historySupported && (walk.partial || walk.endedEarly || walk.capped),
    hasMore,
    loading: walk.loading,
    failed: walk.failed,
    loadMore,
  };
}
