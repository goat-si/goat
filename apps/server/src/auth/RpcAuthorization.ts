import {
  CLIENT_GUARDED_RPC_SCOPES,
  type DeviceListInput,
  clientRpcRequiredScopes,
  authScopeRequiredResponse,
  AssetCreateUrlInput,
  AuthAccessReadScope,
  ServerSettingsPatch,
  ProviderInstanceMutation,
  requiredScopesForServerSettingsPatch,
  requiredScopesForProjectMutation,
  ProjectMutation,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthDiagnosticsReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthTerminalOperateScope,
  ORCHESTRATION_V2_WS_METHODS,
  CHANNEL_GATEWAY_WS_METHODS,
  SLACK_CHANNEL_WS_METHODS,
  AuthTerminalReadScope,
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
  RpcScopeAuthorization,
  WS_METHODS,
  WsRpcGroup as WsBaseRpcGroup,
  WsMemoryCoreRpcGroup,
  WsHubNodesRpcGroup,
  WsMemoryAdministrationRpcGroup,
  WsMemoryImportRpcGroup,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import { captureMemoryGrantCeiling } from "../memory/MemoryAccess.ts";

import { DESKTOP_BOOTSTRAP_SUBJECT } from "./PairingGrantStore.ts";

export const AuthorizedWsRpcGroup = WsBaseRpcGroup.merge(WsMemoryCoreRpcGroup)
  .merge(WsMemoryAdministrationRpcGroup)
  .merge(WsMemoryImportRpcGroup)
  .merge(WsHubNodesRpcGroup);

const WsRpcGroup = WsBaseRpcGroup;

type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

export const RPC_REQUIRED_SCOPES = {
  // Staged client guards must not activate server scopes before their RPC group is installed.
  ...(Object.fromEntries(
    Object.entries(CLIENT_GUARDED_RPC_SCOPES).filter(([tag]) => WsRpcGroup.requests.has(tag)),
  ) as Pick<
    typeof CLIENT_GUARDED_RPC_SCOPES,
    Extract<keyof typeof CLIENT_GUARDED_RPC_SCOPES, WsRpcMethod>
  >),
  [WS_METHODS.connectionCatalogServe]: AuthSettingsWriteScope,
  [WS_METHODS.connectionCatalogRespond]: AuthSettingsWriteScope,
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [CHANNEL_GATEWAY_WS_METHODS.getTask]: AuthOrchestrationReadScope,
  [CHANNEL_GATEWAY_WS_METHODS.listTasks]: AuthOrchestrationReadScope,
  [CHANNEL_GATEWAY_WS_METHODS.getBotStatus]: AuthOrchestrationReadScope,
  [CHANNEL_GATEWAY_WS_METHODS.getInput]: AuthOrchestrationReadScope,
  [SLACK_CHANNEL_WS_METHODS.getSettings]: AuthOrchestrationReadScope,
  [SLACK_CHANNEL_WS_METHODS.subscribeStatus]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThreads]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThread]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverProbe]: AuthOrchestrationReadScope,
  [WS_METHODS.serverCheckComputerUse]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateProvider]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthStart]: AuthProvidersManageScope,
  [WS_METHODS.providerConsumeResetCredit]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthComplete]: AuthProvidersManageScope,
  [WS_METHODS.chatGptReconnectProfile]: AuthProvidersManageScope,
  [WS_METHODS.chatGptImportProfile]: AuthProvidersManageScope,
  [WS_METHODS.chatGptHandoffSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.codexAuthCallbackSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthRespond]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthCancel]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthLogout]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallStart]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallCancel]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.providerInstallRemove]: AuthProvidersManageScope,
  [WS_METHODS.providerHostMatrix]: AuthOrchestrationReadScope,
  [WS_METHODS.providerHostSyncStart]: AuthProvidersManageScope,
  [WS_METHODS.providerHostSyncStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.providerHostSyncCancel]: AuthProvidersManageScope,
  [WS_METHODS.serverUpdateServer]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverUpdateServerWithProgress]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCommitDesktopUpdate]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverUpsertKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverRemoveKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverGetStorageCleanupReport]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetWorktreesDirectoryStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetDatabaseStorage]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetSettings]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateSettings]: AuthSettingsWriteScope,
  [WS_METHODS.serverSearchAcpRegistry]: AuthOrchestrationReadScope,
  [WS_METHODS.serverPrepareAcpRegistryAgent]: AuthProvidersManageScope,
  [WS_METHODS.serverUninstallAcpRegistryManagedBinary]: AuthProvidersManageScope,
  [WS_METHODS.serverAcceptAcpRegistryUrlAuth]: AuthProvidersManageScope,
  [WS_METHODS.serverListAcpRegistrySessions]: AuthOrchestrationReadScope,
  [WS_METHODS.serverImportAcpRegistrySession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverDeleteAcpRegistrySession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListAcpRegistryProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.serverSetAcpRegistryProvider]: AuthProvidersManageScope,
  [WS_METHODS.serverDisableAcpRegistryProvider]: AuthProvidersManageScope,
  [WS_METHODS.serverLogoutAcpRegistry]: AuthProvidersManageScope,
  [WS_METHODS.serverDiscoverSourceControl]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetTraceDiagnostics]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetProcessDiagnostics]: AuthDiagnosticsReadScope,
  // Load-balancing new threads reads host load; that is part of operating
  // threads, not of inspecting diagnostics.
  [WS_METHODS.serverGetHostResources]: AuthOrchestrationReadScope,
  // Reaching SSH hosts also needs orchestration:operate; HostStatusMcpService.readForClient
  // reports only this machine without it.
  [WS_METHODS.serverGetHostStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.hubDeviceVerify]: AuthOrchestrationOperateScope,
  [WS_METHODS.hubDeviceJoin]: AuthOrchestrationOperateScope,
  [WS_METHODS.hubDeviceLeave]: AuthOrchestrationOperateScope,
  [WS_METHODS.hubDeviceRepair]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverGetProcessResourceHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetResourceTelemetryHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverRetryResourceTelemetry]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetUsageSummary]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverRefreshUsageRates]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverSignalProcess]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverReportClientActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.serverReportHostPowerState]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverGetBackgroundPolicy]: AuthOrchestrationReadScope,
  [WS_METHODS.scheduledTasksList]: AuthOrchestrationReadScope,
  [WS_METHODS.scheduledTasksSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.secretsAnswerRequest]: AuthOrchestrationOperateScope,
  // Delivery logs hold request bodies, so they need the same scope as the URL.
  [WS_METHODS.scheduledTasksListWebhookDeliveries]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksGetWebhookDelivery]: AuthOrchestrationOperateScope,
  [WS_METHODS.remoteLaunchesList]: AuthOrchestrationReadScope,
  [WS_METHODS.cloudMachinesList]: AuthOrchestrationReadScope,
  [WS_METHODS.cloudAgentsListRuns]: AuthOrchestrationReadScope,
  // Deprecated folder trust RPCs, kept for older clients; remove in GOAT 0.2.0.
  [WS_METHODS.cloudAgentsListFolderTrust]: AuthOrchestrationReadScope,
  [WS_METHODS.cloudAgentsAcceptFolderTrust]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesConfigure]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesDisconnect]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesCreate]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesStop]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesResume]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesDelete]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesForget]: AuthSettingsWriteScope,
  [WS_METHODS.cloudMachinesDismissUnconfirmed]: AuthSettingsWriteScope,
  // It rewrites this computer's SSH files for the machine, so it is a write.
  [WS_METHODS.cloudMachinesEnsureReady]: AuthSettingsWriteScope,
  [WS_METHODS.cloudGetRelayClientStatus]: AuthRelayReadScope,
  [WS_METHODS.cloudInstallRelayClient]: AuthRelayWriteScope,
  [WS_METHODS.pullRequestsList]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsListStats]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSummary]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRouting]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRoutingIdentity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsStack]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsLinkedThreads]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsPreview]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsChecks]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsReviewGuide]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsThreadComments]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDiffFileContents]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsFilesViewed]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsChangeBreakdown]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsInvalidate]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsReportState]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSubscribeRefreshes]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsReviewerCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsLabelCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlLookupRepository]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeProjectClones]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsListEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsListIgnoredFiles]: AuthFilesystemReadScope,
  [WS_METHODS.projectsReadFile]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchContents]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsWriteFile]: AuthFilesystemWriteScope,
  [WS_METHODS.projectsEnsureScratch]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateNew]: AuthOrchestrationOperateScope,
  [WS_METHODS.shellOpenInEditor]: AuthOrchestrationOperateScope,
  [WS_METHODS.filesystemBrowse]: AuthFilesystemReadScope,
  [WS_METHODS.filesystemGetMetadata]: AuthFilesystemReadScope,
  [WS_METHODS.agentSessionsScan]: AuthOrchestrationReadScope,
  [WS_METHODS.agentSessionsImport]: AuthOrchestrationOperateScope,
  [WS_METHODS.assetsCreateUrl]: AuthOrchestrationReadScope,
  [WS_METHODS.assetsPersistChatAttachments]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsCreateUploadUrl]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerUploadFeedback]: AuthOrchestrationOperateScope,
  [WS_METHODS.mcpAppsCallTool]: AuthOrchestrationOperateScope,
  [WS_METHODS.mcpAppsToolInfo]: AuthOrchestrationReadScope,
  [WS_METHODS.mcpAppsReadResource]: AuthOrchestrationReadScope,
  [WS_METHODS.mcpAppsUpdateModelContext]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeVcsStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeWorktreeSetup]: AuthOrchestrationReadScope,
  [WS_METHODS.worktreeSetupCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeResourceTelemetry]: AuthDiagnosticsReadScope,
  [WS_METHODS.vcsRefreshStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.gitResolvePullRequest]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsListRefs]: AuthOrchestrationReadScope,
  [WS_METHODS.reviewGetDiffPreview]: AuthFilesystemReadScope,
  [WS_METHODS.reviewGetDiffFileContents]: AuthFilesystemReadScope,
  [WS_METHODS.terminalOpen]: AuthTerminalOperateScope,
  [WS_METHODS.terminalAttach]: AuthTerminalOperateScope,
  [WS_METHODS.terminalObserve]: AuthTerminalReadScope,
  [WS_METHODS.terminalWrite]: AuthTerminalOperateScope,
  [WS_METHODS.terminalResize]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClear]: AuthTerminalOperateScope,
  [WS_METHODS.terminalRestart]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClose]: AuthTerminalOperateScope,
  [WS_METHODS.subscribeTerminalEvents]: AuthTerminalReadScope,
  [WS_METHODS.subscribeTerminalMetadata]: AuthTerminalReadScope,
  [WS_METHODS.previewOpen]: AuthPreviewOperateScope,
  [WS_METHODS.previewNavigate]: AuthPreviewOperateScope,
  [WS_METHODS.previewResize]: AuthPreviewOperateScope,
  [WS_METHODS.previewAdjust]: AuthPreviewOperateScope,
  [WS_METHODS.previewRefresh]: AuthPreviewOperateScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.previewList]: AuthOrchestrationReadScope,
  [WS_METHODS.previewClearProfile]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportProfiles]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportStatus]: AuthPreviewOperateScope,
  [WS_METHODS.subscribePreviewEvents]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeDiscoveredLocalServers]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceConfigure]: AuthSettingsWriteScope,
  [WS_METHODS.deviceTestHost]: AuthSettingsWriteScope,
  [WS_METHODS.deviceEasAccount]: AuthSettingsWriteScope,
  [WS_METHODS.deviceList]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceClose]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceShutdown]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceAction]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeDeviceState]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerLifecycle]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeAuthAccess]: AuthAccessReadScope,
  [WS_METHODS.subscribeBackgroundPolicy]: AuthOrchestrationReadScope,
} as const satisfies Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>;

