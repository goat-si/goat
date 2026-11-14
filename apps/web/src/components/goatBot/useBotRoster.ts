import { useEffect } from "react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  botRoster,
  botRosterGroups,
  goatBotNewestTaskChips,
  goatBotTurnsWaiting,
} from "@goat/client-runtime/goatBot";
import type { BotId, BotRemoteWork, EnvironmentId, ThreadId } from "@goat/contracts";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { useTimelineVisibleTurnItems } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";
import { syncGoatBotMemberThreads, useGoatBotEnabled } from "./useGoatBotSession";

const NO_REMOTE_WORK: ReadonlyArray<BotRemoteWork> = [];

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
  // The conversation is read whether or not the server lists task threads: a question the bot
  // asked in its own turn shows only there. These items hold while only a reply's text streams,
  // so a token re-renders no reader of this list and rescans nothing below.
  const items = useTimelineVisibleTurnItems(
    watchedThreadId && environmentId !== null
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
    mainMessageCount: threads.data?.mainMessageCount ?? 0,
    /** Threads the bot launched on other machines; none from servers before this list. */
    remoteWork: threads.data?.remoteWork ?? NO_REMOTE_WORK,
    supported,
    loaded: threads.isSuccess,
    /** A read has succeeded; rows stay the last successful list while a refresh runs or fails. */
    established: threads.data !== null,
    pending: threads.isPending,
    failed: threads.error !== null,
    failure: threads.failure,
    /** The bot's own turns asking a question in its chat, which the rows never list. */
    turnsWaiting: goatBotTurnsWaiting(items),
    /** Each task's newest chip in the conversation: what its worker asks, which rows leave out. */
    chips: goatBotNewestTaskChips(items),
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
    /** Why the last list read failed; `bots` keeps the read before it. */
    botsError: profiles.error,
    retryBots: profiles.refresh,
    roster: botRoster({ supportsProfiles: capabilities?.goatBotProfiles === true, bots }),
    groups: botRosterGroups(bots ?? []),
    rows: threads.rows,
    rowsLoaded: threads.loaded,
    refresh: threads.refresh,
    slackEnabled: slack.data?.some((connection) => connection.enabled) === true,
  };
}
