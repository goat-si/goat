import {
  OrchestratorMcpFailure,
  MessageId,
  ThreadId,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { ThreadLaunchParameters, ThreadLaunchSuccess } from "./toolkits/project/tools.ts";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import { prependStandingInstructions } from "@goat/shared/standingInstructions";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../orchestration-v2/AttachmentClaims.ts";
import * as CloudSource from "../orchestration-v2/CloudTaskSourceService.ts";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Project from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as RemoteReportService from "../remoteReports/RemoteReportService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "./threadAccess.ts";

type Modes = {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
};

export class ThreadLaunchMcpService extends Context.Service<
  ThreadLaunchMcpService,
  {
    readonly launch: (
      scope: McpInvocationContext.McpInvocationScope,
      input: typeof ThreadLaunchParameters.Type,
      modes: Modes,
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

const make = Effect.gen(function* () {
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
  return ThreadLaunchMcpService.of({
    launch: (scope, input, { runtimeMode, interactionMode }) =>
      Effect.gen(function* () {
        const context = yield* readCaller();
        const { caller } = context;
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
        const commandId = yield* newCommandId();
        const threadId = ThreadId.make(commandId);
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
        const modelSelection =
          input.modelSelection ??
          caller?.modelSelection ??
          (yield* readProject)?.defaultModelSelection ??
          undefined;
        if (modelSelection === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
          });
        const startsRun = input.message !== undefined || attachments.length > 0;
        const adapter = yield* adapters
          .get(modelSelection.instanceId)
          .pipe(Effect.mapError(unavailable));
        const capabilities = yield* adapter.getCapabilities().pipe(Effect.mapError(unavailable));
        const cloud = capabilities.sessions.executionLocation === "cloud";
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
        if (cloud && startsRun) {
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
                            : `Launch into that checkout with workspaceStrategy {type:"existing_worktree", worktreePath:"${error.worktreePath}"}, or pass a branch name that does not exist yet.`
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
              const launch = ThreadMessageIntake.launchThread({
                commandId,
                threadId,
                projectId,
                title: input.title,
                modelSelection,
                runtimeMode,
                interactionMode,
                workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
                ...(!startsRun
                  ? {}
                  : {
                      initialMessage: {
                        messageId,
                        ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                        text: standing.text,
                        attachments,
                      },
                    }),
                createdBy: "agent",
                creationSource: "mcp",
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
              const result = yield* report === undefined
                ? launch
                : Effect.gen(function* () {
                    const reports = yield* RemoteReportService.RemoteReportService;
                    // The binding commits before the agent can run. Only a launch that
                    // never created its thread loses it again; an accepted or uncertain
                    // launch keeps it, so the work it started can still report.
                    return yield* Effect.uninterruptibleMask((restore) =>
                      reports.bind(threadId, report).pipe(
                        Effect.mapError(unavailable),
                        Effect.andThen(
                          restore(launch).pipe(
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

export const layer = Layer.effect(ThreadLaunchMcpService, make);
