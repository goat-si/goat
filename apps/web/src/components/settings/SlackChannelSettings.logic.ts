import type {
  ProjectId,
  ModelSelection,
  SlackChannelConfigureInput,
  SlackChannelConnectionStatus,
  SlackChannelDeliveryError,
  SlackChannelSettings,
  SlackChannelStatusEvent,
} from "@goat/contracts";

/**
 * When the Slack section can offer controls for the selected environment. The server
 * owns the tokens and the socket; until it advertises `slackChannel`, the section only
 * explains why it is unavailable.
 */
export type SlackSettingsAvailability =
  | "no_environment"
  | "offline"
  | "unsupported"
  | "read_only"
  | "ready";

export function slackSettingsAvailability(input: {
  readonly environmentSelected: boolean;
  readonly connected: boolean;
  /** `capabilities.slackChannel`; absent on servers without the Slack adapter. */
  readonly slackChannel: boolean | undefined;
  readonly canConfigure: boolean;
}): SlackSettingsAvailability {
  if (!input.environmentSelected) return "no_environment";
  if (!input.connected) return "offline";
  if (input.slackChannel !== true) return "unsupported";
  if (!input.canConfigure) return "read_only";
  return "ready";
}

export function slackSettingsUnavailableMessage(
  availability: SlackSettingsAvailability,
): string | undefined {
  switch (availability) {
    case "no_environment":
      return "Choose an environment to connect Slack.";
    case "offline":
      return "Connect to this environment to manage Slack.";
    case "unsupported":
      return "Slack isn't available on this environment's server yet.";
    case "read_only":
      return "This connection can't change Slack settings.";
    case "ready":
      return undefined;
  }
}

// Public (C) and private (G) channel IDs: upper case, nine or more characters.
const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{8,31}$/;

/**
 * Reads channel IDs typed as a list. Slack shows them under a channel's details, such as
 * `C0123456789`; names like `#general` are not IDs and come back as invalid.
 */
export function parseSlackChannelIds(text: string): {
  readonly ids: ReadonlyArray<string>;
  readonly invalid: ReadonlyArray<string>;
} {
  const ids: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const value = raw.trim();
    if (value.length === 0) continue;
    if (!SLACK_CHANNEL_ID.test(value)) invalid.push(value);
    else if (!ids.includes(value)) ids.push(value);
  }
  return { ids, invalid };
}

export interface SlackSettingsDraft {
  readonly enabled: boolean;
  /** Write-only. Empty keeps the stored token. */
  readonly appToken: string;
  readonly botToken: string;
  readonly channels: string;
  /** Empty means no default project. */
  readonly projectId: string;
  readonly reviewEnabled?: boolean;
  readonly reviewerModel?: ModelSelection;
}

export function slackSettingsDraft(settings: SlackChannelSettings | undefined): SlackSettingsDraft {
  return {
    enabled: settings?.enabled ?? false,
    appToken: "",
    botToken: "",
    channels: settings?.allowedChannelIds.join(", ") ?? "",
    projectId: settings?.defaultTarget?.projectId ?? "",
    reviewEnabled: settings?.review?.enabled ?? false,
    ...(settings?.review === undefined ? {} : { reviewerModel: settings.review.modelSelection }),
  };
}

export type SlackConfigureDraftResult =
  | { readonly _tag: "ok"; readonly input: SlackChannelConfigureInput }
  | { readonly _tag: "invalid"; readonly message: string };

/**
 * The configure call for a saved form. Only typed tokens are sent, so an untouched field keeps
 * the stored one. The default model is not edited here and is passed back unchanged.
 */
