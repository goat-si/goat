import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  type ModelSelection,
  type ThreadId,
} from "@goat/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import {
  WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";

import { createOptimisticThreadLifecycle } from "./threadLifecycle.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import { createThreadTriageOutbox } from "./threadTriageOutbox.ts";
import * as DateTime from "effect/DateTime";

import {
  type AtomCommand,
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  mapAtomCommandResult,
} from "./runtime.ts";
import { environmentConnectionAtoms } from "./environmentConnections.ts";
import { waitForTitleRegenerationOutcome } from "./threadTitleRegeneration.ts";
import {
  type ArchiveThreadInput,
  type CancelQueuedRunInput,
  type RetryWorkspacePreparationInput,
  type CreateThreadInput,
  type DeleteThreadInput,
  type EditQueuedRunInput,
  type InterruptThreadTurnInput,
  type MarkThreadUnreadInput,
  type ForkThreadFromRunInput,
  type ForkThreadAsSideChatInput,
  type MergeThreadBackInput,
  type PromoteQueuedRunInput,
  type ReorderQueuedRunInput,
  type ResumeThreadQueueInput,
  type LinkThreadPullRequestInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type DismissThreadUserInputInput,
  type RevertThreadCheckpointInput,
  type SetThreadInteractionModeInput,
  type SetThreadRuntimeModeInput,
  type PinThreadInput,
  type PromoteThreadInput,
  type ReorderPinnedThreadInput,
  type ReorderActiveThreadInput,
  type SetThreadAutoSettleInput,
  type SettleThreadInput,
  type SnoozeThreadInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type UnarchiveThreadInput,
  type CloseGuestShareInput,
  type ResolveGuestMessageInput,
  type UnlinkThreadPullRequestInput,
  type UnpinThreadInput,
  type WatchThreadPullRequestInput,
  type UnsettleThreadInput,
  type UnsnoozeThreadInput,
  type UpdateThreadMetadataInput,
  type VisitThreadInput,
  archiveThread,
  closeGuestShare,
  resolveGuestMessage,
  cancelQueuedRun,
  createThread,
  deleteThread,
  promoteThread,
  editQueuedRun,
  interruptThreadTurn,
  forkThreadFromRun,
  forkThreadAsSideChat,
  markThreadUnread,
  mergeThreadBack,
  promoteQueuedRun,
  reorderQueuedRun,
  resumeThreadQueue,
  retryWorkspacePreparation,
  linkThreadPullRequest,
  respondToThreadApproval,
  respondToThreadUserInput,
  dismissThreadUserInput,
  revertThreadCheckpoint,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  pinThread,
  reorderPinnedThread,
  reorderActiveThread,
  setThreadAutoSettle,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unlinkThreadPullRequest,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMetadata,
  visitThread,
  watchThreadPullRequest,
} from "../operations/commands.ts";
import { forkThread } from "../operations/forkThread.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";

export type LoadEarlierThreadHistoryInput = {
  readonly threadId: ThreadId;
  readonly throughEntryId?: string;
  readonly workAnchorId?: string;
};

export type {
  ArchiveThreadInput,
  CancelQueuedRunInput,
  CreateThreadInput,
  DeleteThreadInput,
  EditQueuedRunInput,
  InterruptThreadTurnInput,
  MarkThreadUnreadInput,
  ForkThreadFromRunInput,
  ForkThreadAsSideChatInput,
  MergeThreadBackInput,
  PromoteQueuedRunInput,
  ReorderQueuedRunInput,
  LinkThreadPullRequestInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  DismissThreadUserInputInput,
  RetryWorkspacePreparationInput,
  RevertThreadCheckpointInput,
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  PinThreadInput,
  PromoteThreadInput,
  ReorderPinnedThreadInput,
  ReorderActiveThreadInput,
  SetThreadAutoSettleInput,
  SettleThreadInput,
  SnoozeThreadInput,
  StartThreadTurnInput,
  StopThreadSessionInput,
  ThreadCommandInput,
  UnarchiveThreadInput,
  UnlinkThreadPullRequestInput,
  UnpinThreadInput,
  UnsettleThreadInput,
  UnsnoozeThreadInput,
  UpdateThreadMetadataInput,
  VisitThreadInput,
  WatchThreadPullRequestInput,
} from "../operations/commands.ts";

