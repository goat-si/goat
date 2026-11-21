import { BotId, SlackChannelConnectionId, type SlackChannelSettings } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { slackBoundChannelIds, slackReachabilityLabel } from "./slackBindings.ts";

it("only reports reachable channels from connected Slack connections", () => {
  const botId = BotId.make("scout");
  const connection = (channelId: string, status: SlackChannelSettings["status"]) => ({
    connectionId: SlackChannelConnectionId.make("slack-" + channelId),
    enabled: true,
    hasAppToken: true,
    hasBotToken: true,
    channelScope: "listed" as const,
    allowedChannelIds: [channelId],
    botBindings: [{ channelId, botId }],
    status,
  });
  const channels = slackBoundChannelIds(botId, [
    connection("C_REVOKED", "error"),
    connection("C_RECONNECTING", "reconnecting"),
    connection("C_CONNECTED", "connected"),
  ]);
  expect(slackReachabilityLabel(channels)).toBe("Reachable in Slack: C_CONNECTED");
});
