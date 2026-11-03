import type { ChannelTaskId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ChannelLedgerError } from "./ChannelLedger.ts";

export const forwardQueries = (
  sql: SqlClient.SqlClient,
  toLedgerError: (detail: string) => (cause: unknown) => ChannelLedgerError,
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
});
