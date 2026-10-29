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
  channelScope: "listed",
  userAccess: "workspace",
  unlinkedRuntimeModeCeiling: "approval-required",
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
        channelScope: "listed",
        allowedChannelIds: ["C0AAAAAAAA"],
        userAccess: "workspace",
        unlinkedRuntimeModeCeiling: "approval-required",
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
        channelScope: "all",
        allowedChannelIds: [],
        userAccess: "workspace",
        unlinkedRuntimeModeCeiling: "approval-required",
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

  it("needs a channel ID when only listed channels are answered", () => {
    const draft = { ...slackSettingsDraft(saved), channelScope: "listed" as const, channels: "" };
    expect(slackConfigureInput(draft, saved)._tag).toBe("invalid");
    const all = slackConfigureInput({ ...draft, channelScope: "all" }, saved);
    expect(all._tag === "ok" && all.input.channelScope).toBe("all");
  });
});

describe("slackSettingsDraft", () => {
  it("starts a new connection open to every channel and the whole workspace", () => {
    expect(slackSettingsDraft(undefined)).toMatchObject({
      channelScope: "all",
      userAccess: "workspace",
      unlinkedRuntimeModeCeiling: "approval-required",
    });
    expect(
      slackSettingsDraft({ ...saved, userAccess: "linked", unlinkedRuntimeModeCeiling: "auto" }),
    ).toMatchObject({ userAccess: "linked", unlinkedRuntimeModeCeiling: "auto" });
  });

  it("shows an older server's actual behavior and sends it no access choices", () => {
    // A server from before the access choices returns none of them.
    const {
      channelScope: _scope,
      userAccess: _access,
      unlinkedRuntimeModeCeiling: _ceiling,
      ...older
    } = saved;
    const legacy = { ...older, allowedChannelIds: [] };
    const draft = slackSettingsDraft(legacy);
    expect(draft).toMatchObject({ channelScope: "listed", userAccess: "linked" });
    const built = slackConfigureInput(draft, legacy);
    expect(built._tag).toBe("ok");
    expect(built._tag === "ok" && built.input).not.toHaveProperty("channelScope");
    expect(built._tag === "ok" && built.input).not.toHaveProperty("userAccess");
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
