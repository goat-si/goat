import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One row per clientRequestId a keyed MCP write reserved (docs/internals/agent-surface.md#idempotency).
 * boot_id names the server process that holds a running row, so a later process reads it as
 * unknown; receipt_id fences each settlement to the reservation that made it. The audit columns
 * say who reserved it under which grant: principal, profile_id, ceiling and host. grant_json is
 * that grant in full, which a replay must still hold.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS mcp_request_reservations (
    environment_id TEXT NOT NULL, principal TEXT NOT NULL, path TEXT NOT NULL,
    client_request_id TEXT NOT NULL, receipt_id TEXT NOT NULL UNIQUE, tool_name TEXT NOT NULL,
    args_digest TEXT NOT NULL, profile_id TEXT, ceiling TEXT, host TEXT, grant_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'unknown')),
    boot_id TEXT NOT NULL, result_json TEXT, failure_json TEXT, outcome_code TEXT,
    created_at TEXT NOT NULL, completed_at TEXT, expires_at TEXT NOT NULL,
    PRIMARY KEY (environment_id, principal, path, client_request_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS mcp_request_reservations_expiry_idx
    ON mcp_request_reservations(expires_at)`;
});
