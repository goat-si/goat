import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import { splitStandingInstructions } from "@goat/shared/standingInstructions";
import {
  CommandId,
  type ChatAttachment,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ProviderThreadNativeMetadata,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadLauncher,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type Project,
  ProjectId,
  type RunId,
  type RuntimeMode,
  type ScheduledTaskId,
  ThreadId,
  describeWorktreesDirectoryUnavailable,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  buildTemporaryWorktreeBranchName,
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  WORKTREE_BRANCH_PREFIX,
} from "@goat/shared/git";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapters from "./ProviderAdapterRegistry.ts";
import { isCloudExecution } from "@goat/provider-core/server/cloudTask";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as Orchestrator from "./Orchestrator.ts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import { randomUuidV4 } from "@goat/provider-core/server/randomUuid";
import * as ThreadManagement from "./ThreadManagementService.ts";

export type ThreadLaunchWorkspaceStrategy =
  | { readonly type: "root"; readonly branch?: string | undefined }
  | {
      readonly type: "existing_worktree";
      readonly worktreePath: string;
      readonly branch?: string | undefined;
    }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string | undefined;
      readonly startFromOrigin?: boolean | undefined;
    };

export interface ThreadLaunchInitialMessage {
  readonly messageId?: MessageId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: import("@goat/contracts").OrchestrationMessageContext | undefined;
}

export interface ThreadLaunchInput {
  readonly commandId: CommandId;
  readonly threadId?: ThreadId;
  readonly reuseExistingThread?: boolean;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly generateTitle?: boolean;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceStrategy: ThreadLaunchWorkspaceStrategy;
  readonly initialMessage?: ThreadLaunchInitialMessage;
  readonly importedNativeThread?: {
    readonly ref: {
      readonly driver: ProviderDriverKind;
      readonly nativeId: string;
      readonly strength: "strong";
    };
    readonly metadata?: OrchestrationV2ProviderThreadNativeMetadata;
  };
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  /**
   * Set when a person launches from a web, desktop, or mobile client. A missing
   * project folder then shows as a failed thread they can fix there. Every
   * other launch, including a scheduled task first created in a client, is
   * refused before a thread exists.
   */
  readonly fromClient?: boolean;
  /** The agent thread that asked for this launch; descriptive only. */
  readonly launchedBy?: OrchestrationV2ThreadLauncher | undefined;
}

/** What workspace preparation reads from a launch; a retry rebuilds it from the run. */
type PreparationInput = Pick<
  ThreadLaunchInput,
  "commandId" | "projectId" | "workspaceStrategy" | "initialMessage" | "modelSelection"
> & {
  /**
   * Set when a retry reuses the worktree its failed attempt created and
   * recorded. Its setup is tracked like a new one, but the thread already
   * records the workspace, and a branch rename may still be running.
   */
  readonly reusedWorktree?: { readonly baseRef: string };
};

export interface ThreadLaunchRetryInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}

export interface ThreadLaunchResult {
  readonly threadId: ThreadId;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly resumed: boolean;
}

