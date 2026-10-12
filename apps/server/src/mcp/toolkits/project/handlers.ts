import { MessageId, ThreadId, OrchestratorMcpFailure, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { prependStandingInstructions } from "@t3tools/shared/standingInstructions";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as RemoteReportService from "../../../remoteReports/RemoteReportService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

/**
 * An existing checkout a launch may bind: one of the project's own git
 * worktrees. Without this check a launch could point an agent at any directory
 * on the machine.
 */
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

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});

/** Whether a project read goes to another machine. */
const reachesHost = <P extends { readonly host?: string | undefined }>(input: P) =>
  input.host !== undefined;

const decodeHostProjectList = Schema.decodeUnknownEffect(
  ProjectToolkit.tools.goat_project_list.successSchema,
);
const decodeHostProject = Schema.decodeUnknownEffect(
  ProjectToolkit.tools.goat_project_read.successSchema,
);

/** The same tool on another machine's T3 server, which answers for its own projects. */
const readOnHost = <A extends object, E>(
  host: string,
  tool: "goat_project_list" | "goat_project_read",
  args: Readonly<Record<string, unknown>>,
  decode: (value: unknown) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const hosts = yield* HostThreadsMcpService.HostThreadsMcpService;
    return yield* hosts.readOnHost(scope, { host, tool, arguments: args }, decode);
  });

export const layer = McpToolAccess.toLayer(ProjectToolkit, {
  goat_thread_launch: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode }) =>
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
        if (strategy?.type === "worktree")
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
            return unavailable();
          }),
        );
        const result =
          report === undefined
            ? yield* launch
            : yield* Effect.gen(function* () {
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
            ? yield* LaunchWatchService.LaunchWatchService.pipe(
                Effect.flatMap((watches) =>
                  caller !== undefined
                    ? watches
                        .register({
                          launcherThreadId: caller.id,
                          host: null,
                          threadId: thread.id,
                          projectId: thread.projectId,
                          title: thread.title,
                          runId: run?.id ?? null,
                          notifyWebhook: input.notifyWebhook ?? false,
                        })
                        .pipe(Effect.as(true))
                    : run === undefined
                      ? Effect.succeed(false)
                      : // An outside client's launch is watched only for the completion webhook.
                        watches
                          .watchExternal({
                            host: null,
                            threadId: thread.id,
                            projectId: thread.projectId,
                            title: thread.title,
                            runId: run.id,
                            ceiling: context.limits.runtimeMode,
                            requested: input.notifyWebhook === true,
                          })
                          .pipe(Effect.map((watch) => watch !== null)),
                ),
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
          ...(report === undefined ? {} : { report: { correlationId: report.correlationId } }),
        };
      }),
  ),
  goat_project_list: McpToolAccess.readsOrReachesHost(reachesHost, ({ host, ...input }) =>
    Effect.gen(function* () {
      if (host !== undefined)
        return yield* readOnHost(host, "goat_project_list", input, decodeHostProjectList);
      const projects = yield* access;
      const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
      const rows = snapshot.projects.filter((project) => project.deletedAt === null);
      const start = input.cursor ?? 0,
        end = start + (input.limit ?? 20);
      return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
    }),
  ),
  goat_project_read: McpToolAccess.readsOrReachesHost(reachesHost, ({ host, ...input }) =>
    Effect.gen(function* () {
      if (host !== undefined)
        return yield* readOnHost(host, "goat_project_read", input, decodeHostProject);
      const projects = yield* access;
      const result = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(result))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      return result.value;
    }),
  ),
  goat_project_create: McpToolAccess.writesEnvironment(({ workspaceRoot, ...input }) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      if (workspaceRoot === undefined) {
        // Project creation records no model default (only an update does), so
        // reject what this mode would otherwise drop silently.
        if (
          input.scripts !== undefined ||
          input.createWorkspaceRootIfMissing !== undefined ||
          input.defaultModelSelection !== undefined
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with goat_project_update.",
          });
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const created = yield* folders
          .createNamedProject({ name: input.title })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
          );
        const project = yield* projects
          .getById(created.projectId)
          .pipe(
            Effect.mapError(unavailable),
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
            ),
          );
        return {
          ...project,
          ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
        };
      }
      const commandId = yield* newCommandId();
      return yield* projects
        .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  goat_project_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      return yield* projects
        .update({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  goat_project_delete: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      return yield* projects
        .delete({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  goat_project_clone: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const repositories = yield* Repositories.SourceControlRepositoryService;
      return yield* repositories.cloneRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.detail,
            }),
        ),
      );
    }),
  ),
});
