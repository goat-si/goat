import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type { EventSinkV2Error } from "./EventSink.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as ProviderCommitBatch from "./ProviderCommitBatch.ts";

interface Publication {
  readonly publish: Array<Effect.Effect<void>>;
}
const CurrentBatch = Context.Reference<Publication | undefined>(
  "goat/orchestration-v2/EventSink/CurrentBatch",
  { defaultValue: () => undefined },
);

type Commit = <A, E, R>(
  transaction: Effect.Effect<A, E, R>,
  publish: (committed: A) => Effect.Effect<void>,
) => Effect.Effect<A, E | SqlError.SqlError, R>;

export interface Shape {
  readonly consumeProviderEvents: <E, R, E2, R2>(
    source: Stream.Stream<ProviderAdapter.ProviderAdapterV2Event, E, R>,
    process: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void, E2, R2>,
    after: Effect.Effect<boolean, E2, R2>,
    canBatch: Effect.Effect<boolean, never, R2>,
  ) => Effect.Effect<
    void,
    E | E2 | ProviderCommitBatch.CommitBatchError | Schema.SchemaError,
    R | R2
  >;
  readonly withProviderBatch: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | EventSinkV2Error, R>;
}
export const make = Effect.fn("EventSinkBatch.make")(function* (
  mapError: (cause: SqlError.SqlError) => EventSinkV2Error,
) {
  const sql = yield* SqlClient.SqlClient;
  // Serialize commit and publish; reordered publication makes clients drop earlier sequences.
  const publishLane = yield* Semaphore.make(1);
  const commitNow = <A, E, R>(
    transaction: Effect.Effect<A, E, R>,
    publish: (committed: A) => Effect.Effect<void>,
  ) =>
    Effect.uninterruptibleMask((restore) => {
      let holdsLane = false;
      const takeLane = publishLane.take(1).pipe(
        Effect.andThen(
          Effect.sync(() => {
            holdsLane = true;
          }),
        ),
        Effect.uninterruptible,
      );
      // Once committed, publish before interruption so parent tasks observe failed child runs.
      return sql
        .withTransaction(Effect.tap(restore(transaction), () => takeLane))
        .pipe(
          Effect.tap(publish),
          Effect.ensuring(Effect.suspend(() => (holdsLane ? publishLane.release(1) : Effect.void))),
        );
    });

  const withProviderBatch = Effect.fn("orchestrationV2.EventSink.providerBatch")(function* <
    A,
    E,
    R,
  >(effect: Effect.Effect<A, E, R>) {
    if ((yield* CurrentBatch) !== undefined) return yield* effect;
    const batch: Publication = { publish: [] };
    let started = false;
    const result = yield* commitNow(
      Effect.sync(() => {
        started = true;
      }).pipe(Effect.andThen(Effect.provideService(effect, CurrentBatch, batch))),
      () => Effect.forEach(batch.publish, (publish) => publish, { discard: true }),
    ).pipe(
      Effect.retry({
        while: (cause) =>
          !started && SqlError.isSqlError(cause) && cause.reason._tag === "LockTimeoutError",
        times: 2,
      }),
    );
    yield* Effect.annotateCurrentSpan({ "orchestration_v2.batch_writes": batch.publish.length });
    return result;
  });
  const coordinator = yield* ProviderCommitBatch.make(
    (work) =>
      withProviderBatch(work).pipe(
        Effect.mapError((cause) =>
          ProviderCommitBatch.isCommitBatchError(cause)
            ? cause
            : new ProviderCommitBatch.CommitBatchError({ cause }),
        ),
      ),
    yield* ProviderCommitBatch.enabled,
    Effect.fnUntraced(function* (work: Effect.Effect<void, ProviderCommitBatch.CommitBatchError>) {
      const batch = yield* CurrentBatch;
      const publicationCount = batch?.publish.length ?? 0;
      return yield* sql.withTransaction(work).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            if (batch !== undefined) batch.publish.length = publicationCount;
          }),
        ),
        Effect.mapError((cause) =>
          ProviderCommitBatch.isCommitBatchError(cause)
            ? cause
            : new ProviderCommitBatch.CommitBatchError({ cause }),
        ),
      );
    }),
  );
  const commitThenPublish: Commit = (transaction, publish) =>
    Effect.flatMap(CurrentBatch, (batch) =>
      batch === undefined
        ? Effect.flatMap(Effect.serviceOption(sql.transactionService), (existing) =>
            Option.isSome(existing)
              ? commitNow(transaction, publish)
              : coordinator.barrier(commitNow(transaction, publish)),
          )
        : transaction.pipe(
            Effect.tap((committed) =>
              Effect.sync(() => {
                batch.publish.push(publish(committed));
              }),
            ),
          ),
    );
  const service: Shape = {
    consumeProviderEvents: coordinator.consume,
    withProviderBatch: (effect) =>
      withProviderBatch(effect).pipe(
        Effect.mapError((cause) => (SqlError.isSqlError(cause) ? mapError(cause) : cause)),
      ),
  };
  return { commitThenPublish, service };
});
