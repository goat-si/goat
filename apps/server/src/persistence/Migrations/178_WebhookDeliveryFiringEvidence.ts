import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE scheduled_task_webhook_firings (
    delivery_id TEXT PRIMARY KEY REFERENCES scheduled_task_webhook_deliveries(delivery_id)
      ON DELETE CASCADE
  ) WITHOUT ROWID`;
  yield* sql`INSERT INTO scheduled_task_webhook_firings (delivery_id)
    SELECT delivery_id FROM scheduled_task_webhook_deliveries
    WHERE delivery_id IN (
      SELECT webhook_delivery_id FROM scheduled_task_runs
      WHERE webhook_delivery_id IS NOT NULL AND dispatch_status = 'accepted'
      UNION ALL
      SELECT CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.webhookDeliveryId') END
      FROM scheduled_task_channel_inputs
      WHERE state IN ('ingested', 'settled') AND error IS NULL
    ) OR (
      outcome = 'accepted' AND 'routine:scheduled-task:' || task_id || ':webhook:' || delivery_id
      IN (SELECT idempotency_key FROM channel_inbox
        WHERE kind = 'goat' AND connection_id = 'goat'
          AND state = 'replied' AND failure_json IS NULL)
    )`;
});
