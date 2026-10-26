import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The Remote Link GOAT's own setup added for each cloud machine it created, and the release it
 * owes once that machine is deleted or forgotten. A row outlives the release as a tombstone: a
 * cloud alias names one Boat machine for good, so a removed one is never linked again.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS hub_provisioned_links (
    alias TEXT PRIMARY KEY,
    link_id TEXT,
    tunnel_port INTEGER,
    adding_since TEXT,
    release_requested_at TEXT,
    released_at TEXT
  )`;
});