export const MEMORY_RPC_REQUIRED_SCOPES = {
  [WS_METHODS.memoryImportProvider]: "memory:write",
  [WS_METHODS.memoryProjectBindingGet]: "memory:write",
  [WS_METHODS.memoryProjectBindingUpdate]: "memory:write",
  [WS_METHODS.memoryChanges]: "memory:read",
  [WS_METHODS.memorySearch]: "memory:read",
  [WS_METHODS.memoryList]: "memory:read",
  [WS_METHODS.memoryRead]: "memory:read",
  [WS_METHODS.memoryHistory]: "memory:read",
  [WS_METHODS.memoryResetReportAttempts]: "settings:write",
  [WS_METHODS.memoryHubReconcile]: "settings:write",
  [WS_METHODS.memoryHubDiagnostics]: "memory:read",
  [WS_METHODS.memorySyncStatus]: "memory:read",
  [WS_METHODS.memoryUpsert]: "memory:write",
  [WS_METHODS.memoryForget]: "memory:write",
  [WS_METHODS.memoryRevertResolution]: "memory:write",
  [WS_METHODS.memoryReadSource]: "memory:read",
  [WS_METHODS.memoryHubSettingsGet]: "settings:write",
  [WS_METHODS.memoryHubSettingsUpdate]: "settings:write",
  [WS_METHODS.memoryOwnerSourceReadPolicyGet]: "settings:write",
  [WS_METHODS.memoryOwnerSourceReadPolicyUpdate]: "settings:write",
} as const satisfies Readonly<
  Record<
    RpcGroup.Rpcs<
      | typeof WsMemoryCoreRpcGroup
      | typeof WsMemoryAdministrationRpcGroup
      | typeof WsMemoryImportRpcGroup
    >["_tag"],
    AuthEnvironmentScope
  >
