import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE memory_compact_receipts
    SET compact_blob=CAST(substr(compact_blob,1,1) || X'04' || substr(compact_blob,3) AS BLOB)
    WHERE substr(compact_blob,1,2) IN (X'02FF', X'03FF')
      AND json_extract(compact_json,'$.operationKind')='move'`;
});
