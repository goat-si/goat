import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE memory_hub_members ADD COLUMN advertised_features_json TEXT`;
  yield* sql`ALTER TABLE memory_hub_members ADD COLUMN advertised_credential_version INTEGER`;
  yield* sql`ALTER TABLE memory_sync_cursors ADD COLUMN hub_upgrade_blockers_json TEXT`;
  yield* sql`ALTER TABLE memory_space_counters ADD COLUMN last_forget_sequence INTEGER NOT NULL DEFAULT 0`;
  // Compacted V1 forget receipts can already be gone at first negotiation.
  yield* sql`INSERT INTO memory_space_counters(space,forget_generation,last_forget_sequence)
    SELECT space, 0, max(sequence) FROM (
      SELECT space,checkpoint_sequence AS sequence FROM memory_hub_retention
      UNION ALL
      SELECT space,hub_sequence FROM memory_hub_operations
      WHERE json_extract(entry_json,'$.receipt.outcome')='deleted'
    ) GROUP BY space
    ON CONFLICT(space) DO UPDATE SET last_forget_sequence=excluded.last_forget_sequence`;
});
