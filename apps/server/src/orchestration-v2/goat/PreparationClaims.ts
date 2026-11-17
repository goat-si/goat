import type { RunId, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

/**
 * Who owns a "preparing" run. The caller that commits it (launch, Retry, delegation) holds a pending
 * mark on its thread until its preparation fiber holds or queues for the run's claim; the fiber, or
 * the orphan check while it fails the run, holds the claim. Nothing is unowned in between.
 */
export class PreparationClaims extends Context.Service<
  PreparationClaims,
  {
    /**
     * Runs `body` holding the run's claim, waiting for the holder to let go first. `queued`
     * runs once this fiber has the claim or is next in line for it.
     */
    readonly whileClaimed: <E, R>(
      runId: RunId,
      body: Effect.Effect<void, E, R>,
      queued: Effect.Effect<void>,
    ) => Effect.Effect<void, E, R>;
    /** Runs `body` holding the run's claim if it is free; false, running nothing, if not. */
    readonly tryClaim: <E, R>(
      runId: RunId,
      body: Effect.Effect<void, E, R>,
    ) => Effect.Effect<boolean, E, R>;
    readonly isHeld: (runId: RunId) => Effect.Effect<boolean>;
    /** Whether a preparation is waiting for the run's claim. */
    readonly hasWaiters: (runId: RunId) => Effect.Effect<boolean>;
    /** Marks the thread's run as about to be prepared until the scope closes. */
    readonly pending: (threadId: ThreadId) => Effect.Effect<void, never, Scope.Scope>;
    readonly isPending: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("goat/orchestration-v2/goat/PreparationClaims") {}

export const layer = Layer.effect(
  PreparationClaims,
  Effect.gen(function* () {
    // A held run maps to the fibers waiting for it, first in line first.
    const held = yield* Ref.make<ReadonlyMap<RunId, ReadonlyArray<Deferred.Deferred<void>>>>(
      new Map(),
    );
    const pending = yield* Ref.make<ReadonlyMap<ThreadId, number>>(new Map());

    const tryAcquire = (runId: RunId) =>
      Ref.modify(held, (current) =>
        current.has(runId)
          ? ([false, current] as const)
          : ([true, new Map(current).set(runId, [])] as const),
      );
    // Hands the claim to the next waiter in the same step, so it is never free in between.
    const release = (runId: RunId) =>
      Ref.modify(held, (current) => {
        const next = new Map(current);
        const [first, ...rest] = current.get(runId) ?? [];
        if (first === undefined) next.delete(runId);
        else next.set(runId, rest);
        return [first, next] as const;
      }).pipe(
        Effect.flatMap((first) =>
          first === undefined ? Effect.void : Deferred.succeed(first, undefined),
        ),
      );
    // Joins the line, or takes the claim when it is free; true when it was free.
    const enqueue = (runId: RunId, waiter: Deferred.Deferred<void>) =>
      Ref.modify(held, (current) => {
        const waiting = current.get(runId);
        if (waiting === undefined) return [true, new Map(current).set(runId, [])] as const;
        return [false, new Map(current).set(runId, [...waiting, waiter])] as const;
      });
    // A waiter interrupted after the claim was handed to it owns it, so it lets go.
    const leaveLine = (runId: RunId, waiter: Deferred.Deferred<void>) =>
      Ref.modify(held, (current) => {
        const waiting = current.get(runId) ?? [];
        if (!waiting.includes(waiter)) return [true, current] as const;
        return [
          false,
          new Map(current).set(
            runId,
            waiting.filter((candidate) => candidate !== waiter),
          ),
        ] as const;
      }).pipe(Effect.flatMap((handed) => (handed ? release(runId) : Effect.void)));

    const whileClaimed = Effect.fn("PreparationClaims.whileClaimed")(function* <E, R>(
      runId: RunId,
      body: Effect.Effect<void, E, R>,
      queued: Effect.Effect<void>,
    ) {
      const waiter = yield* Deferred.make<void>();
      return yield* Effect.uninterruptibleMask((restore) =>
        enqueue(runId, waiter).pipe(
          Effect.tap(() => queued),
          Effect.flatMap((free) =>
            free
              ? Effect.void
              : restore(Deferred.await(waiter)).pipe(
                  Effect.onInterrupt(() => leaveLine(runId, waiter)),
                ),
          ),
          Effect.andThen(restore(body).pipe(Effect.ensuring(release(runId)))),
        ),
      );
    });

    return PreparationClaims.of({
      whileClaimed,
      tryClaim: Effect.fn("PreparationClaims.tryClaim")(function* <E, R>(
        runId: RunId,
        body: Effect.Effect<void, E, R>,
      ) {
        return yield* Effect.uninterruptibleMask((restore) =>
          tryAcquire(runId).pipe(
            Effect.flatMap((claimed) =>
              claimed
                ? restore(body).pipe(Effect.ensuring(release(runId)), Effect.as(true))
                : Effect.succeed(false),
            ),
          ),
        );
      }),
      // Untraced: read for every preparing run on each orphan check pass, which has its own span.
      isHeld: Effect.fnUntraced(function* (runId: RunId) {
        return (yield* Ref.get(held)).has(runId);
      }),
      pending: Effect.fn("PreparationClaims.pending")(function* (threadId: ThreadId) {
        yield* Effect.acquireRelease(
          Ref.update(pending, (current) =>
            new Map(current).set(threadId, (current.get(threadId) ?? 0) + 1),
          ),
          () =>
            Ref.update(pending, (current) => {
              const next = new Map(current);
              const count = (current.get(threadId) ?? 1) - 1;
              if (count <= 0) next.delete(threadId);
              else next.set(threadId, count);
              return next;
            }),
        );
      }),
      // Untraced for the same reason as isHeld.
      hasWaiters: Effect.fnUntraced(function* (runId: RunId) {
        return ((yield* Ref.get(held)).get(runId) ?? []).length > 0;
      }),
      // Untraced for the same reason as isHeld.
      isPending: Effect.fnUntraced(function* (threadId: ThreadId) {
        return (yield* Ref.get(pending)).has(threadId);
      }),
    });
  }),
);

/**
 * Forks `body` into `scope`, holding the run's claim when there is a run, and returns once the fiber
 * has the claim or is in line for it, or has ended, so the caller's pending mark lasts until then.
 * `finally` runs when the fiber ends, also when it ends waiting for the claim.
 */
export const forkClaimed = Effect.fn("PreparationClaims.forkClaimed")(function* <E, R>(
  claims: PreparationClaims["Service"],
  runId: RunId | null,
  body: Effect.Effect<void, E, R>,
  options: { readonly scope: Scope.Scope; readonly finally: Effect.Effect<void> },
) {
  const queued = yield* Deferred.make<void>();
  const fiber = yield* (
    runId === null ? body : claims.whileClaimed(runId, body, Deferred.succeed(queued, undefined))
  ).pipe(Effect.ignoreCause, Effect.ensuring(options.finally), Effect.forkIn(options.scope));
  if (runId !== null) yield* Effect.raceFirst(Deferred.await(queued), Fiber.await(fiber));
});
