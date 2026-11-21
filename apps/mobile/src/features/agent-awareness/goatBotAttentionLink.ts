import { readGoatBotAttentionTarget } from "@goat/client-runtime/goatBot";
import { MAIN_BOT_ID, type ChannelTask } from "@goat/contracts";
import type { ChannelAttentionTarget } from "@goat/contracts/channel-bot-attention";

function botTaskLink(
  target: ChannelAttentionTarget,
  originKind: ChannelTask["originAddress"]["kind"],
  requestId?: string,
) {
  const params = new URLSearchParams({
    taskId: target.taskId,
    attentionEnvironment: target.environmentId,
    ...(originKind === "goat" ? {} : { attentionDetail: "external" }),
    ...(target.botId === MAIN_BOT_ID ? {} : { botId: target.botId }),
    ...(requestId === undefined ? {} : { attentionRequest: requestId }),
  });
  return "/bot?" + params.toString();
}

export async function resolveMobileBotAttentionLink(
  ...args: Parameters<typeof readGoatBotAttentionTarget>
) {
  const fresh = await readGoatBotAttentionTarget(...args);
  return fresh === null
    ? null
    : botTaskLink(args[2], fresh.task.originAddress.kind, fresh.requestId);
}
