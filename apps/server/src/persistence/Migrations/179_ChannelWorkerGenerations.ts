import type { ChannelTaskId } from "@goat/contracts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { workerLaunchIdsFor } from "../../channels/channelIds.ts";
import {
  fenceWorkerReleaseRollback,
  hasPersistedWorkTriggers,
} from "../reconcileGoatMigrationIds.ts";
import migrateWebhookFiringEvidence from "./178_WebhookDeliveryFiringEvidence.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const draftEvidence =
    yield* sql`SELECT 1 FROM pragma_table_info('scheduled_task_webhook_deliveries')
    WHERE name = 'firing_accepted'`;
  if (draftEvidence.length > 0) {
    yield* migrateWebhookFiringEvidence;
    yield* sql`INSERT INTO scheduled_task_webhook_firings (delivery_id)
      SELECT delivery_id FROM scheduled_task_webhook_deliveries WHERE firing_accepted = 1
      ON CONFLICT (delivery_id) DO NOTHING`;
  }
  yield* sql`CREATE TABLE channel_worker_generations (
    worker_thread_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE REFERENCES channel_tasks(task_id) ON DELETE CASCADE,
    generation INTEGER NOT NULL
  ) WITHOUT ROWID`;
  // Older builds could persist a prepared worker before its task acquired a binding.
  let after = "";
  while (true) {
    const tasks = yield* sql<{ readonly task_id: ChannelTaskId; readonly generation: number }>`
      SELECT task_id, generation FROM channel_tasks
      WHERE task_id > ${after} AND (worker_thread_id IS NOT NULL OR status = 'dispatching')
      ORDER BY task_id LIMIT 256`;
    if (!Arr.isReadonlyArrayNonEmpty(tasks)) break;
    after = Arr.lastNonEmpty(tasks).task_id;
    yield* sql`INSERT INTO channel_worker_generations ${sql.insert(
      Arr.map(tasks, ({ task_id, generation }) => ({
        worker_thread_id: workerLaunchIdsFor(task_id, generation).threadId,
        task_id,
        generation,
      })),
    )}`;
  }
  if (yield* hasPersistedWorkTriggers()) yield* fenceWorkerReleaseRollback();
});
