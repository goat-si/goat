import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Index the roster at projection write time, including existing records,
  // so an idle check never parses the historical provider-thread payloads.
  yield* sql`ALTER TABLE orchestration_v2_projection_provider_threads
    ADD COLUMN has_pending_background_work INTEGER GENERATED ALWAYS AS (
      CASE WHEN json_valid(payload_json)
        THEN COALESCE(json_array_length(payload_json, '$.pendingBackgroundTasks'), 0) > 0
        ELSE 0 END
    ) VIRTUAL`;
  yield* sql`CREATE INDEX orchestration_v2_projection_provider_threads_activity_idx
    ON orchestration_v2_projection_provider_threads(has_pending_background_work)
    WHERE has_pending_background_work = 1`;
  yield* sql`CREATE INDEX orchestration_v2_projection_nodes_activity_idx
    ON orchestration_v2_projection_nodes(status, run_id, started_at)
    WHERE status IN ('pending', 'running', 'waiting')`;
  yield* sql`CREATE INDEX orchestration_v2_projection_subagents_activity_idx
    ON orchestration_v2_projection_subagents(status, run_id, started_at)
    WHERE status IN ('pending', 'running', 'waiting')`;
  yield* sql`CREATE INDEX orchestration_v2_projection_provider_turns_activity_idx
    ON orchestration_v2_projection_provider_turns(status, node_id, started_at)
    WHERE status IN ('pending', 'running')`;
  yield* sql`CREATE INDEX orchestration_v2_projection_turn_items_activity_idx
    ON orchestration_v2_projection_turn_items(status, type, run_id)
    WHERE type IN ('command_execution', 'dynamic_tool', 'subagent')
      AND status IN ('pending', 'running', 'waiting')`;
  yield* sql`CREATE INDEX orchestration_v2_projection_runtime_requests_activity_idx
    ON orchestration_v2_projection_runtime_requests(status)
    WHERE status = 'pending'`;
});
