import { useAtomValue } from "@effect/atom-react";
import { botManageFailure } from "@goat/client-runtime/goatBot";
import type { BotProfileValues } from "@goat/client-runtime/state/channels";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile, EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { Alert } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import { goatBotComputerConnectedNow, useGoatBotComputerConnected } from "./goatBotComputerLink";

const NO_PERMISSION = Atom.make(false);

/**
 * Create, edit, hide, delete and restore bots on the GOAT Bot computer, with what to show on
 * failure. None of them is offered or sent while that computer is offline.
 */
export function useMobileBotManage(environmentId: EnvironmentId | null, botName = "GOAT Bot") {
  const connected = useGoatBotComputerConnected(environmentId);
  const mayCreate = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : channelEnvironment.createBot.permissionAtom(environmentId),
  );
  const mayManage = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : channelEnvironment.setBotHidden.permissionAtom(environmentId),
  );
  const mayEdit = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : channelEnvironment.updateBot.permissionAtom(environmentId),
  );
  const offline = `${botName}'s computer isn't connected.`;
  const change = async (
    title: string,
    run: (environmentId: EnvironmentId) => Promise<{ readonly _tag: string }>,
  ) => {
    if (environmentId === null) return false;
    if (!goatBotComputerConnectedNow(environmentId)) {
      Alert.alert(title, offline);
      return false;
    }
    const result = await run(environmentId);
    if (result._tag === "Success") return true;
    Alert.alert(title, botManageFailure(squashAtomCommandFailure(result as never)));
    return false;
  };
  return {
    canCreate: mayCreate && connected,
    canManage: mayManage && connected,
    canEdit: mayEdit && connected,
    /** This person may hide, delete and restore bots, connected or not; offline they wait. */
    mayManage,
    /** The bot's computer is connected; bot writes wait for it. */
    connected,
    /** Resolves to the new bot, or to the message to show in the sheet. */
    create: async (
      changes: Partial<BotProfileValues>,
      model: BotProfile["defaultModelSelection"],
      clientRequestId: string,
    ): Promise<BotProfile | string> => {
      if (environmentId === null || !goatBotComputerConnectedNow(environmentId)) return offline;
      const result = await runAtomCommand(appAtomRegistry, channelEnvironment.createBot, {
        environmentId,
        input: {
          clientRequestId,
          name: changes.name ?? "",
          avatar: changes.avatar ?? null,
          purpose: changes.purpose ?? "",
          defaultModelSelection: model,
          // Neutral sends no key, which older servers would drop anyway.
          ...(changes.color == null ? {} : { color: changes.color }),
        },
      });
      return result._tag === "Success"
        ? result.value.bot
        : botManageFailure(squashAtomCommandFailure(result));
    },
    /** Resolves to null when saved, else the message to show in the sheet. A model is sent only when given. */
    update: async (
      bot: BotProfile,
      changes: Partial<BotProfileValues>,
      model?: BotProfile["defaultModelSelection"],
    ) => {
      if (environmentId === null || !goatBotComputerConnectedNow(environmentId)) return offline;
      const result = await runAtomCommand(appAtomRegistry, channelEnvironment.updateBot, {
        environmentId,
        input: {
          botId: bot.botId,
          ...changes,
          ...(model === undefined ? {} : { defaultModelSelection: model }),
        },
      });
      return result._tag === "Success" ? null : botManageFailure(squashAtomCommandFailure(result));
    },
    hide: (bot: BotProfile, hidden: boolean) =>
      change(hidden ? `Couldn't hide ${bot.name}` : `Couldn't show ${bot.name}`, (id) =>
        runAtomCommand(appAtomRegistry, channelEnvironment.setBotHidden, {
          environmentId: id,
          input: { botId: bot.botId, hidden },
        }),
      ),
    remove: (bot: BotProfile) =>
      change(`Couldn't delete ${bot.name}`, (id) =>
        runAtomCommand(appAtomRegistry, channelEnvironment.deleteBot, {
          environmentId: id,
          input: { botId: bot.botId },
        }),
      ),
    restore: (bot: BotProfile) =>
      change(`Couldn't restore ${bot.name}`, (id) =>
        runAtomCommand(appAtomRegistry, channelEnvironment.restoreBot, {
          environmentId: id,
          input: { botId: bot.botId },
        }),
      ),
  };
}
