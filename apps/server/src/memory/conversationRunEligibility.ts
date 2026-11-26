import { MAX_CONTINUATION_CHAIN } from "@goat/shared/orchestrationV2ManualContinuation";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { readThreadConversationMemoryPolicy } from "./conversationMemoryPolicy.ts";

/** Pin an unbound provider-session credential to the turn pending at tool admission. */
export const issueConversationRunCheck = Effect.fn("ConversationMemoryPolicy.issueRunCheck")(
  function* (
    sql: SqlClient.SqlClient,
    thread: { readonly threadId: string; readonly runId?: string },
  ) {
    const issued = yield* readThreadConversationMemoryPolicy(sql, thread.threadId);
    if (!issued)
      return readThreadConversationMemoryPolicy(sql, thread.threadId).pipe(
        Effect.map((row) => row === undefined),
      );
    if (!issued.enabled) return Effect.succeed(false);
    const activeRuns = sql<{ run_id: string }>`SELECT run_id FROM orchestration_v2_projection_runs
    WHERE thread_id=${thread.threadId} AND status IN ('preparing','starting','running','waiting') LIMIT 2`;
    let runId = thread.runId;
    if (!runId) {
      const active = yield* activeRuns;
      const [first, second] = active;
      if (!first || second) return Effect.succeed(false);
      runId = first.run_id;
    }
    // Restart and quota recovery create new runs without a new user instruction. Check every
    // contributing run, including its queued edits and steers. Broken chains fail closed.
    const check = sql<{ allowed: number }>`WITH RECURSIVE ancestry(run_id,depth) AS (
      SELECT ${runId},0
      UNION ALL
      SELECT coalesce(json_extract(r.payload_json,'$.restartContinuationOfRunId'),
                      json_extract(r.payload_json,'$.usageLimitContinuationOfRunId')),a.depth+1
      FROM ancestry a CROSS JOIN orchestration_events r
      WHERE coalesce(json_extract(r.payload_json,'$.runId'),json_extract(r.payload_json,'$.id'))=a.run_id
        AND r.application_event_version=2 AND r.aggregate_kind='thread' AND r.stream_id=${thread.threadId}
        AND r.event_type='run.created' AND a.depth<=${MAX_CONTINUATION_CHAIN}
        AND coalesce(json_extract(r.payload_json,'$.restartContinuationOfRunId'),
                     json_extract(r.payload_json,'$.usageLimitContinuationOfRunId')) IS NOT NULL
    ), inputs AS MATERIALIZED (
      SELECT a.run_id,e.event_type,e.sequence,CASE WHEN e.event_type='run.created'
        THEN json_extract(e.payload_json,'$.userMessageId') ELSE json_extract(e.payload_json,'$.id') END AS prompt
      FROM ancestry a CROSS JOIN orchestration_events e
      WHERE coalesce(json_extract(e.payload_json,'$.runId'),json_extract(e.payload_json,'$.id'))=a.run_id
        AND e.application_event_version=2 AND e.aggregate_kind='thread' AND e.stream_id=${thread.threadId}
        AND (e.event_type='run.created' OR (e.event_type='message.updated' AND json_extract(e.payload_json,'$.role')='user'))
        AND (e.event_type='run.created' OR json_extract(e.payload_json,'$.runId') IS NOT NULL)
    )
    SELECT coalesce((SELECT generation FROM conversation_memory_policy ORDER BY generation DESC LIMIT 1),0)=${issued.generation}
      AND NOT EXISTS(SELECT 1 FROM ancestry a WHERE a.depth>${MAX_CONTINUATION_CHAIN} OR NOT EXISTS(
        SELECT 1 FROM inputs i WHERE i.event_type='run.created' AND i.run_id=a.run_id))
      AND NOT EXISTS(SELECT 1 FROM inputs i WHERE (SELECT enabled FROM conversation_memory_policy
        WHERE after_sequence<i.sequence ORDER BY after_sequence DESC,generation DESC LIMIT 1)=0)
      AND NOT EXISTS(SELECT 1 FROM (SELECT DISTINCT prompt FROM inputs WHERE prompt IS NOT NULL) i
        WHERE EXISTS(SELECT 1 FROM conversation_memory_excluded_messages
          WHERE thread_id=${thread.threadId} AND message_id=i.prompt)
        OR coalesce((
          SELECT min(coalesce((SELECT enabled FROM conversation_memory_policy WHERE after_sequence<m.sequence
            ORDER BY after_sequence DESC,generation DESC LIMIT 1),1))
          FROM orchestration_events m WHERE application_event_version=2 AND aggregate_kind='thread'
            AND event_type='message.updated' AND json_extract(payload_json,'$.role')='user'
            AND stream_id=${thread.threadId} AND json_extract(payload_json,'$.id')=i.prompt
        ),0)=0
      ) AS allowed`.pipe(Effect.map((rows) => rows[0]?.allowed === 1));
    if (thread.runId) return check;
    return activeRuns.pipe(
      Effect.flatMap((active) =>
        active.length === 1 && active[0]?.run_id === runId ? check : Effect.succeed(false),
      ),
    );
  },
);
