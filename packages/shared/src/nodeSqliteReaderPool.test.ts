import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { Connection } from "effect/sql/SqlConnection";
import { makeReaderPool, type ReaderSlotState } from "./nodeSqliteReaderPool.ts";

// Fake slots resolve synchronously, so a forked use that has not finished is waiting for a permit.
const makePool = (states: Array<ReaderSlotState> = []) => {
  let created = 0;
  return makeReaderPool({
    makeSlot: () => {
      const index = created++;
      const connection = { index } as unknown as Connection;
      return Effect.succeed({
        acquire: Effect.succeed(connection),
        state: () => states[index] ?? "idle",
      });
    },
    available: undefined,
  });
};
const slotOf = (connection: Connection) => (connection as unknown as { index: number }).index;
const leasedSlot = (pool: Effect.Success<ReturnType<typeof makePool>>) =>
  pool.use((connection) => Effect.succeed(slotOf(connection)));

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
    assert.equal(yield* leasedSlot(pool), 1);
    yield* Deferred.succeed(terminated, undefined);
    yield* Fiber.join(interrupting);
    assert.equal(yield* leasedSlot(pool), 0);
  }),
);

it.effect("leases a running slot first and starts no idle slot while another backs off", () =>
  Effect.gen(function* () {
    assert.equal(yield* leasedSlot(yield* makePool(["idle", "running", "backoff", "idle"])), 1);
    // A backoff anywhere keeps new workers from starting: the failing slot retries on its schedule.
    assert.equal(yield* leasedSlot(yield* makePool(["idle", "backoff", "idle", "idle"])), 1);
    // Without a backoff, an idle slot starts before a running one is waited for.
    assert.equal(yield* leasedSlot(yield* makePool(["idle", "idle", "idle", "idle"])), 0);
  }),
);

it.effect("rejects a reader pool size that is not a positive integer", () =>
  Effect.gen(function* () {
    for (const size of [0, -1, 1.5]) {
      const exit = yield* Effect.exit(
        makeReaderPool({
          makeSlot: () => Effect.die(new Error("no slot is made")),
          available: undefined,
          size,
        }),
      );
      assert.isTrue(exit._tag === "Failure");
    }
  }),
);
