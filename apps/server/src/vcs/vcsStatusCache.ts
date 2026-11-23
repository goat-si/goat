import * as Effect from "effect/Effect";
import * as KeyedLock from "@goat/shared/KeyedLock";

export function makeStatusCache<T>(
  isRetained: (cwd: string) => boolean,
  onEvict: (cwd: string) => void,
) {
  const cache = new Map<string, T>();
  const trim = (retainedCwd?: string) => {
    for (const cwd of cache.keys()) {
      if (cache.size <= 256) break;
      if (cwd === retainedCwd || isRetained(cwd)) continue;
      cache.delete(cwd);
      onEvict(cwd);
    }
  };
  return {
    get(cwd: string) {
      const value = cache.get(cwd);
      if (value !== undefined) {
        cache.delete(cwd);
        cache.set(cwd, value);
      }
      return value;
    },
    set(cwd: string, value: T) {
      cache.delete(cwd);
      cache.set(cwd, value);
      trim(cwd);
    },
    trim,
  };
}

export const makeStatusCacheWithRemoteLock = <T>(
  isRetained: (cwd: string) => boolean,
  onEvict: (cwd: string) => void,
) =>
  Effect.fn("VcsStatusCache.make")(function* () {
    const active = new Map<string, number>();
    const cache = makeStatusCache<T>((cwd) => isRetained(cwd) || active.has(cwd), onEvict);
    const locks = yield* KeyedLock.make<string>();
    const withRemoteWriteLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => active.set(cwd, (active.get(cwd) ?? 0) + 1)),
        () => locks.withLock(cwd, effect),
        () =>
          Effect.sync(() => {
            const remaining = (active.get(cwd) ?? 1) - 1;
            if (remaining === 0) active.delete(cwd);
            else active.set(cwd, remaining);
            cache.trim();
          }),
      );
    return { cache, withRemoteWriteLock };
  })();
