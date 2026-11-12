import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * When a dispatch's host stopped answering, and why GOAT stopped tracking it. end_reason is set
 * with ended_at and only in the state it names, so a writer that moves such a row on without
 * clearing both fails here instead of leaving a row that consumers would misread.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(remote_dispatches)
  `;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("host_unavailable_since")) {
    yield* sql`ALTER TABLE remote_dispatches ADD COLUMN host_unavailable_since TEXT`;
  }
  if (!names.has("ended_at")) {
    yield* sql`ALTER TABLE remote_dispatches ADD COLUMN ended_at TEXT`;
  }
  if (!names.has("end_reason")) {
    yield* sql`ALTER TABLE remote_dispatches ADD COLUMN end_reason TEXT CHECK (
      (end_reason IS NULL) = (ended_at IS NULL) AND (
        end_reason IS NULL
        OR (end_reason = 'host_unreachable' AND state = 'lost')
        OR (end_reason = 'dismissed' AND state = 'cancelled')))`;
  }
});
