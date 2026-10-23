import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import {
  goatclawRoleBrief,
  missingRoleCapabilities,
  roleRefusal,
} from "../goatclaw/RoleTemplates.ts";
import {
  OrchestratorMcpFailure,
  CommandId,
  MessageId,
  ThreadId,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@goat/contracts";
import * as ChannelChildWork from "../channels/ChannelChildWork.ts";
import { captureRpcMemoryGrantCeiling } from "../auth/RpcAuthorization.ts";
import { effectiveMemoryGrant } from "../memory/MemoryAccess.ts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HostProcess from "@goat/shared/HostProcess";
import type { ThreadLaunchParameters, ThreadLaunchSuccess } from "./toolkits/project/tools.ts";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import { prependStandingInstructions } from "@goat/shared/standingInstructions";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../orchestration-v2/AttachmentClaims.ts";
import * as CloudSource from "../orchestration-v2/CloudTaskSourceService.ts";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Project from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as RemoteReportService from "../remoteReports/RemoteReportService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { nativeWorkspacePath } from "../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import {
  admitChildWork,
  bindChildWork,
  launchChildWork,
  releaseChildWork,
} from "./childWorkAdmission.ts";
import { resolveRuntimeMode } from "./OrchestratorMcpService.ts";
import {
  newCommandId,
  readCaller,
  reauthorizationFailure,
  resolveProjectId,
  unavailable,
} from "./threadAccess.ts";

type Modes = {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
};

/** Server-set only: a registered cloud run's stable thread, imported task and launcher name. */
export interface CloudRunLaunch {
  readonly threadId?: ThreadId;
  readonly importedNativeThread?: ThreadLaunch.ThreadLaunchInput["importedNativeThread"];
  readonly externalLauncher?: string;
  /** The caller already passed the cloud launch approval for this launch. */
  readonly approved?: true;
}

export class ThreadLaunchMcpService extends Context.Service<
  ThreadLaunchMcpService,
  {
    readonly launch: (
      scope: McpInvocationContext.McpInvocationScope,
      input: typeof ThreadLaunchParameters.Type,
      modes: Modes,
      cloudRun?: CloudRunLaunch,
    ) => Effect.Effect<typeof ThreadLaunchSuccess.Type, OrchestratorMcpFailure>;
  }
>()("goat/mcp/ThreadLaunchMcpService") {}

const assertProjectWorktree = Effect.fn("mcp.assertProjectWorktree")(function* (
  workspaceRoot: string,
  worktreePath: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const real = (path: string) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const worktrees = yield* git.listWorktreePaths(workspaceRoot).pipe(
    Effect.flatMap((paths) => Effect.forEach(paths, real)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  if (!worktrees.includes(yield* real(worktreePath)))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "worktreePath must be one of the project's git worktrees. goat_worktree_list shows them.",
    });
});

/** The refusal plus the step that gets the caller a folder to launch into. */
function workspaceMissingMessage(error: ThreadLaunch.ThreadLaunchWorkspaceMissingError) {
  if (error.kind === "worktree")
    return `${error.message} Pick a current checkout from goat_worktree_list, or launch with workspaceStrategy {type:"worktree"} to create one.`;
  const relocate = `or point the project at an existing checkout with goat_project_update {projectId:"${error.projectId}", workspaceRoot}`;
  return error.remoteUrl === null
    ? `${error.message} Restore the checkout at that path (goat_project_clone clones it when you know its repository), ${relocate}, then launch again.`
    : `${error.message} Clone it back with goat_project_clone {remoteUrl:"${error.remoteUrl}", destinationPath:"${error.path}"}, ${relocate}, then launch again.`;
}

/** Forwarded metadata only lowers authenticated authority, including live reauthorization. */
export const admitRemoteMemoryGrantCeiling = (
  scope: McpInvocationContext.McpInvocationScope,
  ceiling: import("@goat/contracts").MemoryTaskGrantCeiling,
  policy: ServerSettings.MemoryProviderPolicy,
) =>
  Effect.gen(function* () {
    const readOnly = scope.client?.access === "read-only";
    const captured = yield* captureRpcMemoryGrantCeiling({
      grantedScopes: scope.grantedScopes,
      reauthorize: scope.reauthorize,
      readOnly: false,
    });
    const effective = effectiveMemoryGrant({
      ...policy,
      readOnly,
      memoryGrantCeiling: ceiling,
      dispatchScopes:
        captured === "none"
          ? []
          : captured === "read"
            ? ["memory:read"]
            : ["memory:read", "memory:write"],
    });
    if (
      ceiling !== "none" &&
      (captured === "none" || (ceiling === "read_write" && captured !== "read_write"))
    )
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Forwarded memory ceiling exceeds authenticated destination authority.",
      });
    return effective;
  });