const EMPTY_PENDING_SYNC_ATOM = Atom.make<ReadonlySet<ThreadId>>(new Set());

function applySettle(
  thread: OrchestrationV2ThreadShell,
  now: DateTime.Utc,
  accepted: boolean,
): OrchestrationV2ThreadShell {
  return !accepted &&
    (thread.pendingRuntimeRequest !== null ||
      ["preparing", "queued", "starting", "running", "waiting"].includes(thread.status))
    ? thread
    : {
        ...thread,
        pendingRuntimeRequest: null,
        settledOverride: "settled",
        settledAt: thread.settledOverride === "settled" ? (thread.settledAt ?? now) : now,
        unsettledAt: null,
        activeOrderKey: null,
        pinnedAt: null,
        pinOrderKey: null,
        snoozedAt: null,
        snoozedUntil: null,
      };
}

function applySnooze(
  thread: OrchestrationV2ThreadShell,
  snoozedUntil: string,
  now: DateTime.Utc,
  accepted: boolean,
): OrchestrationV2ThreadShell {
  return (!accepted &&
    ((thread.pendingRuntimeRequest !== null &&
      thread.pendingRuntimeRequest.kind !== "user_input") ||
      ["preparing", "queued", "starting"].includes(thread.status))) ||
    !(Date.parse(snoozedUntil) > DateTime.toEpochMillis(now))
    ? thread
    : {
        ...thread,
        snoozedUntil: DateTime.makeUnsafe(snoozedUntil),
        snoozedAt: now,
      };
}

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom.SecureRandom | R, E>,
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
  /** Offline settle and snooze are sent once this reports a synchronized shell. */
  shellStatusAtom?: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellStatus>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  const loadEarlierHistory = Effect.fn("ThreadCommands.loadEarlierHistory")(function* (
    input: LoadEarlierThreadHistoryInput,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const controller = yield* Effect.serviceOption(ThreadHistoryController.ThreadHistoryController);
    if (Option.isNone(controller)) {
      return {
        _tag: "noop",
      } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    }
    return yield* controller.value.loadEarlier(
      supervisor.target.environmentId,
      input.threadId,
      input.throughEntryId,
      input.workAnchorId,
    );
  });

  // Runs whether or not the server accepted the interrupt, so a stale cached item still
  // settles when Stop had nothing to interrupt; the interrupt's own failure still surfaces.
  // The repair is detached: its lookups must not hold the thread's serial command key, and
  // closing the thread cancels the repair, not the Stop that triggered it.
  const interruptTurn = Effect.fn("ThreadCommands.interruptTurn")(function* (
    input: InterruptThreadTurnInput,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const controller = yield* Effect.serviceOption(ThreadHistoryController.ThreadHistoryController);
    return yield* interruptThreadTurn(input).pipe(
      Effect.ensuring(
        Option.match(controller, {
          onNone: () => Effect.void,
          onSome: (value) =>
            value
              .reconcilePendingWork(supervisor.target.environmentId, input.threadId)
              .pipe(Effect.forkDetach, Effect.asVoid),
        }),
      ),
    );
  });

  const armTitleRegeneration = Effect.fn("ThreadCommands.armTitleRegeneration")(function* (input: {
    readonly threadId: ThreadId;
  }) {
    const random = yield* SecureRandom.SecureRandom;
    const requestId = CommandId.make(yield* random.uuidV4());
    const result = yield* updateThreadMetadata({
      threadId: input.threadId,
      regenerateTitle: true,
      commandId: requestId,
    });
    return { requestId, sequence: result.sequence };
  });

  // Counts the commands that move or remove a thread's row. A list that holds its rows while
  // environments synchronize (`stepSteadyShells`) shows the user's own change at once.
  const rowActionsAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive),
  );
  const rowAction = <W extends { readonly environmentId: EnvironmentId }, A, E>(
    command: AtomCommand<W, A, E>,
  ): AtomCommand<W, A, E> => ({
    label: command.label,
    run: (registry, target) => {
      registry.update(rowActionsAtom(target.environmentId), (count) => count + 1);
      return command.run(registry, target);
    },
  });

  const sent = {
    armTitleRegeneration: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:regenerate-title",
      execute: armTitleRegeneration,
      scheduler,
      concurrency,
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: (input: CreateThreadInput) => createThread(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: (input: DeleteThreadInput) => deleteThread(input),
      scheduler,
      concurrency,
    }),
    closeGuestShare: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:close-guest-share",
      execute: (input: CloseGuestShareInput) => closeGuestShare(input),
      scheduler,
      concurrency,
    }),
    resolveGuestMessage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:resolve-guest-message",
      execute: (input: ResolveGuestMessageInput) => resolveGuestMessage(input),
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: (input: ArchiveThreadInput) => archiveThread(input),
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: (input: UnarchiveThreadInput) => unarchiveThread(input),
      scheduler,
      concurrency,
    }),
    promote: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:promote",
      execute: (input: PromoteThreadInput) => promoteThread(input),
      scheduler,
      concurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: (input: SettleThreadInput) => settleThread(input),
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: (input: UnsettleThreadInput) => unsettleThread(input),
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: (input: SnoozeThreadInput) => snoozeThread(input),
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: (input: UnsnoozeThreadInput) => unsnoozeThread(input),
      scheduler,
      concurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:pin",
      execute: (input: PinThreadInput) => pinThread(input),
      scheduler,
      concurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unpin",
      execute: (input: UnpinThreadInput) => unpinThread(input),
      scheduler,
      concurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-pin",
      execute: (input: ReorderPinnedThreadInput) => reorderPinnedThread(input),
      scheduler,
      concurrency,
    }),
    setAutoSettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-auto-settle",
      execute: (input: SetThreadAutoSettleInput) => setThreadAutoSettle(input),
      scheduler,
      concurrency,
    }),
    reorderActive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-active",
      execute: (input: ReorderActiveThreadInput) => reorderActiveThread(input),
      scheduler,
      concurrency,
    }),
    visit: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:visit",
      execute: (input: VisitThreadInput) => visitThread(input),
      scheduler,
      concurrency,
    }),
    markUnread: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:mark-unread",
      execute: (input: MarkThreadUnreadInput) => markThreadUnread(input),
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: (input: UpdateThreadMetadataInput) => updateThreadMetadata(input),
      scheduler,
      concurrency,
    }),
    setModelSelection: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-model-selection",
      execute: (input: UpdateThreadMetadataInput & { readonly modelSelection: ModelSelection }) =>
        updateThreadMetadata(input),
      scheduler,
      concurrency,
    }),
    linkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:link-pull-request",
      execute: (input: LinkThreadPullRequestInput) => linkThreadPullRequest(input),
      scheduler,
      concurrency,
    }),
    unlinkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unlink-pull-request",
      execute: (input: UnlinkThreadPullRequestInput) => unlinkThreadPullRequest(input),
      scheduler,
      concurrency,
    }),
    watchPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:watch-pull-request",
      execute: (input: WatchThreadPullRequestInput) => watchThreadPullRequest(input),
      scheduler,
      concurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: (input: SetThreadRuntimeModeInput) => setThreadRuntimeMode(input),
      scheduler,
      concurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: (input: SetThreadInteractionModeInput) => setThreadInteractionMode(input),
      scheduler,
      concurrency,
    }),
    startTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      execute: (input: StartThreadTurnInput) => startThreadTurn(input),
      scheduler,
      concurrency,
    }),
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: interruptTurn,
      scheduler,
      concurrency,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: (input: RespondToThreadApprovalInput) => respondToThreadApproval(input),
      scheduler,
      concurrency,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: (input: RespondToThreadUserInputInput) => respondToThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    dismissUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:dismiss-user-input",
      execute: (input: DismissThreadUserInputInput) => dismissThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: (input: RevertThreadCheckpointInput) => revertThreadCheckpoint(input),
      scheduler,
      concurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: (input: StopThreadSessionInput) => stopThreadSession(input),
      scheduler,
      concurrency,
    }),
    forkFromRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:fork-from-run",
      execute: (input: ForkThreadFromRunInput) => forkThreadFromRun(input),
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sourceThreadId]),
      },
    }),
    forkAsSideChat: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:fork-as-side-chat",
      execute: (input: ForkThreadAsSideChatInput) => forkThreadAsSideChat(input),
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sourceThreadId]),
      },
    }),
    /** Fork into the source's checkout or a new worktree; the source environment's capability picks the route. */
    fork: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:fork",
      tag: ORCHESTRATION_V2_WS_METHODS.forkThread,
      execute: forkThread,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sourceThreadId]),
      },
    }),
    mergeBack: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:merge-back",
      execute: (input: MergeThreadBackInput) => mergeThreadBack(input),
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.sourceThreadId, input.targetThreadId]),
      },
    }),
    resumeThreadQueue: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:resume-queue",
      execute: (input: ResumeThreadQueueInput) => resumeThreadQueue(input),
      scheduler,
      concurrency,
    }),
    reorderQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-queued-run",
      execute: (input: ReorderQueuedRunInput) => reorderQueuedRun(input),
      scheduler,
      concurrency,
    }),
    promoteQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:promote-queued-run",
      execute: (input: PromoteQueuedRunInput) => promoteQueuedRun(input),
      scheduler,
      concurrency,
    }),
    cancelQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:cancel-queued-run",
      execute: (input: CancelQueuedRunInput) => cancelQueuedRun(input),
      scheduler,
      concurrency,
    }),
    retryWorkspacePreparation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:retry-workspace-preparation",
      execute: (input: RetryWorkspacePreparationInput) => retryWorkspacePreparation(input),
      scheduler,
      concurrency,
    }),
    editQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:edit-queued-run",
      execute: (input: EditQueuedRunInput) => editQueuedRun(input),
      scheduler,
      concurrency,
    }),
    loadEarlierHistory: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:load-earlier-history",
      execute: loadEarlierHistory,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          `history:${JSON.stringify([environmentId, input.threadId])}`,
      },
    }),
    uploadFeedback: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:upload-feedback",
      tag: WS_METHODS.providerUploadFeedback,
      scheduler,
      concurrency,
    }),
  };
  const commands = {
    ...sent,
    delete: rowAction(sent.delete),
    archive: rowAction(sent.archive),
    unarchive: rowAction(sent.unarchive),
    settle: rowAction(sent.settle),
    unsettle: rowAction(sent.unsettle),
    snooze: rowAction(sent.snooze),
    unsnooze: rowAction(sent.unsnooze),
    pin: rowAction(sent.pin),
    unpin: rowAction(sent.unpin),
  };
  const triage =
    shellStatusAtom !== undefined
      ? createThreadTriageOutbox({
          runtime,
          sourceSnapshotAtom: snapshotAtom,
          shellStatusAtom,
          apply: (thread, action, queuedAt) =>
            action.type === "settle"
              ? applySettle(thread, queuedAt, false)
              : applySnooze(thread, action.snoozedUntil, queuedAt, false),
          send: (registry, { environmentId, threadId, commandId, action }) =>
            action.type === "settle"
              ? settle.run(registry, { environmentId, input: { threadId, commandId } })
              : snooze.run(registry, {
                  environmentId,
                  input: { threadId, commandId, snoozedUntil: action.snoozedUntil },
                }),
        })
      : null;
  const optimistic = createOptimisticThreadLifecycle(triage?.snapshotAtom ?? snapshotAtom);
  const settle = optimistic.wrap(commands.settle, (thread, _input, now, accepted) =>
    applySettle(thread, now, accepted),
  );
  const snooze = optimistic.wrap(commands.snooze, (thread, input, now, accepted) =>
    applySnooze(thread, input.snoozedUntil, now, accepted),
  );
  const pendingSyncAtom =
    triage?.pendingSyncAtom ?? Atom.family((_environmentId: EnvironmentId) => EMPTY_PENDING_SYNC_ATOM);
  const disconnectedAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const connection = AsyncResult.getOrElse(
        get(environmentConnectionAtoms(runtime)(environmentId)),
        () => null,
      );
      return connection !== null && connectionProjectionPhase(connection[0]) === "disconnected";
    }),
  );
  // Resolves with the outcome the server recorded for this request, or null when it cannot tell.
  const regenerateTitle = {
    label: commands.armTitleRegeneration.label,
    run: async (
      registry: AtomRegistry.AtomRegistry,
      target: { readonly environmentId: EnvironmentId; readonly input: { threadId: ThreadId } },
    ) => {
      const armed = await commands.armTitleRegeneration.run(registry, target);
      const outcome =
        armed._tag === "Success"
          ? await waitForTitleRegenerationOutcome(
              registry,
              {
                snapshot: snapshotAtom(target.environmentId),
                disconnected: disconnectedAtom(target.environmentId),
              },
              { threadId: target.input.threadId, ...armed.value },
            )
          : null;
      return mapAtomCommandResult(armed, () => outcome);
    },
  };
  return {
    ...commands,
    regenerateTitle,
    rowActionsAtom,
    snapshotAtom: optimistic.snapshotAtom,
    pendingThreadIdsAtom: optimistic.pendingThreadIdsAtom,
    pendingSyncAtom,
    setModelSelection: optimistic.wrap(commands.setModelSelection, (thread, input) => ({
      ...thread,
      modelSelection: input.modelSelection,
    })),
    // Queued inside the optimistic update, so it stays shown until the queued entry replaces it.
    settle: triage
      ? optimistic.wrap(
          triage.queueWhenOffline(commands.settle, () => ({ type: "settle" as const })),
          (thread, _input, now, accepted) => applySettle(thread, now, accepted),
        )
      : settle,
    unsettle: (() => {
      const wrapped = optimistic.wrap(commands.unsettle, (thread, input, now) => ({
        ...thread,
        settledOverride: input.reason === "user" ? "active" : null,
        settledAt: null,
        unsettledAt: thread.settledOverride === "active" ? (thread.unsettledAt ?? null) : now,
      }));
      return triage ? triage.cancelQueued(wrapped, "settle") : wrapped;
    })(),
    snooze: triage
      ? optimistic.wrap(
          triage.queueWhenOffline(commands.snooze, (input) => ({
            type: "snooze" as const,
            snoozedUntil: input.snoozedUntil,
          })),
          (thread, input, now, accepted) => applySnooze(thread, input.snoozedUntil, now, accepted),
        )
      : snooze,
    unsnooze: (() => {
      const wrapped = optimistic.wrap(commands.unsnooze, (thread) => ({
        ...thread,
        snoozedUntil: null,
        snoozedAt: null,
      }));
      return triage ? triage.cancelQueued(wrapped, "snooze") : wrapped;
    })(),
    setAutoSettle: optimistic.wrap(commands.setAutoSettle, (thread, input, now) => ({
      ...thread,
      autoSettleDisabledAt: input.enabled ? null : (thread.autoSettleDisabledAt ?? now),
    })),
    pin: optimistic.wrap(commands.pin, (thread, input, now) => ({
      ...thread,
      pinnedAt: thread.pinnedAt ?? now,
      pinOrderKey: thread.pinnedAt == null ? (input.orderKey ?? null) : thread.pinOrderKey,
      ...(thread.settledOverride === "settled"
        ? {
            settledOverride: "active" as const,
            settledAt: null,
            unsettledAt: now,
          }
        : {}),
      snoozedUntil: null,
      snoozedAt: null,
    })),
    unpin: optimistic.wrap(commands.unpin, (thread) => ({
      ...thread,
      pinnedAt: null,
      pinOrderKey: null,
    })),
    reorderPin: optimistic.wrap(commands.reorderPin, (thread, input) => ({
      ...thread,
      pinOrderKey: input.orderKey,
    })),
    reorderActive: optimistic.wrap(commands.reorderActive, (thread, input) => ({
      ...thread,
      activeOrderKey: input.orderKey,
    })),
  };
}
