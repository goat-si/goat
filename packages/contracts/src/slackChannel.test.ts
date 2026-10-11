import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  SlackChannelConfigureInput,
  SlackChannelSettings,
  SlackChannelSettingsError,
} from "./index.ts";

const decodeSettings = Schema.decodeUnknownSync(SlackChannelSettings);
const encodeSettings = Schema.encodeSync(SlackChannelSettings);
const decode = Schema.decodeUnknownSync(SlackChannelConfigureInput);
const encodeError = Schema.encodeSync(Schema.toCodecJson(SlackChannelSettingsError));

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

  it("encodes errors without anything a token could hide in", () => {
    const error = new SlackChannelSettingsError({ reason: "invalid_token" });
    expect(encodeError(error)).toEqual({
      _tag: "SlackChannelSettingsError",
      reason: "invalid_token",
    });
    expect(error.message).toBe("Slack rejected the token.");
  });
});
