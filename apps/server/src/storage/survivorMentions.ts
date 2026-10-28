import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const PAGE_ROWS = 16;
const MAX_FIELD_CHARS = 16_384;
const MAX_PAGES = 128;
const MAX_CHARS = 8 * 1024 * 1024;

const sources = [
  {
    table: "orchestration_v2_projection_threads",
    columns: ["payload_json"],
    keep: "item.deleted_at IS NULL",
    join: "",
  },
  ...["messages", "turn_items"].map((kind) => ({
    table: `orchestration_v2_projection_${kind}`,
    columns: ["payload_json"],
    keep: "thread.thread_id IS NOT NULL AND thread.deleted_at IS NULL",
    join: "LEFT JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = item.thread_id",
  })),
  {
    table: "orchestration_v2_projection_context_transfers",
    columns: ["source_thread_id", "target_thread_id", "payload_json"],
    keep: "1",
    join: "",
  },
  {
    table: "orchestration_v2_projection_context_handoffs",
    columns: ["payload_json"],
    keep: "1",
    join: "",
  },
  {
    table: "orchestration_v2_effect_outbox",
    columns: ["payload_json"],
    keep: "item.status IN ('pending', 'running')",
    join: "",
  },
  { table: "mcp_app_model_context", columns: ["text"], keep: "1", join: "" },
  { table: "scheduled_tasks", columns: ["prompt"], keep: "1", join: "" },
];

export const survivorMentions = Effect.fn("storage.survivorMentions")(
  function* (
    needles: ReadonlyArray<string>,
    betweenPages: Effect.Effect<void> = Effect.promise(
      () => new Promise<void>((resolve) => setImmediate(resolve)),
    ),
  ) {
    if (needles.length === 0) return new Set<string>();
    const sql = yield* SqlClient.SqlClient;
    const fence = Effect.fn("storage.survivorMentions.fence")(function* () {
      const version = yield* sql<{ readonly data_version: number }>`PRAGMA data_version`;
      const changes = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;
      if (version[0] === undefined || changes[0] === undefined) return null;
      return `${version[0].data_version}:${changes[0].changes}`;
    });
    const before = yield* fence();
    if (before === null) return null;
    const mentioned = new Set<string>();
    const remaining = new Set(needles);
    let pages = 0;
    let chars = 0;
    for (const source of sources) {
      let after: number | undefined;
      while (true) {
        if (pages >= MAX_PAGES) return null;
        // Identifiers and expressions come only from the fixed source list above.
        const fields = source.columns.map(
          (column, index) => `substr(item.${column}, 1, ${MAX_FIELD_CHARS + 1}) AS text${index}`,
        );
        // SQLite text substr stops at NUL; byte lengths must prove no suffix was hidden.
        const complete = source.columns
          .map(
            (column) =>
              `length(CAST(item.${column} AS BLOB)) IS
         length(CAST(substr(item.${column}, 1, ${MAX_FIELD_CHARS + 1}) AS BLOB))`,
          )
          .join(" AND ");
        const rows = yield* sql
          .unsafe<{
            readonly row_id: number;
            readonly keep: number;
            readonly complete: number;
            readonly text0: string | null;
            readonly text1?: string | null;
            readonly text2?: string | null;
          }>(
            `SELECT item.rowid AS row_id, (${source.keep}) AS keep,
           (${complete}) AS complete, ${fields.join(", ")}
         FROM ${source.table} AS item ${source.join}
         ${after === undefined ? "" : "WHERE item.rowid > ?"}
         ORDER BY item.rowid LIMIT ${PAGE_ROWS}`,
            after === undefined ? [] : [after],
          )
          .pipe(NodeSqliteClient.readOnly);
        pages++;
        for (const row of rows) {
          if (row.keep !== 1) continue;
          if (row.complete !== 1) return null;
          for (const text of [row.text0, row.text1, row.text2]) {
            if (text == null) continue;
            if (typeof text !== "string") return null;
            chars += text.length;
            if (text.length > MAX_FIELD_CHARS || chars > MAX_CHARS) return null;
            for (const needle of remaining) {
              if (text.includes(needle)) {
                mentioned.add(needle);
                remaining.delete(needle);
              }
            }
          }
        }
        if (remaining.size === 0) return mentioned;
        if (rows.length < PAGE_ROWS) break;
        const last = rows.at(-1);
        if (last === undefined || !Number.isSafeInteger(last.row_id)) return null;
        after = last.row_id;
        yield* betweenPages;
      }
    }
    return (yield* fence()) === before ? mentioned : null;
  },
  Effect.orElseSucceed(() => null),
);
