import { useEffect } from "react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { useThreadVisibleTurnItems } from "~/state/entities";
import { botRoster } from "@goat/client-runtime/goatBot";
import { useEnvironment } from "~/state/environments";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";
import { useGoatBotEnabled } from "./useGoatBotSession";

export function useBotRoster() {
  const { environment } = useGoatBotEnabled();
  const environmentId = environment?.environmentId ?? null;
  const presentation = useEnvironment(environmentId);
  const capabilities = presentation?.serverConfig?.environment.capabilities;
  const connected = presentation?.connection.phase === "connected";
  const profiles = useEnvironmentQuery(
    connected && environmentId !== null && capabilities?.goatBotProfiles === true
      ? channelEnvironment.listBots({ environmentId, input: {} })
      : null,
  );
  const threads = useEnvironmentQuery(
    connected && environmentId !== null && capabilities?.goatBotTaskThreads === true
      ? channelEnvironment.listBotThreads({ environmentId, input: {} })
      : null,
  );
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const items = useThreadVisibleTurnItems(
    botRef && botRef.environmentId === environmentId
      ? scopeThreadRef(botRef.environmentId, botRef.threadId)
      : null,
  );
  const revision = items
    .filter(
      ({ item }) =>
        (item.type === "notification" && item.ledgerTask !== undefined) ||
        ((item.type === "user_message" || item.type === "assistant_message") &&
          item.channel !== undefined),
    )
    .map(({ sourceItemId, item }) => `${sourceItemId}:${item.updatedAt}`)
    .join("|");
  const refreshThreads = threads.refresh;
  const botThreadId = botRef?.threadId;
  const shouldRefresh =
    connected &&
    capabilities?.goatBotTaskThreads === true &&
    botRef?.environmentId === environmentId;
  // oxlint-disable-next-line goat/react-effect-budget -- Refresh the roster when channel timeline records change.
  useEffect(() => {
    if (shouldRefresh && botThreadId && revision !== undefined) refreshThreads();
  }, [shouldRefresh, botThreadId, revision, refreshThreads]);
  const slack = useEnvironmentQuery(
    connected && environmentId !== null && capabilities?.slackChannel === true
      ? channelEnvironment.slackSettings({ environmentId, input: {} })
      : null,
  );
  return {
    environmentId,
    roster: botRoster({
      supportsProfiles: capabilities?.goatBotProfiles === true,
      bots: profiles.data?.bots,
    }),
    rows: threads.data?.rows ?? [],
    rowsLoaded: threads.isSuccess,
    refresh: threads.refresh,
    slackEnabled: slack.data?.some((connection) => connection.enabled) === true,
  };
}
