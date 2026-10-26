import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import type * as SqlClient from "effect/sql/SqlClient";

export interface ContinuationCandidate {
  readonly sequence: number;
  readonly event_id: string;
  readonly stream_id: string;
  readonly event_type: string;
  readonly payload_json: string;
  readonly occurred_at: string;
}

/**
 * The terminal run events of live threads whose messages are not yet summarized, or whose
 * consolidation is due. The worker re-derives deterministic work from them, so a reader snapshot
 * one commit behind only repeats a no-op insert. On the reader this multi-join scan (hundreds of
 * milliseconds on a large history) no longer occupies the writer the whole server shares.
 */
export const selectContinuationCandidates = (
  sql: SqlClient.SqlClient,
  input: {
    readonly environmentId: string;
    readonly watermark: number;
    readonly now: number;
    readonly limit: number;
  },
) =>
  sql<ContinuationCandidate>`
      WITH progress AS MATERIALIZED (
        SELECT json_extract(metadata_json,'$.sourceThread.threadId') AS thread_id,
        max(CASE WHEN status='completed' THEN json_extract(metadata_json,'$.sourceWatermark.throughSequence') END) AS summarized,
        max(CASE WHEN kind='consolidate' AND status='completed' THEN json_extract(metadata_json,'$.sourceWatermark.throughSequence') END) AS consolidated,
        max(CASE WHEN kind='consolidate' AND status='completed' AND json_extract(metadata_json,'$.sourceWatermark.throughSequence')>=coalesce(json_extract(metadata_json,'$.observedThroughSequence'),0) THEN json_extract(metadata_json,'$.completedAt') END) AS consolidated_at
        FROM memory_outbox WHERE kind IN ('summary','consolidate') AND json_extract(metadata_json,'$.sourceThread.environmentId')=${input.environmentId}
        GROUP BY 1
      ), settled AS MATERIALIZED (
        SELECT json_extract(metadata_json,'$.sourceThread.threadId') AS thread_id,coalesce(json_extract(metadata_json,'$.observedThroughSequence'),json_extract(metadata_json,'$.sourceWatermark.throughSequence')) AS sequence
        FROM memory_outbox WHERE kind IN ('summary','consolidate') AND status IN ('pending','running','retry','failed','cancelled') AND json_extract(metadata_json,'$.sourceThread.environmentId')=${input.environmentId}
      ), latest AS MATERIALIZED (
        SELECT t.thread_id,(SELECT x.sequence FROM orchestration_events x WHERE x.application_event_version=2 AND x.aggregate_kind='thread' AND x.stream_id=t.thread_id AND x.event_type='run.updated' ORDER BY x.sequence DESC LIMIT 1) AS sequence
        FROM orchestration_v2_projection_threads t WHERE t.deleted_at IS NULL
      )
      SELECT e.sequence,e.event_id,e.stream_id,e.event_type,e.payload_json,e.occurred_at
      FROM latest l CROSS JOIN orchestration_events e ON e.sequence=l.sequence LEFT JOIN progress p ON p.thread_id=l.thread_id
      WHERE l.sequence<=${input.watermark} AND json_extract(e.payload_json,'$.status') IN ('completed','failed','interrupted','cancelled')
      AND NOT EXISTS (SELECT 1 FROM settled s WHERE s.thread_id=l.thread_id AND s.sequence=e.sequence)
      AND (EXISTS (SELECT 1 FROM orchestration_events m WHERE m.application_event_version=2 AND m.aggregate_kind='thread' AND m.stream_id=e.stream_id AND m.event_type='message.updated' AND m.sequence<=e.sequence AND m.sequence>coalesce(p.summarized,0))
      OR (EXISTS (SELECT 1 FROM orchestration_events m WHERE m.application_event_version=2 AND m.aggregate_kind='thread' AND m.stream_id=e.stream_id AND m.event_type='message.updated' AND m.sequence<=e.sequence AND m.sequence>coalesce(p.consolidated,0))
      AND ${input.now}-coalesce(p.consolidated_at,(SELECT CAST((julianday(m.occurred_at)-2440587.5)*86400000 AS INTEGER) FROM orchestration_events m WHERE m.application_event_version=2 AND m.aggregate_kind='thread' AND m.stream_id=e.stream_id AND m.event_type='message.updated' ORDER BY m.sequence LIMIT 1))>=86400000))
      ORDER BY e.sequence LIMIT ${input.limit}`.pipe(NodeSqliteClient.readOnly);
