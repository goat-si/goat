import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

interface QueuedTurnLike {
  readonly nativeStartReady?: Deferred.Deferred<void>;
  readonly subagent: unknown;
  readonly providerThread: {
    readonly nativeThreadRef: { readonly nativeId: string | null } | null;
  };
}

/** Codex answers a queued turn without a start time and accepts turn/interrupt only once it starts. */
export const awaitingNativeStart = (context: QueuedTurnLike): boolean =>
  context.nativeStartReady !== undefined && !Deferred.isDoneUnsafe(context.nativeStartReady);

/**
 * The started root turns sharing a native thread with a stopped turn that is still queued. Codex
 * starts a queued turn only after the running one ends, so stopping it means stopping that turn.
 */
export const queueBlockers = <T extends QueuedTurnLike>(
  stopped: ReadonlyArray<T>,
  active: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const threads = new Set(
    stopped.filter(awaitingNativeStart).flatMap((context) => {
      const nativeId = context.providerThread.nativeThreadRef?.nativeId;
      return nativeId == null ? [] : [nativeId];
    }),
  );
  return active.filter(
    (context) =>
      context.subagent === null &&
      !stopped.includes(context) &&
      !awaitingNativeStart(context) &&
      threads.has(context.providerThread.nativeThreadRef?.nativeId ?? ""),
  );
};

/** Queued turns Stop settled before Codex started them, kept until Codex ends them or the thread unloads. */
export const makeStoppedQueuedTurns = (limit = 64) => {
  const turns = new Map<string, string>();
  return {
    /** False when full: the turn then stays active, so Stop fails and can be tried again. */
    add: (nativeTurnId: string, nativeThreadId: string) => {
      if (turns.size >= limit) return false;
      turns.set(nativeTurnId, nativeThreadId);
      return true;
    },
    has: (nativeTurnId: string) => turns.has(nativeTurnId),
    end: (nativeTurnId: string) => turns.delete(nativeTurnId),
    unloadThread: (nativeThreadId: string) => {
      for (const [nativeTurnId, owner] of turns)
        if (owner === nativeThreadId) turns.delete(nativeTurnId);
    },
  };
};

/**
 * Gives a queued turn 10 seconds to start, then interrupts it through Codex; one that never starts
 * is settled locally. turn/started holds the permit, so a start lands on one side of the decision.
 */
export const stopQueuedTurn = Effect.fn("CodexAdapterV2.stopQueuedTurn")(function* <
  T extends QueuedTurnLike & { readonly nativeTurnId: string },
  E,
  R,
  EF,
>(input: {
  readonly context: T;
  readonly stopped: ReturnType<typeof makeStoppedQueuedTurns>;
  readonly withPermit: <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) => Effect.Effect<A, E2, R2>;
  readonly interrupt: (context: T) => Effect.Effect<void, E, R>;
  readonly settle: Effect.Effect<unknown, never, R>;
  readonly full: Effect.Effect<never, EF>;
}) {
  const { context } = input;
  const ready = yield* Effect.timeoutOption(
    context.nativeStartReady === undefined ? Effect.void : Deferred.await(context.nativeStartReady),
    "10 seconds",
  );
  const decision = yield* input.withPermit(
    Effect.sync(() => {
      if (Option.isSome(ready) || !awaitingNativeStart(context)) return "started" as const;
      const nativeThreadId = context.providerThread.nativeThreadRef?.nativeId ?? "";
      return input.stopped.add(context.nativeTurnId, nativeThreadId)
        ? ("recorded" as const)
        : ("full" as const);
    }),
  );
  if (decision === "started") return yield* input.interrupt(context);
  if (decision === "full") return yield* input.full;
  yield* Effect.logWarning("orchestration-v2.codex-queued-turn-never-started", {
    nativeTurnId: context.nativeTurnId,
  });
  yield* input.settle;
});

/** Interrupts a stopped queued turn that started late, retrying until it is interrupted or ends. */
export const stopLateQueuedTurn = <E, R>(
  interrupt: Effect.Effect<unknown, E, R>,
  pending: () => boolean,
) =>
  interrupt.pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("orchestration-v2.codex-queued-turn-stop-failed", { cause }),
    ),
    Effect.retry({
      schedule: Schedule.concat(Schedule.recurs(2), Schedule.spaced("5 seconds")),
      while: pending,
    }),
    Effect.ignore,
  );

/** Runs every item concurrently to its end, then fails with the first failure, so none waits on another. */
export const settleEach = <A, E, R>(
  items: ReadonlyArray<A>,
  run: (item: A) => Effect.Effect<unknown, E, R>,
) =>
  Effect.forEach(items, (item) => Effect.exit(run(item)), { concurrency: "unbounded" }).pipe(
    Effect.flatMap((exits) => Effect.forEach(exits, (exit) => exit, { discard: true })),
  );
