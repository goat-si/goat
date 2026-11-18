import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE memory_origins ADD COLUMN origin_sequence INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE memory_space_counters ADD COLUMN origin_update_sequence INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE memory_sync_cursors ADD COLUMN after_origin_sequence INTEGER NOT NULL DEFAULT 0`;
  yield* sql`WITH published AS (
      SELECT o.space,o.memory_id,row_number() OVER (PARTITION BY o.space ORDER BY o.memory_id) AS seq
      FROM memory_origins o JOIN memory_identity_ledger i ON i.space=o.space AND i.memory_id=o.memory_id
      WHERE json_extract(i.identity_json,'$.origin.environmentId')=o.environment_id
        AND json_extract(i.identity_json,'$.origin.threadId')=o.thread_id
    )
    UPDATE memory_origins AS o SET origin_sequence=p.seq FROM published p
    WHERE p.space=o.space AND p.memory_id=o.memory_id`;
  yield* sql`INSERT INTO memory_space_counters(space,forget_generation,origin_update_sequence)
    SELECT space,0,max(origin_sequence) FROM memory_origins WHERE origin_sequence>0 GROUP BY space
    ON CONFLICT(space) DO UPDATE SET origin_update_sequence=excluded.origin_update_sequence`;
  yield* sql`CREATE UNIQUE INDEX memory_origins_sequence_idx
    ON memory_origins(space,origin_sequence) WHERE origin_sequence>0`;
});
