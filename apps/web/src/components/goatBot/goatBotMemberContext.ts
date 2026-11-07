import type { BotProfile } from "@goat/contracts";
import { createContext, useContext } from "react";

/** The member bot whose chat, task pane or work panel is open; null for the main bot. */
export const GoatBotMemberContext = createContext<BotProfile | null>(null);

export function useGoatBotMember(): BotProfile | null {
  return useContext(GoatBotMemberContext);
}

/** The /bot search that keeps a task link on the bot it belongs to. */
export function goatBotSearch(member: BotProfile | null): { bot?: BotProfile["botId"] } {
  return member === null ? {} : { bot: member.botId };
}

/** What useBotThreads needs to follow one member's work. */
export function memberThreadsKey(member: BotProfile | null) {
  return member === null ? null : { botId: member.botId, threadId: member.sessionThreadId };
}
