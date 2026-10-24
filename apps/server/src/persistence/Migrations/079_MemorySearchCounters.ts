import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** No migration-time scan: Store advances the durable rowid keyset in bounded batches. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE memory_items ADD COLUMN search_counted INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE memory_items ADD COLUMN search_text_bytes INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE TABLE memory_search_backfill (singleton INTEGER PRIMARY KEY CHECK(singleton=1), after_rowid INTEGER NOT NULL, ready INTEGER NOT NULL)`;
  yield* sql`INSERT INTO memory_search_backfill VALUES (1,0,0)`;
  yield* sql`CREATE TABLE memory_search_counters (space TEXT NOT NULL, scope_key TEXT NOT NULL, eligible INTEGER NOT NULL DEFAULT 0, indexed INTEGER NOT NULL DEFAULT 0, text_bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(space,scope_key))`;
  const bytes = (prefix: string) =>
    `coalesce((SELECT length(CAST(json_extract(body_json,'$.text') AS BLOB)) FROM memory_payloads WHERE space=${prefix}.space AND payload_ref=${prefix}.payload_ref),0)`;
  const delta = (prefix: string, sign: number) => `
    INSERT INTO memory_search_counters(space,scope_key,eligible,indexed,text_bytes)
    VALUES (${prefix}.space,${prefix}.scope_key,
      ${sign}*(${prefix}.search_counted=1 AND ${prefix}.status='active'),
      ${sign}*(${prefix}.search_counted=1 AND ${prefix}.status='active' AND ${prefix}.index_state='ready' AND ${prefix}.indexed_generation=${prefix}.generation),
      ${sign}*CASE WHEN ${prefix}.search_counted=1 AND ${prefix}.status='active' THEN ${prefix}.search_text_bytes ELSE 0 END)
    ON CONFLICT(space,scope_key) DO UPDATE SET eligible=eligible+excluded.eligible,indexed=indexed+excluded.indexed,text_bytes=text_bytes+excluded.text_bytes;`;
  yield* sql.unsafe(`CREATE TRIGGER memory_search_insert AFTER INSERT ON memory_items BEGIN
    UPDATE memory_items SET search_counted=1,search_text_bytes=${bytes("NEW")} WHERE rowid=NEW.rowid;
  END`);
  yield* sql.unsafe(`CREATE TRIGGER memory_search_payload AFTER UPDATE OF payload_ref ON memory_items BEGIN
    UPDATE memory_items SET search_text_bytes=${bytes("NEW")} WHERE rowid=NEW.rowid;
  END`);
  yield* sql.unsafe(
    `CREATE TRIGGER memory_search_update AFTER UPDATE OF search_counted,search_text_bytes,status,index_state,indexed_generation,generation,space,scope_key ON memory_items BEGIN ${delta("OLD", -1)} ${delta("NEW", 1)} END`,
  );
  yield* sql.unsafe(
    `CREATE TRIGGER memory_search_delete AFTER DELETE ON memory_items BEGIN ${delta("OLD", -1)} END`,
  );
});
