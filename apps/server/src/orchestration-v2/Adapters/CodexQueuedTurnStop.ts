import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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

/** Queued turns Stop settled without Codex starting them; a late start is interrupted on arrival. */
export const makeStoppedQueuedTurns = (limit = 64) => {
  const turns = new Set<string>();
  return {
    add: (nativeTurnId: string) => {
      turns.add(nativeTurnId);
      for (const oldest of turns) {
        if (turns.size <= limit) break;
        turns.delete(oldest);
      }
    },
    take: (nativeTurnId: string) => turns.delete(nativeTurnId),
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
>(input: {
  readonly context: T;
  readonly stopped: ReturnType<typeof makeStoppedQueuedTurns>;
  readonly withPermit: <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) => Effect.Effect<A, E2, R2>;
  readonly interrupt: (context: T) => Effect.Effect<void, E, R>;
  readonly settle: Effect.Effect<unknown, never, R>;
}) {
  const { context } = input;
  const ready = yield* Effect.timeoutOption(
    context.nativeStartReady === undefined ? Effect.void : Deferred.await(context.nativeStartReady),
    "10 seconds",
  );
  const started = yield* input.withPermit(
    Effect.sync(() => {
      if (Option.isSome(ready) || !awaitingNativeStart(context)) return true;
      input.stopped.add(context.nativeTurnId);
      return false;
    }),
  );
  if (started) return yield* input.interrupt(context);
  yield* Effect.logWarning("orchestration-v2.codex-queued-turn-never-started", {
    nativeTurnId: context.nativeTurnId,
  });
  yield* input.settle;
});

export const stopLateQueuedTurn = <E, R>(interrupt: Effect.Effect<unknown, E, R>) =>
  interrupt.pipe(
    Effect.asVoid,
    Effect.catch((cause) =>
      Effect.logWarning("orchestration-v2.codex-queued-turn-stop-failed", { cause }),
    ),
  );

/** Runs every effect to its end, then fails with the first failure, so one cannot cancel another. */
export const allSettledThenFail = <E, R>(effects: ReadonlyArray<Effect.Effect<void, E, R>>) =>
  Effect.forEach(effects, Effect.exit, { concurrency: "unbounded" }).pipe(
    Effect.flatMap((exits) => Effect.forEach(exits, (exit) => exit, { discard: true })),
  );
