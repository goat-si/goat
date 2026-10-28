import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { makeManagedHeartbeat } from "./ManagedHeartbeat.ts";

it.effect.each(["business-handler", "business-write", "health-write"] as const)(
  "healthy main survives a held %s with bounded publishing",
  (hold) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const retirements = yield* Ref.make<ReadonlyArray<string>>([]);
      const writes = yield* Ref.make(0);
      const blocked = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const owner = yield* makeManagedHeartbeat({
        generation: "A",
        ready: true,
        writeHealth: () =>
          Ref.update(writes, (n) => n + 1).pipe(
            Effect.andThen(hold === "health-write" ? blocked : Effect.void),
          ),
        retireSelf: () => Ref.update(retirements, (xs) => [...xs, "A"]),
      });
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      if (hold !== "health-write") yield* blocked.pipe(Effect.forkChild);
      yield* owner.publish("ready");
      yield* owner.observe;
      yield* Deferred.await(entered);
      for (let beat = 0; beat < 30; beat++) {
        yield* TestClock.adjust("2 seconds");
        yield* owner.publish("ready");
        yield* owner.observe;
      }
      yield* owner.drainActions;
      assert.deepEqual(yield* Ref.get(retirements), []);
      const state = yield* owner.publisherState;
      assert.isAtMost(state.activeWrites, 1);
      assert.isAtMost(state.pendingSnapshots, 1);
      assert.isAtMost(state.retainedBytes, 1024);
      if (hold === "health-write") assert.equal(yield* Ref.get(writes), 1);
      yield* Deferred.succeed(release, undefined);
    }).pipe(Effect.scoped),
);

it.effect("true silent main retires only captured A once even with held health output", () =>
  Effect.gen(function* () {
    const writing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const retired = yield* Ref.make<ReadonlyArray<string>>([]);
    const a = yield* makeManagedHeartbeat({
      generation: "A",
      ready: true,
      writeHealth: () =>
        Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(release))),
      retireSelf: () => Ref.update(retired, (xs) => [...xs, "A"]),
    });
    const b = yield* makeManagedHeartbeat({
      generation: "B",
      ready: true,
      writeHealth: () => Effect.void,
      retireSelf: () => Ref.update(retired, (xs) => [...xs, "B"]),
    });
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
    yield* a.publish("ready");
    yield* a.observe;
    yield* Deferred.await(writing);
    yield* b.publish("ready");
    yield* b.observe;
    for (let beat = 0; beat < 26; beat++) {
      yield* TestClock.adjust("2 seconds");
      yield* b.publish("ready");
      yield* a.observe;
      yield* b.observe;
    }
    yield* a.drainActions;
    yield* b.drainActions;
    assert.deepEqual(yield* Ref.get(retired), ["A"]);
    yield* a.observe;
    yield* a.drainActions;
    assert.deepEqual(yield* Ref.get(retired), ["A"]);
    yield* Deferred.succeed(release, undefined);
  }).pipe(Effect.scoped),
);
