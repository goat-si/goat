import { resolveSlackAccess, type BotId, type SlackChannelSettings } from "@goat/contracts";

export function slackBoundChannelIds(
  botId: BotId,
  connections: ReadonlyArray<SlackChannelSettings> | null,
) {
  const channels = new Set<string>();
  for (const connection of connections ?? []) {
    if (!connection.enabled) continue;
    const { channelScope } = resolveSlackAccess(connection);
    for (const binding of connection.botBindings ?? []) {
      if (
        binding.botId === botId &&
        (channelScope === "all" || connection.allowedChannelIds.includes(binding.channelId))
      )
        channels.add(binding.channelId);
    }
  }
  return [...channels].sort();
}

export function slackReachabilityLabel(channels: ReadonlyArray<string>): string | null {
  if (channels.length === 0) return null;
  const shown = channels.slice(0, 4);
  const remaining = channels.length - shown.length;
  return "Reachable in Slack: " + shown.join(", ") + (remaining === 0 ? "" : " +" + remaining);
}
