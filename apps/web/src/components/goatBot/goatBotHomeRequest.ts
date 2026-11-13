import type { BotId, ChannelTaskId, EnvironmentId } from "@goat/contracts";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** The Home this history entry was opened to show, from goatBotHomeKey. */
    goatBotOpenHome?: string | { readonly key: string; readonly taskId: ChannelTaskId };
  }
}

export const goatBotHomeKey = (environmentId: EnvironmentId | null, botId: BotId | null) =>
  JSON.stringify([environmentId, botId]);

export function rememberHomeOrigin(
  router: {
    readonly state: { readonly location: { readonly href: string; readonly state: object } };
    readonly history: { replace: (href: string, state: object) => void; flush: () => void };
  },
  environmentId: EnvironmentId,
  botId: BotId | null,
  taskId: ChannelTaskId,
) {
  const location = router.state.location;
  router.history.replace(location.href, {
    ...location.state,
    goatBotOpenHome: { key: goatBotHomeKey(environmentId, botId), taskId },
  });
  // The browser history batches writes and keeps only the last; the link's push follows at once.
  router.history.flush();
}
