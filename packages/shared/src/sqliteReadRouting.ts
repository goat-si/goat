import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const ReadOnly = Context.Reference<boolean>("@goat/shared/nodeSqliteClient/ReadOnly", {
  defaultValue: () => false,
});

/** Wrap the whole transaction; existing write transactions retain the writer, and writes on the reader fail as readonly. */
export const readOnly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, ReadOnly, true);

/** Routes new transactions to the writer even inside a readOnly caller; an open transaction keeps its connection. */
export const onWriter = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, ReadOnly, false);
