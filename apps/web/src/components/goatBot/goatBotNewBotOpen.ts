import type { BotProfile } from "@goat/contracts";
import type { AnyRouter } from "@tanstack/react-router";

// The chat New bot opened focuses its name row once. The mark ends when the row takes it or the
// person goes anywhere but that chat. The chat opens at the bot's own thread, as its roster row
// does: through /bot it would mount twice, and the second mount would lose the focus.
let focusMark: {
  readonly botId: string;
  readonly onChat: () => boolean;
  readonly stop: () => void;
} | null = null;

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
    if (decodedPath(toLocation.pathname) !== chat) clearFocusMark();
  });
  const onChat = () => decodedPath(router.state.location.pathname) === chat;
  focusMark = { botId: bot.botId, onChat, stop };
  void router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: bot.environmentId, threadId: bot.sessionThreadId },
  });
}

/** True once, for the bot whose chat New bot just opened, when the page is that bot's thread. */
export function takeNameRowFocus(botId: string): boolean {
  if (focusMark?.botId !== botId || !focusMark.onChat()) return false;
  clearFocusMark();
  return true;
}
