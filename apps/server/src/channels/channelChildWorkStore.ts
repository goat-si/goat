/**
 * channelChildWorkStore - typed persistence for child-work records on channel_runtime_state.
 *
 * Records key as child-work:<taskId>:<childWorkId> next to the worker-run rows, so no migration
 * competes with other work for an id and one task's records scan by prefix. Admission's capacity
 * check and insert commit in one SQLite write transaction, which is what serializes competing
 * admissions; readers decode and filter in memory because a task's child work stays small.
 *
 * @module channelChildWorkStore
 */
import {
  ChannelChildWork,
  type ChannelChildWorkDestination,
  type ChannelChildWorkId,
  type ChannelChildWorkState,
  type ChannelTaskId,
  isChannelChildWorkActive,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class ChannelChildWorkStoreError extends Schema.TaggedError<ChannelChildWorkStoreError>()(
  "ChannelChildWorkStoreError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const toStoreError =
  (operation: string) =>
  (cause: unknown): ChannelChildWorkStoreError =>
    new ChannelChildWorkStoreError({
      operation,
      detail: cause instanceof Error ? cause.message : String(cause),
      cause,
    });

const encode = Schema.encodeSync(Schema.fromJsonString(ChannelChildWork));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelChildWork));

const keyFor = (taskId: ChannelTaskId, childWorkId: ChannelChildWorkId) =>
  "child-work:" + taskId + ":" + childWorkId;
const prefixFor = (taskId: ChannelTaskId) => "child-work:" + taskId + ":";
// The exclusive scan bound swaps the trailing ":" for its successor, matching listWorkerRuns.
const afterFor = (taskId: ChannelTaskId) => "child-work:" + taskId + ";";
const isDelegateSurface = (surface: ChannelChildWork["surface"]) =>
  surface === "delegate_local" || surface === "delegate_remote";

export type ChannelChildWorkAdmitResult =
  | { readonly _tag: "admitted" }
  | { readonly _tag: "at_capacity" }
  | { readonly _tag: "existing"; readonly record: ChannelChildWork };

export class ChannelChildWorkStore extends Context.Service<
  ChannelChildWorkStore,
  {
    readonly get: (
      taskId: ChannelTaskId,
      childWorkId: ChannelChildWorkId,
    ) => Effect.Effect<ChannelChildWork | undefined, ChannelChildWorkStoreError>;
    /** Every record of one task, any state, any generation, oldest first. */
    readonly listForTask: (
      taskId: ChannelTaskId,
    ) => Effect.Effect<ReadonlyArray<ChannelChildWork>, ChannelChildWorkStoreError>;
    /** Every record still holding capacity, across owners; the reconcile pass reads these. */
    readonly listActive: () => Effect.Effect<
      ReadonlyArray<ChannelChildWork>,
      ChannelChildWorkStoreError
    >;
    /**
     * The record whose destination is this thread, any state. A completed child's thread is
     * still a recorded child, so depth enforcement reads terminal records too.
     */
    readonly findByDestinationThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ChannelChildWork | undefined, ChannelChildWorkStoreError>;
    /**
     * The capacity decision and the reservation in one write transaction: an existing record is
     * the retry's reservation, a task at capacity refuses, otherwise the reserved row commits.
     */
    readonly admitReserved: (
      record: ChannelChildWork,
      capacity: number,
    ) => Effect.Effect<ChannelChildWorkAdmitResult, ChannelChildWorkStoreError>;
    /**
     * Compare-and-set on state; returns the updated record, or undefined when the record moved
     * on (another writer won the race) or is gone.
     */
    readonly transition: (input: {
      readonly taskId: ChannelTaskId;
      readonly childWorkId: ChannelChildWorkId;
      readonly from: ReadonlyArray<ChannelChildWorkState>;
      readonly to: ChannelChildWorkState;
      readonly destination?: ChannelChildWorkDestination | undefined;
      readonly now: string;
    }) => Effect.Effect<ChannelChildWork | undefined, ChannelChildWorkStoreError>;
  }
