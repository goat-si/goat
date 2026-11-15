import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE goatclaw_thread_profiles (
    thread_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, ceiling_json TEXT NOT NULL,
    owner_key TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE goatclaw_lane_reservations (
    id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, child_thread_id TEXT, host TEXT,
    correlation_id TEXT, pending INTEGER NOT NULL DEFAULT 1
  )`;
  yield* sql`CREATE INDEX goatclaw_lanes_owner_idx ON goatclaw_lane_reservations(owner_key)`;
});
