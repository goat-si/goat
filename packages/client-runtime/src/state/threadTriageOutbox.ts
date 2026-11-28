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
          if (!sameEntries(registry.get(entriesAtom), entries)) {
            registry.set(entriesAtom, entries);
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
        ).pipe(Effect.ignore);

  const forgetSupersededEffect = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    succeeded: PendingThreadTriage["action"]["type"],
  ) =>
    update(registry, (stored) => {
      const kept = stored.filter(
        (entry) =>
          entry.environmentId !== environmentId ||
          entry.threadId !== threadId ||
          !supersedesAction(succeeded, entry.action.type),
      );
      return kept.length === stored.length ? stored : kept;
    }).pipe(Effect.ignore);

  const isCompensatingAction = (action: PendingThreadTriage["action"]) =>
    action.type === "unsettle" || action.type === "unsnooze";

  // The live shell is the server's state: it wins over a change made against an older one.
  const replay = Effect.fn("ThreadTriageOutbox.replay")(function* (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
  ) {
    while (registry.get(input.shellStatusAtom(environmentId)) === "live") {
      let hadTransientFailure = false;
      for (const entry of yield* read(registry)) {
        if (entry.environmentId !== environmentId) continue;
        const transient = yield* threadLock(environmentId, entry.threadId).withPermit(
          Effect.gen(function* () {
            // Read again under the per-thread lock: undo or another tab may have cancelled or
            // replaced this entry while an earlier change was being sent.
            const stored = yield* read(registry);
            const currentIndex = stored.findIndex(
              (candidate) => candidate.commandId === entry.commandId,
            );
            const current = currentIndex === -1 ? undefined : stored[currentIndex];
            if (current === undefined) return false;
            // A follow-up action queued behind a compensating undo waits until that undo finishes.
            const blockedByCompensation = stored.some(
              (candidate, index) =>
                index < currentIndex &&
                candidate.environmentId === environmentId &&
                candidate.threadId === current.threadId &&
                isCompensatingAction(candidate.action),
            );
            if (blockedByCompensation) return true;
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
              if (sent._tag === "Failure" && isTransient(sent.cause)) return true;
            }
            yield* forgetEffect(registry, current.commandId);
            return false;
          }),
        );
        if (transient) hadTransientFailure = true;
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
  function queueWhenOffline<I extends { readonly threadId: ThreadId }, CE>(
    command: AtomCommand<Target<I>, { readonly sequence: number }, CE>,
    toAction: (input: I) => PendingThreadTriage["action"],
  ): AtomCommand<Target<I>, { readonly sequence: number }, CE | E> {
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
              const result = yield* Effect.promise(() => command.run(registry, target));
              if (result._tag === "Success") {
                // Only clear entries this action actually supersedes; unrelated compensations stay.
                yield* forgetSupersededEffect(registry, environmentId, threadId, action.type);
                return result;
              }
              if (!hasUnavailableReason(result.cause)) {
                return result;
              }
              const queuedAt = DateTime.nowUnsafe();
              if (
                snapshot == null ||
                thread === undefined ||
                input.apply(thread, action, queuedAt) === thread
              ) {
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
