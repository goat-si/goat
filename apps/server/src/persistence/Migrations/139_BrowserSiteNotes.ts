import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE browser_site_notes (
    origin TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('agent', 'person')),
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE browser_site_note_seed_hidden (origin TEXT PRIMARY KEY)`;
});
