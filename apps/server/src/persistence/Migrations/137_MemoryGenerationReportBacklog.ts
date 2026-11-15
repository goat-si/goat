import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Summary generation once kept one undeliverable report per failed attempt, which filled each
 * space's report budget and refused real deliveries. Keep the newest diagnostic per memory, then
 * the newest 100 per space; the table's delete triggers release their counted capacity.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const diagnostics = "report_kind IN ('summary','consolidate') AND state!='delivered'";
  yield* sql.unsafe(`DELETE FROM memory_report_outbox WHERE report_id IN (
    SELECT report_id FROM (
      SELECT report_id,row_number() OVER (PARTITION BY space,memory_id ORDER BY created_at DESC,report_id DESC) AS rank
      FROM memory_report_outbox WHERE ${diagnostics}
    ) WHERE rank>1)`);
  yield* sql.unsafe(`DELETE FROM memory_report_outbox WHERE report_id IN (
    SELECT report_id FROM (
      SELECT report_id,row_number() OVER (PARTITION BY space ORDER BY created_at DESC,report_id DESC) AS rank
      FROM memory_report_outbox WHERE ${diagnostics}
    ) WHERE rank>100)`);
});
