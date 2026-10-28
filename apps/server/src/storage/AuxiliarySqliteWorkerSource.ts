export const source = String.raw`
const { parentPort, workerData: job } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const select = "SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.handle_id,\n  m.is_from_me, m.date, m.date_read, m.cache_roomnames, m.associated_message_type,\n  m.item_type, m.balloon_bundle_id, h.id AS sender_handle, h.service AS sender_service,\n  c.ROWID AS chat_rowid, c.guid AS chat_guid, c.chat_identifier, c.style,\n  (SELECT COUNT(*) FROM chat_message_join AS j WHERE j.message_id = m.ROWID) AS chat_join_count\n  FROM message AS m\n  LEFT JOIN handle AS h ON h.ROWID = m.handle_id\n  LEFT JOIN chat AS c ON c.ROWID = (\n    SELECT MIN(j.chat_id) FROM chat_message_join AS j WHERE j.message_id = m.ROWID\n  )";
let db;
let output;
let failure;
let category = "query_failed";
let bytes = 0;
let count = 0;
function collect(statement, ...params) {
  const rows = [];
  for (const row of statement.iterate(...params)) {
    count += 1;
    if (count > 100000) throw new Error("result limit");
    for (const value of Object.values(row)) {
      bytes += typeof value === "string" ? Buffer.byteLength(value) :
        value instanceof Uint8Array ? value.byteLength : 8;
    }
    if (bytes > 8 * 1024 * 1024) throw new Error("result limit");
    rows.push(row);
  }
  return rows;
}
function readSelectedJob(connection, input) {
  const result = { worktreePaths: [], projectRoots: [], rows: [], max: 0 };
  if (input.kind === "worktrees" || input.kind === "bindings") {
    result.worktreePaths = collect(connection.prepare(
      "SELECT json_extract(payload_json, '$.worktreePath') AS path FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL",
    )).flatMap((row) => typeof row.path === "string" ? [row.path] : []);
    if (input.kind === "bindings") result.projectRoots = collect(connection.prepare(
      "SELECT workspace_root AS root FROM projection_projects WHERE deleted_at IS NULL",
    )).flatMap((row) => typeof row.root === "string" ? [row.root] : []);
  } else if (input.kind === "imessage-max") {
    const rows = collect(connection.prepare("SELECT MAX(ROWID) AS max FROM message"));
    result.max = Number(rows[0]?.max ?? 0);
    if (!Number.isSafeInteger(result.max)) throw new Error("invalid rowid");
  } else if (input.kind === "imessage-rows") {
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0 ||
        !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)
      throw new Error("invalid range");
    result.rows = collect(connection.prepare(select + " WHERE m.ROWID > ? ORDER BY m.ROWID ASC LIMIT ?"), input.cursor, input.limit);
  } else if (input.kind === "imessage-row") {
    if (!Number.isSafeInteger(input.rowId) || input.rowId < 1) throw new Error("invalid rowid");
    result.rows = collect(connection.prepare(select + " WHERE m.ROWID = ?"), input.rowId);
  } else {
    throw new Error("unknown read kind");
  }
  return result;
}
try {
  db = new DatabaseSync(job.file, { readOnly: true, allowExtension: false, timeout: 2000 });
  output = readSelectedJob(db, job);
} catch (cause) {
  const code = typeof cause?.code === "string" ? cause.code : "";
  const message = cause instanceof Error ? cause.message : "";
  if (/EACCES|EPERM|SQLITE_CANTOPEN/.test(code) || /unable to open|authorization denied/i.test(message))
    category = "database_unavailable";
  else if (/no such table|no such column/i.test(message)) category = "schema_unsupported";
  failure = "auxiliary read unavailable";
} finally {
  try { db?.close(); } catch { failure = "auxiliary close unavailable"; }
}
parentPort.postMessage(failure === undefined ? { type: "complete", output } : { type: "failed", category, message: failure });
parentPort.close();
`;
