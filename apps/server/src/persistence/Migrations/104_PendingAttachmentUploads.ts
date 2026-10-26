import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Who prepared each pending attachment upload, kept across restarts: a replayed
 * goat_attachment_prepare_upload hands back a URL that still accepts bytes, so its caller must
 * still be able to find and discard the upload. Rows go when the upload is sent or discarded, or
 * once the pending file sweep would have removed it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS mcp_pending_uploads (
    attachment_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('image', 'file')),
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    issued_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS mcp_pending_uploads_owner_idx
    ON mcp_pending_uploads(owner, issued_at)`;
});
