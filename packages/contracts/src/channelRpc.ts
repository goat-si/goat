import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  CHANNEL_GATEWAY_WS_METHODS,
  ChannelEnsureBotInput,
  ChannelEnsureBotResult,
  ChannelGetBotStatusInput,
  ChannelGetBotStatusResult,
  ChannelGatewayError,
  ChannelGetInputInput,
  ChannelGetTaskInput,
  ChannelIdentityLinkCreateInput,
  ChannelIdentityLinkCreateResult,
  ChannelIdentityUnlinkInput,
  ChannelIngestInput,
  ChannelIngestResult,
  ChannelInputSnapshot,
  ChannelListTasksInput,
  ChannelListTasksResult,
} from "./channelGateway.ts";
import { ChannelTask } from "./channelLedger.ts";
import {
  SLACK_CHANNEL_WS_METHODS,
  SlackChannelConfigureInput,
  SlackChannelDisconnectInput,
  SlackChannelGetSettingsInput,
  SlackChannelSettings,
  SlackChannelSettingsError,
  SlackChannelStatusEvent,
  SlackChannelSubscribeStatusInput,
} from "./slackChannel.ts";

const ChannelRpcError = Schema.Union([ChannelGatewayError, EnvironmentAuthorizationError]);

/** Channel gateway and Slack settings RPCs. */
const ChannelEnsureBotRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.ensureBot, {
  payload: ChannelEnsureBotInput,
  success: ChannelEnsureBotResult,
  error: ChannelRpcError,
});

const ChannelGetBotStatusRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.getBotStatus, {
  payload: ChannelGetBotStatusInput,
  success: ChannelGetBotStatusResult,
  error: ChannelRpcError,
});

const ChannelIngestRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.ingest, {
  payload: ChannelIngestInput,
  success: ChannelIngestResult,
  error: ChannelRpcError,
});

const ChannelGetTaskRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.getTask, {
  payload: ChannelGetTaskInput,
  success: ChannelTask,
  error: ChannelRpcError,
});

const ChannelListTasksRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.listTasks, {
  payload: ChannelListTasksInput,
  success: ChannelListTasksResult,
  error: ChannelRpcError,
});

const ChannelGetInputRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.getInput, {
  payload: ChannelGetInputInput,
  success: ChannelInputSnapshot,
  error: ChannelRpcError,
});

const ChannelCreateIdentityLinkRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.createIdentityLink, {
  payload: ChannelIdentityLinkCreateInput,
  success: ChannelIdentityLinkCreateResult,
  error: ChannelRpcError,
});

const ChannelUnlinkIdentityRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.unlinkIdentity, {
  payload: ChannelIdentityUnlinkInput,
  error: ChannelRpcError,
});

const SlackChannelRpcError = Schema.Union([
  SlackChannelSettingsError,
  EnvironmentAuthorizationError,
]);

const SlackChannelGetSettingsRpc = Rpc.make(SLACK_CHANNEL_WS_METHODS.getSettings, {
  payload: SlackChannelGetSettingsInput,
  success: Schema.Array(SlackChannelSettings),
  error: SlackChannelRpcError,
});

const SlackChannelConfigureRpc = Rpc.make(SLACK_CHANNEL_WS_METHODS.configure, {
  payload: SlackChannelConfigureInput,
  success: SlackChannelSettings,
  error: SlackChannelRpcError,
});

const SlackChannelDisconnectRpc = Rpc.make(SLACK_CHANNEL_WS_METHODS.disconnect, {
  payload: SlackChannelDisconnectInput,
  error: SlackChannelRpcError,
});

const SlackChannelSubscribeStatusRpc = Rpc.make(SLACK_CHANNEL_WS_METHODS.subscribeStatus, {
  payload: SlackChannelSubscribeStatusInput,
  success: SlackChannelStatusEvent,
  error: SlackChannelRpcError,
  stream: true,
});

export const ChannelRpcs = RpcGroup.make(
  ChannelEnsureBotRpc,
  ChannelGetBotStatusRpc,
  ChannelIngestRpc,
  ChannelGetTaskRpc,
  ChannelListTasksRpc,
  ChannelGetInputRpc,
  ChannelCreateIdentityLinkRpc,
  ChannelUnlinkIdentityRpc,
  SlackChannelGetSettingsRpc,
  SlackChannelConfigureRpc,
  SlackChannelDisconnectRpc,
  SlackChannelSubscribeStatusRpc,
);
