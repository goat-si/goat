import {
  CommandId,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  type DisplacedPendingThreadTriage,
  type PendingThreadTriage,
  type PendingThreadTriages,
  type ThreadTriageOutboxStorageError,
  ThreadTriageOutboxStore,
} from "../platform/threadTriageOutboxStore.ts";
import { EnvironmentRpcUnavailableError, isRpcClientError } from "../rpc/client.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import { type AtomCommand, type AtomCommandResult, executeAtomQuery } from "./runtime.ts";

type Target<I> = { readonly environmentId: EnvironmentId; readonly input: I };

const isUnavailable = Schema.is(EnvironmentRpcUnavailableError);

const hasUnavailableReason = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some((reason) => Cause.isFailReason(reason) && isUnavailable(reason.error));

/** Failures that say nothing about whether the server would accept the change. */
const isTransient = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) =>
      Cause.isInterruptReason(reason) ||
      (Cause.isFailReason(reason) &&
        (isUnavailable(reason.error) || isRpcClientError(reason.error))),
  );

function workSeenState(thread: OrchestrationV2ThreadShell) {
  return JSON.stringify([
    thread.latestRunId,
    thread.status,
    thread.itemCount,
    thread.pendingRuntimeRequest?.id ?? null,
  ]);
}

/**
 * What the user acted on: the thread's work and every triage decision with its time. A rename,
 * tag change or visit is left out, so it does not drop the queued change.
 */
function seenState(thread: OrchestrationV2ThreadShell) {
  return JSON.stringify([
    thread.latestRunId,
    thread.status,
    thread.itemCount,
    thread.pendingRuntimeRequest?.id ?? null,
    thread.settledOverride,
    ...[
      thread.settledAt,
      thread.unsettledAt,
      thread.snoozedUntil,
      thread.snoozedAt,
      thread.pinnedAt,
    ].map((time) => (time == null ? null : DateTime.toEpochMillis(time))),
  ]);
}

const sameEntries = (a: PendingThreadTriages, b: PendingThreadTriages) =>
  a.length === b.length && a.every((entry, index) => entry.commandId === b[index]?.commandId);

/**
 * Settle and snooze for an environment that is not connected: the change is stored on the
 * device, shown at once, and sent when the environment's shell is synchronized again.
 */
