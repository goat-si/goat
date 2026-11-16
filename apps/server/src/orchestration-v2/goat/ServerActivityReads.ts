import type { ServerActivityBlocker } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import type { ServerActivityReadError } from "../ProjectionStore.ts";

/**
 * The store's reads of open work across every thread. ProjectionStore passes its error class
 * and cutoff in so this module never imports it at runtime.
 */
export interface ServerActivityReadDeps {
  readonly sql: SqlClient.SqlClient;
  readonly openedAt: number;
  readonly STALE_BACKGROUND_WORK_MS: number;
  readonly ServerActivityReadError: typeof ServerActivityReadError;
}

export const makeServerActivityReads = (deps: ServerActivityReadDeps) =>
  Effect.sync(() => {
    const { sql, openedAt, STALE_BACKGROUND_WORK_MS, ServerActivityReadError } = deps;
    const activityCutoff = Clock.currentTimeMillis.pipe(
      Effect.map((now) =>
        DateTime.formatIso(DateTime.makeUnsafe(Math.max(openedAt, now - STALE_BACKGROUND_WORK_MS))),
      ),
    );
    const getServerActivityBlockers = Effect.fn("ProjectionStore.getServerActivityBlockers")(
      function* (limit: number) {
        const cutoff = yield* activityCutoff;
        // Work outside a live run counts only after a completed run (a native child that outlived
        // its turn) or without a run. Rows left open under interrupted, failed, or missing runs,
        // and plan or tool nodes a finished turn never closed, are not work.
        const afterRoot = (runId: Statement.Fragment) => sql`(${runId} IS NULL OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs AS run
          WHERE run.run_id = ${runId} AND run.status = 'completed'))`;
        const rows = yield* sql<{
          thread_id: string;
          reason: ServerActivityBlocker["reason"];
          since: string;
          title: string | null;
        }>`WITH blockers(thread_id, reason, since) AS (
          SELECT thread_id,
            CASE status WHEN 'waiting' THEN 'waiting' WHEN 'queued' THEN 'queued' ELSE 'running' END,
            COALESCE(json_extract(payload_json, '$.startedAt'), requested_at)
          FROM orchestration_v2_projection_runs
          WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
            AND (status <> 'queued' OR json_extract(payload_json, '$.queueHeld') IS NOT 1)
          UNION ALL
          SELECT work.thread_id,
            CASE work.kind WHEN 'subagent' THEN 'background' ELSE 'running' END, work.started_at
          FROM orchestration_v2_projection_nodes AS work
          WHERE work.status IN ('pending', 'running', 'waiting') AND work.started_at >= ${cutoff}
            AND ((work.kind = 'subagent' AND ${afterRoot(sql`work.run_id`)})
              -- A held queue whose turn already started still runs it.
              OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS run
                WHERE run.run_id = work.run_id AND run.status = 'queued'))
          UNION ALL
          SELECT work.thread_id, 'background', work.updated_at
          FROM orchestration_v2_projection_subagents AS work
          WHERE work.status IN ('pending', 'running', 'waiting')
            AND work.updated_at >= ${cutoff} AND ${afterRoot(sql`work.run_id`)}
          UNION ALL
          SELECT work.thread_id, 'background', work.updated_at
          FROM orchestration_v2_projection_turn_items AS work
          WHERE work.type IN ('command_execution', 'dynamic_tool', 'subagent')
            AND work.status IN ('pending', 'running', 'waiting')
            AND work.updated_at >= ${cutoff} AND ${afterRoot(sql`work.run_id`)}
          UNION ALL
          SELECT work.thread_id, 'background', work.started_at
          FROM orchestration_v2_projection_provider_turns AS work
          JOIN orchestration_v2_projection_nodes AS node ON node.node_id = work.node_id
          WHERE work.status IN ('pending', 'running') AND node.run_id IS NULL
            AND work.started_at >= ${cutoff}
          UNION ALL
          SELECT work.thread_id, 'waiting', work.created_at
          FROM orchestration_v2_projection_runtime_requests AS work
          JOIN orchestration_v2_projection_nodes AS node ON node.node_id = work.node_id
          WHERE work.status = 'pending' AND node.run_id IS NULL AND work.created_at >= ${cutoff}
          UNION ALL
          SELECT thread_id, 'background', updated_at
          FROM orchestration_v2_projection_provider_threads
          WHERE has_pending_background_work = 1 AND updated_at >= ${cutoff}
            AND thread_id IS NOT NULL
        )
        SELECT blockers.thread_id, blockers.reason, MIN(blockers.since) AS since, thread.title
        FROM blockers
        LEFT JOIN orchestration_v2_projection_threads AS thread
          ON thread.thread_id = blockers.thread_id
        GROUP BY blockers.thread_id, blockers.reason
        ORDER BY since, blockers.thread_id
        LIMIT ${limit}`;
        return rows.map((row): ServerActivityBlocker => ({
          threadId: row.thread_id,
          title: row.title,
          reason: row.reason,
          since: row.since,
        }));
      },
      (effect) => effect.pipe(Effect.mapError((cause) => new ServerActivityReadError({ cause }))),
    );
    const getIgnoredActivity = Effect.fn("ProjectionStore.getIgnoredActivity")(
      function* (limit: number) {
        const rows = yield* sql<{ thread_id: string; open: number; since: string | null }>`
          SELECT work.thread_id, COUNT(*) AS open, MIN(work.started_at) AS since
          FROM orchestration_v2_projection_nodes AS work
          LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = work.run_id
          WHERE work.status IN ('pending', 'running', 'waiting')
            AND work.run_id IS NOT NULL
            AND (run.run_id IS NULL
              OR run.status IN ('completed', 'interrupted', 'failed', 'cancelled'))
          GROUP BY work.thread_id
          ORDER BY since, work.thread_id
          LIMIT ${limit}`;
        return rows.map((row) => ({
          threadId: row.thread_id,
          openRecords: row.open,
          since: row.since,
        }));
      },
      (effect) => effect.pipe(Effect.mapError((cause) => new ServerActivityReadError({ cause }))),
    );
    return { getServerActivityBlockers, getIgnoredActivity };
  });