export function slackConfigureInput(
  draft: SlackSettingsDraft,
  settings: SlackChannelSettings | undefined,
): SlackConfigureDraftResult {
  const appToken = draft.appToken.trim();
  if (draft.reviewEnabled && draft.reviewerModel === undefined) {
    return {
      _tag: "invalid",
      message: "Choose a reviewer model before enabling independent review.",
    };
  }
  const botToken = draft.botToken.trim();
  if (appToken.length > 0 && !appToken.startsWith("xapp-")) {
    return { _tag: "invalid", message: "The app-level token starts with xapp-." };
  }
  if (botToken.length > 0 && !botToken.startsWith("xoxb-")) {
    return { _tag: "invalid", message: "The bot token starts with xoxb-." };
  }
  const channels = parseSlackChannelIds(draft.channels);
  if (channels.invalid.length > 0) {
    return {
      _tag: "invalid",
      message: `Use channel IDs such as C0123456789, not ${channels.invalid.join(", ")}.`,
    };
  }
  const hasAppToken = appToken.length > 0 || settings?.hasAppToken === true;
  const hasBotToken = botToken.length > 0 || settings?.hasBotToken === true;
  if (draft.enabled && !(hasAppToken && hasBotToken)) {
    return { _tag: "invalid", message: "Add both tokens before turning Slack on." };
  }
  // Always sent: an omitted target keeps the stored one, so clearing the project needs `{}`.
  const modelSelection = settings?.defaultTarget?.modelSelection;
  const projectId = draft.projectId.length > 0 ? (draft.projectId as ProjectId) : undefined;
  const defaultTarget = {
    ...(projectId === undefined ? {} : { projectId }),
    ...(modelSelection === undefined ? {} : { modelSelection }),
  };
  return {
    _tag: "ok",
    input: {
      ...(settings === undefined ? {} : { connectionId: settings.connectionId }),
      enabled: draft.enabled,
      ...(appToken.length > 0 ? { appToken } : {}),
      ...(botToken.length > 0 ? { botToken } : {}),
      allowedChannelIds: channels.ids,
      defaultTarget,
      ...(draft.reviewerModel === undefined
        ? {}
        : {
            review: {
              enabled: draft.reviewEnabled === true,
              modelSelection: draft.reviewerModel,
            },
          }),
    },
  };
}

/** The live status wins over the snapshot when it is for the same connection. */
export function withLiveStatus(
  settings: SlackChannelSettings,
  event: SlackChannelStatusEvent | null,
): SlackChannelSettings {
  if (event === null || event.connectionId !== settings.connectionId) return settings;
  const { lastError: _lastError, lastDeliveryError: _lastDeliveryError, ...rest } = settings;
  return {
    ...rest,
    status: event.status,
    ...(event.lastError === undefined ? {} : { lastError: event.lastError }),
    ...(event.lastDeliveryError === undefined
      ? {}
      : { lastDeliveryError: event.lastDeliveryError }),
  };
}

export function slackStatusLabel(status: SlackChannelConnectionStatus): string {
  switch (status) {
    case "disabled":
      return "Off";
    case "connecting":
      return "Connecting";
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting";
    case "error":
      return "Needs attention";
  }
}

const CONNECTION_ERROR_MESSAGES: Record<string, string> = {
  token_revoked: "Slack revoked the bot token. Add a new bot token to reconnect.",
  app_uninstalled: "The Slack app was removed from the workspace. Reinstall it and add new tokens.",
  invalid_token: "Slack rejected a token. Check both tokens.",
  missing_token: "Add both tokens to connect.",
  owner_missing: "Save these settings again to connect.",
  workspace_mismatch: "Slack sent events from a different workspace than the bot token.",
};

/** The server sends fixed reasons; anything else is shown as a generic failure. */
export function slackConnectionErrorMessage(lastError: string | undefined): string | undefined {
  if (lastError === undefined) return undefined;
  return CONNECTION_ERROR_MESSAGES[lastError] ?? "Slack could not connect. Try again later.";
}

/** What to do about the latest failed reply. */
export function slackDeliveryErrorMessage(error: SlackChannelDeliveryError | undefined) {
  if (error === undefined) return undefined;
  const channel = error.channelId === undefined ? "that channel" : error.channelId;
  switch (error.code) {
    case "not_in_channel":
      return `Invite the bot to ${channel} so it can reply there.`;
    case "channel_not_found":
      return `The bot can't see ${channel}. Check the channel ID or invite the bot.`;
    case "invalid_auth":
    case "token_revoked":
      return "A reply failed because Slack rejected the bot token.";
    case "rate_limited":
      return "Slack is rate limiting replies; they will be sent shortly.";
    case "timeout":
    case "network":
      return "A reply may not have reached Slack because the connection dropped.";
    case "unknown":
      return "A reply could not be sent to Slack.";
  }
}
