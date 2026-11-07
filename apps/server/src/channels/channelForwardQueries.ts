import type { ChannelTaskId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ChannelLedgerError, ChannelOutboxInsert } from "./ChannelLedger.ts";

export const forwardQueries = <E, F>(
  sql: SqlClient.SqlClient,
  toLedgerError: (detail: string) => (cause: unknown) => ChannelLedgerError,
  fence: (owner: string) => Effect.Effect<void, E>,
  insertDeliveries: (
    rows: ReadonlyArray<ChannelOutboxInsert>,
    now: string,
  ) => Effect.Effect<void, F>,
) => ({
  hasPendingForward: (taskId: ChannelTaskId) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM channel_task_events
      WHERE task_id = ${taskId} AND forward_state = 'pending' LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toLedgerError("hasPendingForward")),
    ),
  hasEarlierPendingForward: (input: {
    readonly taskId: ChannelTaskId;
    readonly sequence: number;
  }) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM channel_task_events
      WHERE task_id = ${input.taskId} AND forward_state = 'pending'
        AND sequence < ${input.sequence} LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toLedgerError("hasEarlierPendingForward")),
    ),
  isForwardPending: (sequence: number) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM channel_task_events
      WHERE sequence = ${sequence} AND forward_state = 'pending'
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toLedgerError("isForwardPending")),
    ),
  completeForward: (input: {
    readonly owner: string;
    readonly sequence: number;
    readonly clearPendingAnswerMessageId?: string | undefined;
    readonly deliveries?: {
      readonly rows: ReadonlyArray<ChannelOutboxInsert>;
      readonly now: string;
    };
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* fence(input.owner);
          const completed = yield* sql<{ readonly task_id: ChannelTaskId }>`
        UPDATE channel_task_events SET forward_state = 'done'
        WHERE sequence = ${input.sequence} AND forward_state = 'pending' RETURNING task_id
      `;
          if (completed[0] !== undefined && input.clearPendingAnswerMessageId !== undefined) {
            yield* sql`
          UPDATE channel_tasks SET pending_answer_message_id = NULL
          WHERE task_id = ${completed[0].task_id}
            AND pending_answer_message_id = ${input.clearPendingAnswerMessageId}
        `;
          }
          if (completed[0] !== undefined && input.deliveries !== undefined)
            yield* insertDeliveries(input.deliveries.rows, input.deliveries.now);
        }),
      )
      .pipe(Effect.mapError(toLedgerError("completeForward"))),
});
