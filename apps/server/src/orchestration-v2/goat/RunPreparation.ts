import type {
  CommandId,
  MessageId,
  OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as CommandReceiptStore from "../CommandReceiptStore.ts";
import type * as ThreadManagement from "../ThreadManagementService.ts";
import type {
  PreparationInput,
  ThreadLaunchPreparationInput,
  ThreadLaunchWorkspaceStrategy,
} from "../ThreadLaunchService.ts";

type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

/** Whether the command committed, here or in an earlier attempt; an unreadable receipt is logged. */
const commandAccepted = (
  receipts: CommandReceiptStore.CommandReceiptStoreV2["Service"],
  commandId: CommandId,
) =>
  receipts.getByCommandId(commandId).pipe(
    Effect.map((receipt) => Option.isSome(receipt) && receipt.value.status === "accepted"),
    Effect.catch((error) =>
      Effect.logWarning("Could not read a cut dispatch's receipt", {
        commandId,
        tag: error._tag,
      }).pipe(Effect.as(false)),
    ),
  );

/**
 * Runs, inside an uninterruptible region, a dispatch that leaves a run "preparing". A cut while
 * the dispatch waits (for its locks, say) stops it; once its command committed, `recover` still
 * schedules the preparation, since the region's own scheduling never runs.
 */
export const dispatchThenPrepare = <A, E, R, ER>(
  restore: Restore,
  dispatch: Effect.Effect<A, E, R>,
  committed: Effect.Effect<boolean>,
  recover: Effect.Effect<void, ER>,
) =>
  restore(dispatch).pipe(
    Effect.onInterrupt(() =>
      committed.pipe(
        Effect.flatMap((accepted) => (accepted ? recover : Effect.void)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not schedule the preparation of a cut dispatch", { cause }),
        ),
      ),
    ),
  );

/** Prepares runs that are already "preparing": a delegated child, a retry, a cut launch. */
export const makeRunPreparation = <ES>(deps: {
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly reservePreparation: (commandId: CommandId) => Effect.Effect<boolean>;
  readonly releasePreparation: (commandId: CommandId) => Effect.Effect<void>;
  readonly schedulePreparation: (
    input: PreparationInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) => Effect.Effect<void, ES>;
  readonly failPreparedRun: (
    input: Pick<PreparationInput, "commandId">,
    threadId: ThreadId,
    runId: RunId | null,
    cause: unknown,
  ) => Effect.Effect<void>;
  /** The event sink's `settled`: every commit already on the batch worker has settled. */
  readonly settled: Effect.Effect<void>;
  readonly receipts: CommandReceiptStore.CommandReceiptStoreV2["Service"];
}) => {
  const { threads, reservePreparation, releasePreparation } = deps;

  /** Whether a cut dispatch's command committed, once a commit it started on the worker settled. */
  const committed = (commandId: CommandId) =>
    deps.settled.pipe(Effect.andThen(commandAccepted(deps.receipts, commandId)));

  const scheduleRunPreparation = Effect.fn("ThreadLaunchService.scheduleRunPreparation")(function* (
    input: ThreadLaunchPreparationInput,
    thread: OrchestrationV2ThreadProjection["thread"],
    run: OrchestrationV2ThreadProjection["runs"][number],
    workspacePreparation: ThreadLaunchWorkspaceStrategy,
  ) {
    const { messages } = yield* threads.getThreadRecords(input.threadId, ["messages"], {
      messageIds: [run.userMessageId],
    });
    const message = messages.find((candidate) => candidate.id === run.userMessageId);
    const reuse =
      workspacePreparation.type === "worktree" &&
      thread.worktreePath !== null &&
      thread.branch !== null
        ? {
            strategy: {
              type: "existing_worktree" as const,
              worktreePath: thread.worktreePath,
              branch: thread.branch,
            },
            reusedWorktree: { baseRef: workspacePreparation.baseRef },
          }
        : null;
    return yield* deps.schedulePreparation(
      {
        commandId: input.commandId,
        projectId: thread.projectId,
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
  });

  const prepareRun = Effect.fn("ThreadLaunchService.prepareRun")(function* (
    input: ThreadLaunchPreparationInput,
  ) {
    const scheduled = yield* Effect.gen(function* () {
      const { thread, runs } = yield* threads.getThreadRecords(input.threadId, ["runs"], {
        runIds: [input.runId],
      });
      const run = runs.find((candidate) => candidate.id === input.runId);
      const workspacePreparation = run?.workspacePreparation;
      if (run?.status !== "preparing" || workspacePreparation === undefined) return;
      if (!(yield* reservePreparation(input.commandId))) return;
      yield* scheduleRunPreparation(input, thread, run, workspacePreparation).pipe(
        Effect.onError(() => releasePreparation(input.commandId)),
      );
    }).pipe(Effect.exit);
    if (Exit.isFailure(scheduled)) {
      yield* deps.failPreparedRun(
        input,
        input.threadId,
        input.runId,
        Cause.squash(scheduled.cause),
      );
    }
  });

  /** Prepares the run a launch's first message created, if it is still "preparing". */
  const prepareMessageRun = Effect.fn("ThreadLaunchService.prepareMessageRun")(function* (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) {
    const { runs } = yield* threads.getThreadRecords(input.threadId, ["runs"]);
    const run = runs.find((candidate) => candidate.userMessageId === input.messageId);
    if (run !== undefined) yield* prepareRun({ ...input, runId: run.id });
  });

  const retryPreparation = Effect.fn("ThreadLaunchService.retryPreparation")(
    (input: ThreadLaunchPreparationInput) =>
      Effect.uninterruptibleMask((restore) =>
        dispatchThenPrepare(
          restore,
          threads.dispatch({
            type: "prepared-run.retry",
            commandId: input.commandId,
            threadId: input.threadId,
            runId: input.runId,
          }),
          committed(input.commandId),
          prepareRun(input),
        ).pipe(Effect.tap(() => prepareRun(input))),
      ),
  );

  return { committed, prepareRun, prepareMessageRun, retryPreparation };
};
