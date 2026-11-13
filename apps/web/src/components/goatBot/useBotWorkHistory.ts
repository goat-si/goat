import { useEffect } from "react";
import {
  botThreadKey,
  botThreadsHistoryInput,
  mergeBotThreadHistory,
  readBotThreadHistory,
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
import {
  acknowledgeHistoryRow,
  beginHistoryRead,
  failHistoryRead,
  finishHistoryRead,
  historyResult,
  syncHistoryCurrent,
  useHistoryScope,
} from "./botWorkHistoryStore";

export function useBotWorkHistory(
  environmentId: EnvironmentId,
  botId: BotId | null,
  capabilities: ExecutionEnvironmentCapabilities | undefined,
  current: ChannelListBotThreadsResult,
  revision: number,
  loaded: boolean,
) {
  const read = useAtomCommand(channelEnvironment.listBotThreadsPage, { reportFailure: false });
  const scope = useHistoryScope(environmentId, botId);
  // oxlint-disable-next-line goat/react-effect-budget -- Reconcile the live list into the shared history walk.
  useEffect(() => {
    if (loaded) syncHistoryCurrent(environmentId, botId, revision, current.rows);
  }, [environmentId, botId, revision, current.rows, loaded]);
  const historySupported =
    botThreadsHistoryInput(capabilities, botId) !== null && !scope?.unsupported;
  const merged = mergeBotThreadHistory(
    current,
    scope && historySupported ? [historyResult(scope)] : [],
  );
  const hasMore =
    loaded && historySupported && !scope?.capped && (!scope?.started || scope.cursor !== undefined);

  async function loadMore() {
    if (!hasMore) return;
    const token = beginHistoryRead(environmentId, botId);
    if (!token) return;
    try {
      const result = await readBotThreadHistory({
        from: scope?.cursor,
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
      finishHistoryRead(
        environmentId,
        botId,
        token,
        result.pages.map((page) => page.result),
        result.supported,
      );
    } catch {
      failHistoryRead(environmentId, botId, token);
    }
  }
  return {
    historySupported,
    acknowledge: (taskId: ChannelTaskId, through: string) =>
      acknowledgeHistoryRow(environmentId, taskId, through),
    rows: merged.supported && historySupported ? merged.rows : current.rows,
    remoteWork:
      merged.supported && historySupported ? merged.remoteWork : (current.remoteWork ?? []),
    launchesTruncated:
      merged.supported && historySupported ? merged.launchesTruncated : new Set<ChannelTaskId>(),
    incomplete: historySupported && !!scope && (scope.partial || scope.endedEarly || scope.capped),
    hasMore,
    loading: scope?.loading ?? false,
    failed: scope?.failed ?? false,
    loadMore,
  };
}