>;
export const HUB_NODES_RPC_REQUIRED_SCOPES = {
  [WS_METHODS.hubNodesList]: "orchestration:read",
  [WS_METHODS.hubNodesSubscribe]: "orchestration:read",
  [WS_METHODS.hubNodesCheck]: "orchestration:read",
  [WS_METHODS.hubNodesAdd]: "settings:write",
  [WS_METHODS.hubNodesRemove]: "settings:write",
  [WS_METHODS.hubNodesImport]: "settings:write",
  [WS_METHODS.hubNodesDismissNotice]: "settings:write",
} as const satisfies Record<RpcGroup.Rpcs<typeof WsHubNodesRpcGroup>["_tag"], AuthEnvironmentScope>;

const installedScopes = {
  ...RPC_REQUIRED_SCOPES,
  ...MEMORY_RPC_REQUIRED_SCOPES,
  ...HUB_NODES_RPC_REQUIRED_SCOPES,
};

export function requiredScopeForRpcMethod(method: string): AuthEnvironmentScope {
  if (!Object.hasOwn(installedScopes, method)) {
    throw new Error(`RPC method ${method} has no declared authorization scope.`);
  }
  const requiredScope = installedScopes[method as keyof typeof installedScopes];
  if (requiredScope === undefined) {
    throw new Error(`RPC method ${method} has no declared authorization scope.`);
  }
  return requiredScope;
}

