import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * goat_eval's journal (docs/internals/agent-surface.md#replay-safety). A run belongs to one
 * principal and holds its parsed program; claim_id fences each execution of it and boot_id names
 * the server process that holds a running run or step. A step is keyed by its coordinate in the
 * program and records the grant its call ran under, so a replay can require it again.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS mcp_eval_runs (
    eval_run_id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, principal TEXT NOT NULL,
    client_request_id TEXT, program_digest TEXT NOT NULL, program_json TEXT NOT NULL,
    bindings_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'halted')),
    boot_id TEXT NOT NULL, claim_id TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS mcp_eval_runs_expiry_idx ON mcp_eval_runs(expires_at)`;
  yield* sql`CREATE TABLE IF NOT EXISTS mcp_eval_steps (
    eval_run_id TEXT NOT NULL, step_coord TEXT NOT NULL, path TEXT NOT NULL,
    effect TEXT NOT NULL, args_digest TEXT NOT NULL, request_id TEXT, grant_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'unknown')),
    boot_id TEXT NOT NULL, claim_id TEXT NOT NULL, result_json TEXT,
    created_at TEXT NOT NULL, completed_at TEXT,
    PRIMARY KEY (eval_run_id, step_coord)
  )`;
});
