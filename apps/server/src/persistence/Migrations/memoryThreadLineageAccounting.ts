import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const utf8 = (column: string) => `length(CAST(${column} AS BLOB))`;

export const installMemoryThreadLineageAccounting = Effect.fn(
  "Migration.memoryThreadLineageAccounting",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = [
    ["memory_thread_lineages", "space", ["environment_id", "thread_id", "space"], 32],
    ["memory_thread_lineage_revisions", null, ["environment_id", "thread_id", "revision_id"], 96],
    ["memory_revision_marks", "space", ["space", "revision_id"], 32],
    ["memory_origins", "space", ["space", "memory_id", "environment_id", "thread_id"], 64],
  ] as const;
  const delta = (space: string, dimension: string, bytes: string, adding: boolean) =>
    adding
      ? `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES (${space},'${dimension}','',${bytes})
        ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value;`
      : `UPDATE memory_quota_counters SET value=value-(${bytes}) WHERE space=${space} AND dimension='${dimension}' AND scope_key='';`;
  for (const [table, spaceColumn, columns, overhead] of tables) {
    for (const action of ["INSERT", "DELETE"] as const) {
      const adding = action === "INSERT";
      const row = adding ? "NEW" : "OLD";
      const space =
        spaceColumn !== null
          ? `${row}.${spaceColumn}`
          : `(SELECT space FROM memory_thread_lineages WHERE environment_id=${row}.environment_id AND thread_id=${row}.thread_id)`;
      const bytes = [overhead, ...columns.map((column) => utf8(`${row}.${column}`))].join("+");
      yield* sql.unsafe(`CREATE TRIGGER ${table}_usage_${action.toLowerCase()} ${adding ? "AFTER" : "BEFORE"} ${action} ON ${table}
        BEGIN ${delta(space, "usage_local_provenance_bytes", bytes, adding)}
        ${delta("'_usage_environment'", "usage_local_provenance_bytes", bytes, adding)} END`);
    }
  }
  const dimension = "usage_dependency_bytes";
  for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
    const add =
      action === "DELETE"
        ? ""
        : delta("NEW.space", dimension, utf8("NEW.dependencies_json"), true) +
          delta("'_usage_environment'", dimension, utf8("NEW.dependencies_json"), true);
    const subtract =
      action === "INSERT"
        ? ""
        : delta("OLD.space", dimension, utf8("OLD.dependencies_json"), false) +
          delta("'_usage_environment'", dimension, utf8("OLD.dependencies_json"), false);
    yield* sql.unsafe(`CREATE TRIGGER memory_payload_dependency_usage_${action.toLowerCase()} AFTER ${action === "UPDATE" ? "UPDATE OF space, dependencies_json" : action} ON memory_payloads
      BEGIN ${subtract}${add} END`);
  }
  yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
    SELECT space,'usage_dependency_bytes','',sum(length(CAST(dependencies_json AS BLOB)))
    FROM memory_payloads GROUP BY space`;
  yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
    SELECT '_usage_environment','usage_dependency_bytes','',coalesce(sum(length(CAST(dependencies_json AS BLOB))),0)
    FROM memory_payloads`;
});