export function createThreadTriageOutbox<R, E>(input: {
  readonly runtime: Atom.AtomRuntime<SecureRandom.SecureRandom | R, E>;
  readonly sourceSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
  readonly shellStatusAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellStatus>;
  /** When false (e.g. a surface without shell status wiring), offline queueing is disabled. */
  readonly enabled?: boolean;
  /** Returns the thread itself when the action cannot apply to it. */
  readonly apply: (
    thread: OrchestrationV2ThreadShell,
    action: PendingThreadTriage["action"],
    queuedAt: DateTime.Utc,
  ) => OrchestrationV2ThreadShell;
  /** Sends the action under its command id, which the server answers only once. */
  readonly send: (
    registry: AtomRegistry.AtomRegistry,
    entry: PendingThreadTriage,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
}) {
  const enabled = input.enabled ?? true;
  const emptyPendingAtom = Atom.make(new Set<ThreadId>() as ReadonlySet<ThreadId>).pipe(
    Atom.keepAlive,
  );
  const entriesAtom = Atom.make<PendingThreadTriages>([]).pipe(Atom.keepAlive);
  // Command IDs already superseded by a live server write whose storage cleanup has not finished.
  const supersededCommandIds = new Set<CommandId>();
  // Write-ahead replacement IDs already definitively rejected whose restore write has not finished.
  const rejectedReplacementIds = new Set<CommandId>();
  const flattenDisplaced = (
    entries: ReadonlyArray<PendingThreadTriage>,
  ): ReadonlyArray<DisplacedPendingThreadTriage> =>
    entries.flatMap((entry) => {
      if (entry.displaced !== undefined && entry.displaced.length > 0) {
        return entry.displaced;
      }
      const { displaced: _displaced, ...rest } = entry;
      return [rest];
    });
  // Storage is shared with other tabs, so memory takes each result in the order storage gave it.
  const order = Semaphore.makeUnsafe(1);
  // Per-thread lock serializing replay check+send against queue persistence and cancel/undo.
  const threadLocks = new Map<string, Semaphore.Semaphore>();
  const threadLock = (environmentId: EnvironmentId, threadId: ThreadId) => {
    const key = `${environmentId}\0${threadId}`;
    let lock = threadLocks.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      threadLocks.set(key, lock);
    }
    return lock;
  };
  const replayGenerationAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive),
  );
  const triggerReplayIfLive = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
  ) => {
    if (registry.get(input.shellStatusAtom(environmentId)) === "live") {
      registry.update(replayGenerationAtom(environmentId), (generation) => generation + 1);
    }
  };
  const update = Effect.fn("ThreadTriageOutbox.update")(function* (
    registry: AtomRegistry.AtomRegistry,
    change: (stored: PendingThreadTriages) => PendingThreadTriages,
  ) {
    const store = yield* ThreadTriageOutboxStore;
    return yield* store.update(change).pipe(
      Effect.tap((entries) =>
        Effect.sync(() => {
          const visible =
            supersededCommandIds.size === 0
              ? entries
              : entries.filter((entry) => !supersededCommandIds.has(entry.commandId));
          if (!sameEntries(registry.get(entriesAtom), visible)) {
            registry.set(entriesAtom, visible);
          }
        }),
      ),
      order.withPermit,
    );
  });
  const read = (registry: AtomRegistry.AtomRegistry) => update(registry, (stored) => stored);

  const runInRuntime = <A, EA>(
    registry: AtomRegistry.AtomRegistry,
    label: string,
    effect: Effect.Effect<A, EA, SecureRandom.SecureRandom | R>,
  ): Promise<AtomCommandResult<A, EA | E>> => {
    const atom = input.runtime.atom(effect).pipe(Atom.withLabel(label));
    return executeAtomQuery(registry, atom, { reportDefect: false, reportFailure: false });
  };

  const supersedesAction = (
    succeeded: PendingThreadTriage["action"]["type"],
    queued: PendingThreadTriage["action"]["type"],
  ) => {
    switch (succeeded) {
      case "settle":
        // Settling clears snooze on the server too, so it supersedes any queued triage entry.
        return true;
      case "snooze":
      case "unsnooze":
        return queued === "snooze" || queued === "unsnooze";
      case "unsettle":
        return queued === "settle" || queued === "unsettle";
    }
  };

  /** Never fails: a change that stays stored is judged again on the next synchronized shell. */
  const forgetEffect = (registry: AtomRegistry.AtomRegistry, commandId: CommandId | undefined) =>
    commandId === undefined
      ? Effect.void
      : update(registry, (stored) =>
          stored.some((entry) => entry.commandId === commandId)
            ? stored.filter((entry) => entry.commandId !== commandId)
            : stored,
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              supersededCommandIds.delete(commandId);
            }),
          ),
          Effect.ignore,
        );

  const forgetSupersededEffect = Effect.fn("ThreadTriageOutbox.forgetSuperseded")(function* (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    succeeded: PendingThreadTriage["action"]["type"],
  ) {
    const isSuperseded = (entry: PendingThreadTriage) =>
      entry.environmentId === environmentId &&
      entry.threadId === threadId &&
      supersedesAction(succeeded, entry.action.type);
    const markedIds: CommandId[] = [];
    for (const entry of registry.get(entriesAtom)) {
      if (isSuperseded(entry)) {
        supersededCommandIds.add(entry.commandId);
        markedIds.push(entry.commandId);
      }
    }
    if (markedIds.length > 0) {
      registry.update(entriesAtom, (current) =>
        current.filter((entry) => !supersededCommandIds.has(entry.commandId)),
      );
    }
    yield* update(registry, (stored) => {
      const kept: PendingThreadTriage[] = [];
      let changed = false;
      for (const entry of stored) {
        if (isSuperseded(entry) || supersededCommandIds.has(entry.commandId)) {
          supersededCommandIds.add(entry.commandId);
          markedIds.push(entry.commandId);
          changed = true;
          continue;
        }
        kept.push(entry);
      }
      return changed ? kept : stored;
    });
    for (const id of markedIds) {
      supersededCommandIds.delete(id);
      rejectedReplacementIds.delete(id);
    }
  });

  const restoreDisplacedEffect = Effect.fn("ThreadTriageOutbox.restoreDisplaced")(function* (
    registry: AtomRegistry.AtomRegistry,
    commandId: CommandId,
  ) {
    let restored = false;
    yield* update(registry, (stored) => {
      const index = stored.findIndex((entry) => entry.commandId === commandId);
      const target = stored[index];
      if (target === undefined) return stored;
      const displaced = target.displaced ?? [];
      restored = displaced.length > 0;
      return [...stored.slice(0, index), ...displaced, ...stored.slice(index + 1)];
    });
    rejectedReplacementIds.delete(commandId);
    return restored;
  });

  const isCompensatingAction = (action: PendingThreadTriage["action"]) =>
    action.type === "unsettle" || action.type === "unsnooze";

  // The live shell is the server's state: it wins over a change made against an older one.
  const replay = Effect.fn("ThreadTriageOutbox.replay")(function* (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
  ) {
    while (registry.get(input.shellStatusAtom(environmentId)) === "live") {
      let hadTransientFailure = false;
      let restoredDisplaced = false;
      for (const entry of yield* read(registry)) {
        if (entry.environmentId !== environmentId) continue;
        const step = yield* threadLock(environmentId, entry.threadId).withPermit(
          Effect.gen(function* () {
            // Read again under the per-thread lock: undo or another tab may have cancelled or
            // replaced this entry while an earlier change was being sent.
            const stored = yield* read(registry);
            const currentIndex = stored.findIndex(
              (candidate) => candidate.commandId === entry.commandId,
            );
            const current = currentIndex === -1 ? undefined : stored[currentIndex];
            if (current === undefined) return "done" as const;
            if (supersededCommandIds.has(current.commandId)) {
              yield* forgetEffect(registry, current.commandId);
              return "done" as const;
            }
            if (rejectedReplacementIds.has(current.commandId)) {
              const restored = yield* restoreDisplacedEffect(registry, current.commandId).pipe(
                Effect.exit,
              );
              if (restored._tag === "Failure") return "transient" as const;
              return restored.value ? ("restored" as const) : ("done" as const);
            }
            // A follow-up action queued behind a compensating undo waits until that undo finishes.
            const blockedByCompensation = stored.some(
              (candidate, index) =>
                index < currentIndex &&
                candidate.environmentId === environmentId &&
                candidate.threadId === current.threadId &&
                isCompensatingAction(candidate.action),
            );
            if (blockedByCompensation) return "transient" as const;
            const thread = registry
              .get(input.sourceSnapshotAtom(environmentId))
              ?.threads.find((candidate) => candidate.id === current.threadId);
            const seenMatches = isCompensatingAction(current.action)
              ? true
              : current.afterCompensation === true
                ? thread !== undefined && workSeenState(thread) === current.seen
                : thread !== undefined && seenState(thread) === current.seen;
            const matchesThread =
              thread !== undefined &&
              seenMatches &&
              input.apply(thread, current.action, DateTime.nowUnsafe()) !== thread;
            if (matchesThread) {
              // Mark attempted in storage before sending so an offline undo after a lost reply
              // knows the server may have committed this action and queues a compensating undo.
              if (!isCompensatingAction(current.action) && current.attempted !== true) {
                yield* update(registry, (list) =>
                  list.map((item) =>
                    item.commandId === current.commandId
                      ? { ...item, attempted: true as const }
                      : item,
                  ),
                );
              }
              const sent = yield* Effect.promise(() => input.send(registry, current));
              if (sent._tag === "Failure") {
                if (isTransient(sent.cause)) return "transient" as const;
                if (current.displaced !== undefined && current.displaced.length > 0) {
                  rejectedReplacementIds.add(current.commandId);
                  const restored = yield* restoreDisplacedEffect(registry, current.commandId).pipe(
                    Effect.exit,
                  );
                  if (restored._tag === "Failure") return "transient" as const;
                  return restored.value ? ("restored" as const) : ("done" as const);
                }
              }
            } else if (
              seenMatches &&
              current.displaced !== undefined &&
              current.displaced.length > 0
            ) {
              rejectedReplacementIds.add(current.commandId);
              const restored = yield* restoreDisplacedEffect(registry, current.commandId).pipe(
                Effect.exit,
              );
              if (restored._tag === "Failure") return "transient" as const;
              return restored.value ? ("restored" as const) : ("done" as const);
            }
            yield* forgetEffect(registry, current.commandId);
            return "done" as const;
          }),
        );
        if (step === "transient") hadTransientFailure = true;
        if (step === "restored") restoredDisplaced = true;
      }
      if (restoredDisplaced && registry.get(input.shellStatusAtom(environmentId)) === "live") {
        continue;
      }
      if (!hadTransientFailure || registry.get(input.shellStatusAtom(environmentId)) !== "live") {
        break;
      }
      // Retry transiently failed entries while the shell stays live; interrupted automatically if
      // the shell leaves "live" or another queue event bumps replayGenerationAtom.
      yield* Effect.sleep("2 seconds");
    }
  });
  // Rebuilt on each shell status or live-queue bump, which stops a replay when the shell is no
  // longer synchronized and keeps one replay per environment. Any other status only loads storage.
  const syncAtom = Atom.family((environmentId: EnvironmentId) =>
    input.runtime.atom((get) => {
      get(replayGenerationAtom(environmentId));
      return get(input.shellStatusAtom(environmentId)) === "live"
        ? replay(get.registry, environmentId)
        : Effect.asVoid(read(get.registry));
    }),
  );
  const environmentEntriesAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      get.mount(syncAtom(environmentId));
      return get(entriesAtom).filter((entry) => entry.environmentId === environmentId);
    }),
  );

  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    enabled
      ? Atom.make((get) => {
          const snapshot = get(input.sourceSnapshotAtom(environmentId));
          const entries = get(environmentEntriesAtom(environmentId));
          if (snapshot === null || entries.length === 0) return snapshot;
          const byThread = new Map<ThreadId, PendingThreadTriage[]>();
          for (const entry of entries) {
            const list = byThread.get(entry.threadId);
            if (list) list.push(entry);
            else byThread.set(entry.threadId, [entry]);
          }
          return {
            ...snapshot,
            threads: snapshot.threads.map((thread) => {
              const threadEntries = byThread.get(thread.id);
              return threadEntries === undefined
                ? thread
                : threadEntries.reduce(
                    (current, entry) => input.apply(current, entry.action, entry.queuedAt),
                    thread,
                  );
            }),
          };
        })
      : input.sourceSnapshotAtom(environmentId),
  );

  const pendingSyncAtom = Atom.family((environmentId: EnvironmentId) =>
    enabled
      ? Atom.make(
          (get): ReadonlySet<ThreadId> =>
            new Set(get(environmentEntriesAtom(environmentId)).map((entry) => entry.threadId)),
        )
      : emptyPendingAtom,
  );

  const queue = Effect.fn("ThreadTriageOutbox.queue")(function* (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    thread: OrchestrationV2ThreadShell,
    action: PendingThreadTriage["action"],
    queuedAt: DateTime.Utc,
  ) {
    const random = yield* SecureRandom.SecureRandom;
    const commandId = CommandId.make(yield* random.uuidV4());
    const stored = yield* update(registry, (current) => {
      const sameThread = (entry: PendingThreadTriage) =>
        entry.environmentId === environmentId && entry.threadId === thread.id;
      const existing = current.filter(sameThread);
      const existingRegular = existing.filter((entry) => !isCompensatingAction(entry.action));
      // A snooze cannot replace a queued settle, which online it keeps.
      if (
        action.type === "snooze" &&
        existingRegular.some((entry) => entry.action.type === "settle")
      ) {
        return current;
      }
      // Keep any compensating undo ahead of a later non-canceling action so reconnect applies both.
      const keptCompensations = existing.filter(
        (entry) =>
          isCompensatingAction(entry.action) &&
          !(action.type === "settle" && entry.action.type === "unsettle") &&
          !(action.type === "snooze" && entry.action.type === "unsnooze"),
      );
      const nextEntry: PendingThreadTriage =
        keptCompensations.length > 0
          ? {
              environmentId,
              threadId: thread.id,
              commandId,
              action,
              queuedAt,
              seen: workSeenState(thread),
              afterCompensation: true,
            }
          : {
              environmentId,
              threadId: thread.id,
              commandId,
              action,
              queuedAt,
              seen: seenState(thread),
            };
      return [...current.filter((entry) => !sameThread(entry)), ...keptCompensations, nextEntry];
    });
    return stored.some((entry) => entry.commandId === commandId);
  });

  /** Queues the action on the device when its environment is not connected. */
  function queueWhenOffline<
    I extends { readonly threadId: ThreadId; readonly commandId?: CommandId },
    CE,
  >(
    command: AtomCommand<Target<I>, { readonly sequence: number }, CE>,
    toAction: (input: I) => PendingThreadTriage["action"],
  ): AtomCommand<
    Target<I>,
    { readonly sequence: number },
    CE | ThreadTriageOutboxStorageError | E
  > {
    if (!enabled) return command;
    return {
      label: command.label,
      run: async (registry, target) => {
        const { environmentId } = target;
        const { threadId } = target.input;
        const action = toAction(target.input);
        const outcome = await runInRuntime(
          registry,
          "thread-triage-outbox:queue",
          threadLock(environmentId, threadId).withPermit(
            Effect.gen(function* () {
              // Read before sending: the change is judged against what the user saw when acting.
              const snapshot = registry.get(input.sourceSnapshotAtom(environmentId));
              const thread = snapshot?.threads.find((candidate) => candidate.id === threadId);
              const queuedAt = DateTime.nowUnsafe();
              const applicable =
                snapshot != null &&
                thread !== undefined &&
                input.apply(thread, action, queuedAt) !== thread;
              const isSupersededEntry = (entry: PendingThreadTriage) =>
                entry.environmentId === environmentId &&
                entry.threadId === threadId &&
                supersedesAction(action.type, entry.action.type);
              const needsWriteAheadSwap = (entry: PendingThreadTriage) =>
                isSupersededEntry(entry) &&
                (isCompensatingAction(entry.action) || (entry.displaced?.length ?? 0) > 0);
              // Atomically replace any superseded compensating undo (and every other superseded
              // entry in its thread queue) with the new write-ahead intent BEFORE sending,
              // persisting the displaced entries alongside it so definitive rejection—live, during
              // replay, or after a crash/restart—restores the full displaced queue in order.
              let writeAheadEntry: PendingThreadTriage | undefined;
              const replacedIds: CommandId[] = [];
              if (applicable) {
                const random = yield* SecureRandom.SecureRandom;
                const replacementId =
                  target.input.commandId ?? CommandId.make(yield* random.uuidV4());
                yield* update(registry, (stored) => {
                  if (!stored.some(needsWriteAheadSwap)) return stored;
                  const displacedEntries = stored.filter(isSupersededEntry);
                  const displaced = flattenDisplaced(displacedEntries);
                  replacedIds.push(...displacedEntries.map((entry) => entry.commandId));
                  writeAheadEntry = {
                    environmentId,
                    threadId,
                    commandId: replacementId,
                    action,
                    queuedAt,
                    seen: workSeenState(thread),
                    attempted: true,
                    afterCompensation: true,
                    displaced,
                  };
                  return [...stored.filter((entry) => !isSupersededEntry(entry)), writeAheadEntry];
                });
                for (const id of replacedIds) rejectedReplacementIds.delete(id);
              }
              const sendTarget: Target<I> =
                writeAheadEntry === undefined
                  ? target
                  : {
                      ...target,
                      input: { ...target.input, commandId: writeAheadEntry.commandId },
                    };
              const result = yield* Effect.promise(() => command.run(registry, sendTarget));
              if (result._tag === "Success") {
                // Only clear entries this action actually supersedes; unrelated compensations stay.
                yield* forgetSupersededEffect(registry, environmentId, threadId, action.type);
                return result;
              }
              if (writeAheadEntry !== undefined) {
                const persistedId = writeAheadEntry.commandId;
                if (hasUnavailableReason(result.cause) || isTransient(result.cause)) {
                  // Replacement intent (with its displaced entries) is already durably persisted.
                  triggerReplayIfLive(registry, environmentId);
                  return AsyncResult.success({ sequence: snapshot?.snapshotSequence ?? 0 });
                }
                // Definitive server rejection: atomically restore all displaced entries in order.
                rejectedReplacementIds.add(persistedId);
                const restored = yield* restoreDisplacedEffect(registry, persistedId).pipe(
                  Effect.exit,
                );
                if (restored._tag === "Success") {
                  if (restored.value) {
                    triggerReplayIfLive(registry, environmentId);
                  }
                  return result;
                }
                // Restore write failed transiently; keep writeAheadEntry (with displaced) on disk
                // and let replay retry the restore without re-sending the rejected replacement.
                triggerReplayIfLive(registry, environmentId);
                return AsyncResult.failure(restored.cause);
              }
              if (!hasUnavailableReason(result.cause) || !applicable) {
                return result;
              }
              const stored = yield* queue(registry, environmentId, thread, action, queuedAt).pipe(
                Effect.exit,
              );
              if (stored._tag === "Success" && stored.value) {
                triggerReplayIfLive(registry, environmentId);
                return AsyncResult.success({ sequence: snapshot.snapshotSequence });
              }
              return result;
            }),
          ),
        );
        return outcome._tag === "Success" ? outcome.value : AsyncResult.failure(outcome.cause);
      },
    };
  }

  /**
   * Removes a queued change from storage first. Offline this returns `cancelledOnDevice`, unless
   * replay already attempted the change — in which case a compensating undo atomically replaces it.
   */
  function cancelQueued<I extends { readonly threadId: ThreadId }, CE>(
    command: AtomCommand<Target<I>, { readonly sequence: number }, CE>,
    cancels: "settle" | "snooze",
    toCompensate: (
      input: I,
    ) => Extract<PendingThreadTriage["action"], { readonly type: "unsettle" | "unsnooze" }>,
  ): AtomCommand<
    Target<I>,
    { readonly sequence: number; readonly cancelledOnDevice?: true },
    CE | ThreadTriageOutboxStorageError | E
  > {
    if (!enabled) return command;
    const cancelled = { sequence: 0, cancelledOnDevice: true } as const;
    return {
      label: command.label,
      run: async (registry, target) => {
        const { environmentId } = target;
        const { threadId } = target.input;
        const outcome = await runInRuntime(
          registry,
          "thread-triage-outbox:cancel",
          threadLock(environmentId, threadId).withPermit(
            Effect.gen(function* () {
              const random = yield* SecureRandom.SecureRandom;
              const compensationId = CommandId.make(yield* random.uuidV4());
              const liveBefore = registry.get(input.shellStatusAtom(environmentId)) === "live";
              let removedUnattempted = false;
              let replacedWithCompensation = false;
              let deferredAttemptedId: CommandId | undefined;
              const makeCompensation = (): PendingThreadTriage => ({
                environmentId,
                threadId,
                commandId: compensationId,
                action: toCompensate(target.input),
                queuedAt: DateTime.nowUnsafe(),
                seen: "",
              });
              // Single atomic storage update: an attempted entry is replaced in place when offline,
              // or retained until the live reverse command succeeds or falls back to compensation.
              yield* update(registry, (stored) => {
                let changed = false;
                const next: PendingThreadTriage[] = [];
                for (const entry of stored) {
                  if (
                    entry.environmentId === environmentId &&
                    entry.threadId === threadId &&
                    entry.action.type === cancels
                  ) {
                    if (entry.attempted === true) {
                      if (!liveBefore) {
                        next.push(makeCompensation());
                        replacedWithCompensation = true;
                        changed = true;
                      } else {
                        deferredAttemptedId = entry.commandId;
                        next.push(entry);
                      }
                    } else {
                      removedUnattempted = true;
                      changed = true;
                    }
                    continue;
                  }
                  next.push(entry);
                }
                return changed ? next : stored;
              });
              if (replacedWithCompensation) {
                triggerReplayIfLive(registry, environmentId);
                const snapshot = registry.get(input.sourceSnapshotAtom(environmentId));
                return AsyncResult.success({ sequence: snapshot?.snapshotSequence ?? 0 });
              }
              const liveAfter = registry.get(input.shellStatusAtom(environmentId)) === "live";
              if (removedUnattempted && !liveAfter) {
                return AsyncResult.success(cancelled);
              }
              const result = yield* Effect.promise(() => command.run(registry, target));
              if (result._tag === "Success") {
                const reverseType = cancels === "settle" ? "unsettle" : "unsnooze";
                yield* forgetSupersededEffect(registry, environmentId, threadId, reverseType);
                return result;
              }
              if (hasUnavailableReason(result.cause)) {
                if (deferredAttemptedId !== undefined) {
                  const targetId = deferredAttemptedId;
                  yield* update(registry, (stored) =>
                    stored.map((entry) =>
                      entry.commandId === targetId ? makeCompensation() : entry,
                    ),
                  );
                  triggerReplayIfLive(registry, environmentId);
                  const snapshot = registry.get(input.sourceSnapshotAtom(environmentId));
                  return AsyncResult.success({ sequence: snapshot?.snapshotSequence ?? 0 });
                }
                if (removedUnattempted) {
                  return AsyncResult.success(cancelled);
                }
              }
              return result;
            }),
          ),
        );
        return outcome._tag === "Success" ? outcome.value : AsyncResult.failure(outcome.cause);
      },
    };
  }

  return { snapshotAtom, pendingSyncAtom, queueWhenOffline, cancelQueued };
}
