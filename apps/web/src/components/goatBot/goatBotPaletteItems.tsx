import { useAtomValue } from "@effect/atom-react";
import { goatBotMemberPicture } from "@goat/client-runtime/goatBot";
import type { BotProfile } from "@goat/contracts";
import type { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";

import { BotIcon } from "~/components/solar";
import { dispatchMenuAction } from "~/shortcuts/dispatcher";
import { channelEnvironment } from "~/state/channels";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { useGoatBotEnabled } from "./useGoatBotSession";

type BotNavigate = ReturnType<typeof useNavigate>;
const NO_PERMISSION = Atom.make(false);

/** The bots the palette can open: main, then members that are not deleted. Read while it is open. */
export function useGoatBotPaletteBots(): ReadonlyArray<BotProfile> {
  const { environment } = useGoatBotEnabled();
  const environmentId = environment?.environmentId ?? null;
  const configs = useServerConfigs();
  const supported =
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.goatBotProfiles === true;
  const profiles = useEnvironmentQuery(
    supported ? channelEnvironment.listBots({ environmentId, input: {} }) : null,
  );
  return (profiles.data?.bots ?? []).filter((bot) => bot.state !== "deleted");
}

/**
 * What the palette's New bot needs: the environment, its whole bot list (the same read as the
 * roster's, deleted bots included, for the generated name) and the create command. Null until that
 * list has loaded, and where the server has no member bots or this person may not create one.
 */
export function useGoatBotPaletteNewBotSource() {
  const { environment } = useGoatBotEnabled();
  const environmentId = environment?.environmentId ?? null;
  const configs = useServerConfigs();
  const supported =
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.goatBotMembers === true;
  const canCreate = useAtomValue(
    supported ? channelEnvironment.createBot.permissionAtom(environmentId) : NO_PERMISSION,
  );
  const profiles = useEnvironmentQuery(
    supported && canCreate
      ? channelEnvironment.listBots({ environmentId, input: { includeDeleted: true } })
      : null,
  );
  const send = useAtomCommand(channelEnvironment.createBot, { reportFailure: false });
  const listed = profiles.data?.bots;
  return environmentId === null || listed === undefined ? null : { environmentId, listed, send };
}

/**
 * One entry per bot, so a person can jump to any bot by its name. The main bot is an action;
 * added bots appear only for a search, so many of them never push the palette's own actions down.
 */
export function goatBotPaletteItems(
  bots: ReadonlyArray<BotProfile>,
  navigate: BotNavigate,
): {
  readonly actions: CommandPaletteActionItem[];
  readonly search: CommandPaletteActionItem[];
} {
  const main = bots.find((bot) => bot.role === "main");
  const actions: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "action:goat-bot",
      searchTerms: ["goat bot", "bot", "assistant", "helper", ...(main ? [main.name] : [])],
      title: `Open ${main?.name ?? "GOAT Bot"}`,
      icon: <BotIcon className={ITEM_ICON_CLASS} />,
      run: () => navigate({ to: "/bot" }),
    },
  ];
  actions.push({
    kind: "action",
    value: "action:goat-bot-next-ask",
    searchTerms: ["needs you", "waiting", "question", "approval"],
    title: "Open next bot ask",
    icon: <BotIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "goatBot.nextAsk",
    run: async () => dispatchMenuAction("goatBot.nextAsk"),
  });
  const search: CommandPaletteActionItem[] = [];
  for (const bot of bots) {
    if (bot.role !== "member") continue;
    search.push({
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
  return { actions, search };
}
