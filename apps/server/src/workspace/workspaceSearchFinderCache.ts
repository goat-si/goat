import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as RcMap from "effect/RcMap";
import * as Semaphore from "effect/Semaphore";

import {
  make,
  WorkspaceSearchIndexCreateFailed,
  type WorkspaceSearchIndexVariant,
} from "./WorkspaceSearchIndex.ts";

const FINDER_CAPACITY = 16;
const FINDER_IDLE_TTL = "15 minutes";

const makeFinderCache = Effect.gen(function* () {
  const admission = yield* Semaphore.make(1);
  const liveSlots = yield* Semaphore.make(FINDER_CAPACITY);
  let nativeCapacity = FINDER_CAPACITY;
  const quarantineSlot = Effect.suspend(() => {
    nativeCapacity -= 1;
    return liveSlots.resize(nativeCapacity);
  });
  const cache = yield* RcMap.make({
    lookup: (key: string) => {
      const separator = key.indexOf("\n");
      const variant = key.startsWith("content\n") ? "content" : "paths";
      // The finder finalizer awaits native teardown before the scope releases this permit.
      return liveSlots
        .takeScoped(1)
        .pipe(Effect.andThen(make(key.slice(separator + 1), variant, quarantineSlot)));
    },
    capacity: FINDER_CAPACITY,
    idleTimeToLive: FINDER_IDLE_TTL,
  });
  const invalidated = new WeakSet<object>();
  const keyOf = (cwd: string, variant: WorkspaceSearchIndexVariant) => `${variant}\n${cwd}`;
  const busy = (cwd: string) =>
    new WorkspaceSearchIndexCreateFailed({
      cwd,
      reason: "Workspace search indexes are busy. Try again after a search finishes.",
    });

  const retain = Effect.fn("WorkspaceSearchFinderCache.retain")(function* (
    cwd: string,
    variant: WorkspaceSearchIndexVariant,
    cachedOnly: boolean,
  ) {
    const key = keyOf(cwd, variant);
    const fiber = yield* admission.withPermits(1)(
      Effect.gen(function* () {
        if (cache.state._tag === "Closed") return yield* Effect.interrupt;
        const entries = cache.state.map;
        let existing = Option.getOrUndefined(MutableHashMap.get(entries, key));
        if (existing && invalidated.has(existing)) {
          if (existing.refCount > 0) return undefined;
          yield* RcMap.invalidate(cache, key);
          existing = undefined;
        }
        if (!existing && (cachedOnly || nativeCapacity === 0)) return undefined;
        if (!existing && MutableHashMap.size(entries) >= nativeCapacity) {
          let oldest: string | undefined;
          let oldestExpiry = Number.POSITIVE_INFINITY;
          for (const [candidate, entry] of entries) {
            if (entry.refCount > 0 || entry.expiresAt >= oldestExpiry) continue;
            oldest = candidate;
            oldestExpiry = entry.expiresAt;
          }
          if (oldest === undefined) return undefined;
          yield* RcMap.invalidate(cache, oldest);
        }
        // Register the borrower under the lock, then wait for initialization outside it.
        return yield* Effect.forkChild(RcMap.get(cache, key), { startImmediately: true });
      }),
    );
    if (fiber === undefined) return undefined;
    return yield* Fiber.join(fiber).pipe(
      Effect.catchTags({ ExceededCapacityError: () => Effect.fail(busy(cwd)) }),
    );
  });

  const get = Effect.fn("WorkspaceSearchFinderCache.get")(function* (
    cwd: string,
    variant: WorkspaceSearchIndexVariant,
  ) {
    const index = yield* retain(cwd, variant, false);
    return index ?? (yield* busy(cwd));
  });
  const getExisting = (cwd: string, variant: WorkspaceSearchIndexVariant) =>
    retain(cwd, variant, true);
  const invalidate = Effect.fn("WorkspaceSearchFinderCache.invalidate")(function* (
    cwd: string,
    variant: WorkspaceSearchIndexVariant,
  ) {
    yield* admission.withPermits(1)(
      Effect.gen(function* () {
        if (cache.state._tag === "Closed") return;
        const key = keyOf(cwd, variant);
        const entry = Option.getOrUndefined(MutableHashMap.get(cache.state.map, key));
        if (!entry) return;
        if (entry.refCount > 0) invalidated.add(entry);
        else yield* RcMap.invalidate(cache, key);
      }),
    );
  });

  return { get, getExisting, invalidate };
});

export class WorkspaceSearchFinderCache extends Context.Service<
  WorkspaceSearchFinderCache,
  Effect.Success<typeof makeFinderCache>
>()("goat/workspace/workspaceSearchFinderCache") {
  static readonly layer = Layer.effect(this, makeFinderCache);
}
