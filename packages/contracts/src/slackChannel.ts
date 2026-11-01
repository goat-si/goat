import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ChannelDeliveryErrorCode } from "./channelCommon.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

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

/** The most recent failed delivery, without secrets or the raw Slack response. */
export const SlackChannelDeliveryError = Schema.Struct({
  code: ChannelDeliveryErrorCode,
  at: IsoDateTime,
  channelId: Schema.optional(TrimmedNonEmptyString),
});
export type SlackChannelDeliveryError = typeof SlackChannelDeliveryError.Type;

/** "all": every channel the bot is a member of. "listed": only `allowedChannelIds`. */
export const SlackChannelScope = Schema.Literals(["all", "listed"]);
export type SlackChannelScope = typeof SlackChannelScope.Type;

/** "workspace": anyone in the connected workspace. "linked": only accounts linked with a code. */
export const SlackUserAccess = Schema.Literals(["workspace", "linked"]);
export type SlackUserAccess = typeof SlackUserAccess.Type;

export const SLACK_DEFAULT_UNLINKED_RUNTIME_MODE: RuntimeMode = "approval-required";

interface SlackAccessFields {
  readonly channelScope?: SlackChannelScope | undefined;
  readonly allowedChannelIds: ReadonlyArray<string>;
  readonly userAccess?: SlackUserAccess | undefined;
  readonly unlinkedRuntimeModeCeiling?: RuntimeMode | undefined;
}

/**
 * The access a connection grants, with defaults for fields saved before they existed: a saved
 * channel list keeps restricting, an empty one means every channel the bot is in.
 */
export const resolveSlackAccess = (fields: SlackAccessFields) => ({
  channelScope:
    fields.channelScope ?? (fields.allowedChannelIds.length > 0 ? "listed" : ("all" as const)),
  userAccess: fields.userAccess ?? ("workspace" as const),
  unlinkedRuntimeModeCeiling:
    fields.unlinkedRuntimeModeCeiling ?? SLACK_DEFAULT_UNLINKED_RUNTIME_MODE,
});

export const SlackChannelSettings = Schema.Struct({
  connectionId: SlackChannelConnectionId,
  enabled: Schema.Boolean,
  hasAppToken: Schema.Boolean,
  hasBotToken: Schema.Boolean,
  teamId: Schema.optional(TrimmedNonEmptyString),
  botUserId: Schema.optional(TrimmedNonEmptyString),
  allowedChannelIds: Schema.Array(TrimmedNonEmptyString),
  /** Optional on the wire for older servers; read it through `resolveSlackAccess`. */
  channelScope: Schema.optional(SlackChannelScope),
  userAccess: Schema.optional(SlackUserAccess),
  /** The highest access level for work from people who have not linked their account. */
  unlinkedRuntimeModeCeiling: Schema.optional(RuntimeMode),
  defaultTarget: Schema.optional(SlackChannelDefaultTarget),
  status: SlackChannelConnectionStatus,
  /** Redacted; never contains a token. */
  lastError: Schema.optional(Schema.String),
  lastDeliveryError: Schema.optional(SlackChannelDeliveryError),
});
export type SlackChannelSettings = typeof SlackChannelSettings.Type;

/**
 * Omitted tokens and access fields keep the stored ones; `clearCredentials: true` deletes both
 * tokens. Without `connectionId` the server creates a connection. A channel list sent without
 * `channelScope` (an older client) sets the scope from whether it is empty.
 */
export const SlackChannelConfigureInput = Schema.Struct({
  connectionId: Schema.optional(SlackChannelConnectionId),
  enabled: Schema.Boolean,
  appToken: Schema.optional(TrimmedNonEmptyString),
  botToken: Schema.optional(TrimmedNonEmptyString),
  clearCredentials: Schema.optional(Schema.Boolean),
  allowedChannelIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  channelScope: Schema.optional(SlackChannelScope),
  userAccess: Schema.optional(SlackUserAccess),
  unlinkedRuntimeModeCeiling: Schema.optional(RuntimeMode),
  defaultTarget: Schema.optional(SlackChannelDefaultTarget),
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