export class ThreadLaunchError extends Schema.TaggedError<ThreadLaunchError>()(
  "ThreadLaunchError",
  {
    operation: Schema.Literals([
      "resolve-project",
      "read-receipt",
      "generate-metadata",
      "provision-worktree",
      "run-setup-script",
      "create-thread",
      "update-thread",
      "dispatch-message",
      "release-run",
      "fail-run",
    ]),
    commandId: CommandId,
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread launch ${this.commandId} failed during ${this.operation}.`;
  }
}

/** A new worktree was asked to start from a ref that gives it no commit. */
export class ThreadLaunchBaseRefError extends Schema.TaggedError<ThreadLaunchBaseRefError>()(
  "ThreadLaunchBaseRefError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    workspaceRoot: Schema.String,
    baseRef: Schema.String,
  },
) {
  override get message(): string {
    return `Base ref "${this.baseRef}" does not resolve to a commit in project "${this.projectTitle}" (${this.workspaceRoot}).`;
  }
}

export class ThreadLaunchBranchError extends Schema.TaggedError<ThreadLaunchBranchError>()(
  "ThreadLaunchBranchError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    workspaceRoot: Schema.String,
    branch: Schema.String,
    worktreePath: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return this.worktreePath === null
      ? `Branch "${this.branch}" already exists in project "${this.projectTitle}" (${this.workspaceRoot}), and a new worktree needs a new branch.`
      : `Branch "${this.branch}" is already checked out at ${this.worktreePath} in project "${this.projectTitle}".`;
  }
}

/**
 * An agent or server launch named a folder that is gone from this machine, such as a
 * project whose checkout was deleted or never cloned here. Refused before any thread exists.
 */
export class ThreadLaunchWorkspaceMissingError extends Schema.TaggedError<ThreadLaunchWorkspaceMissingError>()(
  "ThreadLaunchWorkspaceMissingError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    /** `project` is the project's own folder; `worktree` an existing worktree the launch named. */
    kind: Schema.Literals(["project", "worktree"]),
    path: Schema.String,
    /** The project's remote, when GOAT still knows it, so a caller can clone it back. */
    remoteUrl: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return this.kind === "project"
      ? `Project "${this.projectTitle}" points at ${this.path}, which does not exist on this machine. No thread was created.`
      : `Worktree ${this.path} of project "${this.projectTitle}" does not exist on this machine. No thread was created.`;
  }
}

export class ThreadLaunchService extends Context.Service<
  ThreadLaunchService,
  {
    /**
     * Launches from an agent or the server (anything but a person in a client) are refused
     * with ThreadLaunchWorkspaceMissingError when their folder is gone. A person launching
     * from a client still gets the thread, with the failure shown in it.
     */
    readonly launch: (
      input: ThreadLaunchInput,
    ) => Effect.Effect<
      ThreadLaunchResult,
      | ThreadLaunchError
      | ThreadLaunchWorkspaceMissingError
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
    /**
     * Fails when a new worktree's base ref cannot give provisioning a commit,
     * or when its requested branch already exists (`git worktree add -b`
     * refuses it). `launch` accepts such a launch and reports the failure
     * inside the thread; a caller that needs it before a thread exists checks first.
     */
    readonly checkWorktreeBase: (
      input: Pick<ThreadLaunchInput, "projectId" | "workspaceStrategy">,
    ) => Effect.Effect<void, ThreadLaunchBaseRefError | ThreadLaunchBranchError>;
    /** Dispatches prepared-run.retry and prepares the run's workspace again. */
    readonly retryPreparation: (input: ThreadLaunchRetryInput) => Effect.Effect<
      Orchestrator.OrchestratorV2DispatchResult,
      // Dispatches prepared-run.retry, a command the enablement chokepoint
      // never gates; the type stays accurate anyway.
      | Orchestrator.OrchestratorV2Error
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("goat/orchestration-v2/ThreadLaunchService") {}

const isThreadLaunchError = Schema.is(ThreadLaunchError);

function failureDetail(error: unknown): string {
  if (isThreadLaunchError(error)) {
    const cause = error.cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return `Workspace preparation failed during ${error.operation.replaceAll("-", " ")}: ${detail}`;
  }
  return `Workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`;
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const setupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  const cloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
  const terminals = yield* TerminalManager.TerminalManager;
  const git = yield* GitWorkflow.GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerAdapters = yield* Effect.serviceOption(ProviderAdapters.ProviderAdapterRegistryV2);
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  // Optional so harnesses that never launch into a real folder need not provide it.
  const workspacePaths = yield* Effect.serviceOption(WorkspacePaths.WorkspacePaths);
  const preparationScope = yield* Scope.make("sequential");
  const scheduledLaunches = yield* Ref.make<ReadonlySet<CommandId>>(new Set());
  yield* Effect.addFinalizer(() => Scope.close(preparationScope, Exit.void));

  const mapError =
    (input: PreparationInput, operation: ThreadLaunchError["operation"], threadId?: ThreadId) =>
    (cause: unknown) =>
      new ThreadLaunchError({
        operation,
        commandId: input.commandId,
        projectId: input.projectId,
        ...(threadId === undefined ? {} : { threadId }),
        cause,
      });

  const readReceipt = (input: ThreadLaunchInput, commandId: CommandId) =>
    receipts
      .getByCommandId(commandId)
      .pipe(Effect.mapError(mapError(input, "read-receipt", input.threadId)));

  const validateReusableThread = Effect.fn("ThreadLaunchService.validateReusableThread")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
  ) {
    const projection = yield* threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
    if (
      projection.thread.projectId !== input.projectId ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      (yield* threads
        .getMessageCount(threadId)
        .pipe(Effect.mapError(mapError(input, "update-thread", threadId)))) > 0 ||
      projection.runs.length > 0
    ) {
      return yield* mapError(
        input,
        "update-thread",
        threadId,
      )("Only an empty active thread in the target project can change workspace during launch.");
    }
  });

  const checkWorktreeBase: ThreadLaunchService["Service"]["checkWorktreeBase"] = Effect.fn(
    "ThreadLaunchService.checkWorktreeBase",
  )(function* (input) {
    const strategy = input.workspaceStrategy;
    if (strategy.type !== "worktree") return;
    const { branch } = strategy;
    if (branch !== undefined) {
      const taken = yield* Effect.gen(function* () {
        const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
        if (project === undefined) return undefined;
        const cwd = project.workspaceRoot;
        if (!(yield* git.hasCommit({ cwd, refName: `refs/heads/${branch}` }))) return undefined;
        return { project, worktreePath: yield* git.branchWorktreePath({ cwd, branch }) };
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (taken !== undefined)
        return yield* new ThreadLaunchBranchError({
          projectId: taken.project.id,
          projectTitle: taken.project.title,
          workspaceRoot: taken.project.workspaceRoot,
          branch,
          worktreePath: taken.worktreePath,
        });
    }
    // `:/text` is a commit search, which cannot be asked for a commit type.
    if (strategy.baseRef.startsWith(":")) return;
    const { baseRef } = strategy;
    // Anything this cannot establish is left for the launch to report: a
    // missing project, a folder that is not a repository, a failing Git.
    const unresolved = yield* Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
      if (project === undefined) return undefined;
      const cwd = project.workspaceRoot;
      // `git worktree add` reads `-` as the previous checkout.
      if (yield* git.hasCommit({ cwd, refName: baseRef === "-" ? "@{-1}" : baseRef }))
        return undefined;
      // Provisioning fetches the base from origin when it can, and runs a
      // repository with no commits yet without a worktree.
      if (
        strategy.startFromOrigin === true &&
        (yield* git.remoteExists({ cwd, remoteName: "origin" }))
      )
        return undefined;
      // `git worktree add` also starts from a remote-tracking branch of that
      // name; any ref carrying it is reason enough to let Git decide.
      if (yield* git.hasRefNamed({ cwd, refName: baseRef })) return undefined;
      return (yield* git.hasCommit({ cwd, refName: "HEAD" })) ? project : undefined;
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (unresolved !== undefined)
      return yield* new ThreadLaunchBaseRefError({
        projectId: unresolved.id,
        projectTitle: unresolved.title,
        workspaceRoot: unresolved.workspaceRoot,
        baseRef,
      });
  });

  const prepareInBackground = Effect.fn("ThreadLaunchService.prepareInBackground")(function* (
    input: PreparationInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(mapError(input, "resolve-project", threadId)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(mapError(input, "resolve-project", threadId)("Project no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );

    if (Option.isSome(providerAdapters)) {
      const adapter = yield* providerAdapters.value
        .get(input.modelSelection.instanceId)
        .pipe(Effect.mapError(mapError(input, "resolve-project", threadId)));
      const capabilities = yield* adapter
        .getCapabilities()
        .pipe(Effect.mapError(mapError(input, "resolve-project", threadId)));
      if (isCloudExecution(capabilities)) {
        if (runId !== null)
          yield* threads
            .dispatch({
              type: "prepared-run.release",
              commandId: CommandId.make(`${input.commandId}:release`),
              threadId,
              runId,
            })
            .pipe(Effect.mapError(mapError(input, "release-run", threadId)));
        return;
      }
    }
    const reused = input.reusedWorktree;
    const tracked = input.workspaceStrategy.type === "worktree" || reused !== undefined;
    let createdWorktreePath: string | null = null;
    let setupTerminalId: string | null = null;
    let workspaceRecorded = false;
    if (input.workspaceStrategy.type === "worktree") {
      yield* setupTracker.begin({
        threadId,
        branch: input.workspaceStrategy.branch ?? null,
        baseRef: input.workspaceStrategy.baseRef,
        stages: ["fetch", "checkout", "setup-script", "agent"],
        fiber: yield* Effect.fiber,
      });
    } else if (reused !== undefined) {
      yield* setupTracker.begin({
        threadId,
        branch: input.workspaceStrategy.branch ?? null,
        baseRef: reused.baseRef,
        stages: ["setup-script", "agent"],
        fiber: yield* Effect.fiber,
      });
    }
    yield* Effect.gen(function* () {
      const initialMessage = input.initialMessage;
      const generateBranchNameFor = (cwd: string, message: ThreadLaunchInitialMessage) =>
        Effect.gen(function* () {
          const settings = resolveProjectSettings(
            yield* serverSettings.getSettings,
            input.projectId,
          ).settings;
          const modelSelection =
            settings.sourceControlWriterModelSelection === null
              ? settings.textGenerationModelSelection
              : ServerSettings.resolveSourceControlWriterModelSelection(
                  settings,
                  yield* providerRegistry.getProviders,
                  input.projectId,
                );
          return yield* textGeneration
            .generateBranchName({
              naming: {
                mode: settings.branchNamingMode,
                prefix: settings.branchNamePrefix,
                instructions: settings.branchNameInstructions,
              },
              cwd,
              // Name the branch after the task, not the standing instructions in front of it.
              message: splitStandingInstructions(message.text).text,
              attachments: message.attachments,
              ...(message.context ? { context: message.context } : {}),
              modelSelection,
            })
            .pipe(
              Effect.map((result) => ({
                branch: result.branch,
                exactName: settings.branchNamingMode === "custom",
              })),
            );
        });

      // The server owns worktree naming: without an explicit branch, provision
      // under a temporary `goat/<hash>` name so the worktree never waits on
      // name generation, then rename in the background below.
      const requestedBranch = input.workspaceStrategy.branch;
      let branch: string | null;
      if (input.workspaceStrategy.type === "worktree" && requestedBranch === undefined) {
        const uuid = yield* randomUuidV4;
        branch = buildTemporaryWorktreeBranchName(() => uuid.replaceAll("-", ""));
      } else {
        branch = requestedBranch ?? null;
      }
      let worktreePath =
        input.workspaceStrategy.type === "existing_worktree"
          ? input.workspaceStrategy.worktreePath
          : null;
      if (input.workspaceStrategy.type === "worktree") {
        if (runId !== null) {
          yield* threads
            .dispatch({
              type: "prepared-run.progress",
              commandId: CommandId.make(`${input.commandId}:progress:worktree`),
              threadId,
              runId,
              phase: "worktree",
            })
            .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
        }
        let startRef = input.workspaceStrategy.baseRef;
        // "Start from origin" is a stored default; repos without the requested
        // remote branch fall back to the local base branch.
        const startFromOrigin =
          input.workspaceStrategy.startFromOrigin === true &&
          (yield* git
            .remoteExists({ cwd: project.workspaceRoot, remoteName: "origin" })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId))));
        yield* setupTracker.stageStatus(threadId, "fetch", startFromOrigin ? "running" : "skipped");
        if (startFromOrigin) {
          yield* git
            .fetchRemote({
              cwd: project.workspaceRoot,
              remoteName: "origin",
              refName: input.workspaceStrategy.baseRef,
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
          const remoteBaseExists = yield* git
            .remoteBranchExists({
              cwd: project.workspaceRoot,
              refName: input.workspaceStrategy.baseRef,
              remoteName: "origin",
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
          if (remoteBaseExists) {
            startRef = yield* git
              .resolveRemoteTrackingCommit({
                cwd: project.workspaceRoot,
                refName: input.workspaceStrategy.baseRef,
                fallbackRemoteName: "origin",
              })
              .pipe(
                Effect.map((resolved) => resolved.commitSha),
                Effect.mapError(mapError(input, "provision-worktree", threadId)),
              );
          }
        }
        if (startFromOrigin) yield* setupTracker.stageStatus(threadId, "fetch", "done");
        if (
          branch !== null &&
          isTemporaryWorktreeBranch(branch) &&
          (yield* git
            .hasCommit({
              cwd: project.workspaceRoot,
              // A plain branch named after the namespace blocks every ref inside it.
              refName: `refs/heads/${branch.split("/")[0] ?? WORKTREE_BRANCH_PREFIX}`,
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId))))
        ) {
          branch = flattenTemporaryWorktreeBranchName(branch);
        }
        yield* setupTracker.stageStatus(threadId, "checkout", "running");
        // Set from the fallback callback; the cast keeps TS from narrowing it to null.
        let worktreesDirectoryNotice = null as string | null;
        const worktree = yield* git
          .createWorktree(
            {
              cwd: project.workspaceRoot,
              refName: startRef,
              newRefName: branch!,
              baseRefName: input.workspaceStrategy.baseRef,
              path: null,
            },
            {
              progress: {
                onWorktreeClaimed: (path) =>
                  Effect.sync(() => {
                    createdWorktreePath = path;
                  }),
                onWorktreesDirectoryFallback: ({ configured, unavailable }) =>
                  Effect.sync(() => {
                    worktreesDirectoryNotice = `Used the default folder: ${configured} ${describeWorktreesDirectoryUnavailable(unavailable.reason)}`;
                  }),
                onCheckoutProgress: (progress) =>
                  setupTracker.stage(threadId, "checkout", { percent: progress.percent }),
              },
            },
          )
          .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
        worktreePath = worktree.worktree.path;
        branch = worktree.worktree.refName;
        createdWorktreePath = worktreePath;
        yield* setupTracker.update(threadId, (snapshot) => ({ ...snapshot, worktreePath, branch }));
        yield* worktreesDirectoryNotice === null
          ? setupTracker.stageStatus(threadId, "checkout", "done")
          : setupTracker.stageStatus(threadId, "checkout", "warning", worktreesDirectoryNotice);
      }

      // A reused worktree is already recorded, and rewriting it could undo
      // the first attempt's branch rename.
      if (reused === undefined) {
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${input.commandId}:workspace`),
            threadId,
            branch,
            worktreePath,
          })
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
      }
      workspaceRecorded = true;

      // Rename temporary branches (server-invented above, or sent by clients
      // that name worktrees themselves) in the background so generation latency
      // never delays provisioning or the provider turn. The temporary name
      // simply sticks if generation or the rename fails.
      if (
        reused === undefined &&
        worktreePath !== null &&
        branch !== null &&
        initialMessage !== undefined &&
        isTemporaryWorktreeBranch(branch)
      ) {
        const oldBranch = branch;
        const worktreeCwd = worktreePath;
        yield* generateBranchNameFor(worktreeCwd, initialMessage).pipe(
          Effect.flatMap(({ branch: newBranch, exactName }) =>
            git.renameBranch({
              cwd: worktreeCwd,
              oldBranch,
              newBranch,
              ...(exactName ? { exactName: true } : {}),
            }),
          ),
          Effect.flatMap((renamed) =>
            threads.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`${input.commandId}:branch-rename`),
              threadId,
              branch: renamed.branch,
              // A late rename must not restore a worktree removed by setup cancellation.
              expectedWorktreePath: worktreeCwd,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Thread worktree branch rename failed", {
              commandId: input.commandId,
              threadId,
              oldBranch,
              cause,
            }),
          ),
          Effect.forkIn(preparationScope),
        );
      }

      const cwd = worktreePath ?? project.workspaceRoot;
      if (runId !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.progress",
            commandId: CommandId.make(`${input.commandId}:progress:setup`),
            threadId,
            runId,
            phase: "setup",
          })
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
      }
      yield* setupTracker.stageStatus(threadId, "setup-script", "running");
      const setup = yield* setupScripts
        .runForThread({
          threadId,
          projectId: input.projectId,
          projectCwd: project.workspaceRoot,
          worktreePath: cwd,
          ...(tracked
            ? {
                observeCompletion: {
                  onOutputLine: (line: string) =>
                    setupTracker.appendTail(threadId, "setup-script", line),
                },
              }
            : {}),
          project: {
            id: project.id,
            workspaceRoot: project.workspaceRoot,
            scripts: project.scripts,
          },
        })
        .pipe(Effect.mapError(mapError(input, "run-setup-script", threadId)));

      let awaitAsyncSetup = Effect.void;
      if (setup.status === "started") {
        setupTerminalId = setup.terminalId;
        yield* setupTracker.update(threadId, (snapshot) => ({
          ...snapshot,
          setupScript: {
            name: setup.scriptName,
            command: setup.scriptCommand,
            terminalId: setup.terminalId,
          },
        }));
        if (setup.completion) {
          const awaitCompletion = Effect.gen(function* () {
            const completion = yield* setup.completion!;
            yield* setupTracker.stage(threadId, "setup-script", {
              status: completion.exitCode === 0 ? "done" : "failed",
              detail: `exited with ${completion.exitCode ?? "no exit code"}`,
            });
            if (completion.exitCode !== 0 && !setup.async)
              return yield* mapError(
                input,
                "run-setup-script",
                threadId,
              )(`Setup script exited with ${completion.exitCode ?? "no exit code"}.`);
          });
          if (setup.async) {
            awaitAsyncSetup = awaitCompletion.pipe(
              Effect.catchCause((cause) =>
                setupTracker.stage(threadId, "setup-script", {
                  status: "failed",
                  detail: failureDetail(Cause.squash(cause)),
                }),
              ),
            );
          } else {
            yield* awaitCompletion;
          }
        } else {
          yield* setupTracker.stageStatus(threadId, "setup-script", "done");
        }
      } else {
        yield* setupTracker.stageStatus(threadId, "setup-script", "skipped");
      }
      yield* setupTracker.markUncancellable(threadId);
      yield* setupTracker.stageStatus(threadId, "agent", "running");
      if (runId !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.release",
            commandId: CommandId.make(`${input.commandId}:release`),
            threadId,
            runId,
          })
          .pipe(Effect.mapError(mapError(input, "release-run", threadId)));
      }
      yield* setupTracker.stageStatus(threadId, "agent", "done");
      yield* awaitAsyncSetup;
      yield* setupTracker.finish(threadId, "done");
    }).pipe(
      Effect.onError((cause) =>
        Effect.gen(function* () {
          const cancelled = Cause.hasInterruptsOnly(cause);
          yield* setupTracker.finish(
            threadId,
            cancelled ? "cancelled" : "failed",
            cancelled ? null : failureDetail(Cause.squash(cause)),
          );
          // A cancelled setup leaves nothing behind. A failed one keeps a worktree
          // the thread recorded, so a retry reuses it, and removes one it never
          // recorded, which a retry would otherwise duplicate.
          if (tracked && createdWorktreePath && (cancelled || !workspaceRecorded)) {
            if (setupTerminalId)
              yield* terminals
                .close({ threadId, terminalId: setupTerminalId, deleteHistory: true })
                .pipe(Effect.ignore);
            const removedPath = createdWorktreePath;
            // The thread forgets the worktree only once it is gone; a failed
            // removal leaves the directory for the user to clean up rather than
            // reusing a checkout that may be half written.
            yield* git
              .removeWorktree({ cwd: project.workspaceRoot, path: removedPath, force: true })
              .pipe(
                Effect.andThen(
                  threads
                    .dispatch({
                      type: "thread.metadata.update",
                      commandId: CommandId.make(`${input.commandId}:cancel-workspace`),
                      threadId,
                      worktreePath: null,
                      branch: null,
                    })
                    .pipe(Effect.ignore),
                ),
                Effect.catchCause((removeCause) =>
                  Effect.logWarning("Failed to remove an abandoned thread worktree", {
                    commandId: input.commandId,
                    threadId,
                    path: removedPath,
                    cause: removeCause,
                  }),
                ),
              );
          }
        }),
      ),
    );
  });

  const failPreparedRun = (
    input: Pick<PreparationInput, "commandId">,
    threadId: ThreadId,
    runId: RunId | null,
    cause: unknown,
  ) =>
    runId === null
      ? Effect.logWarning("Thread workspace preparation failed", {
          commandId: input.commandId,
          threadId,
          cause,
        })
      : threads
          .dispatch({
            type: "prepared-run.fail",
            commandId: CommandId.make(`${input.commandId}:fail`),
            threadId,
            runId,
            failure: makeProviderFailure({
              cause,
              message: failureDetail(cause),
              class: "validation_error",
              retryable: false,
            }),
          })
          .pipe(
            Effect.catchCause((persistCause) =>
              Effect.logWarning("Failed to persist thread workspace preparation failure", {
                commandId: input.commandId,
                threadId,
                cause,
                persistCause,
              }),
            ),
          );

  const reservePreparation = (commandId: CommandId) =>
    Ref.modify(scheduledLaunches, (scheduled) => {
      if (scheduled.has(commandId)) return [false, scheduled] as const;
      const next = new Set(scheduled);
      next.add(commandId);
      return [true, next] as const;
    });

  const releasePreparation = (commandId: CommandId) =>
    Ref.update(scheduledLaunches, (scheduled) => {
      const next = new Set(scheduled);
      next.delete(commandId);
      return next;
    });

  const schedulePreparation = Effect.fn("ThreadLaunchService.schedulePreparation")(function* (
    input: PreparationInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    yield* prepareInBackground(input, threadId, runId).pipe(
      Effect.onError((cause) =>
        failPreparedRun(
          input,
          threadId,
          runId,
          Cause.hasInterruptsOnly(cause) ? "Worktree setup cancelled." : Cause.squash(cause),
        ),
      ),
      Effect.ignoreCause,
      Effect.ensuring(releasePreparation(input.commandId)),
      Effect.forkIn(preparationScope),
    );
  });

  /** Fails only when a folder is missing or not a directory; any other stat failure is left to the launch. */
  const assertWorkspaceExists = Effect.fn("ThreadLaunchService.assertWorkspaceExists")(function* (
    project: Project,
    strategy: ThreadLaunchWorkspaceStrategy,
  ) {
    if (Option.isNone(workspacePaths)) return;
    const paths: ReadonlyArray<readonly ["project" | "worktree", string]> = [
      ["project", project.workspaceRoot],
      ...(strategy.type === "existing_worktree"
        ? [["worktree", strategy.worktreePath] as const]
        : []),
    ];
    for (const [kind, path] of paths) {
      const missing = yield* workspacePaths.value.normalizeWorkspaceRoot(path).pipe(
        Effect.as(false),
        Effect.catchTags({
          WorkspaceRootNotExistsError: () => Effect.succeed(true),
          WorkspaceRootNotDirectoryError: () => Effect.succeed(true),
        }),
        Effect.orElseSucceed(() => false),
      );
      if (missing)
        return yield* new ThreadLaunchWorkspaceMissingError({
          projectId: project.id,
          projectTitle: project.title,
          kind,
          path,
          remoteUrl: project.repositoryIdentity?.locator.remoteUrl ?? null,
        });
    }
  });

  const launch: ThreadLaunchService["Service"]["launch"] = Effect.fn("ThreadLaunchService.launch")(
    function* (input) {
      const adapter = Option.isSome(providerAdapters)
        ? yield* providerAdapters.value
            .get(input.modelSelection.instanceId)
            .pipe(Effect.mapError(mapError(input, "resolve-project")))
        : undefined;
      const cloud =
        adapter !== undefined &&
        isCloudExecution(
          yield* adapter
            .getCapabilities()
            .pipe(Effect.mapError(mapError(input, "resolve-project"))),
        );
      if (cloud && input.workspaceStrategy.type === "worktree") {
        input = {
          ...input,
          workspaceStrategy: {
            type: "root",
            branch: input.workspaceStrategy.baseRef,
          },
        };
      }
      yield* ProjectCloneTracker.rejectCommandsDuringClone(cloneTracker, {
        type: "thread.create",
        projectId: input.projectId,
      }).pipe(Effect.mapError(mapError(input, "resolve-project")));
      const project = yield* projects.getById(input.projectId).pipe(
        Effect.mapError(mapError(input, "resolve-project")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(mapError(input, "resolve-project")("Project not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (input.reuseExistingThread === true && input.threadId === undefined) {
        return yield* mapError(
          input,
          "update-thread",
        )("Reusing an existing thread requires a thread id.");
      }

      const launchReceipt = yield* readReceipt(input, input.commandId);
      yield* threads.assertProviderInstanceEnabled({
        projectId: input.projectId,
        commandId: input.commandId,
        instanceId: input.modelSelection.instanceId,
      });
      return yield* Effect.gen(function* () {
        // A retried launch has no client-supplied id to replay against, so
        // recover the thread id its accepted create was recorded under before
        // allocating another one; a fresh id would only collide with the
        // recorded receipt.
        const reusableLaunchReceipt =
          input.threadId === undefined &&
          Option.isSome(launchReceipt) &&
          launchReceipt.value.status === "accepted" &&
          launchReceipt.value.commandType === "thread.create"
            ? launchReceipt.value
            : undefined;
        const candidateThreadId =
          input.threadId ??
          reusableLaunchReceipt?.threadId ??
          (yield* ids.allocate
            .thread({ projectId: input.projectId })
            .pipe(Effect.mapError(mapError(input, "create-thread"))));

        if (reusableLaunchReceipt !== undefined) {
          const shell = yield* threads
            .getThreadShell(candidateThreadId)
            .pipe(Effect.mapError(mapError(input, "create-thread", candidateThreadId)));
          if (shell === null) {
            return yield* mapError(input, "create-thread", candidateThreadId)("Thread not found.");
          }
          if (shell.projectId !== input.projectId) {
            return yield* mapError(
              input,
              "resolve-project",
              candidateThreadId,
            )("Project identity changed.");
          }
        }

        if (input.reuseExistingThread === true && Option.isNone(launchReceipt)) {
          yield* validateReusableThread(input, candidateThreadId);
        }

        // A Scratch thread launched at the project root runs in a folder of its
        // own. Only the first attempt claims one; a retry replays its create.
        const workspaceStrategy: ThreadLaunchWorkspaceStrategy =
          !cloud && input.workspaceStrategy.type === "root" && Option.isNone(launchReceipt)
            ? Option.match(
                yield* managedFolders
                  .folderForThread({
                    projectId: input.projectId,
                    threadId: candidateThreadId,
                    text: input.initialMessage?.text ?? input.title,
                  })
                  .pipe(Effect.mapError(mapError(input, "provision-worktree", candidateThreadId))),
                {
                  onNone: () => input.workspaceStrategy,
                  onSome: (worktreePath) => ({ type: "existing_worktree", worktreePath }),
                },
              )
            : input.workspaceStrategy;
        // Checked after a Scratch launch claims its folder, which recreates a
        // deleted Scratch folder. Only a first attempt is checked: a replay must
        // keep answering with the thread it made.
        if (
          Option.isNone(launchReceipt) &&
          input.importedNativeThread === undefined &&
          input.fromClient !== true
        )
          yield* assertWorkspaceExists(project, workspaceStrategy);
        const initialBranch = workspaceStrategy.branch ?? null;
        const initialWorktreePath =
          workspaceStrategy.type === "existing_worktree" ? workspaceStrategy.worktreePath : null;
        const claimDispatch =
          input.reuseExistingThread === true
            ? threads.dispatch({
                type: "thread.metadata.update",
                commandId: input.commandId,
                threadId: candidateThreadId,
                expectedEmpty: true,
              })
            : threads.dispatch({
                type: "thread.create",
                commandId: input.commandId,
                threadId: candidateThreadId,
                projectId: input.projectId,
                title: input.title,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                branch: initialBranch,
                worktreePath: initialWorktreePath,
                ...(input.importedNativeThread === undefined
                  ? {}
                  : { importedNativeThread: input.importedNativeThread }),
                createdBy: input.createdBy,
                creationSource: input.creationSource,
                ...(input.launchedBy === undefined ? {} : { launchedBy: input.launchedBy }),
              });
        const claimed = yield* claimDispatch.pipe(
          Effect.mapError(
            mapError(
              input,
              input.reuseExistingThread === true ? "update-thread" : "create-thread",
              candidateThreadId,
            ),
          ),
        );
        const threadId =
          claimed.storedEvents.find((stored) => stored.event.type.startsWith("thread."))?.event
            .threadId ?? candidateThreadId;
        if (project.id !== input.projectId) {
          return yield* mapError(input, "resolve-project", threadId)("Project identity changed.");
        }

        let runId: RunId | null = null;
        let messageWasAlreadyAccepted = false;
        if (input.initialMessage !== undefined) {
          const messageCommandId = CommandId.make(`${input.commandId}:initial-message`);
          const messageReceipt = yield* readReceipt(input, messageCommandId);
          messageWasAlreadyAccepted = Option.isSome(messageReceipt);
          const messageId =
            input.initialMessage.messageId ??
            (yield* ids.allocate
              .message({ threadId, ordinal: 1 })
              .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId))));
          const dispatched = yield* threads
            .dispatch({
              type: "message.dispatch",
              commandId: messageCommandId,
              threadId,
              messageId,
              text: input.initialMessage.text,
              ...(input.initialMessage.scheduledTaskId === undefined
                ? {}
                : { scheduledTaskId: input.initialMessage.scheduledTaskId }),
              ...(input.initialMessage.senderThreadId === undefined
                ? {}
                : { senderThreadId: input.initialMessage.senderThreadId }),
              attachments: input.initialMessage.attachments,
              ...(input.initialMessage.context ? { context: input.initialMessage.context } : {}),
              ...(input.generateTitle === true ? { titleSeed: input.title } : {}),
              modelSelection: input.modelSelection,
              dispatchMode: { type: "defer_start", workspaceStrategy },
              createdBy: input.createdBy,
              creationSource: input.creationSource,
            })
            .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId)));
          const runCreated = dispatched.storedEvents.find(
            (stored) => stored.event.type === "run.created",
          );
          runId = runCreated?.event.type === "run.created" ? runCreated.event.payload.id : null;
          if (runId === null) {
            return yield* mapError(
              input,
              "dispatch-message",
              threadId,
            )("Initial message was accepted without a durable run.");
          }
        }

        const projection = yield* threads
          .getThreadProjection(threadId)
          .pipe(Effect.mapError(mapError(input, "create-thread", threadId)));
        const runIsPreparing =
          runId !== null &&
          projection.runs.some((run) => run.id === runId && run.status === "preparing");
        const shouldSchedule = runId === null ? Option.isNone(launchReceipt) : runIsPreparing;
        // A retried root launch prepares the folder its first attempt bound, so
        // a Scratch thread keeps its own. Other root launches bind no folder.
        const boundWorktreePath = projection.thread.worktreePath;
        const preparationStrategy: ThreadLaunchWorkspaceStrategy =
          Option.isSome(launchReceipt) &&
          workspaceStrategy.type === "root" &&
          boundWorktreePath !== null
            ? {
                type: "existing_worktree",
                worktreePath: boundWorktreePath,
                branch: workspaceStrategy.branch,
              }
            : workspaceStrategy;
        if (shouldSchedule) {
          const ownsPreparation = yield* reservePreparation(input.commandId);
          if (ownsPreparation) {
            yield* Effect.gen(function* () {
              const preparationStillRequired =
                runId === null
                  ? true
                  : yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] }).pipe(
                      Effect.map((current) =>
                        current.runs.some((run) => run.id === runId && run.status === "preparing"),
                      ),
                      Effect.mapError(mapError(input, "update-thread", threadId)),
                    );
              if (preparationStillRequired) {
                yield* schedulePreparation(
                  { ...input, workspaceStrategy: preparationStrategy },
                  threadId,
                  runId,
                );
              } else {
                yield* releasePreparation(input.commandId);
              }
            }).pipe(Effect.onError(() => releasePreparation(input.commandId)));
          }
        }

        return {
          threadId,
          projection,
          resumed: Option.isSome(launchReceipt) || messageWasAlreadyAccepted,
        };
      });
    },
  );

  const retryPreparation: ThreadLaunchService["Service"]["retryPreparation"] = Effect.fn(
    "ThreadLaunchService.retryPreparation",
  )(function* (input) {
    const dispatched = yield* threads.dispatch({
      type: "prepared-run.retry",
      commandId: input.commandId,
      threadId: input.threadId,
      runId: input.runId,
    });
    // A replayed retry finds the run already past preparation, or prepared by
    // the attempt that first reserved this command.
    // From here the run is preparing again; anything that stops preparation
    // from being scheduled must fail it, or it would wait in preparing forever.
    const scheduled = yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadProjection(input.threadId);
      const run = projection.runs.find((candidate) => candidate.id === input.runId);
      const workspacePreparation = run?.workspacePreparation;
      if (run?.status !== "preparing" || workspacePreparation === undefined) return;
      if (!(yield* reservePreparation(input.commandId))) return;
      yield* scheduleRetriedPreparation(input, projection, run, workspacePreparation).pipe(
        Effect.onError(() => releasePreparation(input.commandId)),
      );
    }).pipe(Effect.exit);
    if (Exit.isFailure(scheduled)) {
      yield* failPreparedRun(input, input.threadId, input.runId, Cause.squash(scheduled.cause));
    }
    return dispatched;
  });

  const scheduleRetriedPreparation = (
    input: ThreadLaunchRetryInput,
    projection: OrchestrationV2ThreadProjection,
    run: OrchestrationV2ThreadProjection["runs"][number],
    workspacePreparation: ThreadLaunchWorkspaceStrategy,
  ) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    // A worktree the failed attempt already created is reused, not created again.
    const reuse =
      workspacePreparation.type === "worktree" &&
      projection.thread.worktreePath !== null &&
      projection.thread.branch !== null
        ? {
            strategy: {
              type: "existing_worktree" as const,
              worktreePath: projection.thread.worktreePath,
              branch: projection.thread.branch,
            },
            reusedWorktree: { baseRef: workspacePreparation.baseRef },
          }
        : null;
    return schedulePreparation(
      {
        commandId: input.commandId,
        projectId: projection.thread.projectId,
        modelSelection: run.modelSelection,
        workspaceStrategy: reuse?.strategy ?? workspacePreparation,
        ...(reuse === null ? {} : { reusedWorktree: reuse.reusedWorktree }),
        ...(message === undefined
          ? {}
          : {
              initialMessage: {
                text: message.text,
                attachments: message.attachments,
                ...(message.context ? { context: message.context } : {}),
              },
            }),
      },
      input.threadId,
      run.id,
    );
  };

  return ThreadLaunchService.of({ launch, checkWorktreeBase, retryPreparation });
});

export const layer = Layer.effect(ThreadLaunchService, make);
