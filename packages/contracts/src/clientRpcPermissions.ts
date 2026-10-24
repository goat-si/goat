import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthMemoryReadScope,
  AuthMemoryWriteScope,
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthEnvironmentMaintainScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { CHANNEL_GATEWAY_WS_METHODS } from "./channelGateway.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";
import { SLACK_CHANNEL_WS_METHODS } from "./slackChannel.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.decisionList]: AuthOrchestrationReadScope,
  [WS_METHODS.decisionGet]: AuthOrchestrationReadScope,
  [WS_METHODS.decisionRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.decisionAnswer]: AuthOrchestrationOperateScope,
  [WS_METHODS.decisionWithdraw]: AuthOrchestrationOperateScope,
  [WS_METHODS.sshHostStatus]: AuthOrchestrationReadScope,
  // It reaches the device with this machine's SSH keys, like the host-status fan-out.
  [WS_METHODS.hubDeviceVerify]: AuthOrchestrationOperateScope,
  [WS_METHODS.hubDeviceJoin]: AuthOrchestrationOperateScope,
  [WS_METHODS.hubDeviceLeave]: AuthOrchestrationOperateScope,
  [WS_METHODS.hubDeviceRepair]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerHostMatrix]: AuthOrchestrationReadScope,
  [WS_METHODS.providerHostSyncStart]: AuthProvidersManageScope,
  [WS_METHODS.providerHostSyncStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.providerHostSyncCancel]: AuthProvidersManageScope,
  [WS_METHODS.sshHostHandoffProgress]: AuthOrchestrationReadScope,
  [WS_METHODS.sshHostProbe]: AuthSettingsWriteScope,
  [WS_METHODS.sshHostPreflight]: AuthSettingsWriteScope,
  [WS_METHODS.sshHostTrust]: AuthSettingsWriteScope,
  [WS_METHODS.sshHostPrepare]: AuthEnvironmentMaintainScope,
  [WS_METHODS.sshHostForget]: AuthSettingsWriteScope,
  [WS_METHODS.handoffsOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.handoffsRespond]: AuthOrchestrationOperateScope,
  [WS_METHODS.computerUseStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.computerUseStopAll]: AuthOrchestrationOperateScope,
  [WS_METHODS.computerUseResume]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewSessionsSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.computerUseStatusChanges]: AuthOrchestrationReadScope,
  [WS_METHODS.previewSessionsControl]: AuthOrchestrationOperateScope,
  [WS_METHODS.secretsAnswerRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.memorySearch]: AuthMemoryReadScope,
  [WS_METHODS.memoryList]: AuthMemoryReadScope,
  [WS_METHODS.memoryRead]: AuthMemoryReadScope,
  [WS_METHODS.memoryHistory]: AuthMemoryReadScope,
  [WS_METHODS.memoryResetReportAttempts]: AuthSettingsWriteScope,
  [WS_METHODS.memoryHubReconcile]: AuthSettingsWriteScope,
  [WS_METHODS.memoryChanges]: AuthMemoryReadScope,
  [WS_METHODS.memoryHubDiagnostics]: AuthMemoryReadScope,
  [WS_METHODS.memorySyncStatus]: AuthMemoryReadScope,
  [WS_METHODS.memoryOwnerSourceReadPolicyGet]: AuthSettingsWriteScope,
  [WS_METHODS.memoryOwnerSourceReadPolicyUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.memoryUpsert]: AuthMemoryWriteScope,
  [WS_METHODS.memoryForget]: AuthMemoryWriteScope,
  [WS_METHODS.memoryRevertResolution]: AuthMemoryWriteScope,
  [WS_METHODS.memoryImportProvider]: AuthMemoryWriteScope,
  [WS_METHODS.memoryProjectBindingGet]: AuthMemoryWriteScope,
  [WS_METHODS.memoryProjectBindingUpdate]: AuthMemoryWriteScope,
  [WS_METHODS.memoryHubSettingsGet]: AuthSettingsWriteScope,
  [WS_METHODS.memoryHubSettingsUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.memoryReadSource]: AuthMemoryReadScope,

  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCompactStorage]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCheckOpenCodexUpdate]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCleanUpStrayProcesses]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,
  [WS_METHODS.sshWorkspaceLaunch]: AuthSourceControlWriteScope,
  [WS_METHODS.sshWorkspaceFetchBack]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,

  [WS_METHODS.notesList]: AuthOrchestrationReadScope,
  [WS_METHODS.notesRead]: AuthOrchestrationReadScope,
  [WS_METHODS.notesSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.notesWorkTargets]: AuthOrchestrationReadScope,
  [WS_METHODS.notesWorkTargetProjects]: AuthOrchestrationReadScope,
  [WS_METHODS.notesWrite]: AuthOrchestrationOperateScope,
  [WS_METHODS.notesUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.notesMove]: AuthOrchestrationOperateScope,
  [WS_METHODS.notesDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.notesStartWork]: AuthOrchestrationOperateScope,

  [CHANNEL_GATEWAY_WS_METHODS.ensureBot]: AuthOrchestrationOperateScope,
  [CHANNEL_GATEWAY_WS_METHODS.ingest]: AuthOrchestrationOperateScope,
  [CHANNEL_GATEWAY_WS_METHODS.createIdentityLink]: AuthSettingsWriteScope,
  [CHANNEL_GATEWAY_WS_METHODS.unlinkIdentity]: AuthSettingsWriteScope,
  [SLACK_CHANNEL_WS_METHODS.configure]: AuthSettingsWriteScope,
  [SLACK_CHANNEL_WS_METHODS.disconnect]: AuthSettingsWriteScope,
  // Boat machines bill the owner's account, so every lifecycle change needs settings write.
  [WS_METHODS.cloudMachinesConfigure]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesDisconnect]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesCreate]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesStop]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesResume]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesDelete]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesForget]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesDismissUnconfirmed]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesEnsureReady]: AuthSettingsWriteScope,
  [WS_METHODS.cloudAgentsAcceptFolderTrust]: AuthSettingsWriteScope,
  [WS_METHODS.hubNodesList]: AuthOrchestrationReadScope,
  [WS_METHODS.hubNodesSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.hubNodesCheck]: AuthOrchestrationReadScope,
  // Registering a node or a link lets this server reach another machine.
  [WS_METHODS.hubNodesAdd]: AuthSettingsWriteScope,
  [WS_METHODS.hubNodesRemove]: AuthSettingsWriteScope,
  [WS_METHODS.hubNodesImport]: AuthSettingsWriteScope,
  [WS_METHODS.hubNodesDismissNotice]: AuthSettingsWriteScope,
  // Preparing may install GOAT on a node; enrolling lets the hub act there for every proxied client.
  [WS_METHODS.hubProxyPrepareNode]: AuthSettingsWriteScope,
  [WS_METHODS.hubProxyEnrollNode]: AuthSettingsWriteScope,
  [WS_METHODS.hubProxyUnenrollNode]: AuthSettingsWriteScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.memoryImportProvider)
    return [AuthMemoryWriteScope, AuthFilesystemReadScope];
  if (method === WS_METHODS.memoryReadSource)
    return [AuthMemoryReadScope, AuthOrchestrationReadScope];
  if (method === WS_METHODS.sshWorkspaceLaunch)
    return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