>()("goat/channels/channelChildWorkStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readRows = (rows: ReadonlyArray<{ readonly value_json: string }>) =>
    rows.map((row) => decode(row.value_json));

  const get = (taskId: ChannelTaskId, childWorkId: ChannelChildWorkId) =>
    sql<{ readonly value_json: string }>`
      SELECT value_json FROM channel_runtime_state WHERE key = ${keyFor(taskId, childWorkId)}
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : decode(rows[0].value_json))),
      Effect.mapError(toStoreError("get")),
    );

  const listForTask = (taskId: ChannelTaskId) =>
    sql<{ readonly value_json: string }>`
      SELECT value_json FROM channel_runtime_state
      WHERE key >= ${prefixFor(taskId)} AND key < ${afterFor(taskId)}
      ORDER BY key
    `.pipe(Effect.map(readRows), Effect.mapError(toStoreError("listForTask")));

  const listActive = () =>
    sql<{ readonly value_json: string }>`
      SELECT value_json FROM channel_runtime_state
      WHERE key >= ${"child-work:"} AND key < ${"child-work;"}
    `.pipe(
      Effect.map((rows) =>
        readRows(rows).filter((record) => isChannelChildWorkActive(record.state)),
      ),
      Effect.mapError(toStoreError("listActive")),
    );

  const findByDestinationThread = (threadId: ThreadId) =>
    sql<{ readonly value_json: string }>`
      SELECT value_json FROM channel_runtime_state
      WHERE key >= ${"child-work:"} AND key < ${"child-work;"}
        AND value_json LIKE ${"%" + threadId + "%"}
    `.pipe(
      Effect.map((rows) =>
        readRows(rows).find((record) => record.destination?.threadId === threadId),
      ),
      Effect.mapError(toStoreError("findByDestinationThread")),
    );

  const admitReserved = (record: ChannelChildWork, capacity: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql<{ readonly value_json: string }>`
            SELECT value_json FROM channel_runtime_state
            WHERE key = ${keyFor(record.taskId, record.childWorkId)}
          `;
          if (existing[0] !== undefined) {
            return {
              _tag: "existing",
              record: decode(existing[0].value_json),
            } as const satisfies ChannelChildWorkAdmitResult;
          }
          const siblings = yield* sql<{ readonly value_json: string }>`
            SELECT value_json FROM channel_runtime_state
            WHERE key >= ${prefixFor(record.taskId)} AND key < ${afterFor(record.taskId)}
          `;
          const delegate = isDelegateSurface(record.surface);
          const active = readRows(siblings).filter(
            (sibling) =>
              isChannelChildWorkActive(sibling.state) &&
              isDelegateSurface(sibling.surface) === delegate,
          ).length;
          if (active >= capacity) {
            return { _tag: "at_capacity" } as const satisfies ChannelChildWorkAdmitResult;
          }
          yield* sql`
            INSERT INTO channel_runtime_state (key, value_json, updated_at)
            VALUES (${keyFor(record.taskId, record.childWorkId)}, ${encode(record)}, ${record.updatedAt})
          `;
          return { _tag: "admitted" } as const satisfies ChannelChildWorkAdmitResult;
        }),
      )
      .pipe(Effect.mapError(toStoreError("admitReserved")));

  const transition = Effect.fn("ChannelChildWorkStore.transition")(function* (input: {
    readonly taskId: ChannelTaskId;
    readonly childWorkId: ChannelChildWorkId;
    readonly from: ReadonlyArray<ChannelChildWorkState>;
    readonly to: ChannelChildWorkState;
    readonly destination?: ChannelChildWorkDestination | undefined;
    readonly now: string;
  }) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly value_json: string }>`
            SELECT value_json FROM channel_runtime_state
            WHERE key = ${keyFor(input.taskId, input.childWorkId)}
          `;
          if (rows[0] === undefined) return undefined;
          const current = decode(rows[0].value_json);
          if (!input.from.includes(current.state)) return undefined;
          const next: ChannelChildWork = {
            ...current,
            state: input.to,
            ...(input.destination === undefined ? {} : { destination: input.destination }),
            updatedAt: input.now,
          };
          yield* sql`
            UPDATE channel_runtime_state SET value_json = ${encode(next)}, updated_at = ${input.now}
            WHERE key = ${keyFor(input.taskId, input.childWorkId)}
          `;
          return next;
        }),
      )
      .pipe(Effect.mapError(toStoreError("transition")));
  });

  return ChannelChildWorkStore.of({
    get,
    listForTask,
    listActive,
    findByDestinationThread,
    admitReserved,
    transition,
  });
});

export const layer = Layer.effect(ChannelChildWorkStore, make);
