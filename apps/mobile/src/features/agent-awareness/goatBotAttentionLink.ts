import {
  botAttentionDecisionTarget,
  readGoatBotAttentionTarget,
} from "@goat/client-runtime/goatBot";
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
  if (fresh === null) return null;
  const target = args[2];
  const decision = botAttentionDecisionTarget(target.environmentId, fresh.task, fresh.requestId);
  return decision === null
    ? botTaskLink(target, fresh.task.originAddress.kind, fresh.requestId)
    : "/decisions?" + new URLSearchParams(decision).toString();
}
