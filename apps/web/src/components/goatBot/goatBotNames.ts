import type { BotProfile, EnvironmentId } from "@goat/contracts";

const botNamesByThread = new Map<string, string>();
const mainBotNames = new Map<string, string>();
const openChatNames = new Map<string, string>();
const threadNameKey = (environmentId: string, threadId: string) => `${environmentId}\0${threadId}`;

/** The send queue reads these after render, when a server answer names the conversation. */
export function rememberGoatBotNames(
  environmentId: EnvironmentId,
  bots: ReadonlyArray<BotProfile>,
): void {
  for (const bot of bots) {
    if (bot.environmentId !== environmentId) continue;
    botNamesByThread.set(threadNameKey(environmentId, bot.sessionThreadId), bot.name);
    if (bot.role === "main") mainBotNames.set(environmentId, bot.name);
  }
}

export function goatBotNameFor(environmentId: string, threadId: string): string {
  return botNamesByThread.get(threadNameKey(environmentId, threadId)) ?? "GOAT Bot";
}

export function openMainBotName(environmentId: EnvironmentId | null): string {
  if (environmentId === null) return "GOAT Bot";
  return mainBotNames.get(environmentId) ?? "GOAT Bot";
}

export function rememberOpenChatName(environmentId: string, name: string): void {
  openChatNames.set(environmentId, name);
}

export function openChatNameFor(environmentId: string | null): string {
  if (environmentId === null) return "GOAT Bot";
  return openChatNames.get(environmentId) ?? "GOAT Bot";
}
