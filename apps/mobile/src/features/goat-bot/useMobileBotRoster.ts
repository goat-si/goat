import { botRoster, botRosterGroups } from "@goat/client-runtime/goatBot";
import { useEffect } from "react";
import { channelEnvironment } from "../../state/channels";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { pickMobileGoatBotHomeEnvironment } from "./goatBotHomeMode";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { syncMobileGoatBotMembers } from "./mobileGoatBotMembers";
import { useComputerReadable, useKeptPerComputer } from "./useKeptPerComputer";

/**
 * The bot list: bots only. The work each bot started is listed in that bot's home sheet. While the
 * computer is offline it keeps the list it last read there; what the server supports comes from
 * its capabilities, which outlive the connection.
 */
export function useMobileBotRoster() {
  const home = useMobileGoatBotHomeMode();
  const selected = pickMobileGoatBotHomeEnvironment(home.environments, home.botRef);
  const environmentId = selected?.environmentId ?? null;
  const { presentationById } = useEnvironments();
  const capabilities =
    environmentId === null
      ? undefined
      : presentationById.get(environmentId)?.serverConfig?.environment.capabilities;
  const connected = selected?.connected === true;
  const supportsProfiles = capabilities?.goatBotProfiles === true;
  const supportsMembers = capabilities?.goatBotMembers === true;
  const profiles = useEnvironmentQuery(
    environmentId !== null && connected && supportsProfiles
      ? channelEnvironment.listBots({
          environmentId,
          input: supportsMembers ? { includeDeleted: true } : {},
        })
      : null,
  );
  const bots = useKeptPerComputer("bots", environmentId, profiles, !connected)?.bots;
  const readable = useComputerReadable(environmentId);
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
  return {
    bots: botRoster({ supportsProfiles, bots }),
    groups: botRosterGroups(bots ?? []),
    supportsMembers,
    /** No computer, or none of its capabilities read yet: not taken as an older server. */
    membersUnknown: capabilities === undefined,
    connected,
    computerLabel: selected?.label ?? null,
    environmentId,
    slackEnabled: readable && slack.data?.some((connection) => connection.enabled) === true,
    error: profiles.error,
    /** Every bot the list holds, hidden and deleted included; null before it has answered. */
    listedBots: bots ?? null,
    /** Reads the bot list again; null while a read is under way or none has answered yet. */
    refreshBots: profiles.data !== null && !profiles.isPending ? profiles.refresh : null,
    /** Reads the bot list again after it failed; always offered beside its error. */
    retryBots: profiles.refresh,
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
  const selected = pickMobileGoatBotHomeEnvironment(home.environments, home.botRef);
  const environmentId = selected?.environmentId ?? null;
  const { presentationById } = useEnvironments();
  const capabilities =
    environmentId === null
      ? undefined
      : presentationById.get(environmentId)?.serverConfig?.environment.capabilities;
  const supported = capabilities?.goatBotMembers === true;
  // A named member is looked up as before; the main bot's name follows the roster's condition.
  const readsMember = supported && botId !== undefined;
  const connected = selected?.connected === true;
  const readsMain = connected && capabilities?.goatBotProfiles === true;
  const profiles = useEnvironmentQuery(
    environmentId !== null && connected && (readsMember || readsMain)
      ? channelEnvironment.listBots({
          environmentId,
          input: supported ? { includeDeleted: true } : {},
        })
      : null,
  );
  // Offline, the list the roster last read here, so a member's chat opens without a new read.
  const listed = useKeptPerComputer("bots", environmentId, profiles, !connected);
  const member =
    botId === undefined || !supported
      ? null
      : (listed?.bots.find((bot) => bot.role === "member" && bot.botId === botId) ?? null);
  return {
    member,
    main: botRosterGroups(listed?.bots ?? []).main,
    missing:
      botId !== undefined &&
      member === null &&
      (!supported ||
        (!profiles.isPending && profiles.isSuccess) ||
        (!connected && listed !== null)),
  };
}
