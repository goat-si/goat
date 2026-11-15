import type { OrchestrationV2ThreadProjection, RunId, ThreadId } from "@goat/contracts";
import { RunId as RunIdSchema } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** A thread's newest run by ordinal, whatever its status, and whether the thread is closed. */
export interface ThreadNewestRun {
  readonly archivedAt: DateTime.Utc | null;
  readonly deletedAt: DateTime.Utc | null;
  readonly newestRun: { readonly id: RunId; readonly ordinal: number } | null;
}

const utc = (value: string | null) => (value === null ? null : DateTime.makeUnsafe(value));

/** One read: the thread row and its newest run through the (thread_id, ordinal) index. */
export const selectThreadNewestRun = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{
    readonly archived_at: string | null;
    readonly deleted_at: string | null;
    readonly run_id: string | null;
    readonly ordinal: number | null;
  }>`
    SELECT json_extract(t.payload_json, '$.archivedAt') AS archived_at, t.deleted_at,
      newest.run_id, newest.ordinal
    FROM orchestration_v2_projection_threads t
    LEFT JOIN (
      SELECT run_id, ordinal FROM orchestration_v2_projection_runs
      WHERE thread_id = ${threadId}
      ORDER BY ordinal DESC
      LIMIT 1
    ) newest ON 1 = 1
    WHERE t.thread_id = ${threadId}
  `.pipe(
    Effect.map((rows): ThreadNewestRun | null => {
      const row = rows[0];
      if (row === undefined) return null;
      return {
        archivedAt: utc(row.archived_at),
        deletedAt: utc(row.deleted_at),
        newestRun:
          row.run_id === null || row.ordinal === null
            ? null
            : { id: RunIdSchema.make(row.run_id), ordinal: row.ordinal },
      };
    }),
  );

export const projectionThreadNewestRun = (
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
): ThreadNewestRun | null => {
  if (projection === undefined) return null;
  const newest = projection.runs.reduce<(typeof projection.runs)[number] | undefined>(
    (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
    undefined,
  );
  return {
    archivedAt: projection.thread.archivedAt,
    deletedAt: projection.thread.deletedAt,
    newestRun: newest === undefined ? null : { id: newest.id, ordinal: newest.ordinal },
  };
};
