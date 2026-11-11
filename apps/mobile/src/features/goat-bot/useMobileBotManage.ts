import { useAtomValue } from "@effect/atom-react";
import { botManageFailure } from "@goat/client-runtime/goatBot";
import type { BotProfileValues } from "@goat/client-runtime/state/channels";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile, EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { Alert } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";

const NO_PERMISSION = Atom.make(false);

/** Create, edit, hide, delete and restore bots on the GOAT Bot computer, with what to show on failure. */
export function useMobileBotManage(environmentId: EnvironmentId | null, botName = "GOAT Bot") {
  const canCreate = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : channelEnvironment.createBot.permissionAtom(environmentId),
  );
  const canManage = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : channelEnvironment.setBotHidden.permissionAtom(environmentId),
  );
  const canEdit = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : channelEnvironment.updateBot.permissionAtom(environmentId),
  );
  const change = async (
    title: string,
    run: (environmentId: EnvironmentId) => Promise<{ readonly _tag: string }>,
  ) => {
    if (environmentId === null) return false;
    const result = await run(environmentId);
    if (result._tag === "Success") return true;
    Alert.alert(title, botManageFailure(squashAtomCommandFailure(result as never)));
    return false;
  };
  return {
    canCreate,
    canManage,
    canEdit,
    /** Resolves to the new bot, or to the message to show in the sheet. */
    create: async (
      changes: Partial<BotProfileValues>,
      model: BotProfile["defaultModelSelection"],
      clientRequestId: string,
    ): Promise<BotProfile | string> => {
      if (environmentId === null) return `${botName}'s computer isn't connected.`;
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
      if (environmentId === null) return `${botName}'s computer isn't connected.`;
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
