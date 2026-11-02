import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";

const READER_POOL_SIZE = 4;

// Startup failures usually share one cause, so every slot honors one restart backoff and one
// restart runs at a time: slots waiting behind it re-check the deadline a failure extended.
export const makeReaderRestart = (gate: Semaphore.Semaphore) => {
  let retryAt = 0n;
  let retryMs = 250;
  let failing = false;
  let probe: Effect.Effect<unknown> = Effect.void;
  return {
    gate,
    // From a failure until a read succeeds, restarts go through the gate one at a time.
    failing: () => failing,
    // A later failure never shortens a deadline another slot already set.
    fail: (now: bigint) => {
      const next = now + BigInt(retryMs) * 1_000_000n;
      if (next > retryAt) retryAt = next;
      retryMs = Math.min(8_000, retryMs * 2);
      failing = true;
    },
    succeed: () => {
      retryMs = 250;
      failing = false;
    },
    remainingMs: (now: bigint) => Number(retryAt - now) / 1e6,
    // A restart's startup outlives a cancelled request, so the next restart waits for its outcome,
    // bounded by the startup deadline in case the worker never answers.
    probe: () => probe,
    setProbe: (next: Effect.Effect<unknown>) => {
      probe = next;
    },
  };
};
export type ReaderRestart = ReturnType<typeof makeReaderRestart>;

export interface ReaderSlot {
  readonly acquire: Effect.Effect<Connection, SqlError>;
  readonly backingOff: () => boolean;
}

// WAL readers run concurrently; one worker serialized every read behind the slowest transaction.
export const makeReaderPool = Effect.fn("SqliteReaderPool.make")(function* <R>(options: {
  readonly makeSlot: (restart: ReaderRestart) => Effect.Effect<ReaderSlot, never, R>;
  readonly available: Effect.Effect<void, SqlError> | undefined;
}) {
  const restart = makeReaderRestart(yield* Semaphore.make(1));
  const slots = yield* Effect.forEach(Array.from({ length: READER_POOL_SIZE }), () =>
    options.makeSlot(restart),
  );
  // Holding a permit guarantees a free slot, so choosing one never waits.
  const permits = yield* Semaphore.make(READER_POOL_SIZE);
  const leased = new Set<number>();
  // Prefer a slot that can serve now; a slot that must restart during backoff is a last resort.
  const lease = () => {
    let fallback = -1;
    for (const [index, slot] of slots.entries()) {
      if (leased.has(index)) continue;
      if (!slot.backingOff()) {
        leased.add(index);
        return index;
      }
      if (fallback < 0) fallback = index;
    }
    leased.add(fallback);
    return fallback;
  };
  const release = (index: number) => {
    leased.delete(index);
  };
  const connection = (index: number) => {
    const acquire = slots[index]?.acquire ?? Effect.die(new Error("Unknown reader slot"));
    return options.available === undefined ? acquire : Effect.andThen(options.available, acquire);
  };
  // Cancelling a read retires its slot's worker; the slot returns only after that cancellation finishes.
  const use = <A, E, R2>(body: (connection: Connection) => Effect.Effect<A, E, R2>) =>
    permits.withPermits(1)(
      Effect.acquireUseRelease(
        Effect.sync(lease),
        (index) => Effect.flatMap(connection(index), body),
        (index) => Effect.sync(() => release(index)),
      ),
    );
  return { permits, lease, release, connection, use };
});

export type ReaderPool = Effect.Success<ReturnType<typeof makeReaderPool>>;
