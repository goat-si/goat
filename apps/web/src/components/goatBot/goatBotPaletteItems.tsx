import { goatBotMemberPicture } from "@goat/client-runtime/goatBot";
import type { BotProfile } from "@goat/contracts";
import type { useNavigate } from "@tanstack/react-router";

import { BotIcon } from "~/components/solar";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { useGoatBotEnabled } from "./useGoatBotSession";

type BotNavigate = ReturnType<typeof useNavigate>;

/** The bots the palette can open: main, then members that are not deleted. Read while it is open. */
export function useGoatBotPaletteBots(): ReadonlyArray<BotProfile> {
  const { environment } = useGoatBotEnabled();
  const environmentId = environment?.environmentId ?? null;
  const presentation = useEnvironment(environmentId);
  const capabilities = presentation?.serverConfig?.environment.capabilities;
  const profiles = useEnvironmentQuery(
    presentation?.connection.phase === "connected" &&
      environmentId !== null &&
      capabilities?.goatBotProfiles === true
      ? channelEnvironment.listBots({ environmentId, input: {} })
      : null,
  );
  return (profiles.data?.bots ?? []).filter((bot) => bot.state !== "deleted");
}

/** One entry per bot, so a person can jump to any bot by its name. */
export function goatBotPaletteItems(
  bots: ReadonlyArray<BotProfile>,
  navigate: BotNavigate,
): CommandPaletteActionItem[] {
  const main = bots.find((bot) => bot.role === "main");
  const items: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "action:goat-bot",
      searchTerms: ["goat bot", "bot", "assistant", "helper", ...(main ? [main.name] : [])],
      title: `Open ${main?.name ?? "GOAT Bot"}`,
      icon: <BotIcon className={ITEM_ICON_CLASS} />,
      run: () => navigate({ to: "/bot" }),
    },
  ];
  for (const bot of bots) {
    if (bot.role !== "member") continue;
    items.push({
      kind: "action",
      value: `action:goat-bot:${bot.botId}`,
      searchTerms: [bot.name, "bot", ...(bot.purpose ? [bot.purpose] : [])],
      title: `Open ${bot.name}`,
      icon: (
        <span
          aria-hidden
          className={`${ITEM_ICON_CLASS} flex items-center justify-center rounded-full border border-border text-3xs leading-none`}
        >
          {goatBotMemberPicture(bot)}
        </span>
      ),
      run: () => navigate({ to: "/bot", search: { bot: bot.botId } }),
    });
  }
  return items;
}
