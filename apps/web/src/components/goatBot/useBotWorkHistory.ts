import { useEffect, useRef, useState } from "react";
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

interface Walk {
  readonly key: string;
  readonly scope: string;
  readonly retained: ReadonlyArray<ChannelListBotThreadsResult>;
  readonly pages: ReadonlyArray<ChannelListBotThreadsResult>;
  readonly unsupported: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
}

export function useBotWorkHistory(
  environmentId: EnvironmentId,
  botId: BotId | null,
  capabilities: ExecutionEnvironmentCapabilities | undefined,
  current: ChannelListBotThreadsResult,
  revision: number,
  loaded: boolean,
) {
  const read = useAtomCommand(channelEnvironment.listBotThreadsPage, { reportFailure: false });
  const scope = JSON.stringify([environmentId, botId]);
  const key = JSON.stringify([scope, revision]);
  const [stored, setStored] = useState<Walk>({
    key,
    scope,
    retained: [],
    pages: [],
    unsupported: false,
    loading: false,
    failed: false,
  });
  const walk =
    stored.key === key
      ? stored
      : {
          key,
          scope,
          retained:
            stored.scope === scope && !stored.unsupported
              ? [...stored.pages, ...stored.retained]
              : [],
          pages: [],
          unsupported: false,
          loading: false,
          failed: false,
        };
  const active = useRef<{ key: string } | null>(null);
  const currentKey = useRef<{ key: string } | null>(null);
  // oxlint-disable-next-line goat/react-effect-budget -- Discard history responses after switching lists or unmounting.
  useEffect(() => {
    currentKey.current = { key };
    return () => {
      currentKey.current = null;
    };
  }, [key]);
  const merged = mergeBotThreadHistory(current, [...walk.pages, ...walk.retained]);
  const cursor = walk.pages.at(-1)?.history?.nextCursor;
  const historySupported =
    botThreadsHistoryInput(capabilities, botId) !== null && !walk.unsupported;
  const enabled = loaded && historySupported;
  const hasMore = enabled && (walk.pages.length === 0 || cursor !== undefined);

  async function loadMore() {
    const request = currentKey.current;
    if (!hasMore || active.current === request || request?.key !== key) return;
    active.current = request;
    setStored({ ...walk, loading: true, failed: false });
    try {
      const result = await readBotThreadHistory({
        from: cursor,
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
      if (currentKey.current !== request) return;
      setStored({
        key,
        scope,
        retained:
          result.supported &&
          (result.pages.at(-1)?.result.history?.nextCursor !== undefined ||
            result.pages.at(-1)?.result.history?.partial ||
            result.pages.at(-1)?.result.history?.endedEarly)
            ? walk.retained
            : [],
        pages: result.supported ? [...walk.pages, ...result.pages.map((page) => page.result)] : [],
        unsupported: !result.supported,
        loading: false,
        failed: false,
      });
    } catch {
      if (currentKey.current === request) setStored({ ...walk, loading: false, failed: true });
    } finally {
      if (active.current === request) active.current = null;
    }
  }
  return {
    rows: merged.supported && historySupported ? merged.rows : current.rows,
    remoteWork:
      merged.supported && historySupported ? merged.remoteWork : (current.remoteWork ?? []),
    launchesTruncated:
      merged.supported && historySupported ? merged.launchesTruncated : new Set<ChannelTaskId>(),
    incomplete: merged.supported && historySupported && (merged.partial || merged.endedEarly),
    hasMore,
    loading: walk.loading,
    failed: walk.failed,
    loadMore,
  };
}
