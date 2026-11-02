import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";

const DEFAULT_READER_POOL_SIZE = 4;

export type ReaderSlotState = "running" | "idle" | "backoff";

export interface ReaderSlot {
  readonly acquire: Effect.Effect<Connection, SqlError>;
  readonly state: () => ReaderSlotState;
}

// A free running slot serves first. While any slot waits out restart backoff, a failing slot
// retries on its own schedule instead of new slots starting workers, so a shared startup fault
// keeps one retry stream; otherwise an idle slot starts a worker.
const choose = (slots: ReadonlyArray<ReaderSlot>, leased: ReadonlySet<number>) => {
  const free = slots.flatMap((slot, index) => (leased.has(index) ? [] : [{ index, slot }]));
  const pick = (state: ReaderSlotState) => free.find(({ slot }) => slot.state() === state)?.index;
  const anyBackoff = slots.some((slot) => slot.state() === "backoff");
  return (
    pick("running") ??
    (anyBackoff ? (pick("backoff") ?? pick("idle")) : (pick("idle") ?? pick("backoff"))) ??
    -1
  );
};

// WAL readers run concurrently; one worker serialized every read behind the slowest transaction.
export const makeReaderPool = Effect.fn("SqliteReaderPool.make")(function* <R>(options: {
  readonly makeSlot: () => Effect.Effect<ReaderSlot, never, R>;
  readonly available: Effect.Effect<void, SqlError> | undefined;
  readonly size?: number | undefined;
}) {
  const size = options.size ?? DEFAULT_READER_POOL_SIZE;
  if (!Number.isInteger(size) || size < 1) {
    return yield* Effect.die(new Error(`readerPoolSize must be a positive integer, got ${size}`));
  }
  const slots = yield* Effect.forEach(Array.from({ length: size }), () => options.makeSlot());
  // Holding a permit guarantees a free slot, so choosing one never waits.
  const permits = yield* Semaphore.make(size);
  const leased = new Set<number>();
  const lease = () => {
    const index = choose(slots, leased);
    leased.add(index);
    return index;
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