export const rpcAuthorizationError = (requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message: `The authenticated token is missing required scope: ${requiredScope}.`,
    ...authScopeRequiredResponse(requiredScope),
  });

const SettingsUpdate = Schema.Struct({
  patch: ServerSettingsPatch,
  providerInstanceMutation: Schema.optionalKey(ProviderInstanceMutation),
});

const requiredScopesForSettingsUpdate = (payload: unknown) => {
  const input = Schema.decodeUnknownSync(SettingsUpdate)(payload);
  const scopes = requiredScopesForServerSettingsPatch(input.patch);
  if (input.providerInstanceMutation === undefined) return scopes;
  // An atomic provider mutation carries an empty patch unless it also changes settings.
  return Object.values(input.patch).every((value) => value === undefined)
    ? [AuthProvidersManageScope]
    : [...new Set([...scopes, AuthProvidersManageScope])];
};

const decodeProjectMutation = Schema.decodeUnknownSync(ProjectMutation);

/** Throws for a method this server does not declare; callers outside the middleware must catch. */
export const requiredScopesForRpcCall = (
  method: string,
  payload: unknown,
): ReadonlyArray<AuthEnvironmentScope> => {
  if (method === WS_METHODS.serverRetryResourceTelemetry) {
    return [AuthEnvironmentMaintainScope, AuthDiagnosticsReadScope];
  }
  if (method === WS_METHODS.assetsCreateUrl) {
    const { resource } = Schema.decodeUnknownSync(AssetCreateUrlInput)(payload);
    return [
      resource._tag === "workspace-file" ||
      resource._tag === "media-file" ||
      resource._tag === "draft-workspace-file"
        ? AuthFilesystemReadScope
        : AuthOrchestrationReadScope,
    ];
  }
  if (method === WS_METHODS.serverUpdateSettings) return requiredScopesForSettingsUpdate(payload);
  if (method === WS_METHODS.projectsMutate) {
    return requiredScopesForProjectMutation(decodeProjectMutation(payload));
  }
  const guarded = clientRpcRequiredScopes(method, payload);
  if (guarded.length > 0) return guarded;
  return [requiredScopeForRpcMethod(method)];
};

