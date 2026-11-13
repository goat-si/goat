import type { BotId, EnvironmentId } from "@goat/contracts";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** The Home this history entry was opened to show, from goatBotHomeKey. */
    goatBotOpenHome?: string;
  }
}

export const goatBotHomeKey = (environmentId: EnvironmentId | null, botId: BotId | null) =>
  JSON.stringify([environmentId, botId]);
