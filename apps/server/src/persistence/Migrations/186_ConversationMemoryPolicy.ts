import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const conversationMemoryPolicySchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE conversation_memory_policy (
    generation INTEGER PRIMARY KEY,
    after_sequence INTEGER NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
  )`;
  yield* sql`CREATE INDEX conversation_memory_policy_boundary
    ON conversation_memory_policy(after_sequence DESC, generation DESC)`;
});

export default conversationMemoryPolicySchema.pipe(
  Effect.andThen(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE channel_inbox ADD COLUMN conversation_memory_enabled INTEGER NOT NULL DEFAULT 1`;
      // One seek serves the run origin and every user message steered into it.
      yield* sql`CREATE INDEX conversation_memory_run_inputs
    ON orchestration_events (stream_id, coalesce(json_extract(payload_json,'$.runId'),json_extract(payload_json,'$.id')), sequence)
    WHERE application_event_version=2 AND aggregate_kind='thread'
      AND (event_type='run.created' OR (event_type='message.updated' AND json_extract(payload_json,'$.role')='user'))`;
    }),
  ),
);
