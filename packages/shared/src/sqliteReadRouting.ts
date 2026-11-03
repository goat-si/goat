import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

// SqlClient masks transaction acquisition, so readOnly carries the caller's interruption policy.
export const ReadOnly = Context.Reference<typeof Effect.interruptible | undefined>(
  "@goat/shared/nodeSqliteClient/ReadOnly",
  { defaultValue: () => undefined },
);

/** Wrap the whole transaction; existing write transactions retain the writer, and writes on the reader fail as readonly. */
export const readOnly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    restore(Effect.provideService(effect, ReadOnly, restore)),
  );

/** Routes new transactions to the writer even inside a readOnly caller; an open transaction keeps its connection. */
export const onWriter = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, ReadOnly, undefined);
