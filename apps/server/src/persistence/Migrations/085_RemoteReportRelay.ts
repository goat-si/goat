import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // On the remote: whether the origin relays this thread's sends to hosts it cannot
  // reach, and the send a relay report carries (JSON RemoteRelaySend, else null).
  const bindings = yield* sql<{ name: string }>`PRAGMA table_info(remote_report_bindings)`;
  if (!bindings.some((column) => column.name === "relay_send"))
    yield* sql`ALTER TABLE remote_report_bindings ADD COLUMN relay_send INTEGER NOT NULL DEFAULT 0`;
  const reports = yield* sql<{ name: string }>`PRAGMA table_info(remote_reports)`;
  if (!reports.some((column) => column.name === "relay"))
    yield* sql`ALTER TABLE remote_reports ADD COLUMN relay TEXT`;
  // On the remote: the report each relayed clientRequestId became, kept after the origin
  // collects it, so a later retry is the same request.
  yield* sql`
    CREATE TABLE IF NOT EXISTS remote_relay_requests (
      correlation_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      PRIMARY KEY (correlation_id, client_request_id)
    ) WITHOUT ROWID
  `;
  // On the origin: whether this dispatch offered to relay (existing rows did not), and
  // the last relay sequence it started sending, so a restart cannot send one twice.
  const dispatches = yield* sql<{ name: string }>`PRAGMA table_info(remote_dispatches)`;
  if (!dispatches.some((column) => column.name === "relay_send"))
    yield* sql`ALTER TABLE remote_dispatches ADD COLUMN relay_send INTEGER NOT NULL DEFAULT 0`;
  if (!dispatches.some((column) => column.name === "relay_attempted"))
    yield* sql`ALTER TABLE remote_dispatches ADD COLUMN relay_attempted INTEGER NOT NULL DEFAULT 0`;
});
