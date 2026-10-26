import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Track lifecycle changes without revisiting every historical space on each refresh. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lifecycle = (p: string) =>
    `${p}.space!='_checkpoint_lifecycle' AND ${p}.scope_key='' AND ${p}.dimension IN ('checkpoint_initialized','hub_snapshot_bytes','hub_snapshot_rows')`;
  const mark = (p: string) =>
    `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES ('_checkpoint_lifecycle',${p}.space,'',1) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=1;`;
  for (const [action, p] of [
    ["INSERT", "NEW"],
    ["DELETE", "OLD"],
  ] as const)
    yield* sql.unsafe(`CREATE TRIGGER memory_checkpoint_lifecycle_${action.toLowerCase()} AFTER ${action} ON memory_quota_counters
      WHEN ${lifecycle(p)} BEGIN ${mark(p)} END`);
  yield* sql.unsafe(`CREATE TRIGGER memory_checkpoint_lifecycle_move AFTER UPDATE OF space,dimension,scope_key ON memory_quota_counters
    WHEN (OLD.space IS NOT NEW.space OR OLD.dimension IS NOT NEW.dimension OR OLD.scope_key IS NOT NEW.scope_key)
      AND ((${lifecycle("OLD")}) OR (${lifecycle("NEW")}))
    BEGIN
      INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT '_checkpoint_lifecycle',OLD.space,'',1 WHERE ${lifecycle("OLD")} ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=1;
      INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT '_checkpoint_lifecycle',NEW.space,'',1 WHERE ${lifecycle("NEW")} ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=1;
    END`);
  yield* sql.unsafe(`CREATE TRIGGER memory_checkpoint_lifecycle_marker AFTER UPDATE OF value ON memory_quota_counters
    WHEN ${lifecycle("NEW")} AND NEW.dimension='checkpoint_initialized' AND OLD.value IS NOT NEW.value
    BEGIN ${mark("NEW")} END`);
  // The one full sweep: queue spaces that already break the lifecycle invariant so the
  // first refresh rejects pre-upgrade corruption. Healthy spaces leave no queue rows.
  yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
    SELECT '_checkpoint_lifecycle',i.space,'',1 FROM (
      SELECT DISTINCT space FROM memory_quota_counters
      WHERE space!='_checkpoint_lifecycle' AND scope_key='' AND dimension IN ('checkpoint_initialized','hub_snapshot_bytes','hub_snapshot_rows')
    ) i WHERE
      NOT EXISTS(SELECT 1 FROM memory_quota_counters m WHERE m.space=i.space AND m.dimension='checkpoint_initialized' AND m.scope_key='' AND m.value=1)
      OR NOT EXISTS(SELECT 1 FROM memory_quota_counters b WHERE b.space=i.space AND b.dimension='hub_snapshot_bytes' AND b.scope_key='')
      OR NOT EXISTS(SELECT 1 FROM memory_quota_counters n WHERE n.space=i.space AND n.dimension='hub_snapshot_rows' AND n.scope_key='')
    ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=1`;
});
