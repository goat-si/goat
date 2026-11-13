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
  localChildThreadId,
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
const SETTLED_STATES: ReadonlyArray<ChannelChildWorkState> = ["completed", "failed", "cancelled"];

export type ChannelChildWorkAdmitResult =
  | { readonly _tag: "admitted" }
  | { readonly _tag: "at_capacity" }
  | { readonly _tag: "existing"; readonly record: ChannelChildWork }
  /** The owning task finished or a retry moved it to another generation. */
  | { readonly _tag: "owner_settled" };

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
    readonly listRecentForTask: (
      taskId: ChannelTaskId,
      limit: number,
    ) => Effect.Effect<
      { readonly children: ReadonlyArray<ChannelChildWork>; readonly truncated: boolean },
      ChannelChildWorkStoreError
    >;
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
     * on (another writer won the race) or is gone. threadIdIfMissing is written only when the
     * current record has no thread id, so it never replaces one; a call that also passes a
     * destination is refused, since that destination would replace the current one.
     */
    readonly transition: (input: {
      readonly taskId: ChannelTaskId;
      readonly childWorkId: ChannelChildWorkId;
      readonly from: ReadonlyArray<ChannelChildWorkState>;
      readonly to: ChannelChildWorkState;
      readonly destination?: ChannelChildWorkDestination | undefined;
      readonly threadIdIfMissing?: ThreadId | undefined;
      readonly now: string;
    }) => Effect.Effect<ChannelChildWork | undefined, ChannelChildWorkStoreError>;
    /**
     * Up to `limit` child-work rows after this key, in key order: the last key read, how many
     * rows were read, and among them the settled remote thread launches with no thread whose
     * dispatch holds the thread its host acknowledged.
     */
    readonly pageSettledLaunches: (
      after: string,
      limit: number,
    ) => Effect.Effect<
      {
        readonly lastKey: string | undefined;
        readonly inspected: number;
        readonly candidates: ReadonlyArray<{
          readonly record: ChannelChildWork;
          readonly remoteThreadId: string;
        }>;
      },
      ChannelChildWorkStoreError
    >;
    /**
     * Fills a settled remote launch's missing thread when the record still names this
     * correlation and has none; true only when this call filled it. Timestamps stay as settled.
     */
    readonly fillSettledLaunchThread: (input: {
      readonly taskId: ChannelTaskId;
      readonly childWorkId: ChannelChildWorkId;
      readonly correlationId: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<boolean, ChannelChildWorkStoreError>;
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

  const listRecentForTask = Effect.fn("ChannelChildWorkStore.listRecentForTask")(function* (
    taskId: ChannelTaskId,
    limit: number,
  ) {
    const rows = yield* sql<{ readonly value_json: string }>`
      SELECT value_json FROM channel_runtime_state
      WHERE key >= ${prefixFor(taskId)} AND key < ${afterFor(taskId)}
      ORDER BY json_extract(value_json, '$.createdAt') DESC, key DESC LIMIT ${limit + 1}
    `.pipe(Effect.mapError(toStoreError("listRecentForTask")));
    return { children: readRows(rows.slice(0, limit)), truncated: rows.length > limit };
  });

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
        readRows(rows).find((record) => localChildThreadId(record.destination) === threadId),
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
          // Checked in this write so a retry and an admission are ordered: either the retry sees
          // this record, or this admission sees the task at its next generation.
          const owners = yield* sql<{ readonly generation: number }>`
            SELECT generation FROM channel_tasks WHERE task_id = ${record.taskId}
              AND status NOT IN ('completed', 'failed', 'cancelled')
          `;
          if (owners[0]?.generation !== record.generation) {
            return { _tag: "owner_settled" } as const satisfies ChannelChildWorkAdmitResult;
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
    readonly threadIdIfMissing?: ThreadId | undefined;
    readonly now: string;
  }) {
    if (input.destination !== undefined && input.threadIdIfMissing !== undefined)
      return yield* new ChannelChildWorkStoreError({
        operation: "transition",
        detail: "A transition takes a destination or threadIdIfMissing, not both.",
      });
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
          const filled =
            input.threadIdIfMissing === undefined || current.destination?.threadId !== undefined
              ? (input.destination ?? current.destination)
              : { ...current.destination, threadId: input.threadIdIfMissing };
          const next: ChannelChildWork = {
            ...current,
            state: input.to,
            ...(filled === undefined ? {} : { destination: filled }),
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

  // The inner LIMIT bounds the rows read, whether or not any of them match.
  const pageSettledLaunches = (after: string, limit: number) =>
    sql<{
      readonly key: string;
      readonly value_json: string;
      readonly remote_thread_id: string | null;
    }>`
      SELECT c.key, c.value_json, d.remote_thread_id FROM (
        SELECT key, value_json FROM channel_runtime_state
        WHERE key > ${after} AND key >= ${"child-work:"} AND key < ${"child-work;"}
        ORDER BY key LIMIT ${limit}
      ) c
      LEFT JOIN remote_dispatches d
        ON json_extract(c.value_json, '$.surface') = 'ssh_thread_launch'
        AND json_extract(c.value_json, '$.state') IN ${sql.in(SETTLED_STATES)}
        AND json_extract(c.value_json, '$.destination.threadId') IS NULL
        AND d.correlation_id = json_extract(c.value_json, '$.destination.correlationId')
        AND d.kind = 'thread' AND d.host = json_extract(c.value_json, '$.destination.host')
      ORDER BY c.key
    `.pipe(
      Effect.map((rows) => ({
        lastKey: rows.at(-1)?.key,
        inspected: rows.length,
        candidates: rows.flatMap((row) =>
          row.remote_thread_id === null
            ? []
            : [{ record: decode(row.value_json), remoteThreadId: row.remote_thread_id }],
        ),
      })),
      Effect.mapError(toStoreError("pageSettledLaunches")),
    );

  const fillSettledLaunchThread = Effect.fn("ChannelChildWorkStore.fillSettledLaunchThread")(
    function* (input: {
      readonly taskId: ChannelTaskId;
      readonly childWorkId: ChannelChildWorkId;
      readonly correlationId: string;
      readonly threadId: ThreadId;
    }) {
      const key = keyFor(input.taskId, input.childWorkId);
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly value_json: string }>`
              SELECT value_json FROM channel_runtime_state WHERE key = ${key}
            `;
            if (rows[0] === undefined) return false;
            const current = decode(rows[0].value_json);
            const destination = current.destination;
            if (
              current.surface !== "ssh_thread_launch" ||
              !SETTLED_STATES.includes(current.state) ||
              destination?.correlationId !== input.correlationId ||
              destination.threadId !== undefined
            )
              return false;
            const next = { ...current, destination: { ...destination, threadId: input.threadId } };
            yield* sql`UPDATE channel_runtime_state SET value_json = ${encode(next)} WHERE key = ${key}`;
            return true;
          }),
        )
        .pipe(Effect.mapError(toStoreError("fillSettledLaunchThread")));
    },
  );

  return ChannelChildWorkStore.of({
    get,
    listForTask,
    listRecentForTask,
    listActive,
    findByDestinationThread,
    admitReserved,
    transition,
    pageSettledLaunches,
    fillSettledLaunchThread,
  });
});

export const layer = Layer.effect(ChannelChildWorkStore, make);
