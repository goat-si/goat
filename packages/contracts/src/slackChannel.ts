import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ChannelDeliveryErrorCode } from "./channelCommon.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * Settings and status for the Slack channel connection. Tokens are write-only: they go in
 * through configure and never come back out; responses only say whether one is stored.
 */

export const SlackChannelConnectionId = TrimmedNonEmptyString.pipe(
  Schema.brand("SlackChannelConnectionId"),
);
export type SlackChannelConnectionId = typeof SlackChannelConnectionId.Type;

export const SlackChannelConnectionStatus = Schema.Literals([
  "disabled",
  "connecting",
  "connected",
  "reconnecting",
  "error",
]);
export type SlackChannelConnectionStatus = typeof SlackChannelConnectionStatus.Type;

/**
 * Defaults for work started from Slack. The server fills the remaining dispatch fields
 * (environment, runtime and interaction mode, workspace) from its own defaults and the
 * requester's ceiling, and validates all of them before launching.
 */
export const SlackChannelDefaultTarget = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  modelSelection: Schema.optional(ModelSelection),
});
export type SlackChannelDefaultTarget = typeof SlackChannelDefaultTarget.Type;

export const SlackChannelReviewSettings = Schema.Struct({
  enabled: Schema.Boolean,
  modelSelection: ModelSelection,
});
export type SlackChannelReviewSettings = typeof SlackChannelReviewSettings.Type;

/** The most recent failed delivery, without secrets or the raw Slack response. */
export const SlackChannelDeliveryError = Schema.Struct({
  code: ChannelDeliveryErrorCode,
  at: IsoDateTime,
  channelId: Schema.optional(TrimmedNonEmptyString),
});
export type SlackChannelDeliveryError = typeof SlackChannelDeliveryError.Type;

export const SlackChannelSettings = Schema.Struct({
  connectionId: SlackChannelConnectionId,
  enabled: Schema.Boolean,
  hasAppToken: Schema.Boolean,
  hasBotToken: Schema.Boolean,
  teamId: Schema.optional(TrimmedNonEmptyString),
  botUserId: Schema.optional(TrimmedNonEmptyString),
  allowedChannelIds: Schema.Array(TrimmedNonEmptyString),
  defaultTarget: Schema.optional(SlackChannelDefaultTarget),
  review: Schema.optional(SlackChannelReviewSettings),
  status: SlackChannelConnectionStatus,
  /** Redacted; never contains a token. */
  lastError: Schema.optional(Schema.String),
  lastDeliveryError: Schema.optional(SlackChannelDeliveryError),
});
export type SlackChannelSettings = typeof SlackChannelSettings.Type;

/**
 * Omitted tokens keep the stored ones. `clearCredentials: true` disconnects and deletes both
 * tokens; `disconnect` keeps them. Without `connectionId` the server creates a connection
 * with an id it generates.
 */
export const SlackChannelConfigureInput = Schema.Struct({
  connectionId: Schema.optional(SlackChannelConnectionId),
  enabled: Schema.Boolean,
  appToken: Schema.optional(TrimmedNonEmptyString),
  botToken: Schema.optional(TrimmedNonEmptyString),
  clearCredentials: Schema.optional(Schema.Boolean),
  allowedChannelIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  defaultTarget: Schema.optional(SlackChannelDefaultTarget),
  review: Schema.optional(SlackChannelReviewSettings),
});
export type SlackChannelConfigureInput = typeof SlackChannelConfigureInput.Type;

export const SlackChannelGetSettingsInput = Schema.Struct({});
export type SlackChannelGetSettingsInput = typeof SlackChannelGetSettingsInput.Type;

export const SlackChannelDisconnectInput = Schema.Struct({
  connectionId: SlackChannelConnectionId,
});
export type SlackChannelDisconnectInput = typeof SlackChannelDisconnectInput.Type;

export const SlackChannelSubscribeStatusInput = Schema.Struct({});
export type SlackChannelSubscribeStatusInput = typeof SlackChannelSubscribeStatusInput.Type;

export const SlackChannelStatusEvent = Schema.Struct({
  connectionId: SlackChannelConnectionId,
  status: SlackChannelConnectionStatus,
  lastError: Schema.optional(Schema.String),
  lastDeliveryError: Schema.optional(SlackChannelDeliveryError),
});
export type SlackChannelStatusEvent = typeof SlackChannelStatusEvent.Type;

const SLACK_CHANNEL_FAILURE_MESSAGES = {
  adapter_unavailable: "Slack is not available on this server.",
  invalid_input: "The Slack settings are not valid.",
  invalid_token: "Slack rejected the token.",
  not_found: "That Slack connection does not exist.",
  persistence_failed: "Could not save the Slack settings.",
} as const;

export const SlackChannelSettingsErrorReason = Schema.Literals(
  Object.keys(SLACK_CHANNEL_FAILURE_MESSAGES) as Array<keyof typeof SLACK_CHANNEL_FAILURE_MESSAGES>,
);
export type SlackChannelSettingsErrorReason = typeof SlackChannelSettingsErrorReason.Type;

/**
 * Safe to show: never contains a token or a raw Slack response. Like the gateway error it has
 * no `cause`, which would be encoded onto the wire; the server logs causes instead.
 */
export class SlackChannelSettingsError extends Schema.TaggedError<SlackChannelSettingsError>()(
  "SlackChannelSettingsError",
  {
    reason: SlackChannelSettingsErrorReason,
  },
) {
  override get message(): string {
    return SLACK_CHANNEL_FAILURE_MESSAGES[this.reason];
  }
}

export const SLACK_CHANNEL_WS_METHODS = {
  getSettings: "slackChannel.getSettings",
  configure: "slackChannel.configure",
  disconnect: "slackChannel.disconnect",
  subscribeStatus: "slackChannel.subscribeStatus",
} as const;
