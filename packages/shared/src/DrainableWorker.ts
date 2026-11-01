import * as Cause from "effect/Cause";
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  readonly enqueue: (item: A) => Effect.Effect<"accepted" | "full" | "closed">;

  readonly drain: Effect.Effect<void>;
}

/**
 * Scope closure drops queued items; `drain` still waits for active work. Item failures are logged.
 * Capacity counts waiting items, excluding the active item; rejection never blocks.
 * Bounded callers reconcile rejected work. Omission preserves unbounded admission.
 */
export const makeDrainableWorker = Effect.fn("DrainableWorker.makeDrainableWorker")(function* <
  A,
  E,
  R,
>(
  process: (item: A) => Effect.Effect<void, E, R>,
  options?: { readonly capacity: number },
): Effect.fn.Return<DrainableWorker<A>, never, Scope.Scope | R> {
  if (options && (!Number.isSafeInteger(options.capacity) || options.capacity < 1)) {
    return yield* Effect.die(new RangeError("Worker capacity must be a positive safe integer"));
  }
  const outstanding = yield* TxRef.make(0);
  const queue = yield* Effect.acquireRelease(
    options ? TxQueue.dropping<A>(options.capacity) : TxQueue.unbounded<A>(),
    (queue) =>
      // Uncount only the dropped items: an item still running uncounts itself,
      // even when a parallel scope closes it after this finalizer.
      TxQueue.clear(queue).pipe(
        Effect.flatMap((dropped) => TxRef.update(outstanding, (n) => n - dropped.length)),
        Effect.andThen(TxQueue.shutdown(queue)),
        Effect.tx,
      ),
  );

  yield* TxQueue.take(queue).pipe(
    Effect.flatMap((a) =>
      // `suspend` turns a `process` that throws while building its effect
      // into this item's defect instead of the loop's.
      Effect.suspend(() => process(a)).pipe(
        // Only the item's own failure, defect, or interruption lands here and
        // the loop continues; interrupting the worker fiber still stops it.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("DrainableWorker item failed", cause),
        ),
        Effect.ensuring(TxRef.update(outstanding, (n) => n - 1)),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
    Effect.flatMap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
    Effect.tx,
  );

  // Admission runs for each producer event, so avoid a span per item.
  const enqueue: DrainableWorker<A>["enqueue"] = Effect.fnUntraced(function* (element: A) {
    if (!(yield* TxQueue.isOpen(queue))) return "closed" as const;
    if (!(yield* TxQueue.offer(queue, element))) return "full" as const;
    yield* TxRef.update(outstanding, (n) => n + 1);
    return "accepted" as const;
  }, Effect.tx);

  return { enqueue, drain } satisfies DrainableWorker<A>;
});
