import {
  type CommandId,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  OrchestrationV2ThreadForkError,
  type OrchestrationV2ThreadForkRefusal,
  type OrchestrationV2ThreadForkResult,
  type OrchestrationV2ThreadForkSourcePoint,
  type OrchestrationV2ThreadForkWorkspace,
  type OrchestrationV2ThreadForkWorktreeResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type ThreadId,
} from "@goat/contracts";
import { isCloudExecution } from "@goat/provider-core/server/cloudTask";
import { buildTemporaryWorktreeBranchName } from "@goat/shared/git";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as Git from "../../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { isForkableSourceRunStatus } from "../ThreadForkService.ts";
import * as ThreadManagementService from "../ThreadManagementService.ts";

export interface ThreadForkWorkspaceInput {
  readonly commandId: CommandId;
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly sourcePoint: OrchestrationV2ThreadForkSourcePoint;
  readonly title?: string;
  readonly workspace: OrchestrationV2ThreadForkWorkspace;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

/** Forks a thread into its source's checkout or into a new GOAT-managed worktree made from it. */
export class ThreadForkWorkspaceService extends Context.Service<
  ThreadForkWorkspaceService,
  {
    readonly fork: (
      input: ThreadForkWorkspaceInput,
    ) => Effect.Effect<OrchestrationV2ThreadForkResult, OrchestrationV2ThreadForkError>;
  }
>()("goat/orchestration-v2/goat/ThreadForkWorkspace/ThreadForkWorkspaceService") {}

const isForkError = Schema.is(OrchestrationV2ThreadForkError);

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

function hasForkableRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  sourcePoint: OrchestrationV2ThreadForkSourcePoint,
): boolean {
  if (sourcePoint.type === "run") {
    const run = runs.find((candidate) => candidate.id === sourcePoint.runId);
    return run !== undefined && isForkableSourceRunStatus(run.status);
  }
  // The orchestrator resolves checkpoints; a refusal there removes the worktree.
  return (
    sourcePoint.type === "checkpoint" || runs.some((run) => isForkableSourceRunStatus(run.status))
  );
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const git = yield* Git.GitVcsDriver;
  const snapshots = yield* Git.makeVcsDriverShape();
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;

  // One in-flight fork per commandId, so a retry racing the first call cannot make a second checkout.
  const inFlight = new Map<CommandId, { readonly lock: Semaphore.Semaphore; holders: number }>();
  const singleFlight = <A, E, R>(commandId: CommandId, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = inFlight.get(commandId) ?? { lock: Semaphore.makeUnsafe(1), holders: 0 };
        entry.holders += 1;
        inFlight.set(commandId, entry);
        return entry;
      }),
      (entry) => entry.lock.withPermits(1)(effect),
      (entry) =>
        Effect.sync(() => {
          entry.holders -= 1;
          if (entry.holders === 0) inFlight.delete(commandId);
        }),
    );

  const refuse = (
    input: ThreadForkWorkspaceInput,
    reason: OrchestrationV2ThreadForkRefusal,
    message: string,
    extra: { readonly cause?: unknown; readonly retainedWorktreePath?: string } = {},
  ) =>
    new OrchestrationV2ThreadForkError({
      commandId: input.commandId,
      sourceThreadId: input.sourceThreadId,
      reason,
      message,
      ...(extra.retainedWorktreePath === undefined
        ? {}
        : { retainedWorktreePath: extra.retainedWorktreePath }),
      ...(extra.cause === undefined ? {} : { cause: extra.cause }),
    });

  const readTarget = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, []).pipe(
      Effect.map((projection) => projection.thread),
      Effect.option,
    );

  const replay = Effect.fn("ThreadForkWorkspace.replay")(function* (
    input: ThreadForkWorkspaceInput,
  ) {
    const receipt = yield* receipts
      .getByCommandId(input.commandId)
      .pipe(
        Effect.mapError((cause) =>
          refuse(input, "fork_failed", "Could not read this fork's earlier attempt.", { cause }),
        ),
      );
    if (Option.isNone(receipt)) return Option.none<OrchestrationV2ThreadForkResult>();
    if (receipt.value.status === "rejected") {
      return yield* refuse(input, "fork_failed", receipt.value.error ?? "The fork was refused.");
    }
    const target = yield* readTarget(receipt.value.threadId);
    const worktreePath = Option.isSome(target) ? target.value.worktreePath : null;
    const branch = Option.isSome(target) ? target.value.branch : null;
    return Option.some<OrchestrationV2ThreadForkResult>({
      sequence: receipt.value.resultSequence,
      targetThreadId: receipt.value.threadId,
      ...(input.workspace.type === "worktree" && worktreePath !== null && branch !== null
        ? {
            worktree: {
              branch,
              worktreePath,
              baseCommit: null,
              uncommitted: null,
              setupScript: "unknown",
            },
          }
        : {}),
    });
  });

  const dispatchFork = (
    input: ThreadForkWorkspaceInput,
    workspace?: { readonly branch: string; readonly worktreePath: string },
  ) =>
    threads.dispatch({
      type: "thread.fork",
      commandId: input.commandId,
      sourceThreadId: input.sourceThreadId,
      targetThreadId: input.targetThreadId,
      sourcePoint: input.sourcePoint,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(workspace === undefined ? {} : { workspace }),
      createdBy: input.createdBy,
      creationSource: input.creationSource,
    });

  /** Validates the source and returns the checkout a worktree fork starts from. */
  const resolveSource = Effect.fn("ThreadForkWorkspace.resolveSource")(function* (
    input: ThreadForkWorkspaceInput,
  ) {
    const projection = yield* threads
      .getThreadRecords(input.sourceThreadId, ["runs"])
      .pipe(
        Effect.mapError((cause) =>
          refuse(input, "fork_failed", "The thread to fork could not be read.", { cause }),
        ),
      );
    const thread: OrchestrationV2AppThread = projection.thread;
    if (thread.sideChatOf != null) {
      return yield* refuse(input, "side_chat", "A side chat cannot be forked into a worktree.");
    }
    if (!hasForkableRun(projection.runs, input.sourcePoint)) {
      return yield* refuse(input, "fork_failed", "This thread has no finished turn to fork from.");
    }
    if (yield* managedFolders.isScratchProject(thread.projectId)) {
      return yield* refuse(
        input,
        "scratch_project",
        "A scratch session has no repository to make a worktree from.",
      );
    }
    const capabilities = yield* providerAdapters.get(thread.providerInstanceId).pipe(
      Effect.flatMap((adapter) => adapter.getCapabilities()),
      Effect.option,
    );
    if (Option.isSome(capabilities) && isCloudExecution(capabilities.value)) {
      return yield* refuse(input, "cloud_provider", "A cloud agent works in its own environment.");
    }
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.mapError((cause) =>
        refuse(input, "checkout_missing", "The thread's project could not be read.", { cause }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              refuse(input, "checkout_missing", "The thread's project no longer exists."),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    const sourceCwd = thread.worktreePath ?? project.workspaceRoot;
    if (!(yield* fileSystem.exists(sourceCwd).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* refuse(input, "checkout_missing", `The checkout at ${sourceCwd} is missing.`);
    }
    const status = yield* gitWorkflow.localStatus({ cwd: sourceCwd }).pipe(Effect.option);
    if (Option.isNone(status) || !status.value.isRepo) {
      return yield* refuse(input, "not_git_repository", `${sourceCwd} is not a git repository.`);
    }
    return { thread, project, sourceCwd };
  });

  /** Pins the commit the worktree starts at and, when asked, snapshots the uncommitted changes. */
  const pinSource = Effect.fn("ThreadForkWorkspace.pinSource")(function* (
    input: ThreadForkWorkspaceInput,
    sourceCwd: string,
    includeUncommitted: boolean,
  ) {
    const gitLines = (args: ReadonlyArray<string>) =>
      git
        .execute({ operation: "ThreadForkWorkspace.pin", cwd: sourceCwd, args })
        .pipe(Effect.map((result) => result.stdout.trim().split("\n")));
    if (!includeUncommitted) {
      const head = yield* git.resolveCommit({ cwd: sourceCwd, revision: "HEAD" });
      // A fresh read: the status cache may predate the latest edits.
      const [dirty] = yield* gitLines(["status", "--porcelain", "--untracked-files=normal"]);
      return {
        baseCommit: head.commitSha,
        snapshot: null,
        uncommitted: (dirty ?? "") === "" ? ("none" as const) : ("left" as const),
      };
    }
    const snapshotRef = `refs/goat/snapshots/fork-${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`;
    const snapshot = yield* snapshots
      .captureWorkspaceSnapshot({ cwd: sourceCwd, snapshotRef })
      .pipe(
        Effect.mapError((cause) =>
          refuse(
            input,
            "uncommitted_unsupported",
            "The uncommitted changes could not be copied. Fork without them, or commit them first.",
            { cause },
          ),
        ),
      );
    // Only a ref this call created is deleted, and only while it still points at this snapshot.
    yield* Effect.addFinalizer(() =>
      git
        .execute({
          operation: "ThreadForkWorkspace.dropSnapshot",
          cwd: sourceCwd,
          args: ["update-ref", "-d", snapshotRef, snapshot.commitOid],
          allowNonZeroExit: true,
        })
        .pipe(Effect.ignoreCause({ log: true })),
    );
    if (!snapshot.complete) {
      return yield* refuse(
        input,
        "uncommitted_unsupported",
        "Some uncommitted files could not be read. Fork without them, or commit them first.",
      );
    }
    const [baseCommit, snapshotTree, baseTree] = yield* gitLines([
      "rev-parse",
      `${snapshot.commitOid}^`,
      `${snapshot.commitOid}^{tree}`,
      `${snapshot.commitOid}^^{tree}`,
    ]);
    if (baseCommit === undefined || baseCommit === "") {
      return yield* refuse(input, "worktree_failed", "The source commit could not be resolved.");
    }
    return {
      baseCommit,
      snapshot: snapshotTree === baseTree ? null : snapshot.commitOid,
      uncommitted: snapshotTree === baseTree ? ("none" as const) : ("carried" as const),
    };
  });

  const forkIntoWorktree = Effect.fn("ThreadForkWorkspace.forkIntoWorktree")(function* (
    input: ThreadForkWorkspaceInput,
    workspace: Extract<OrchestrationV2ThreadForkWorkspace, { readonly type: "worktree" }>,
  ) {
    const { thread, project, sourceCwd } = yield* resolveSource(input);
    const token = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).replaceAll("-", "");
    const branch = workspace.branch ?? buildTemporaryWorktreeBranchName(() => token);
    const existing = yield* gitWorkflow.listLocalBranchNames(project.workspaceRoot).pipe(
      Effect.mapError((cause) =>
        refuse(input, "worktree_failed", "The repository's branches could not be listed.", {
          cause,
        }),
      ),
    );
    if (existing.includes(branch)) {
      return yield* refuse(input, "branch_exists", `Branch '${branch}' already exists.`);
    }
    const pin = yield* pinSource(input, sourceCwd, workspace.includeUncommitted !== false).pipe(
      Effect.mapError((cause) =>
        isForkError(cause)
          ? cause
          : refuse(input, "worktree_failed", "The source checkout could not be read.", { cause }),
      ),
    );

    // No journal: a crash before the fork commits leaves this worktree unowned, as worktree.handoff does.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const created = yield* restore(
          gitWorkflow.createWorktree(
            {
              cwd: project.workspaceRoot,
              refName: pin.baseCommit,
              newRefName: branch,
              baseRefName: thread.branch ?? pin.baseCommit,
              path: null,
            },
            { skipSetupHook: true },
          ),
        ).pipe(
          Effect.mapError((cause) =>
            refuse(input, "worktree_failed", "The worktree could not be created.", { cause }),
          ),
        );
        const worktreePath = created.worktree.path;
        const createdBranch = created.worktree.refName;
        const removeCreated = gitWorkflow
          .removeWorktree({ cwd: project.workspaceRoot, path: worktreePath, force: true })
          .pipe(
            Effect.andThen(
              gitWorkflow.deleteLocalBranch({
                cwd: project.workspaceRoot,
                refName: createdBranch,
                force: true,
              }),
            ),
            Effect.ignoreCause({ log: true }),
          );

        if (pin.snapshot !== null) {
          yield* restore(
            snapshots.materializeWorkspaceSnapshot({
              cwd: worktreePath,
              baseCommit: pin.baseCommit,
              snapshotCommit: pin.snapshot,
            }),
          ).pipe(
            Effect.tapCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.void : removeCreated,
            ),
            Effect.mapError((cause) =>
              refuse(
                input,
                "uncommitted_unsupported",
                "The uncommitted changes could not be copied. Fork without them, or commit them first.",
                { cause },
              ),
            ),
          );
        }

        const forkWorkspace = { branch: createdBranch, worktreePath };
        const dispatched = yield* restore(dispatchFork(input, forkWorkspace)).pipe(
          Effect.map((result) => result.sequence),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              // The event sink commits before it publishes, so a failure here may follow a committed fork.
              const receipt = yield* receipts
                .getByCommandId(input.commandId)
                .pipe(Effect.orElseSucceed(() => Option.none()));
              const target = yield* readTarget(input.targetThreadId);
              if (Option.isSome(receipt) && receipt.value.status === "accepted") {
                return receipt.value.resultSequence;
              }
              if (
                Option.isNone(receipt) &&
                Option.isSome(target) &&
                target.value.worktreePath === worktreePath
              ) {
                return yield* refuse(
                  input,
                  "fork_failed",
                  "The fork was created but its result could not be confirmed.",
                  { retainedWorktreePath: worktreePath, cause: Cause.squash(cause) },
                );
              }
              const definite =
                (Option.isSome(receipt) && receipt.value.status === "rejected") ||
                (Option.isNone(receipt) && Option.isNone(target));
              if (definite && !Cause.hasInterruptsOnly(cause)) {
                yield* removeCreated;
                return yield* refuse(
                  input,
                  "fork_failed",
                  Option.isSome(receipt) && receipt.value.error !== null
                    ? receipt.value.error
                    : errorText(Cause.squash(cause)),
                  { cause: Cause.squash(cause) },
                );
              }
              yield* Effect.logWarning("Kept a fork worktree after an unknown outcome", {
                commandId: input.commandId,
                worktreePath,
              });
              return yield* refuse(
                input,
                "fork_failed",
                `The fork's outcome is unknown; its worktree was kept at ${worktreePath}.`,
                { retainedWorktreePath: worktreePath, cause: Cause.squash(cause) },
              );
            }),
          ),
        );

        yield* vcsStatus
          .refreshStatus(worktreePath)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
        const setupScript = yield* setupScripts
          .runForThread({
            threadId: input.targetThreadId,
            projectId: project.id,
            projectCwd: project.workspaceRoot,
            worktreePath,
            project: {
              id: project.id,
              workspaceRoot: project.workspaceRoot,
              scripts: project.scripts,
            },
          })
          .pipe(
            Effect.map((result): "started" | "no-script" =>
              result.status === "started" ? "started" : "no-script",
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Fork worktree setup script failed", {
                worktreePath,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as("failed" as const)),
            ),
          );
        const worktree: OrchestrationV2ThreadForkWorktreeResult = {
          branch: createdBranch,
          worktreePath,
          baseCommit: pin.baseCommit,
          uncommitted: pin.uncommitted,
          setupScript,
        };
        return { sequence: dispatched, targetThreadId: input.targetThreadId, worktree };
      }),
    );
  });

  const fork = Effect.fn("ThreadForkWorkspace.fork")(function* (input: ThreadForkWorkspaceInput) {
    return yield* singleFlight(
      input.commandId,
      Effect.gen(function* () {
        const replayed = yield* replay(input);
        if (Option.isSome(replayed)) return replayed.value;
        if (input.workspace.type === "current") {
          const result = yield* dispatchFork(input).pipe(
            Effect.mapError((cause) => refuse(input, "fork_failed", errorText(cause), { cause })),
          );
          return { sequence: result.sequence, targetThreadId: input.targetThreadId };
        }
        return yield* forkIntoWorktree(input, input.workspace);
      }).pipe(Effect.scoped),
    );
  });

  return ThreadForkWorkspaceService.of({ fork });
});

export const layer = Layer.effect(ThreadForkWorkspaceService, make);
