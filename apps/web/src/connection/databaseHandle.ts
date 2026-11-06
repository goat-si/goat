import { ConnectionTransientError } from "@goat/client-runtime/connection";
import * as Effect from "effect/Effect";

export interface DatabaseHandle {
  readonly get: Effect.Effect<IDBDatabase, ConnectionTransientError>;
  readonly invalidate: (database: IDBDatabase) => Effect.Effect<void>;
}

// Browsers can omit close events; retry InvalidStateError with a fresh connection.
export function withDatabase<A>(
  database: DatabaseHandle,
  use: (opened: IDBDatabase) => Effect.Effect<A, ConnectionTransientError>,
) {
  const closedConnection = Symbol("closedConnection");
  const attempt = Effect.flatMap(database.get, (opened) =>
    use(opened).pipe(
      Effect.catchIf(
        (error) => error.detail.includes("InvalidStateError"),
        (error) =>
          database
            .invalidate(opened)
            .pipe(Effect.andThen(Effect.fail({ [closedConnection]: error } as const))),
      ),
    ),
  );
  return attempt.pipe(
    Effect.catchIf(
      (error): error is { readonly [closedConnection]: ConnectionTransientError } =>
        closedConnection in error,
      () => Effect.flatMap(database.get, use),
    ),
  );
}
