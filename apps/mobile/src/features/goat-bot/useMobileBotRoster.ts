import { botRosterGroups, selectBotChildren } from "@goat/client-runtime/goatBot";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { ChannelUpdateTaskViewInput } from "@goat/contracts";
import { useEffect, useState } from "react";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { pickMobileGoatBotEnvironment } from "./goatBotHomeMode";
import { mobileBotRoster } from "./mobileBotRoster";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { syncMobileGoatBotMembers } from "./mobileGoatBotMembers";

export function useMobileBotRoster(selectedKey: string | null) {
  const home = useMobileGoatBotHomeMode();
  const selected = pickMobileGoatBotEnvironment(home.environments, home.botRef);
  const environmentId = selected?.environmentId ?? null;
  const { presentationById } = useEnvironments();
  const capabilities =
    environmentId === null
      ? undefined
      : presentationById.get(environmentId)?.serverConfig?.environment.capabilities;
  const connected = selected?.connected === true;
  const supportsProfiles = connected && capabilities?.goatBotProfiles === true;
  const supportsTaskThreads = connected && capabilities?.goatBotTaskThreads === true;
  const supportsMembers = connected && capabilities?.goatBotMembers === true;
  const profiles = useEnvironmentQuery(
    environmentId !== null && supportsProfiles
      ? channelEnvironment.listBots({
          environmentId,
          input: supportsMembers ? { includeDeleted: true } : {},
        })
      : null,
  );
  const threads = useEnvironmentQuery(
    environmentId !== null && supportsTaskThreads
      ? channelEnvironment.listBotThreads({ environmentId, input: {} })
      : null,
  );
  const items = useThreadVisibleTurnItems({
    environmentId: home.botRef?.environmentId === environmentId ? environmentId : null,
    threadId: home.botRef?.environmentId === environmentId ? (home.botRef?.threadId ?? null) : null,
  });
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
  const botThreadId = home.botRef?.threadId;
  const shouldRefresh = supportsTaskThreads && home.botRef?.environmentId === environmentId;
  // oxlint-disable-next-line goat/react-effect-budget -- Refresh the roster when channel timeline records change.
  useEffect(() => {
    if (shouldRefresh && botThreadId && revision !== undefined) refreshThreads();
  }, [shouldRefresh, botThreadId, revision, refreshThreads]);
  const bots = profiles.data?.bots;
  // oxlint-disable-next-line goat/react-effect-budget -- Keep the environment's send queue to the members the roster lists as active.
  useEffect(() => {
    if (environmentId !== null && supportsMembers && bots !== undefined)
      syncMobileGoatBotMembers(environmentId, bots);
  }, [environmentId, supportsMembers, bots]);
  const slack = useEnvironmentQuery(
    environmentId !== null && connected && capabilities?.slackChannel === true
      ? channelEnvironment.slackSettings({ environmentId, input: {} })
      : null,
  );
  const [showMore, setShowMore] = useState(false);
  const [now, setNow] = useState(Date.now);
  // oxlint-disable-next-line goat/react-effect-budget -- Quiet task visibility changes with time.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const roster = mobileBotRoster({
    supportsProfiles,
    supportsTaskThreads,
    bots: profiles.data?.bots,
    children: threads.data?.rows,
    now,
    showMore,
    selectedKey,
  });
  const alternateChildren = selectBotChildren({
    rows: supportsTaskThreads ? (threads.data?.rows ?? []) : [],
    now,
    showMore: !showMore,
    selectedKey,
  });
  const hiddenCount = showMore
    ? roster.children.rows.length - alternateChildren.rows.length
    : alternateChildren.rows.length - roster.children.rows.length;
  const update = async (input: ChannelUpdateTaskViewInput) => {
    if (environmentId === null || !supportsTaskThreads)
      throw new Error("Bot task threads are unavailable.");
    const result = await runAtomCommand(appAtomRegistry, channelEnvironment.updateTaskView, {
      environmentId,
      input,
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    threads.refresh();
  };
  return {
    ...roster,
    groups: botRosterGroups(profiles.data?.bots ?? []),
    supportsMembers,
    environmentId,
    slackEnabled: slack.data?.some((connection) => connection.enabled) === true,
    expanded: showMore,
    hiddenCount,
    showMore: () => setShowMore((current) => !current),
    update,
    error: profiles.error ?? threads.error,
  };
}

/**
 * The member bot a GoatBot screen names, deleted ones included; null for main. Also the main
 * bot's profile, which names the main chat. Reads the roster's own query. A named member the
 * roster does not know is reported missing only once the roster has answered, so it never falls
 * back to main.
 */
export function useMobileGoatBotMember(botId: string | undefined) {
  const home = useMobileGoatBotHomeMode();
  const selected = pickMobileGoatBotEnvironment(home.environments, home.botRef);
  const environmentId = selected?.environmentId ?? null;
  const { presentationById } = useEnvironments();
  const capabilities =
    environmentId === null
      ? undefined
      : presentationById.get(environmentId)?.serverConfig?.environment.capabilities;
  const supported = capabilities?.goatBotMembers === true;
  const profiles = useEnvironmentQuery(
    environmentId !== null && (supported || capabilities?.goatBotProfiles === true)
      ? channelEnvironment.listBots({
          environmentId,
          input: supported ? { includeDeleted: true } : {},
        })
      : null,
  );
  const member =
    botId === undefined || !supported
      ? null
      : (profiles.data?.bots.find((bot) => bot.role === "member" && bot.botId === botId) ?? null);
  return {
    member,
    main: botRosterGroups(profiles.data?.bots ?? []).main,
    missing:
      botId !== undefined &&
      member === null &&
      !profiles.isPending &&
      (profiles.isSuccess || !supported),
  };
}
