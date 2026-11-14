import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const pruneDevSettleScripts = Effect.fn("pruneDevSettleScripts")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE projection_projects
    SET scripts_json = (
      SELECT json_group_array(json_remove(script.value, '$.runOnSettle') ORDER BY script.key)
      FROM json_each(scripts_json) AS script)
    WHERE EXISTS (
      SELECT 1 FROM json_each(scripts_json) AS script
      WHERE json_extract(script.value, '$.runOnSettle') IS NOT NULL)`;
});
