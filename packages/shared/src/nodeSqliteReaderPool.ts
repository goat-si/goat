import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";

const READER_POOL_SIZE = 4;

// Startup failures usually share one cause, so every slot honors the same restart backoff.
export interface ReaderRestart {
  retryAt: bigint;
  retryMs: number;
}

export interface ReaderSlot {
  readonly acquire: Effect.Effect<Connection, SqlError>;
  readonly backingOff: () => boolean;
}

// WAL readers run concurrently; one worker serialized every read behind the slowest transaction.
export const makeReaderPool = Effect.fn("SqliteReaderPool.make")(function* <R>(options: {
  readonly makeSlot: (restart: ReaderRestart) => Effect.Effect<ReaderSlot, never, R>;
  readonly available: Effect.Effect<void, SqlError> | undefined;
}) {
  const restart: ReaderRestart = { retryAt: 0n, retryMs: 250 };
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
