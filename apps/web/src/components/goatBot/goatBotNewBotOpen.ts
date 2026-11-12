import type { BotProfile } from "@goat/contracts";
import type { AnyRouter } from "@tanstack/react-router";

// The chat New bot opened focuses its name row once. The mark ends when the row takes it or the
// person goes anywhere but that chat: /bot, which moves on to the bot's own thread, or the thread.
let focusMark: { readonly botId: string; readonly stop: () => void } | null = null;

function clearFocusMark() {
  focusMark?.stop();
  focusMark = null;
}

function decodedPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** Opens the chat of a bot New bot just created; its name row takes focus there once. */
export function openNewBotChat(router: AnyRouter, bot: BotProfile): void {
  clearFocusMark();
  const chat = `/${bot.environmentId}/${bot.sessionThreadId}`;
  const stop = router.subscribe("onResolved", ({ toLocation }) => {
    const path = decodedPath(toLocation.pathname);
    if (path !== "/bot" && path !== chat) clearFocusMark();
  });
  focusMark = { botId: bot.botId, stop };
  void router.navigate({ to: "/bot", search: { bot: bot.botId } });
}

/** True once, for the bot whose chat New bot just opened. */
export function takeNameRowFocus(botId: string): boolean {
  if (focusMark?.botId !== botId) return false;
  clearFocusMark();
  return true;
}