const make = Effect.gen(function* () {
  const permissions = yield* Profiles.PermissionProfiles;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* Project.ProjectService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const watches = yield* LaunchWatchService.LaunchWatchService;
  const reports = yield* RemoteReportService.RemoteReportService;
  const adapters = yield* ProviderAdapters.ProviderAdapterRegistryV2;
  const sources = yield* CloudSource.CloudTaskSourceService;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const channelChildWork = yield* Effect.serviceOption(ChannelChildWork.ChannelChildWork);
  /**
   * Refuses a provider instance this environment does not have, or a requested
   * model its provider does not list, before any thread exists. An SSH launch
   * forwards the caller's model as requested, so the remote checks it here. The
   * cached model list goes stale when the provider's own catalog changes (for
   * example `ocx sync` on a remote host), so a miss refreshes the instance once.
   */
  const checkModelSelection = Effect.fn("ThreadLaunchMcpService.checkModelSelection")(function* (
    selection: { readonly instanceId: string; readonly model: string },
    requested: boolean,
  ) {
    if (Option.isNone(providerRegistry)) return;
    const registry = providerRegistry.value;
    const providers = yield* registry.getProviders;
    let provider = providers.find((entry) => entry.instanceId === selection.instanceId);
    if (provider === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `This GOAT has no provider instance ${selection.instanceId}; it has ${
          providers.map((entry) => entry.instanceId).join(", ") || "none"
        }. orchestrator_capabilities lists providers and models.`,
      });
    const misses = (candidate: typeof provider) =>
      requested &&
      candidate !== undefined &&
      candidate.models.length > 0 &&
      !candidate.models.some((model) => model.slug === selection.model);
    if (!misses(provider)) return;
    const refreshed = yield* registry.refreshInstance(provider.instanceId);
    provider = refreshed.find((entry) => entry.instanceId === selection.instanceId) ?? provider;
    if (misses(provider))
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Provider ${selection.instanceId} here does not offer model ${selection.model}, even after refreshing its model list. Pick one orchestrator_capabilities lists for it, or fix the provider's catalog and check it with goat_provider_diagnose {instanceId:"${selection.instanceId}"}.`,
      });
  });
  return ThreadLaunchMcpService.of({
    launch: (scope, rawInput, { runtimeMode: requestedRuntimeMode, interactionMode }, cloudRun) =>
      Effect.gen(function* () {
        // The checkout is checked and recorded as given, so it must already be native here.
        const platform = yield* HostProcess.Platform;
        const nativeInput =
          rawInput.workspaceStrategy?.type === "existing_worktree"
            ? {
                ...rawInput,
                workspaceStrategy: {
                  ...rawInput.workspaceStrategy,
                  worktreePath: nativeWorkspacePath(
                    platform,
                    rawInput.workspaceStrategy.worktreePath,
                  ),
                },
              }
            : rawInput;
        const effective = yield* permissions.resolve(
          scope,
          requestedRuntimeMode,
          rawInput.permissionProfileCeiling,
        );
        const role = rawInput.goatclawRole;
        if (role !== undefined && !effective.enabled)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "goatclaw is off, so role launches are unavailable.",
          });
        const missing = role === undefined ? [] : missingRoleCapabilities(role, effective.profile);
        if (role !== undefined && missing.length > 0) return yield* roleRefusal(role, missing);
        if (role !== undefined && nativeInput.message === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A goatclaw role launch needs message: the task the role works on.",
          });
        const input =
          role === undefined || nativeInput.message === undefined
            ? nativeInput
            : { ...nativeInput, message: goatclawRoleBrief(role, nativeInput.message) };
        const runtimeMode = effective.runtimeMode;
        const context = yield* readCaller();
        const { caller } = context;
        const forwarded = input.memoryGrantCeiling;
        if (forwarded !== undefined && (scope.thread !== undefined || scope.client === undefined))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Only an authenticated outside dispatch may forward a memory ceiling.",
          });
        const policy = yield* Effect.serviceOption(ServerSettings.MemoryProviderCommittedPolicy);
        const memoryGrantCeiling =
          forwarded === undefined
            ? yield* captureRpcMemoryGrantCeiling({
                grantedScopes: scope.grantedScopes,
                reauthorize: scope.reauthorize,
                readOnly: scope.client?.access === "read-only",
              }).pipe(Effect.mapError(reauthorizationFailure))
            : yield* admitRemoteMemoryGrantCeiling(
                scope,
                forwarded,
                Option.isSome(policy)
                  ? yield* policy.value.read
                  : { policyReady: false, enableAgentMemoryAccess: false, epoch: 0 },
              ).pipe(Effect.mapError(reauthorizationFailure));
        if (
          input.launchedBy !== undefined &&
          (caller !== undefined ||
            input.launchedBy.environmentId === null ||
            input.launchedBy.environmentId === context.scope.environmentId)
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "launchedBy is accepted only from an outside caller naming a foreign environment.",
          });
        // A channel-owned caller (a GOAT Bot worker thread) admits this launch against its
        // task's descendant budget; the record's id becomes the command id, so a retry replays
        // the same launch instead of starting a second thread.
        const admission =
          caller === undefined
            ? undefined
            : yield* admitChildWork(channelChildWork, {
                callerThreadId: caller.id,
                surface: "thread_launch",
                prompt: input.message ?? "",
                destinationKey: [
                  input.projectId ?? caller.projectId ?? "",
                  input.workspaceStrategy === undefined
                    ? ""
                    : input.workspaceStrategy.type +
                      ":" +
                      (input.workspaceStrategy.branch ?? "") +
                      (input.workspaceStrategy.type === "existing_worktree"
                        ? ":" + input.workspaceStrategy.worktreePath
                        : ""),
                  input.modelSelection?.instanceId ?? "",
                  input.modelSelection?.model ?? "",
                  input.goatclawRole ?? "",
                ].join("\u0000"),
                ...(input.title === undefined ? {} : { destinationHint: input.title }),
              });
        const commandId =
          admission === undefined
            ? yield* newCommandId()
            : CommandId.make(admission.record.childWorkId);
        const threadId = cloudRun?.threadId ?? ThreadId.make(commandId);
        const messageId = MessageId.make(commandId);
        const attachments = input.attachments ?? [];
        if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A new thread accepts only pending attachment uploads.",
          });
        const report = input.report;
        // Only another machine's GOAT, signed in as an outside client, binds an origin.
        if (
          report !== undefined &&
          (context.scope.thread !== undefined || context.scope.client === undefined)
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "An origin report binding may only be supplied by an outside client.",
          });
        if (
          input.scratch === true &&
          (input.projectId !== undefined || input.workspaceStrategy !== undefined)
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
          });
        if (input.scratch === true) {
          const selected = input.modelSelection ?? caller?.modelSelection;
          if (selected !== undefined) {
            yield* checkModelSelection(selected, input.modelSelection !== undefined);
            const selectedAdapter = yield* adapters
              .get(selected.instanceId)
              .pipe(Effect.mapError(unavailable));
            const selectedCapabilities = yield* selectedAdapter
              .getCapabilities()
              .pipe(Effect.mapError(unavailable));
            if (selectedCapabilities.sessions.executionLocation === "cloud") {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "Cloud tasks require a project with a published repository.",
              });
            }
          }
        }
        const projectId =
          input.scratch === true
            ? (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
                Effect.flatMap((folders) => folders.ensureScratchProject),
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: error.message,
                    }),
                ),
              )).projectId
            : yield* resolveProjectId(context, input.projectId);
        const readProject = Project.ProjectService.pipe(
          Effect.flatMap((projects) => projects.getById(projectId)),
          Effect.mapError(unavailable),
          Effect.map(Option.getOrUndefined),
        );
        // A caller outside a thread has nothing to inherit, so it starts with the
        // project's effective defaults, as the composer does. Its mode stays
        // within the ceiling it was approved with.
        const projectDefaults =
          caller === undefined
            ? yield* ServerSettings.ServerSettingsService.pipe(
                Effect.flatMap((settings) => settings.getSettings),
                Effect.mapError(unavailable),
                Effect.flatMap((settings) =>
                  Effect.map(
                    readProject,
                    (project) => resolveProjectSettings(settings, projectId, project).settings,
                  ),
                ),
              )
            : undefined;
        const modelSelection =
          input.modelSelection ??
          caller?.modelSelection ??
          (projectDefaults === undefined
            ? (yield* readProject)?.defaultModelSelection
            : projectDefaults.defaultModelSelection) ??
          undefined;
        if (modelSelection === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
          });
        const startedRuntimeMode =
          projectDefaults !== undefined && input.runtimeMode === undefined
            ? yield* resolveRuntimeMode(runtimeMode, projectDefaults.defaultRuntimeMode).pipe(
                Effect.orElseSucceed(() => runtimeMode),
              )
            : runtimeMode;
        const startsRun = input.message !== undefined || attachments.length > 0;
        yield* checkModelSelection(modelSelection, input.modelSelection !== undefined);
        const adapter = yield* adapters
          .get(modelSelection.instanceId)
          .pipe(Effect.mapError(unavailable));
        const capabilities = yield* adapter.getCapabilities().pipe(Effect.mapError(unavailable));
        const cloud = capabilities.sessions.executionLocation === "cloud";
        if (cloud) {
          const effective = yield* permissions.require(scope, "cloud.launch", {
            forwarded: input.permissionProfileCeiling,
            runtimeMode,
          });
          // Following a run registered from outside starts nothing billable.
          if (
            cloudRun?.approved !== true &&
            cloudRun?.importedNativeThread?.cloudTask === undefined
          )
            yield* permissions.requireCloudApproval(scope, effective, {
              target: `thread:${modelSelection.instanceId}`,
            });
        }
        if (input.workspaceStrategy?.type === "existing_worktree") {
          const project = yield* readProject;
          if (project === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The project was not found.",
            });
          yield* assertProjectWorktree(project.workspaceRoot, input.workspaceStrategy.worktreePath);
        }
        // A launch is accepted before its worktree is provisioned, so a base
        // ref that cannot resolve, or a branch Git will not create, is refused
        // while the agent can still act on it.
        const strategy = input.workspaceStrategy;
        // A registered run carries its own source; nothing is submitted from this checkout.
        if (cloud && startsRun && cloudRun?.importedNativeThread?.cloudTask === undefined) {
          const project = yield* readProject;
          if (project === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The project was not found.",
            });
          const branch = strategy?.type === "worktree" ? strategy.baseRef : strategy?.branch;
          yield* sources
            .resolve({
              restriction: capabilities.sessions.sourceRestriction ?? "published-ref",
              cwd:
                capabilities.sessions.sourceRestriction !== "project-folder" &&
                strategy?.type === "existing_worktree"
                  ? strategy.worktreePath
                  : project.workspaceRoot,
              ...(branch === undefined ? {} : { branch }),
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: error.message,
                  }),
              ),
            );
        }
        if (!cloud && strategy?.type === "worktree")
          yield* ThreadLaunch.ThreadLaunchService.pipe(
            Effect.flatMap((launches) =>
              launches.checkWorktreeBase({ projectId, workspaceStrategy: strategy }),
            ),
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message:
                    error._tag === "ThreadLaunchBranchError"
                      ? `${error.message} No thread was created. ${
                          error.worktreePath === null
                            ? "Pass a branch name that does not exist yet."
                            : `Launch into that checkout with workspaceStrategy ${JSON.stringify({ type: "existing_worktree", worktreePath: error.worktreePath, branch: error.branch })}, or pass a branch name that does not exist yet.`
                        }`
                      : `${error.message} No thread was created. Pass a branch, tag, or commit that exists there${
                          strategy.startFromOrigin === true
                            ? "; the project has no origin remote to fetch it from."
                            : ", or set startFromOrigin:true if it exists only on origin."
                        }`,
                }),
            ),
          );
        // The executing environment's policy, so a launch forwarded over SSH
        // gets the instructions of the machine it runs on.
        const standing =
          startsRun && input.standingInstructions !== false
            ? prependStandingInstructions(
                yield* ServerSettings.ServerSettingsService.pipe(
                  Effect.flatMap((settings) => settings.getSettings),
                  Effect.map(
                    (settings) =>
                      resolveProjectSettings(settings, projectId).settings.standingInstructions,
                  ),
                  Effect.mapError(unavailable),
                ),
                input.message ?? "",
              )
            : { text: input.message ?? "", block: null };
        // A webhook choice is checked, and an inline secret kept, before any thread exists.
        const launchWatches = yield* LaunchWatchService.LaunchWatchService;
        // Set in the same uninterruptible step that saves the watch, which then holds the route.
        // Until then any exit, interruption included, frees the secret the route kept.
        let routeKept = false;
        return yield* Effect.acquireUseRelease(
          input.notifyTarget === undefined
            ? Effect.succeed({ notifyWebhook: input.notifyWebhook ?? false, webhookTarget: null })
            : launchWatches
                .resolveRoute({
                  notifyWebhook: input.notifyWebhook,
                  notifyOnCompletion: input.notifyOnCompletion,
                  notifyTarget: input.notifyTarget,
                  projectId: caller?.projectId ?? null,
                })
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new OrchestratorMcpFailure({
                        code: "invalid_request",
                        message: error.message,
                      }),
                  ),
                ),
          (route) =>
            Effect.gen(function* () {
              yield* launchChildWork(channelChildWork, admission, { threadId });
              const admitted = yield* permissions.claim(scope, {
                id: commandId,
                childThreadId: threadId,
                runtimeMode: startedRuntimeMode,
                worktree: input.workspaceStrategy?.type === "worktree",
                forwarded: input.permissionProfileCeiling,
                ...(role === undefined ? {} : { role }),
              });
              const launch = ThreadMessageIntake.launchThread({
                commandId,
                threadId,
                projectId,
                title: input.title,
                modelSelection,
                runtimeMode: admitted.runtimeMode,
                interactionMode,
                workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
                ...(!startsRun
                  ? {}
                  : {
                      initialMessage: {
                        messageId,
                        memoryGrantCeiling,
                        ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                        text: standing.text,
                        attachments,
                      },
                    }),
                createdBy: "agent",
                creationSource: "mcp",
                ...(cloudRun?.importedNativeThread === undefined
                  ? {}
                  : { importedNativeThread: cloudRun.importedNativeThread }),
                ...(cloudRun?.externalLauncher === undefined
                  ? {}
                  : { externalLauncher: cloudRun.externalLauncher }),
                // The calling thread is the launcher. A launch forwarded over SSH has no
                // calling thread here and names its launcher on the other machine instead.
                ...(caller !== undefined
                  ? {
                      launchedBy: {
                        kind: "launch" as const,
                        threadId: caller.id,
                        environmentId: null,
                        environmentLabel: null,
                        threadTitle: caller.title,
                        via: "thread_launch" as const,
                      },
                    }
                  : input.launchedBy === undefined
                    ? {}
                    : {
                        launchedBy: {
                          ...input.launchedBy,
                          kind: "launch" as const,
                          via:
                            input.launchedBy.via === "delegate_task"
                              ? ("delegate_task" as const)
                              : ("ssh_thread_launch" as const),
                        },
                      }),
              }).pipe(
                Effect.mapError((error) => {
                  if (error._tag === "AttachmentClaimError") {
                    return new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: error.message,
                    });
                  }
                  if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
                    return new OrchestratorMcpFailure({
                      code: "invalid_request",
                      message: error.message,
                    });
                  }
                  if (error._tag === "ThreadLaunchWorkspaceMissingError") {
                    return new OrchestratorMcpFailure({
                      code: "invalid_request",
                      message: workspaceMissingMessage(error),
                    });
                  }
                  return unavailable();
                }),
              );
              const protectedLaunch = launch.pipe(
                Effect.tap(() =>
                  admitted.enabled ? permissions.complete(commandId) : Effect.void,
                ),
                Effect.onError(() =>
                  admitted.enabled
                    ? permissions.release(commandId, true).pipe(Effect.ignore)
                    : Effect.void,
                ),
                // A launch error means no thread committed, so the admission releases.
                Effect.onError(() => releaseChildWork(channelChildWork, admission)),
              );
              const result = yield* report === undefined
                ? protectedLaunch
                : Effect.gen(function* () {
                    const reports = yield* RemoteReportService.RemoteReportService;
                    // The binding commits before the agent can run. Only a launch that
                    // never created its thread loses it again; an accepted or uncertain
                    // launch keeps it, so the work it started can still report.
                    return yield* Effect.uninterruptibleMask((restore) =>
                      reports.bind(threadId, report).pipe(
                        Effect.mapError(unavailable),
                        Effect.andThen(
                          restore(protectedLaunch).pipe(
                            Effect.onError(() =>
                              context.threads.getThreadShell(threadId).pipe(
                                Effect.flatMap((shell) =>
                                  shell === null ? reports.unbind(threadId) : Effect.void,
                                ),
                                Effect.ignore,
                              ),
                            ),
                          ),
                        ),
                      ),
                    );
                  });
              yield* bindChildWork(channelChildWork, admission, { threadId });
              const thread = result.projection.thread;
              const run = result.projection.runs.find((run) => run.userMessageId === messageId);
              // A launch another machine's GOAT forwards is watched by that machine.
              const external =
                caller === undefined &&
                input.launchedBy === undefined &&
                report === undefined &&
                run !== undefined;
              const watching =
                input.notifyOnCompletion !== false && (caller !== undefined || external)
                  ? yield* (
                      caller !== undefined
                        ? launchWatches
                            .register({
                              launcherThreadId: caller.id,
                              host: null,
                              threadId: thread.id,
                              projectId: thread.projectId,
                              title: thread.title,
                              runId: run?.id ?? null,
                              notifyWebhook: route.notifyWebhook,
                              webhookTarget: route.webhookTarget,
                            })
                            .pipe(
                              Effect.tap(() =>
                                Effect.sync(() => {
                                  routeKept = true;
                                }),
                              ),
                              Effect.as(true),
                              Effect.uninterruptible,
                            )
                        : run === undefined
                          ? Effect.succeed(false)
                          : // An outside client's launch is watched only for the completion webhook.
                            launchWatches
                              .watchExternal({
                                owner: context.scope.requestNamespace,
                                host: null,
                                threadId: thread.id,
                                projectId: thread.projectId,
                                title: thread.title,
                                runId: run.id,
                                ceiling: context.limits.runtimeMode,
                                route,
                              })
                              .pipe(
                                Effect.map((watch) => {
                                  routeKept = watch !== null;
                                  return routeKept;
                                }),
                                Effect.uninterruptible,
                              )
                    ).pipe(
                      // The thread exists either way; a watch that failed to save is reported, not fatal.
                      Effect.catch((error) =>
                        Effect.logWarning("launch watch not recorded", {
                          threadId: thread.id,
                          cause: error,
                        }).pipe(Effect.as(false)),
                      ),
                    )
                  : false;
              return {
                threadId: thread.id,
                projectId: thread.projectId,
                modelSelection: thread.modelSelection,
                runId: run?.id ?? null,
                status: run?.status ?? null,
                watching,
                standingInstructionsVersion: standing.block?.version ?? null,
                ...(report === undefined
                  ? {}
                  : { report: { correlationId: report.correlationId } }),
              };
            }),
          (route) =>
            routeKept || route.webhookTarget === null
              ? Effect.void
              : launchWatches.releaseRoute(route),
        );
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(ThreadManagement.ThreadManagementService, threads),
        Effect.provideService(ThreadLaunch.ThreadLaunchService, launches),
        Effect.provideService(Project.ProjectService, projects),
        Effect.provideService(ManagedProjectFolders.ManagedProjectFolders, folders),
        Effect.provideService(GitVcsDriver.GitVcsDriver, git),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provideService(ServerSettings.ServerSettingsService, settings),
        Effect.provideService(LaunchWatchService.LaunchWatchService, watches),
        Effect.provideService(RemoteReportService.RemoteReportService, reports),
      ),
  });
});

export const layer = Layer.effect(ThreadLaunchMcpService, make).pipe(Layer.provide(Profiles.layer));
