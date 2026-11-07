import { useEffect } from "react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { botRoster, botRosterGroups, goatBotTurnsWaiting } from "@goat/client-runtime/goatBot";
import type { BotId, EnvironmentId, ThreadId } from "@goat/contracts";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { useThreadVisibleTurnItems } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";
import { syncGoatBotMemberThreads, useGoatBotEnabled } from "./useGoatBotSession";

/**
 * One bot's task threads, main when botId is null. The list is read again when channel records
 * in that bot's conversation change, so a member's work follows its own chat.
 */
export function useBotThreads(
  environmentId: EnvironmentId | null,
  bot: { readonly botId: BotId; readonly threadId: ThreadId } | null,
) {
  const presentation = useEnvironment(environmentId);
  const capabilities = presentation?.serverConfig?.environment.capabilities;
  const connected = presentation?.connection.phase === "connected";
  const supported =
    connected &&
    environmentId !== null &&
    capabilities?.goatBotTaskThreads === true &&
    (bot === null || capabilities.goatBotMembers === true);
  const threads = useEnvironmentQuery(
    supported
      ? channelEnvironment.listBotThreads({
          environmentId,
          input: bot === null ? {} : { botId: bot.botId },
        })
      : null,
  );
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const watchedThreadId =
    bot?.threadId ?? (botRef?.environmentId === environmentId ? botRef?.threadId : undefined);
  const items = useThreadVisibleTurnItems(
    supported && watchedThreadId && environmentId !== null
      ? scopeThreadRef(environmentId, watchedThreadId)
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
  // oxlint-disable-next-line goat/react-effect-budget -- Refresh the bot's task list when its channel timeline records change.
  useEffect(() => {
    if (supported && watchedThreadId && revision !== undefined) refreshThreads();
  }, [supported, watchedThreadId, revision, refreshThreads]);
  return {
    rows: threads.data?.rows ?? [],
    supported,
    loaded: threads.isSuccess,
    failed: threads.error !== null,
    /** The bot's own turns asking a question in its chat, which the rows never list. */
    turnsWaiting: goatBotTurnsWaiting(items),
    refresh: threads.refresh,
  };
}

export function useBotRoster() {
  const { environment } = useGoatBotEnabled();
  const environmentId = environment?.environmentId ?? null;
  const presentation = useEnvironment(environmentId);
  const capabilities = presentation?.serverConfig?.environment.capabilities;
  const connected = presentation?.connection.phase === "connected";
  const supportsMembers = connected && capabilities?.goatBotMembers === true;
  const profiles = useEnvironmentQuery(
    connected && environmentId !== null && capabilities?.goatBotProfiles === true
      ? channelEnvironment.listBots({
          environmentId,
          input: supportsMembers ? { includeDeleted: true } : {},
        })
      : null,
  );
  const threads = useBotThreads(environmentId, null);
  const slack = useEnvironmentQuery(
    connected && environmentId !== null && capabilities?.slackChannel === true
      ? channelEnvironment.slackSettings({ environmentId, input: {} })
      : null,
  );
  const bots = profiles.data?.bots;
  // oxlint-disable-next-line goat/react-effect-budget -- Keep the environment's send queue to the members the roster lists as active.
  useEffect(() => {
    if (environmentId !== null && supportsMembers && bots !== undefined)
      syncGoatBotMemberThreads(environmentId, bots);
  }, [environmentId, supportsMembers, bots]);
  return {
    environmentId,
    supportsMembers,
    bots,
    botsLoaded: profiles.isSuccess,
    botsPending: profiles.isPending,
    roster: botRoster({ supportsProfiles: capabilities?.goatBotProfiles === true, bots }),
    groups: botRosterGroups(bots ?? []),
    rows: threads.rows,
    rowsLoaded: threads.loaded,
    refresh: threads.refresh,
    slackEnabled: slack.data?.some((connection) => connection.enabled) === true,
  };
}
