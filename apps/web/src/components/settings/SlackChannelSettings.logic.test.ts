import { describe, expect, it } from "vite-plus/test";

import type { SlackChannelSettings } from "@goat/contracts";

import {
  parseSlackChannelIds,
  slackConfigureInput,
  slackDeliveryErrorMessage,
  slackSettingsAvailability,
  slackSettingsDraft,
  slackSettingsUnavailableMessage,
  withLiveStatus,
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

const saved = {
  connectionId: "slack-0123456789ab",
  enabled: true,
  hasAppToken: true,
  hasBotToken: true,
  teamId: "T0TEAM",
  allowedChannelIds: ["C0AAAAAAAA"],
  defaultTarget: {
    projectId: "project-1",
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
  },
  status: "connected",
} as unknown as SlackChannelSettings;

describe("parseSlackChannelIds", () => {
  it("accepts channel IDs with any separator, once each, and rejects names", () => {
    expect(
      parseSlackChannelIds(" C0AAAAAAAA, C0BBBBBBBB\nC0AAAAAAAA  #general general G0PRIVATE1 "),
    ).toEqual({
      ids: ["C0AAAAAAAA", "C0BBBBBBBB", "G0PRIVATE1"],
      invalid: ["#general", "general"],
    });
  });
});

describe("slackConfigureInput", () => {
  it("keeps saved tokens by sending only the ones typed", () => {
    const result = slackConfigureInput(
      { ...slackSettingsDraft(saved), botToken: " xoxb-new " },
      saved,
    );
    expect(result).toEqual({
      _tag: "ok",
      input: {
        connectionId: "slack-0123456789ab",
        enabled: true,
        botToken: "xoxb-new",
        allowedChannelIds: ["C0AAAAAAAA"],
        defaultTarget: saved.defaultTarget,
      },
    });
  });

  it("refuses to turn Slack on without both tokens and catches swapped tokens", () => {
    const fresh = { ...slackSettingsDraft(undefined), enabled: true };
    expect(slackConfigureInput({ ...fresh, appToken: "xapp-1" }, undefined)._tag).toBe("invalid");
    expect(
      slackConfigureInput({ ...fresh, appToken: "xoxb-1", botToken: "xoxb-2" }, undefined)._tag,
    ).toBe("invalid");
    expect(
      slackConfigureInput({ ...fresh, appToken: "xapp-1", botToken: "xoxb-2" }, undefined),
    ).toEqual({
      _tag: "ok",
      input: {
        enabled: true,
        appToken: "xapp-1",
        botToken: "xoxb-2",
        allowedChannelIds: [],
        defaultTarget: {},
      },
    });
  });

  it("clears the default project but keeps the default model it does not edit", () => {
    const result = slackConfigureInput({ ...slackSettingsDraft(saved), projectId: "" }, saved);
    expect(result._tag === "ok" && result.input.defaultTarget).toEqual({
      modelSelection: saved.defaultTarget?.modelSelection,
    });
  });

  it("clears a project-only default by sending an empty target", () => {
    const projectOnly = {
      ...saved,
      defaultTarget: { projectId: "project-1" },
    } as unknown as SlackChannelSettings;
    const result = slackConfigureInput(
      { ...slackSettingsDraft(projectOnly), projectId: "" },
      projectOnly,
    );
    expect(result._tag === "ok" && result.input.defaultTarget).toEqual({});
  });

  it("rejects channel names instead of saving an allowlist that matches nothing", () => {
    const result = slackConfigureInput(
      { ...slackSettingsDraft(saved), channels: "general" },
      saved,
    );
    expect(result._tag).toBe("invalid");
  });
});

describe("withLiveStatus", () => {
  it("applies the live status of the same connection and drops its stale error", () => {
    const failing = {
      ...saved,
      status: "error",
      lastError: "token_revoked",
    } as SlackChannelSettings;
    expect(
      withLiveStatus(failing, { connectionId: saved.connectionId, status: "connected" } as never),
    ).toEqual({ ...saved, status: "connected" });
    expect(
      withLiveStatus(failing, { connectionId: "slack-other", status: "connected" } as never),
    ).toBe(failing);
  });
});

describe("slackDeliveryErrorMessage", () => {
  it("tells the user to invite the bot when it is not in the channel", () => {
    expect(
      slackDeliveryErrorMessage({
        code: "not_in_channel",
        at: "2026-10-12T00:00:00.000Z",
        channelId: "C0AAAAAAAA",
      } as never),
    ).toBe("Invite the bot to C0AAAAAAAA so it can reply there.");
  });
});

describe("Slack independent review form", () => {
  it("defaults off and requires an explicit model before enabling", () => {
    const draft = slackSettingsDraft(saved);
    expect(draft.reviewEnabled).toBe(false);
    expect(slackConfigureInput({ ...draft, reviewEnabled: true }, saved)._tag).toBe("invalid");
  });
  it("round-trips and disables the connection's reviewer without changing the worker model", () => {
    const review = {
      enabled: true,
      modelSelection: { ...saved.defaultTarget!.modelSelection!, model: "review-model" },
    };
    const connection = { ...saved, review };
    const result = slackConfigureInput(
      { ...slackSettingsDraft(connection), reviewEnabled: false },
      connection,
    );
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") throw new Error("expected valid settings");
    expect(result.input.review).toEqual({ ...review, enabled: false });
    expect(result.input.defaultTarget?.modelSelection).toEqual(saved.defaultTarget!.modelSelection);
  });
});
