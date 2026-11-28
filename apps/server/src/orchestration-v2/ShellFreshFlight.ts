import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ShellSnapshotOptions, ShellSnapshotRead } from "./ProjectionStore.ts";

const MAX_FLIGHTS = 128;
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const makeFreshFlight = Effect.fn("ShellFreshFlight.make")(function* <A, E>(
  onRegression: (minimum: number, observed: number) => E,
) {
  const scope = yield* Effect.scope;
  type Slot = {
    readonly minimum: number;
    readonly done: Deferred.Deferred<{ readonly sequence: number; readonly value: A }, E>;
  };
  const flights = new Map<string, Array<Slot>>();
  let flightCount = 0;
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      const pending = [...flights.values()].flatMap((slots) => slots.map((slot) => slot.done));
      flights.clear();
      return pending;
    }).pipe(
      Effect.flatMap((pending) => Effect.forEach(pending, Deferred.interrupt, { discard: true })),
    ),
  );
  const run = Effect.fn("ShellFreshFlight.run")(function* (
    key: string,
    barrier: Effect.Effect<number, E>,
    build: Effect.Effect<{ readonly sequence: number; readonly value: A }, E>,
  ) {
    const minimum = yield* barrier;
    const snapshot = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (closed) return yield* Effect.interrupt;
        let slot = flights.get(key)?.find((entry) => entry.minimum >= minimum);
        if (slot === undefined && flightCount >= MAX_FLIGHTS) return yield* restore(build);
        if (slot === undefined) {
          slot = {
            minimum,
            done: Deferred.makeUnsafe<{ readonly sequence: number; readonly value: A }, E>(),
          };
          const slots = flights.get(key) ?? [];
          slots.push(slot);
          flights.set(key, slots);
          flightCount++;
          const owner = slot;
          yield* build.pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                const current = flights.get(key);
                const index = current?.indexOf(owner) ?? -1;
                if (current !== undefined && index >= 0) {
                  current.splice(index, 1);
                  flightCount--;
                  if (current.length === 0) flights.delete(key);
                }
              }).pipe(Effect.andThen(Deferred.done(owner.done, exit))),
            ),
            Effect.forkIn(scope),
          );
        }
        return yield* restore(Deferred.await(slot.done));
      }),
    );
    if (snapshot.sequence < minimum)
      return yield* Effect.fail(onRegression(minimum, snapshot.sequence));
    return snapshot.value;
  });
  return { run };
});

export const makeSnapshot = Effect.fn("ShellFreshFlight.makeSnapshot")(function* <
  Rows,
  E,
  ReadError,
>(
  sql: SqlClient.SqlClient,
  read: (options: ShellSnapshotOptions | undefined) => Effect.Effect<Rows, ReadError>,
  decode: (rows: Rows, omitIdleSubagents?: boolean) => Effect.Effect<ShellSnapshotRead, E>,
  onError: (cause: unknown) => E,
) {
  const flight = yield* makeFreshFlight<ShellSnapshotRead, E>((minimum, observed) =>
    onError(new Error(`Shell snapshot sequence regressed from ${minimum} to ${observed}`)),
  );
  const maxSequence = sql<{ readonly sequence: number }>`
    SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
  `.pipe(Effect.map((rows) => rows[0]?.sequence ?? 0));
  return Effect.fn("ShellFreshFlight.snapshot")(function* (options?: ShellSnapshotOptions) {
    if (options?.threadIds !== undefined)
      return yield* sql.withTransaction(read(options)).pipe(
        Effect.mapError(onError),
        Effect.flatMap((rows) => decode(rows, options.omitIdleSubagents)),
      );
    const key = encodeKey({
      location: options?.location ?? null,
      projectId: options?.projectId ?? null,
      familyOf: options?.familyOf ?? null,
      worktreePath: options?.worktreePath ?? null,
      omitIdleSubagents: options?.omitIdleSubagents ?? false,
      unsettledOnly: options?.unsettledOnly ?? false,
    });
    const build = sql
      .withTransaction(
        Effect.gen(function* () {
          const sequence = yield* maxSequence;
          const rows = yield* read(options);
          return { sequence, rows };
        }),
      )
      .pipe(
        Effect.mapError(onError),
        Effect.flatMap(({ sequence, rows }) =>
          decode(rows, options?.omitIdleSubagents).pipe(
            Effect.map((value) => ({ sequence, value })),
          ),
        ),
      );
    return yield* flight.run(key, maxSequence.pipe(Effect.mapError(onError)), build);
  });
});
