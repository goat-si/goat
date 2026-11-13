import { useRef, useState } from "react";
import {
  applyHistoryPress,
  botThreadsHistoryInput,
  botWorkHistoryReported,
  botWorkHistoryView,
  EMPTY_WALK,
  markWalkRead,
  readBotThreadHistory,
  writeThrough,
} from "@goat/client-runtime/goatBot";
import type {
  BotId,
  ChannelListBotThreadsResult,
  ChannelTaskId,
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
} from "@goat/contracts";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";

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
  const reported = botWorkHistoryReported(walk, current);
  const [written, setWritten] = useState("[[],[],[]]");
  if (reported !== written) {
    setWritten(reported);
    setWalk((state) => writeThrough(state, current));
  }
  const view = botWorkHistoryView({ walk, current, capabilities, botId, loaded });
  function markRead(taskId: ChannelTaskId, through: string) {
    setWalk((state) => markWalkRead(state, taskId, through));
  }
  async function loadMore() {
    if (!view.hasMore || busy.current) return;
    busy.current = true;
    setWalk((state) => ({ ...state, loading: true, failed: false }));
    try {
      const result = await readBotThreadHistory({
        from: walk.cursor,
        listed: view.listed,
        wanted: 5,
        read: async (cursor) => {
          const input = botThreadsHistoryInput(capabilities, botId, cursor);
          if (input === null) throw new Error("History is unavailable");
          const answer = await read({ environmentId, input });
          if (answer._tag !== "Success") throw new Error("History could not be read");
          return answer.value;
        },
      });
      setWalk((state) => applyHistoryPress(state, result));
    } catch {
      setWalk((state) => ({ ...state, loading: false, failed: true }));
    }
    busy.current = false;
  }
  return {
    supported: view.supported,
    markRead,
    currentTaskIds: view.currentTaskIds,
    rows: view.rows,
    remoteWork: view.remoteWork,
    launchesTruncated: view.launchesTruncated,
    incomplete: view.incomplete,
    hasMore: view.hasMore,
    loading: walk.loading,
    failed: walk.failed,
    loadMore,
  };
}
