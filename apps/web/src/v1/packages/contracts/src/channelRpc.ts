import * as Schema from "effect/Schema";
import { ChannelAttentionFeedInput, ChannelAttentionFeedResult } from "./channelBotAttention.ts";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  BotPackageExportInput,
  BotPackageExportResult,
  BotPackageImportInput,
  BotPackageImportResult,
  BotPackageReviewInput,
  BotPackageReviewResult,
} from "./botPackage.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  CHANNEL_GATEWAY_WS_METHODS,
  ChannelEnsureBotInput,
  ChannelEnsureBotResult,
  ChannelGetBotStatusInput,
  ChannelGetBotStatusResult,
  ChannelListOpenAsksInput,
  ChannelListOpenAsksResult,
  ChannelSubscribeTaskChangesInput,
  ChannelTaskChangesEvent,
  ChannelListBotsInput,
  ChannelListBotsResult,
  ChannelUpdateBotInput,
  ChannelUpdateBotResult,
  ChannelBotResult,
  ChannelCreateBotInput,
  ChannelResolveBotProposalInput,
  ChannelDeleteBotInput,
  ChannelRestoreBotInput,
  ChannelSetBotHiddenInput,
  ChannelListChildWorkInput,
  ChannelListChildWorkResult,
  ChannelFollowThreadInput,
  ChannelFollowTarget,
  ChannelListFollowedThreadsInput,
  ChannelListFollowedThreadsResult,
  ChannelListBotThreadsInput,
  ChannelListBotThreadsResult,
  ChannelUpdateTaskViewInput,
  ChannelSnoozeBotTaskInput,
  ChannelUnsnoozeBotTaskInput,
  ChannelTaskView,
  ChannelRetryTaskInput,
  ChannelRetryTaskResult,
  ChannelGatewayError,
  ChannelGetInputInput,
  ChannelGetTaskInput,
  ChannelGetBotTaskInput,
  ChannelSearchBotTasksInput,
  ChannelSearchBotTasksResult,
  BotWorkResult,
  ChannelIdentityLinkCreateInput,
  ChannelIdentityLinkCreateResult,
  ChannelIdentityUnlinkInput,
  ChannelIngestInput,
  ChannelIngestResult,
  ChannelInputSnapshot,
  ChannelListTasksRpcInput,
  ChannelListTasksResult,
} from "./channelGateway.ts";
import {
  ChannelListBotArtifactsInput,
  ChannelListBotArtifactsResult,
  ChannelReadBotArtifactInput,
  ChannelReadBotArtifactResult,
} from "./channelBotArtifacts.ts";
import { ChannelListBotNotesInput, ChannelListBotNotesResult } from "./channelBotNotes.ts";
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

const ChannelListOpenAsksRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.listOpenAsks, {
  payload: ChannelListOpenAsksInput,
  success: ChannelListOpenAsksResult,
  error: ChannelRpcError,
});

const ChannelListBotAttentionRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.listBotAttention, {
  payload: ChannelAttentionFeedInput,
  success: ChannelAttentionFeedResult,
  error: ChannelRpcError,
});

const ChannelSubscribeTaskChangesRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.subscribeTaskChanges, {
  payload: ChannelSubscribeTaskChangesInput,
  success: ChannelTaskChangesEvent,
  error: ChannelRpcError,
  stream: true,
});

const ChannelListBotsRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.listBots, {
  payload: ChannelListBotsInput,
  success: ChannelListBotsResult,
  error: ChannelRpcError,
});

const ChannelUpdateBotRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.updateBot, {
  payload: ChannelUpdateBotInput,
  success: ChannelUpdateBotResult,
  error: ChannelRpcError,
});

const ChannelCreateBotRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.createBot, {
  payload: ChannelCreateBotInput,
  success: ChannelBotResult,
  error: ChannelRpcError,
});

const BotPackageExportRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.exportBotPackage, {
  payload: BotPackageExportInput,
  success: BotPackageExportResult,
  error: ChannelRpcError,
});
const BotPackageReviewRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.reviewBotPackage, {
  payload: BotPackageReviewInput,
  success: BotPackageReviewResult,
  error: ChannelRpcError,
});
const BotPackageImportRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.importBotPackage, {
  payload: BotPackageImportInput,
  success: BotPackageImportResult,
  error: ChannelRpcError,
});

const ChannelResolveBotProposalRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.resolveBotProposal, {
  payload: ChannelResolveBotProposalInput,
  success: Schema.Void,
  error: ChannelRpcError,
});

const ChannelSetBotHiddenRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.setBotHidden, {
  payload: ChannelSetBotHiddenInput,
  success: ChannelBotResult,
  error: ChannelRpcError,
});

const ChannelDeleteBotRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.deleteBot, {
  payload: ChannelDeleteBotInput,
  success: ChannelBotResult,
  error: ChannelRpcError,
});

const ChannelRestoreBotRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.restoreBot, {
  payload: ChannelRestoreBotInput,
  success: ChannelBotResult,
  error: ChannelRpcError,
});

const ChannelFollowThreadRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.followThread, {
  payload: ChannelFollowThreadInput,
  success: Schema.Boolean,
  error: ChannelRpcError,
});
const ChannelStopFollowingThreadRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.stopFollowingThread, {
  payload: ChannelFollowTarget,
  error: ChannelRpcError,
});
const ChannelListFollowedThreadsRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.listFollowedThreads, {
  payload: ChannelListFollowedThreadsInput,
  success: ChannelListFollowedThreadsResult,
  error: ChannelRpcError,
});

const ChannelListBotThreadsRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.listBotThreads, {
  payload: ChannelListBotThreadsInput,
  success: ChannelListBotThreadsResult,
  error: ChannelRpcError,
});

const ChannelListBotNotesRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.listBotNotes, {
  payload: ChannelListBotNotesInput,
  success: ChannelListBotNotesResult,
  error: ChannelRpcError,
});

const ChannelListBotArtifactsRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.listBotArtifacts, {
  payload: ChannelListBotArtifactsInput,
  success: ChannelListBotArtifactsResult,
  error: ChannelRpcError,
});

const ChannelReadBotArtifactRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.readBotArtifact, {
  payload: ChannelReadBotArtifactInput,
  success: ChannelReadBotArtifactResult,
  error: ChannelRpcError,
});

const ChannelListChildWorkRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.listChildWork, {
  payload: ChannelListChildWorkInput,
  success: ChannelListChildWorkResult,
  error: ChannelRpcError,
});

const ChannelUpdateTaskViewRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.updateTaskView, {
  payload: ChannelUpdateTaskViewInput,
  success: ChannelTaskView,
  error: ChannelRpcError,
});

const ChannelRetryTaskRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.retryTask, {
  payload: ChannelRetryTaskInput,
  success: ChannelRetryTaskResult,
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

const ChannelSnoozeBotTaskRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.snoozeBotTask, {
  payload: ChannelSnoozeBotTaskInput,
  success: ChannelTaskView,
  error: ChannelGatewayError,
});
const ChannelUnsnoozeBotTaskRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.unsnoozeBotTask, {
  payload: ChannelUnsnoozeBotTaskInput,
  success: ChannelTaskView,
  error: ChannelGatewayError,
});

const ChannelGetBotTaskRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.getBotTask, {
  payload: ChannelGetBotTaskInput,
  success: BotWorkResult,
  error: ChannelRpcError,
});
const ChannelSearchBotTasksRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.searchBotTasks, {
  payload: ChannelSearchBotTasksInput,
  success: ChannelSearchBotTasksResult,
  error: ChannelRpcError,
});

const ChannelListTasksRpc = Rpc.make(CHANNEL_GATEWAY_WS_METHODS.listTasks, {
  payload: ChannelListTasksRpcInput,
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
  ChannelListOpenAsksRpc,
  ChannelListBotAttentionRpc,
  ChannelSubscribeTaskChangesRpc,
  ChannelListBotsRpc,
  ChannelUpdateBotRpc,
  ChannelCreateBotRpc,
  BotPackageExportRpc,
  BotPackageReviewRpc,
  BotPackageImportRpc,
  ChannelResolveBotProposalRpc,
  ChannelSetBotHiddenRpc,
  ChannelDeleteBotRpc,
  ChannelRestoreBotRpc,
  ChannelFollowThreadRpc,
  ChannelStopFollowingThreadRpc,
  ChannelListFollowedThreadsRpc,
  ChannelListBotThreadsRpc,
  ChannelListBotNotesRpc,
  ChannelListBotArtifactsRpc,
  ChannelReadBotArtifactRpc,
  ChannelListChildWorkRpc,
  ChannelUpdateTaskViewRpc,
  ChannelRetryTaskRpc,
  ChannelIngestRpc,
  ChannelGetTaskRpc,
  ChannelGetBotTaskRpc,
  ChannelSnoozeBotTaskRpc,
  ChannelUnsnoozeBotTaskRpc,
  ChannelSearchBotTasksRpc,
  ChannelListTasksRpc,
  ChannelGetInputRpc,
  ChannelCreateIdentityLinkRpc,
  ChannelUnlinkIdentityRpc,
  SlackChannelGetSettingsRpc,
  SlackChannelConfigureRpc,
  SlackChannelDisconnectRpc,
  SlackChannelSubscribeStatusRpc,
);
