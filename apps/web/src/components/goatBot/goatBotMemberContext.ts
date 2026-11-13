import {
  goatBotAccent,
  goatBotMemberPicture,
  goatBotName,
  type GoatBotAccent,
} from "@goat/client-runtime/goatBot";
import type { BotProfile } from "@goat/contracts";
import { createContext, useContext, type CSSProperties } from "react";

/** The member bot whose chat, task pane or work panel is open; null for the main bot. */
export const GoatBotMemberContext = createContext<BotProfile | null>(null);

/** The main bot's profile where its route has read the bot list; null otherwise. */
export const GoatBotMainProfileContext = createContext<BotProfile | null>(null);

export function useGoatBotMember(): BotProfile | null {
  return useContext(GoatBotMemberContext);
}

/** What the open chat is called: the member's name, else the main bot's, else GOAT Bot. */
export function useGoatBotName(): string {
  const member = useContext(GoatBotMemberContext);
  const main = useContext(GoatBotMainProfileContext);
  return goatBotName(member ?? main);
}

/** The main bot's name, for text about the main bot even inside a member's chat. */
export function useGoatBotMainName(): string {
  return goatBotName(useContext(GoatBotMainProfileContext));
}

/**
 * The open chat's bot as its avatar draws it: a member's emoji or initial on its colour, as in
 * the roster, else the main bot's avatar (null draws the face) with no colour.
 */
export function useGoatBotPicture(): {
  readonly emoji: string | null;
  readonly accent: GoatBotAccent | null;
} {
  const member = useContext(GoatBotMemberContext);
  const main = useContext(GoatBotMainProfileContext);
  return member === null
    ? { emoji: main?.avatar ?? null, accent: null }
    : { emoji: goatBotMemberPicture(member), accent: goatBotAccent(member) };
}

/**
 * The open member's accent as custom properties on the chat root, so its person pill and Send
 * read it. Null for the main bot and a member without a color: they keep the theme's neutral.
 */
export function useGoatBotAccentStyle(): CSSProperties | undefined {
  const accent = goatBotAccent(useContext(GoatBotMemberContext));
  return accent === null
    ? undefined
    : ({
        "--goat-bot-accent": accent.background,
        "--goat-bot-accent-foreground": accent.foreground,
      } as CSSProperties);
}

/** The /bot search that keeps a task link on the bot it belongs to. */
export function goatBotSearch(member: BotProfile | null): { bot?: BotProfile["botId"] } {
  return member === null ? {} : { bot: member.botId };
}

/** What useBotThreads needs to follow one member's work. */
export function memberThreadsKey(member: BotProfile | null) {
  return member === null ? null : { botId: member.botId, threadId: member.sessionThreadId };
}
