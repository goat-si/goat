import type { RunId, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";
import { generationOf } from "./PreparationStretch.ts";

/** A run's line holds at most this many preparations; the next caller leaves the run to them. */
const MAX_WAITERS = 4;

/**
 * Who owns a "preparing" run. The caller that commits it (launch, Retry, delegation) holds a pending
 * mark on its thread until its preparation fiber holds or queues for the run's claim; the fiber
 * holds the claim. A mark is recorded under the thread's command lock, so it never lands inside a
 * commit that is deciding a fail on that thread.
 */
export class PreparationClaims extends Context.Service<
  PreparationClaims,
  {
    /**
     * Runs `body` holding the run's claim, waiting for the holder to let go first. `queued`
     * runs once this fiber has the claim or is in line for it. With the line full it returns.
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
    /** Marks the thread's run as about to be prepared until the scope closes. */
    readonly pending: (threadId: ThreadId) => Effect.Effect<void, never, Scope.Scope>;
    readonly isPending: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** Whether a caller's mark or a preparation's claim owns the run. */
    readonly isOwned: (threadId: ThreadId, runId: RunId) => Effect.Effect<boolean>;
    /** The run's generation (see PreparationStretch) from events before `before`, or null. */
    readonly generation: (
      threadId: ThreadId,
      runId: RunId,
      before?: number,
    ) => Effect.Effect<number | null, SqlError.SqlError>;
  }
>()("goat/orchestration-v2/goat/PreparationClaims") {}

interface Owners {
  // A held run maps to the fibers waiting for it, first in line first.
  readonly held: ReadonlyMap<RunId, ReadonlyArray<Deferred.Deferred<void>>>;
  readonly pending: ReadonlyMap<ThreadId, number>;
}

const withHeld = (owners: Owners, held: Owners["held"]): Owners => ({ ...owners, held });

export const layer = Layer.effect(
  PreparationClaims,
  Effect.gen(function* () {
    const lock = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const sql = yield* SqlClient.SqlClient;
    const owners = yield* Ref.make<Owners>({ held: new Map(), pending: new Map() });

    const tryAcquire = (runId: RunId) =>
      Ref.modify(owners, (current) =>
        current.held.has(runId)
          ? ([false, current] as const)
          : ([true, withHeld(current, new Map(current.held).set(runId, []))] as const),
      );
    // Hands the claim to the next waiter in the same step, so it is never free in between.
    const release = (runId: RunId) =>
      Ref.modify(owners, (current) => {
        const held = new Map(current.held);
        const [first, ...rest] = current.held.get(runId) ?? [];
        if (first === undefined) held.delete(runId);
        else held.set(runId, rest);
        return [first, withHeld(current, held)] as const;
      }).pipe(
        Effect.flatMap((first) =>
          first === undefined ? Effect.void : Deferred.succeed(first, undefined),
        ),
      );
    const enqueue = (runId: RunId, waiter: Deferred.Deferred<void>) =>
      Ref.modify(owners, (current) => {
        const waiting = current.held.get(runId);
        if (waiting === undefined)
          return ["free", withHeld(current, new Map(current.held).set(runId, []))] as const;
        if (waiting.length >= MAX_WAITERS) return ["full", current] as const;
        return [
          "queued",
          withHeld(current, new Map(current.held).set(runId, [...waiting, waiter])),
        ] as const;
      });
    // A waiter interrupted after the claim was handed to it owns it, so it lets go.
    const leaveLine = (runId: RunId, waiter: Deferred.Deferred<void>) =>
      Ref.modify(owners, (current) => {
        const waiting = current.held.get(runId) ?? [];
        if (!waiting.includes(waiter)) return [true, current] as const;
        const held = new Map(current.held).set(
          runId,
          waiting.filter((candidate) => candidate !== waiter),
        );
        return [false, withHeld(current, held)] as const;
      }).pipe(Effect.flatMap((handed) => (handed ? release(runId) : Effect.void)));
    const countPending = (threadId: ThreadId, change: 1 | -1) =>
      Ref.update(owners, (current) => {
        const pending = new Map(current.pending);
        const count = (current.pending.get(threadId) ?? 0) + change;
        if (count <= 0) pending.delete(threadId);
        else pending.set(threadId, count);
        return { ...current, pending };
      });

    return PreparationClaims.of({
      whileClaimed: Effect.fn("PreparationClaims.whileClaimed")(function* <E, R>(
        runId: RunId,
        body: Effect.Effect<void, E, R>,
        queued: Effect.Effect<void>,
      ) {
        const waiter = yield* Deferred.make<void>();
        return yield* Effect.uninterruptibleMask((restore) =>
          enqueue(runId, waiter).pipe(
            Effect.flatMap((place) =>
              place === "full"
                ? Effect.void
                : queued.pipe(
                    Effect.andThen(
                      place === "free"
                        ? Effect.void
                        : restore(Deferred.await(waiter)).pipe(
                            Effect.onInterrupt(() => leaveLine(runId, waiter)),
                          ),
                    ),
                    Effect.andThen(restore(body).pipe(Effect.ensuring(release(runId)))),
                  ),
            ),
          ),
        );
      }),
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
      pending: Effect.fn("PreparationClaims.pending")(function* (threadId: ThreadId) {
        // The wait for the lock stays interruptible; the count and its release go in together.
        yield* lock.withLock(
          threadId,
          Effect.uninterruptible(
            countPending(threadId, 1).pipe(
              Effect.andThen(Effect.addFinalizer(() => countPending(threadId, -1))),
            ),
          ),
        );
      }),
      // Untraced: read for every preparing run on each orphan check pass, which has its own span.
      isPending: Effect.fnUntraced(function* (threadId: ThreadId) {
        return (yield* Ref.get(owners)).pending.has(threadId);
      }),
      // Untraced for the same reason as isPending.
      isOwned: Effect.fnUntraced(function* (threadId: ThreadId, runId: RunId) {
        const current = yield* Ref.get(owners);
        return current.pending.has(threadId) || current.held.has(runId);
      }),
      // Untraced: also read inside a commit's transaction, whose span covers it.
      generation: Effect.fnUntraced(function* (
        threadId: ThreadId,
        runId: RunId,
        before: number = Number.MAX_SAFE_INTEGER,
      ) {
        const rows = yield* sql.unsafe<{ readonly sequence: number }>(generationOf("?", "?", "?"), [
          threadId,
          before,
          runId,
        ]);
        return rows[0]?.sequence ?? null;
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
