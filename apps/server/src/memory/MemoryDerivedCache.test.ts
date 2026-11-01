import { assert, it } from "@effect/vitest";
import { MEMORY_DERIVED_CACHE_MAX_BYTES, MEMORY_DERIVED_CACHE_TTL_MS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Cache from "./MemoryDerivedCache.ts";

// Scope.state is public: count retained cleanup resources, not just body charges.
const cleanupCount = (scope: Scope.Scope) => {
  const state = scope.state;
  return state._tag === "Open" ? (state.finalizers?.size ?? 1) : 0;
};

it.effect.each(["unregister", "TTL", "eviction", "oversized"] as const)(
  "bounds caller cleanup resources across repeated %s releases",
  (reason) =>
    Effect.gen(function* () {
      const cache = yield* Cache.MemoryDerivedCache;
      const scope = yield* Scope.make();
      const releases = new Map<string, number>();
      const retain = (owner: string, bytes: number, released?: Deferred.Deferred<void>) =>
        cache
          .retain({
            bytes,
            release: Effect.sync(() => {
              releases.set(owner, (releases.get(owner) ?? 0) + 1);
            }).pipe(
              Effect.andThen(released ? Deferred.succeed(released, undefined) : Effect.void),
              Effect.asVoid,
            ),
          })
          .pipe(Effect.provideService(Scope.Scope, scope));
      for (let i = 0; i < 32; i++) {
        const owner = `owner-${i}`;
        const released = yield* Deferred.make<void>();
        const unregister = yield* retain(
          owner,
          reason === "oversized" ? MEMORY_DERIVED_CACHE_MAX_BYTES + 1 : 1,
          released,
        );
        if (reason === "unregister") {
          yield* unregister;
        } else if (reason === "TTL") {
          yield* TestClock.adjust(MEMORY_DERIVED_CACHE_TTL_MS);
        } else if (reason === "eviction") {
          const stopReplacement = yield* retain(`replacement-${i}`, MEMORY_DERIVED_CACHE_MAX_BYTES);
          assert.equal(cleanupCount(scope), 1);
          yield* stopReplacement;
        }
        yield* Deferred.await(released);
        assert.deepEqual(yield* cache.usage, { bytes: 0, owners: 0 });
        assert.equal(cleanupCount(scope), 0);
        yield* unregister;
        assert.equal(releases.get(owner), 1);
      }
      // Only the remaining owners may be released by the still-open caller.
      const completed = new Map(releases);
      const stopA = yield* retain("remaining-a", 2);
      const stopB = yield* retain("remaining-b", 3);
      assert.equal(cleanupCount(scope), 2);
      assert.deepEqual(yield* cache.usage, { bytes: 5, owners: 2 });
      yield* Scope.close(scope, Exit.void);
      yield* stopA;
      yield* stopB;
      assert.deepEqual(releases, new Map([...completed, ["remaining-a", 1], ["remaining-b", 1]]));
      assert.deepEqual(yield* cache.usage, { bytes: 0, owners: 0 });
      assert.equal(cleanupCount(scope), 0);
    }).pipe(Effect.provide(Cache.layer)),
);

it.effect("finishes release and detaches cleanup when unregister is interrupted", () =>
  Effect.gen(function* () {
    const cache = yield* Cache.MemoryDerivedCache;
    const scope = yield* Scope.make();
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let releases = 0;
    const unregister = yield* cache
      .retain({
        bytes: 1,
        release: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.andThen(Effect.sync(() => releases++)),
          Effect.asVoid,
        ),
      })
      .pipe(Effect.provideService(Scope.Scope, scope));
    const stopping = yield* unregister.pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const interrupting = yield* Fiber.interrupt(stopping).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(interrupting);
    yield* unregister;
    yield* Scope.close(scope, Exit.void);
    assert.equal(releases, 1);
    assert.equal(cleanupCount(scope), 0);
    assert.deepEqual(yield* cache.usage, { bytes: 0, owners: 0 });
  }).pipe(Effect.provide(Cache.layer)),
);

it.effect("evicts the oldest bodies across runtime scopes at the aggregate limit", () =>
  Effect.gen(function* () {
    const cache = yield* Cache.MemoryDerivedCache;
    const dropped: string[] = [];
    const retain = (owner: string, bytes: number) =>
      Effect.scoped(
        cache.retain({
          bytes,
          release: Effect.sync(() => {
            dropped.push(owner);
          }),
        }),
      );
    // Distinct session scopes share the same server service.
    const a = yield* Scope.make();
    const b = yield* Scope.make();
    const c = yield* Scope.make();
    const _registration0 = yield* cache
      .retain({
        bytes: 16 * 1024 * 1024,
        release: Effect.sync(() => {
          dropped.push("a");
        }),
      })
      .pipe(Effect.provideService(Scope.Scope, a));
    const _registration1 = yield* cache
      .retain({
        bytes: 16 * 1024 * 1024,
        release: Effect.sync(() => {
          dropped.push("b");
        }),
      })
      .pipe(Effect.provideService(Scope.Scope, b));
    assert.deepEqual(dropped, []);
    const _registration2 = yield* cache
      .retain({
        bytes: 1,
        release: Effect.sync(() => {
          dropped.push("c");
        }),
      })
      .pipe(Effect.provideService(Scope.Scope, c));
    assert.deepEqual(dropped, ["a"]);
    assert.deepEqual(yield* cache.usage, { bytes: 16 * 1024 * 1024 + 1, owners: 2 });
    yield* Scope.close(b, Exit.void);
    assert.deepEqual(yield* cache.usage, { bytes: 1, owners: 1 });
    yield* Scope.close(a, Exit.void);
    yield* Scope.close(c, Exit.void);
    const _oversize = yield* retain("oversize", MEMORY_DERIVED_CACHE_MAX_BYTES + 1);
    assert.deepEqual(yield* cache.usage, { bytes: 0, owners: 0 });
    assert.deepEqual(dropped, ["a", "b", "c", "oversize"]);
  }).pipe(Effect.provide(Cache.layer)),
);

it.effect("expires an idle body without another turn and unregisters stopped owners", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cache = yield* Cache.MemoryDerivedCache;
      const expired = yield* Deferred.make<void>();
      const unregister = yield* cache.retain({
        bytes: 23,
        release: Deferred.succeed(expired, undefined).pipe(Effect.asVoid),
      });
      yield* TestClock.adjust(MEMORY_DERIVED_CACHE_TTL_MS - 1);
      assert.deepEqual(yield* cache.usage, { bytes: 23, owners: 1 });
      yield* TestClock.adjust(1);
      yield* Deferred.await(expired);
      assert.deepEqual(yield* cache.usage, { bytes: 0, owners: 0 });
      yield* unregister;
      let stopped = 0;
      const stop = yield* cache.retain({
        bytes: 42,
        release: Effect.sync(() => {
          stopped++;
        }),
      });
      yield* stop;
      yield* TestClock.adjust(MEMORY_DERIVED_CACHE_TTL_MS);
      assert.equal(stopped, 1);
      assert.deepEqual(yield* cache.usage, { bytes: 0, owners: 0 });
    }),
  ).pipe(Effect.provide(Cache.layer)),
);
