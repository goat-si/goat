import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";

/**
 * Reads on a reader, rerunning once on the writer when reader admission is saturated.
 * Only for reads whose failure would fail a running turn; other reads stay fail-fast so an
 * overload burst does not move onto the writer.
 */
export const readOnReaderOrWriter =
  <Args extends ReadonlyArray<unknown>, A, E, R>(
    method: (...args: Args) => Effect.Effect<A, E, R>,
  ) =>
  (...args: Args): Effect.Effect<A, E, R> =>
    method(...args).pipe(
      NodeSqliteClient.readOnly,
      Effect.catchIf(NodeSqliteClient.isReaderAdmissionOverload, () => method(...args)),
    );
