import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TRIGGER memory_save_suggestions_usage_update
    AFTER UPDATE OF derived_json ON memory_save_suggestions
    WHEN NEW.derived_json IS NOT OLD.derived_json
    BEGIN
      UPDATE memory_quota_counters
      SET value=value+length(CAST(NEW.derived_json AS BLOB))-length(CAST(OLD.derived_json AS BLOB))
      WHERE space IN (NEW.space,'_usage_environment')
        AND dimension='usage_local_provenance_bytes' AND scope_key='';
    END`;

  // A suggestion already deleted with stale accounting leaves no row to repair by delta.
  yield* sql`UPDATE memory_quota_counters SET value=0
    WHERE dimension='usage_local_provenance_bytes' AND scope_key=''`;
  yield* sql`
    WITH provenance(space,bytes) AS (
      SELECT space,sum(32+length(CAST(environment_id AS BLOB))+length(CAST(thread_id AS BLOB))
        +length(CAST(space AS BLOB))) FROM memory_thread_lineages GROUP BY space
      UNION ALL
      SELECT l.space,sum(96+length(CAST(r.environment_id AS BLOB))+length(CAST(r.thread_id AS BLOB))
        +length(CAST(r.revision_id AS BLOB)))
      FROM memory_thread_lineage_revisions r JOIN memory_thread_lineages l USING(environment_id,thread_id)
      GROUP BY l.space
      UNION ALL
      SELECT space,sum(32+length(CAST(space AS BLOB))+length(CAST(revision_id AS BLOB)))
      FROM memory_revision_marks GROUP BY space
      UNION ALL
      SELECT space,sum(64+length(CAST(space AS BLOB))+length(CAST(memory_id AS BLOB))
        +length(CAST(environment_id AS BLOB))+length(CAST(thread_id AS BLOB)))
      FROM memory_origins GROUP BY space
      UNION ALL
      SELECT space,sum(128+length(CAST(id AS BLOB))+length(CAST(space AS BLOB))
        +length(CAST(origin_environment_id AS BLOB))+length(CAST(origin_thread_id AS BLOB))
        +length(CAST(text AS BLOB))+length(CAST(scope_json AS BLOB))+length(CAST(derived_json AS BLOB)))
      FROM memory_save_suggestions GROUP BY space
    ), totals(space,bytes) AS (
      SELECT space,bytes FROM provenance
      UNION ALL
      SELECT '_usage_environment',bytes FROM provenance
    )
    INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
    SELECT space,'usage_local_provenance_bytes','',sum(bytes) FROM totals GROUP BY space
    ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=excluded.value`;
});
