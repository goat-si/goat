import { BotId, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";

const isChannelTaskId = Schema.is(ChannelTaskId);
const isEnvironmentId = Schema.is(EnvironmentId);
const isBotId = Schema.is(BotId);

/** `bot` names a member bot; without it the route is the main bot's. */
export function validateBotTaskSearch(search: Record<string, unknown>): {
  task?: ChannelTaskId;
  bot?: BotId;
  taskTitle?: string;
  attentionEnvironment?: EnvironmentId;
  attentionRequest?: string;
  attentionDetail?: "external";
} {
  return {
    ...(isChannelTaskId(search.task) ? { task: search.task } : {}),
    ...(isEnvironmentId(search.attentionEnvironment) && isChannelTaskId(search.task)
      ? { attentionEnvironment: search.attentionEnvironment }
      : {}),
    ...(search.attentionDetail === "external" ? { attentionDetail: "external" } : {}),
    ...(typeof search.attentionRequest === "string" && search.attentionRequest.length <= 1024
      ? { attentionRequest: search.attentionRequest }
      : {}),
    ...(isBotId(search.bot) ? { bot: search.bot } : {}),
    ...(typeof search.taskTitle === "string" && search.taskTitle.length > 0
      ? { taskTitle: search.taskTitle }
      : {}),
  };
}
