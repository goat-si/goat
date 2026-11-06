import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Summary and consolidation failures stay in the report outbox as per-memory diagnostics that
 * nothing delivers, yet the processing counters showed them as reports waiting for delivery. Count
 * only deliverable kinds, and recompute both counters from the rows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const counters = (p: string) =>
    [
      [
        "processing_report_backlog",
        `${p}.report_kind NOT IN ('summary','consolidate') AND ${p}.state IN ('pending','failed')`,
      ],
      [
        "processing_report_failed",
        `${p}.report_kind NOT IN ('summary','consolidate') AND ${p}.state='failed'`,
      ],
    ] as const;
  const add = (p: string) =>
    counters(p)
      .map(
        ([dimension, expression]) =>
          `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES (${p}.space,'${dimension}','',coalesce((${expression}),0)) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value;`,
      )
      .join("\n");
  const remove = (p: string) =>
    counters(p)
      .map(
        ([dimension, expression]) =>
          `UPDATE memory_quota_counters SET value=value-coalesce((${expression}),0) WHERE space=${p}.space AND dimension='${dimension}' AND scope_key='';`,
      )
      .join("\n");
  for (const action of ["insert", "update", "delete"])
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS memory_report_outbox_processing_${action}`);
  yield* sql.unsafe(
    `CREATE TRIGGER memory_report_outbox_processing_insert AFTER INSERT ON memory_report_outbox BEGIN ${add("NEW")} END`,
  );
  yield* sql.unsafe(
    `CREATE TRIGGER memory_report_outbox_processing_update AFTER UPDATE OF space,state,report_kind ON memory_report_outbox BEGIN ${remove("OLD")} ${add("NEW")} END`,
  );
  yield* sql.unsafe(
    `CREATE TRIGGER memory_report_outbox_processing_delete AFTER DELETE ON memory_report_outbox BEGIN ${remove("OLD")} END`,
  );
  for (const [dimension, expression] of counters("r")) {
    yield* sql.unsafe(
      `UPDATE memory_quota_counters SET value=0 WHERE dimension='${dimension}' AND scope_key=''`,
    );
    yield* sql.unsafe(
      `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT r.space,'${dimension}','',coalesce(sum(coalesce((${expression}),0)),0) FROM memory_report_outbox r GROUP BY r.space ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=excluded.value`,
    );
  }
});
