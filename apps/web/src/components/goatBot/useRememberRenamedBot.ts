import { RegistryContext } from "@effect/atom-react";
import type { BotProfile } from "@goat/contracts";
import { useContext } from "react";

import { channelEnvironment } from "~/state/channels";
import { keepRenamedBot } from "./goatBotRenamedBots";

/**
 * Remembers the profile a member rename returned until the bot list has been read since. The
 * rename's own re-read (refreshBots in client-runtime's channels.ts) restarts the list, so the
 * next read to settle began after the rename: a success retires the profile whatever it lists,
 * and a failure keeps it for the read after.
 */
export function useRememberRenamedBot(): (bot: BotProfile) => void {
  const registry = useContext(RegistryContext);
  return (bot) => {
    if (bot.role !== "member") return;
    const list = channelEnvironment.listBots({
      environmentId: bot.environmentId,
      input: { includeDeleted: true },
    });
    keepRenamedBot(bot, (retire) =>
      registry.subscribe(list, (result) => {
        if (!result.waiting && result._tag === "Success") retire();
      }),
    );
  };
}
