import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

export interface KeyedLock<Key> {
  readonly withLock: <A, E, R>(key: Key, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly activeKeys: Effect.Effect<ReadonlyArray<Key>>;
}

interface LockEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

/**
 * Not reentrant: taking a key while already holding it deadlocks.
 */
export const make = Effect.fn("KeyedLock.make")(function* <Key>(): Effect.fn.Return<
  KeyedLock<Key>
> {
  const locks = yield* Ref.make<ReadonlyMap<Key, LockEntry>>(new Map());

  const acquire = (key: Key) =>
    Effect.flatMap(Semaphore.make(1), (candidate) =>
      Ref.modify(locks, (current) => {
        const existing = current.get(key);
        const semaphore = existing?.semaphore ?? candidate;
        const next = new Map(current);
        next.set(key, { semaphore, users: (existing?.users ?? 0) + 1 });
        return [semaphore, next] as const;
      }),
    );

  const release = (key: Key) =>
    Ref.update(locks, (current) => {
      const existing = current.get(key);
      if (existing === undefined) return current;
      const next = new Map(current);
      if (existing.users === 1) {
        next.delete(key);
      } else {
        next.set(key, { ...existing, users: existing.users - 1 });
      }
      return next;
    });

  return {
    withLock: (key, effect) =>
      Effect.acquireUseRelease(
        acquire(key),
        (semaphore) => semaphore.withPermit(effect),
        () => release(key),
      ),
    activeKeys: Effect.map(Ref.get(locks), (current) => Array.from(current.keys())),
  } satisfies KeyedLock<Key>;
});

/** Bounded admission with FIFO execution per key for callers submitting work in order. */
export const makeRunner = Effect.fn("KeyedLock.makeRunner")(function* <Key>() {
  const lock = yield* make<Key>();
  const active = yield* Semaphore.make(16);
  const admitted = yield* Semaphore.make(128);
  const fibers = yield* FiberSet.make<void>();

  const run = <R>(key: Key, effect: Effect.Effect<unknown, never, R>) =>
    Effect.uninterruptibleMask((restore) =>
      restore(admitted.take(1)).pipe(
        Effect.andThen(
          FiberSet.run(
            fibers,
            lock
              .withLock(key, active.withPermit(effect))
              .pipe(Effect.asVoid, Effect.interruptible, Effect.ensuring(admitted.release(1))),
            { startImmediately: true },
          ),
        ),
        Effect.asVoid,
      ),
    );

  return { run };
});
