import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Each revision caches the size of its body-free checkpoint record, so checkpoint
 * accounting decodes a revision once instead of on every write to its memory.
 * NULL means not measured yet; existing rows are measured on their memory's next write.
 * Idempotent, so tests that run the current store on an older schema can apply it early.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(memory_revisions)`;
  if (!columns.some((column) => column.name === "checkpoint_bytes"))
    yield* sql`ALTER TABLE memory_revisions ADD COLUMN checkpoint_bytes INTEGER CHECK(checkpoint_bytes>=0)`;
  yield* sql`CREATE INDEX IF NOT EXISTS memory_revisions_checkpoint_bytes ON memory_revisions(space,memory_id,checkpoint_bytes)`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS memory_revisions_checkpoint_bytes_reset AFTER UPDATE OF space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at ON memory_revisions
    WHEN NEW.checkpoint_bytes IS NOT NULL
    BEGIN UPDATE memory_revisions SET checkpoint_bytes=NULL WHERE space=NEW.space AND revision_id=NEW.revision_id; END`;
});
