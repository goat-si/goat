import * as Deferred from "effect/Deferred";
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

/** Bounded FIFO admission. A backlog on active keys leaves room for new keys. */
export const makeRunner = Effect.fn("KeyedLock.makeRunner")(function* <Key>(perKey = 128) {
  const lock = yield* make<Key>();
  const active = yield* Semaphore.make(16);
  const fibers = yield* FiberSet.make<void>();
  const counts = new Map<Key, number>();
  let total = 0;
  let changed = Deferred.makeUnsafe<void>();

  const canAdmit = (key: Key, limit = perKey) => {
    const count = counts.get(key) ?? 0;
    return count < limit && total < (count === 0 ? 128 : 112);
  };
  const releaseKey = (key: Key) =>
    Effect.suspend(() => {
      total--;
      const remaining = (counts.get(key) ?? 1) - 1;
      if (remaining === 0) counts.delete(key);
      else counts.set(key, remaining);
      const previous = changed;
      changed = Deferred.makeUnsafe<void>();
      return Deferred.succeed(previous, undefined);
    });

  const tryRun = <R>(key: Key, effect: Effect.Effect<unknown, never, R>, limit = perKey) =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        if (!canAdmit(key, limit)) return Effect.succeed(false);
        total++;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return FiberSet.run(
          fibers,
          lock
            .withLock(key, active.withPermit(effect))
            .pipe(Effect.asVoid, Effect.interruptible, Effect.ensuring(releaseKey(key))),
          { startImmediately: true },
        ).pipe(Effect.as(true));
      }),
    );

  const awaitChange = () => Deferred.await(changed);
  const run = <R>(
    key: Key,
    effect: Effect.Effect<unknown, never, R>,
  ): Effect.Effect<void, never, R> =>
    Effect.suspend(() => {
      const capacityChanged = awaitChange();
      return tryRun(key, effect).pipe(
        Effect.flatMap((accepted) =>
          accepted ? Effect.void : capacityChanged.pipe(Effect.andThen(run(key, effect))),
        ),
      );
    });

  return {
    run,
    tryRun: <R>(key: Key, effect: Effect.Effect<unknown, never, R>) => tryRun(key, effect),
    tryRunOverflow: <R>(key: Key, replay: Effect.Effect<unknown, never, R>) =>
      tryRun(key, replay, perKey + 1),
    canAdmit: (key: Key) => canAdmit(key),
    awaitChange,
  };
});
