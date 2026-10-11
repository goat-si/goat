import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { SlackChannelConfigureInput, SlackChannelSettings } from "./index.ts";

const decodeSettings = Schema.decodeUnknownSync(SlackChannelSettings);
const encodeSettings = Schema.encodeSync(SlackChannelSettings);
const decode = Schema.decodeUnknownSync(SlackChannelConfigureInput);

describe("Slack channel settings", () => {
  it("reports whether tokens are stored without carrying them", () => {
    const settings = decodeSettings({
      connectionId: "slack-1",
      enabled: true,
      hasAppToken: true,
      hasBotToken: true,
      appToken: "xapp-should-not-survive",
      allowedChannelIds: ["C1"],
      status: "connected",
    });
    expect(settings).not.toHaveProperty("appToken");
    expect(encodeSettings(settings)).not.toHaveProperty("appToken");
  });

  it("treats omitted tokens as keep and accepts replacements on configure", () => {
    expect(decode({ enabled: true })).toEqual({ enabled: true });
    expect(decode({ connectionId: "slack-1", enabled: true, botToken: "xoxb-new" })).toEqual({
      connectionId: "slack-1",
      enabled: true,
      botToken: "xoxb-new",
    });
    expect(() => decode({ enabled: true, appToken: "  " })).toThrow();
  });
});
