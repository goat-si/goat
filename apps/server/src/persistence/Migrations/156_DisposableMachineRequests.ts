import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * An attach's request key: a digest of its caller and clientRequestId. A repeat with the same key
 * answers the stored record's status, never the invite token, which this table never holds. A
 * reissue's key is reserved in disposable_machine_requests before it cancels anything, and keeps
 * its outcome: running, ok, settled, or the refusal it ended with.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE disposable_machines ADD COLUMN request_key TEXT`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS disposable_machines_request_key
    ON disposable_machines(request_key) WHERE request_key IS NOT NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS disposable_machine_requests (
    request_key TEXT PRIMARY KEY,
    attach_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS disposable_machine_requests_attach
    ON disposable_machine_requests(attach_id)`;
});
