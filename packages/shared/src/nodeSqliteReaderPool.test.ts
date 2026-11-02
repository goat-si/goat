import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { Connection } from "effect/sql/SqlConnection";
import * as Semaphore from "effect/Semaphore";
import { makeReaderPool, makeReaderRestart } from "./nodeSqliteReaderPool.ts";

// Fake slots resolve synchronously, so a forked use that has not finished is waiting for a permit.
const makePool = (backingOff: Array<boolean> = []) => {
  let created = 0;
  return makeReaderPool({
    makeSlot: () => {
      const index = created++;
      const connection = { index } as unknown as Connection;
      return Effect.succeed({
        acquire: Effect.succeed(connection),
        backingOff: () => backingOff[index] ?? false,
      });
    },
    available: undefined,
  });
};
const slotOf = (connection: Connection) => (connection as unknown as { index: number }).index;

const holdSlots = Effect.fnUntraced(function* (pool: Effect.Success<ReturnType<typeof makePool>>) {
  const release = yield* Deferred.make<void>();
  const slots: Array<number> = [];
  const fibers = [];
  for (let index = 0; index < 4; index++)
    fibers.push(
      yield* Effect.forkChild(
        pool.use((connection) =>
          Effect.andThen(
            Effect.sync(() => slots.push(slotOf(connection))),
            Deferred.await(release),
          ),
        ),
        { startImmediately: true },
      ),
    );
  return { release, slots, fibers };
});

it.effect("a fifth use waits for a slot, and an interrupted waiter leaks no permit", () =>
  Effect.gen(function* () {
    const pool = yield* makePool();
    const held = yield* holdSlots(pool);
    assert.deepEqual([...held.slots].toSorted(), [0, 1, 2, 3]);
    const waiter = yield* Effect.forkChild(
      pool.use(() => Effect.void),
      {
        startImmediately: true,
      },
    );
    assert.isUndefined(waiter.pollUnsafe());
    yield* Fiber.interrupt(waiter);
    yield* Deferred.succeed(held.release, undefined);
    for (const fiber of held.fibers) yield* Fiber.join(fiber);
    // All four permits came back: four new uses hold every slot at once again.
    const again = yield* holdSlots(pool);
    assert.deepEqual([...again.slots].toSorted(), [0, 1, 2, 3]);
    yield* Deferred.succeed(again.release, undefined);
    for (const fiber of again.fibers) yield* Fiber.join(fiber);
  }),
);

it.effect("an interrupted use returns its slot only after its cancellation finishes", () =>
  Effect.gen(function* () {
    const pool = yield* makePool();
    const started = yield* Deferred.make<void>();
    const terminated = yield* Deferred.make<void>();
    const cancelled = yield* Effect.forkChild(
      pool.use(() =>
        Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
          Effect.onInterrupt(() => Deferred.await(terminated)),
        ),
      ),
      { startImmediately: true },
    );
    yield* Deferred.await(started);
    const interrupting = yield* Effect.forkChild(Fiber.interrupt(cancelled), {
      startImmediately: true,
    });
    // Slot 0 is still terminating, so the next use lands on slot 1.
    assert.equal(yield* pool.use((connection) => Effect.succeed(slotOf(connection))), 1);
    yield* Deferred.succeed(terminated, undefined);
    yield* Fiber.join(interrupting);
    assert.equal(yield* pool.use((connection) => Effect.succeed(slotOf(connection))), 0);
  }),
);

it.effect("leases a slot that can serve now before one waiting out restart backoff", () =>
  Effect.gen(function* () {
    const pool = yield* makePool([true, false, true, true]);
    assert.equal(yield* pool.use((connection) => Effect.succeed(slotOf(connection))), 1);
    // With every free slot in backoff, the lowest one is used and waits inside its own acquire.
    const all = yield* makePool([true, true, true, true]);
    assert.equal(yield* all.use((connection) => Effect.succeed(slotOf(connection))), 0);
  }),
);

it.effect("a failure after a success never shortens the shared restart deadline", () =>
  Effect.gen(function* () {
    const restart = makeReaderRestart(yield* Semaphore.make(1));
    const ms = (value: number) => BigInt(value) * 1_000_000n;
    restart.fail(ms(0));
    restart.fail(ms(10));
    // The deadline is 510ms; a healthy slot's success resets only the next interval.
    restart.succeed();
    restart.fail(ms(20));
    assert.equal(restart.remainingMs(ms(20)), 490);
    restart.fail(ms(600));
    assert.equal(restart.remainingMs(ms(600)), 500);
  }),
);
