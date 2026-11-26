import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { readConversationMemoryPolicy } from "./conversationMemoryPolicy.ts";

/** Pin an unbound provider-session credential to the turn pending at tool admission. */
export const issueConversationRunCheck = Effect.fn("ConversationMemoryPolicy.issueRunCheck")(
  function* (
    sql: SqlClient.SqlClient,
    thread: { readonly threadId: string; readonly runId?: string },
  ) {
    const issued = yield* readConversationMemoryPolicy(sql);
    if (!issued)
      return readConversationMemoryPolicy(sql).pipe(Effect.map((row) => row === undefined));
    if (!issued.enabled) return Effect.succeed(false);
    const activeRuns = sql<{ run_id: string }>`SELECT run_id FROM orchestration_v2_projection_runs
    WHERE thread_id=${thread.threadId} AND status IN ('preparing','starting','running','waiting') LIMIT 2`;
    let runId = thread.runId;
    if (!runId) {
      const active = yield* activeRuns;
      if (active.length !== 1) return Effect.succeed(false);
      runId = active[0]!.run_id;
    }
    // Run creation and assigned user inputs share conversation_memory_run_inputs. The user
    // history lookup uses computer_use_first_message_event, including older unassigned versions.
    const check = sql<{ allowed: number }>`WITH inputs AS MATERIALIZED (
    SELECT event_type,sequence,CASE WHEN event_type='run.created' THEN json_extract(payload_json,'$.userMessageId')
      ELSE json_extract(payload_json,'$.id') END AS prompt
    FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread'
      AND (event_type='run.created' OR (event_type='message.updated' AND json_extract(payload_json,'$.role')='user'))
      AND stream_id=${thread.threadId} AND coalesce(json_extract(payload_json,'$.runId'),json_extract(payload_json,'$.id'))=${runId}
      AND (event_type='run.created' OR json_extract(payload_json,'$.runId') IS NOT NULL)
  )
  SELECT (SELECT generation FROM conversation_memory_policy ORDER BY generation DESC LIMIT 1)=${issued.generation}
    AND EXISTS(SELECT 1 FROM inputs WHERE event_type='run.created')
    AND NOT EXISTS(SELECT 1 FROM inputs i WHERE (SELECT enabled FROM conversation_memory_policy
      WHERE after_sequence<i.sequence ORDER BY after_sequence DESC,generation DESC LIMIT 1)=0)
    AND NOT EXISTS(SELECT 1 FROM (SELECT DISTINCT prompt FROM inputs WHERE prompt IS NOT NULL) i
      WHERE coalesce((
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
