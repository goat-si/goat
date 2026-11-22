import type { BotProfile, EnvironmentId, ThreadId } from "@goat/contracts";

let pending: { bot: BotProfile; text: string } | undefined;

export function offerBotTemplateDraft(bot: BotProfile, text: string): void {
  pending = { bot, text };
}

export function readBotTemplateDraft(
  environmentId: EnvironmentId | null | undefined,
  threadId: ThreadId | null | undefined,
): string | undefined {
  if (pending?.bot.environmentId !== environmentId || pending?.bot.sessionThreadId !== threadId)
    return undefined;
  return pending?.text;
}

export function clearBotTemplateDraft(
  environmentId: EnvironmentId | null | undefined,
  threadId: ThreadId | null | undefined,
): void {
  if (pending?.bot.environmentId === environmentId && pending?.bot.sessionThreadId === threadId)
    pending = undefined;
}
