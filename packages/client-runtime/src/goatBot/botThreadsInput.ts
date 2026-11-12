import type {
  BotId,
  ChannelListBotThreadsInput,
  ExecutionEnvironmentCapabilities,
} from "@goat/contracts";

/**
 * The input for one bot's first page of work, main when botId is absent. Every reader of that
 * list uses it, so they share one query. Only servers with `goatBotTaskThreadsPaged` get the
 * page key; older ones would drop it and answer the same list.
 */
export function botThreadsInput(
  capabilities: ExecutionEnvironmentCapabilities | undefined,
  botId?: BotId | null,
): ChannelListBotThreadsInput {
  return {
    ...(botId === undefined || botId === null ? {} : { botId }),
    ...(capabilities?.goatBotTaskThreadsPaged === true ? { page: { kind: "first" } } : {}),
  };
}
