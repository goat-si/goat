import { BotId, ChannelTaskId } from "@goat/contracts";
import * as Schema from "effect/Schema";

const isChannelTaskId = Schema.is(ChannelTaskId);
const isBotId = Schema.is(BotId);

/** `bot` names a member bot; without it the route is the main bot's. */
export function validateBotTaskSearch(search: Record<string, unknown>): {
  task?: ChannelTaskId;
  bot?: BotId;
} {
  return {
    ...(isChannelTaskId(search.task) ? { task: search.task } : {}),
    ...(isBotId(search.bot) ? { bot: search.bot } : {}),
  };
}
