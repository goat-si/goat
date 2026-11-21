import {
  botAttentionDecisionSearch,
  encodeBotAttentionRequest,
  type BotAttentionDecisionResolver,
  readGoatBotAttentionTarget,
} from "@goat/client-runtime/goatBot";
import { MAIN_BOT_ID, type ChannelTask } from "@goat/contracts";
import type { ChannelAttentionTarget } from "@goat/contracts/channel-bot-attention";

function botTaskLink(
  target: ChannelAttentionTarget,
  originKind: ChannelTask["originAddress"]["kind"],
  requestId?: string,
  request?: ChannelAttentionTarget["request"],
) {
  const params = new URLSearchParams({
    taskId: target.taskId,
    attentionEnvironment: target.environmentId,
    ...(originKind === "goat" ? {} : { attentionDetail: "external" }),
    ...(target.botId === MAIN_BOT_ID ? {} : { botId: target.botId }),
    ...(request === undefined
      ? {}
      : {
          attentionNative: encodeBotAttentionRequest(request),
          ...(target.generation === undefined
            ? {}
            : { attentionGeneration: String(target.generation) }),
        }),
    ...(requestId === undefined ? {} : { attentionRequest: requestId }),
  });
  return "/bot?" + params.toString();
}

export async function resolveMobileBotAttentionLink(
  registry: Parameters<typeof readGoatBotAttentionTarget>[0],
  channels: Parameters<typeof readGoatBotAttentionTarget>[1],
  target: ChannelAttentionTarget,
  resolveDecision?: BotAttentionDecisionResolver,
) {
  const fresh = await readGoatBotAttentionTarget(registry, channels, target);
  if (fresh === null) return null;
  const decision =
    fresh.request === undefined || resolveDecision === undefined
      ? null
      : await resolveDecision(fresh.request, fresh.task);
  if (!registry.get(channels.listBotAttention.permissionAtom(target.environmentId))) return null;
  return decision === null
    ? botTaskLink(target, fresh.task.originAddress.kind, fresh.requestId, fresh.request)
    : "/decisions?" +
        new URLSearchParams(botAttentionDecisionSearch(decision, target, fresh.task)).toString();
}
