import { describe, expect, it } from "vite-plus/test";

import {
  slackSettingsAvailability,
  slackSettingsUnavailableMessage,
} from "./SlackChannelSettings.logic";

const ready = {
  environmentSelected: true,
  connected: true,
  slackChannel: true,
  canConfigure: true,
} as const;

describe("slackSettingsAvailability", () => {
  it("offers controls only on a connected server that supports Slack and allows changes", () => {
    expect(slackSettingsAvailability(ready)).toBe("ready");
    expect(slackSettingsUnavailableMessage("ready")).toBeUndefined();
  });

  it.each([
    [{ ...ready, environmentSelected: false, connected: false }, "no_environment"],
    [{ ...ready, connected: false }, "offline"],
    [{ ...ready, connected: false, slackChannel: undefined }, "offline"],
    [{ ...ready, slackChannel: undefined }, "unsupported"],
    [{ ...ready, slackChannel: false }, "unsupported"],
    [{ ...ready, slackChannel: undefined, canConfigure: false }, "unsupported"],
    [{ ...ready, canConfigure: false }, "read_only"],
  ] as const)("reports %o as %s", (input, expected) => {
    expect(slackSettingsAvailability(input)).toBe(expected);
    expect(slackSettingsUnavailableMessage(expected)).toEqual(expect.any(String));
  });
});
