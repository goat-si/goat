import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE memory_space_counters (
    space TEXT PRIMARY KEY,
    forget_generation INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE memory_save_suggestions (
    id TEXT PRIMARY KEY,
    space TEXT NOT NULL,
    origin_environment_id TEXT NOT NULL,
    origin_thread_id TEXT NOT NULL,
    text TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    derived_json TEXT NOT NULL,
    lineage_complete INTEGER NOT NULL CHECK (lineage_complete IN (0,1)),
    reason TEXT NOT NULL,
    forget_generation INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepting')),
    attempt INTEGER NOT NULL DEFAULT 0,
    accept_operation_id TEXT
  )`;
  yield* sql`CREATE INDEX memory_save_suggestions_space ON memory_save_suggestions (space, created_at, id)`;
  yield* sql`CREATE INDEX memory_save_suggestions_expiry ON memory_save_suggestions (expires_at)`;
  yield* sql`CREATE INDEX memory_save_suggestions_accept ON memory_save_suggestions (space, accept_operation_id)
    WHERE accept_operation_id IS NOT NULL`;
  for (const action of ["INSERT", "DELETE"] as const) {
    const row = action === "INSERT" ? "NEW" : "OLD";
    const bytes = [
      128,
      ...[
        "id",
        "space",
        "origin_environment_id",
        "origin_thread_id",
        "text",
        "scope_json",
        "derived_json",
      ].map((column) => `length(CAST(${row}.${column} AS BLOB))`),
    ].join("+");
    const change = (space: string) =>
      action === "INSERT"
        ? `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES (${space},'usage_local_provenance_bytes','',${bytes})
         ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value;`
        : `UPDATE memory_quota_counters SET value=value-(${bytes}) WHERE space=${space} AND dimension='usage_local_provenance_bytes' AND scope_key='';`;
    yield* sql.unsafe(`CREATE TRIGGER memory_save_suggestions_usage_${action.toLowerCase()} AFTER ${action} ON memory_save_suggestions
      BEGIN ${change(`${row}.space`)} ${change("'_usage_environment'")} END`);
  }
});