/** The same decision backs the middleware and its permission behavior fixtures. */
export const authorizeRpcCall = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  method: string,
  payload: unknown,
) =>
  Effect.suspend(() => {
    const required = requiredScopesForRpcCall(method, payload);
    const missing = required.find((scope) => !scopes.includes(scope));
    return missing === undefined ? Effect.void : Effect.fail(rpcAuthorizationError(missing));
  });

/** Observes successful authorized calls, including completion of streaming RPCs. */
export const layer = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  onAuthorized?: (method: string, payload: unknown) => Effect.Effect<void>,
) =>
  Layer.succeed(RpcScopeAuthorization)((effect, { rpc, payload }) =>
    authorizeRpcCall(scopes, rpc._tag, payload).pipe(
      Effect.andThen(
        onAuthorized === undefined
          ? effect
          : Effect.tap(effect, () => onAuthorized(rpc._tag, payload)),
      ),
    ),
  );

/** Retrying can install or restart tools even though ordinary listing is readable. */
export const requiredScopeForDeviceList = (input: DeviceListInput): AuthEnvironmentScope =>
  input.retryHostId || input.updateTool
    ? AuthOrchestrationOperateScope
    : AuthOrchestrationReadScope;

/** Hosting is reserved to the owning desktop's trusted bootstrap grant. */
export const requireConnectionCatalogHost = (session: {
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}) =>
  session.subject !== DESKTOP_BOOTSTRAP_SUBJECT
    ? Effect.fail(
        new EnvironmentAuthorizationError({
          message: "Only the owning desktop bootstrap session may host saved connections.",
          requiredScope: AuthSettingsWriteScope,
        }),
      )
    : session.scopes.includes(AuthSettingsWriteScope)
      ? Effect.void
      : Effect.fail(
          new EnvironmentAuthorizationError({
            message: "Hosting saved connections requires settings:write scope.",
            requiredScope: AuthSettingsWriteScope,
          }),
        );

/** Server-only task input port; capture live session grants before persistence, outside SQL. */
export const captureRpcMemoryGrantCeiling = <E, R>(input: {
  readonly grantedScopes?: ReadonlyArray<AuthEnvironmentScope> | undefined;
  readonly reauthorize?:
    | ((scopes: ReadonlyArray<AuthEnvironmentScope>) => Effect.Effect<void, E, R>)
    | undefined;
  readonly readOnly: boolean;
}) =>
  Effect.gen(function* () {
    if (input.grantedScopes === undefined || input.reauthorize === undefined)
      return "none" as const;
    const ceiling = captureMemoryGrantCeiling(input.grantedScopes, input.readOnly);
    const scopes: ReadonlyArray<AuthEnvironmentScope> =
      ceiling === "none"
        ? []
        : ceiling === "read"
          ? ["memory:read"]
          : ["memory:read", "memory:write"];
    yield* input.reauthorize(scopes);
    return ceiling;
  });

/** Public task metadata cannot increase a server-captured ceiling. */
export const rejectPublicMemoryGrantCeiling = (input: unknown) =>
  typeof input === "object" &&
  input !== null &&
  "memoryGrantCeiling" in input &&
  input.memoryGrantCeiling !== undefined &&
  input.memoryGrantCeiling !== "none"
    ? Effect.fail(
        new EnvironmentAuthorizationError({
          message: "Task memory ceilings are captured by the server, not supplied by clients.",
          requiredScope: "memory:read",
        }),
      )
    : Effect.void;
