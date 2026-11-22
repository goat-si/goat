import type { BotProfile, ChannelCreateBotInput } from "@goat/contracts";

export function botTemplateRetryInput(bot: BotProfile): ChannelCreateBotInput | undefined {
  if (bot.state === "deleted" || bot.templateSetup === undefined) return;
  return {
    ...bot.templateSetup,
    retryForBotId: bot.botId,
    name: bot.name,
    avatar: bot.avatar,
    purpose: bot.purpose,
    defaultModelSelection: bot.defaultModelSelection,
  };
}
