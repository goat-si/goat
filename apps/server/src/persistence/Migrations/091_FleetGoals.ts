import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fleet goals (docs/internals/agentic-k8s.md, "Persistence"). Goals are control-plane rows outside
 * the orchestration event stream. Spec, owner and status are JSON the contract decodes; the
 * columns the controller selects and compares on sit beside them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fleet_goals (
      id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      client_request_id TEXT,
      owner_json TEXT NOT NULL,
      title TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      generation INTEGER NOT NULL,
      status_json TEXT NOT NULL,
      observed_generation INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      next_reconcile_at TEXT,
      deletion_requested_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_goals_client_request
    ON fleet_goals(owner_key, client_request_id) WHERE client_request_id IS NOT NULL
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_fleet_goals_due ON fleet_goals(paused, next_reconcile_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fleet_goal_workers (
      goal_id TEXT NOT NULL,
      slot INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      host TEXT,
      thread_id TEXT,
      watch_id TEXT,
      branch TEXT,
      model_json TEXT NOT NULL,
      state TEXT NOT NULL,
      launch_client_request_id TEXT NOT NULL,
      tried_json TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (goal_id, slot)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fleet_goal_events (
      goal_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      reason TEXT NOT NULL,
      message TEXT NOT NULL,
      slot INTEGER,
      attempt INTEGER,
      action_id TEXT,
      PRIMARY KEY (goal_id, seq)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fleet_goal_actions (
      action_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      kind TEXT NOT NULL,
      host TEXT,
      reserved_slot INTEGER,
      claimed_at TEXT NOT NULL,
      settled_at TEXT,
      outcome TEXT,
      -- The thread a launch started, written once when it is known. It outlives slot records,
      -- so a status write lost to a generation change cannot orphan the thread.
      thread_host TEXT,
      thread_id TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_fleet_goal_actions_goal ON fleet_goal_actions(goal_id, kind)`;
});
