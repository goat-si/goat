import { useAtomValue } from "@effect/atom-react";
import { botManageFailure } from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile, EnvironmentId } from "@goat/contracts";

import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";

/** Runs one roster change and says why it failed; resolves true when it went through. */
export function useBotManage(environmentId: EnvironmentId) {
  const setHidden = useAtomCommand(channelEnvironment.setBotHidden, { reportFailure: false });
  const remove = useAtomCommand(channelEnvironment.deleteBot, { reportFailure: false });
  const restore = useAtomCommand(channelEnvironment.restoreBot, { reportFailure: false });
  const update = useAtomCommand(channelEnvironment.updateBot, { reportFailure: false });
  const canManage = useAtomValue(channelEnvironment.setBotHidden.permissionAtom(environmentId));
  const report = async (
    title: string,
    run: Promise<Awaited<ReturnType<typeof setHidden>>>,
  ): Promise<boolean> => {
    const result = await run;
    if (result._tag === "Success") return true;
    toastManager.add({
      type: "error",
      title,
      description: botManageFailure(squashAtomCommandFailure(result)),
    });
    return false;
  };
  return {
    canManage,
    hide: (bot: BotProfile, hidden: boolean) =>
      report(
        hidden ? `Couldn't hide ${bot.name}` : `Couldn't show ${bot.name}`,
        setHidden({ environmentId, input: { botId: bot.botId, hidden } }),
      ),
    remove: (bot: BotProfile) =>
      report(`Couldn't delete ${bot.name}`, remove({ environmentId, input: { botId: bot.botId } })),
    restore: (bot: BotProfile) =>
      report(
        `Couldn't restore ${bot.name}`,
        restore({ environmentId, input: { botId: bot.botId } }),
      ),
    update,
  };
}
