import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE hub_node_registrations (
    route_id TEXT PRIMARY KEY, environment_id TEXT, label TEXT,
    target_json TEXT NOT NULL, added_by_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE hub_node_route_state (
    route_id TEXT PRIMARY KEY, environment_id TEXT, status TEXT NOT NULL,
    checked_at TEXT, last_seen_at TEXT, last_error TEXT
  )`;
  yield* sql`CREATE TABLE hub_node_imports (
    source TEXT PRIMARY KEY, outcome TEXT NOT NULL, imported INTEGER NOT NULL,
    at TEXT NOT NULL, notice_dismissed_at TEXT
  )`;
});
