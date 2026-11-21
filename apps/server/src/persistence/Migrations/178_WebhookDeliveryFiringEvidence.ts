import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_task_webhook_deliveries
    ADD COLUMN firing_accepted INTEGER NOT NULL DEFAULT 0`;
  yield* sql`UPDATE scheduled_task_webhook_deliveries SET firing_accepted = 1
    WHERE delivery_id IN (
      SELECT webhook_delivery_id FROM scheduled_task_runs
      WHERE webhook_delivery_id IS NOT NULL AND dispatch_status = 'accepted'
      UNION ALL
      SELECT CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.webhookDeliveryId') END
      FROM scheduled_task_channel_inputs
      WHERE state IN ('ingested', 'settled') AND error IS NULL
    )`;
});
