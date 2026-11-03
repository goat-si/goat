import * as Effect from "effect/Effect";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";
import { admissionSqlError, makeReaderAdmission, READER_LANE_AGING_MS } from "./readerAdmission.ts";

const DEFAULT_READER_POOL_SIZE = 4;

export type ReaderSlotState = "running" | "idle" | "backoff";

export interface ReaderSlot {
  readonly acquire: Effect.Effect<Connection, SqlError>;
  readonly state: () => ReaderSlotState;
}

// A free running slot serves first. While any slot waits out restart backoff, a free failing slot
// is reused before an idle slot starts a worker, so sequential reads keep one retry stream during
// a shared startup fault; concurrent reads add at most one stream per slot, each with its own
// capped backoff.
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
  // Holding a token guarantees a free slot, so choosing one never waits. Background reads leave
  // one slot to interactive reads; fail-fast belongs to client admission, so the pool always waits.
  const gate = yield* makeReaderAdmission({
    limit: size,
    backgroundLimit: size > 1 ? size - 1 : size,
    timeout: null,
    backgroundTimeout: null,
    honorFailFast: false,
    agingMs: READER_LANE_AGING_MS,
  });
  const leased = new Set<number>();
  const lease = () => {
    const index = choose(slots, leased);
    leased.add(index);
    return index;
  };
  const connection = (index: number) => {
    const acquire = slots[index]?.acquire ?? Effect.die(new Error("Unknown reader slot"));
    return options.available === undefined ? acquire : Effect.andThen(options.available, acquire);
  };
  /** Takes a token and a free slot; run the returned release once to free the slot, then the token. */
  const acquireLease = (restore: typeof Effect.interruptible) =>
    Effect.map(Effect.mapError(gate.acquire(restore), admissionSqlError), (token) => {
      const index = lease();
      const release = Effect.sync(() => leased.delete(index)).pipe(
        Effect.andThen(gate.release(token)),
      );
      return { index, release };
    });
  // Cancelling a read retires its slot's worker; the slot returns only after that cancellation finishes.
  const use = <A, E, R2>(body: (connection: Connection) => Effect.Effect<A, E, R2>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(acquireLease(restore), (held) =>
        Effect.ensuring(restore(Effect.flatMap(connection(held.index), body)), held.release),
      ),
    );
  return { acquireLease, connection, use };
});

export type ReaderPool = Effect.Success<ReturnType<typeof makeReaderPool>>;
