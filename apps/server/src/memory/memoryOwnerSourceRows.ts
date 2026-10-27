import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const encodeStrings = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

/**
 * The committed versions of the requested messages a hub peer may read. Each question (the latest
 * version of a message, the run state at and after the watermark) is one pass over the thread's
 * stream, so a long thread costs a few index scans instead of one scan per candidate message.
 */
export const readOwnerSourceRows = Effect.fn("MemoryOwnerSourceReader.readOwnerSourceRows")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly threadId: string;
      readonly throughSequence: number;
      readonly messageIds: ReadonlyArray<string>;
    },
  ) {
    const ids = yield* encodeStrings(input.messageIds);
    const candidates = yield* sql<{
      payload_json: string;
      bytes: number;
      sequence: number;
      id: string;
      run_id: string | null;
      role: string;
    }>`SELECT substr(payload_json,1,65537) AS payload_json,length(CAST(payload_json AS BLOB)) AS bytes,sequence,
      json_extract(payload_json,'$.id') AS id,json_extract(payload_json,'$.runId') AS run_id,json_extract(payload_json,'$.role') AS role
      FROM orchestration_events
      WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${input.threadId}
      AND event_type='message.updated' AND sequence<=${input.throughSequence}
      AND json_extract(payload_json,'$.id') IN (SELECT value FROM json_each(${ids}))
      AND coalesce(json_extract(payload_json,'$.streaming'),0)=0
      AND json_extract(payload_json,'$.role') IN ('user','assistant')
      ORDER BY sequence`;
    if (!candidates.length) return [];
    const latest = new Map(
      (yield* sql<{
        id: string;
        sequence: number;
      }>`SELECT json_extract(payload_json,'$.id') AS id,max(sequence) AS sequence
        FROM orchestration_events
        WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${input.threadId}
        AND event_type='message.updated' AND json_extract(payload_json,'$.id') IN (SELECT value FROM json_each(${ids}))
        GROUP BY 1`).map((row) => [row.id, row.sequence]),
    );
    const runIds = [
      ...new Set(candidates.flatMap((row) => (row.run_id === null ? [] : [row.run_id]))),
    ];
    // Per run: its newest status up to the watermark, and whether it changed after it.
    const runs = new Map<string, { status: string | null; changedAfter: boolean }>();
    if (runIds.length) {
      const events = yield* sql<{
        id: string;
        sequence: number;
        status: string | null;
      }>`SELECT json_extract(payload_json,'$.id') AS id,sequence,json_extract(payload_json,'$.status') AS status
        FROM orchestration_events
        WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${input.threadId}
        AND event_type IN ('run.created','run.updated')
        AND json_extract(payload_json,'$.id') IN (SELECT value FROM json_each(${yield* encodeStrings(runIds)}))
        ORDER BY sequence`;
      for (const event of events) {
        const run = runs.get(event.id) ?? { status: null, changedAfter: false };
        if (event.sequence <= input.throughSequence) run.status = event.status;
        else run.changedAfter = true;
        runs.set(event.id, run);
      }
    }
    return candidates
      .filter((row) => {
        if (latest.get(row.id) !== row.sequence) return false;
        if (row.run_id === null) return row.role === "user";
        const run = runs.get(row.run_id);
        return run !== undefined && run.status === "completed" && !run.changedAfter;
      })
      .slice(0, 101)
      .map(({ payload_json, bytes, sequence }) => ({ payload_json, bytes, sequence }));
  },
);
