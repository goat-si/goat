import {
  botManageFailure,
  newBotSlot,
  settleListedNewBots,
  startNewBot,
  type CreateNewBot,
} from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile, EnvironmentId } from "@goat/contracts";
import { useRouter, type AnyRouter } from "@tanstack/react-router";
import { createElement } from "react";

import { PlusIcon } from "~/components/solar";
import { randomUUID } from "~/lib/utils";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { openNewBotChat } from "./goatBotNewBotOpen";
import { useGoatBotPaletteNewBotSource } from "./goatBotPaletteItems";
import { navigationBlocked } from "~/lib/navigationHolds";
import { readGoatBotEnvironmentId } from "./readGoatBotEnvironmentId";
import { useNewBotSlot } from "./useNewBotSlot";

type PaletteNewBotSource = NonNullable<ReturnType<typeof useGoatBotPaletteNewBotSource>>;

// Running an item closes the palette, and its components with it, long before a create answers.
// This owner outlives them; only the environment's cleanup forgets its create.
const paletteOwner = {};

/** The palette's New bot: the roster's create, with no roster needed to see it through. */
export function useGoatBotPaletteNewBot(): CommandPaletteActionItem[] {
  const source = useGoatBotPaletteNewBotSource();
  const router = useRouter();
  const { operation } = useNewBotSlot(source?.environmentId ?? null);
  if (source === null) return [];
  return [
    {
      kind: "action",
      value: "action:goat-bot-new",
      searchTerms: ["new bot", "create bot", "add bot", "bot"],
      title: "New bot",
      icon: createElement(PlusIcon, { className: ITEM_ICON_CLASS }),
      ...(operation === null
        ? {}
        : {
            disabled: true,
            description:
              operation.phase === "creating"
                ? `Creating ${operation.name}…`
                : "Couldn't create; open Bots to retry",
          }),
      run: async () => startPaletteNewBot(source, router),
    },
  ];
}

function startPaletteNewBot(
  { environmentId, listed, send }: PaletteNewBotSource,
  router: AnyRouter,
) {
  const ranAt = router.state.location.href;
  const create: CreateNewBot = async (name, clientRequestId) => {
    const result = await send({
      environmentId,
      input: { clientRequestId, name, avatar: null, purpose: "", defaultModelSelection: null },
    });
    if (result._tag === "Success") return result.value.bot;
    const failure = botManageFailure(squashAtomCommandFailure(result));
    // No roster may be showing, so the failure is said here too; a forgotten create says nothing.
    if (newBotSlot(environmentId).operation?.clientRequestId === clientRequestId)
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Couldn't create ${name}`,
          description: failure,
        }),
      );
    return failure;
  };
  // The chat opens only if, when the create answers, GOAT Bot is still on the same environment, the
  // page is the one the command ran on, and nothing holds the page and nothing modal, the palette
  // included, is open. Otherwise no roster may be showing the new bot, so a toast says it is ready.
  const open = (bot: BotProfile, sentTo: EnvironmentId) => {
    const stillHere = readGoatBotEnvironmentId() === sentTo && router.state.location.href === ranAt;
    if (stillHere && !navigationBlocked()) openNewBotChat(router, bot);
    else toastManager.add(stackedThreadToast({ type: "success", title: `${bot.name} is ready` }));
  };
  settleListedNewBots(environmentId, new Set(listed.map((bot) => bot.botId)));
  startNewBot(environmentId, listed, create, open, paletteOwner, randomUUID);
}
